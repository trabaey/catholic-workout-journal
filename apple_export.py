#!/usr/bin/env python3
"""
apple_export.py — read an Apple Health "Export All Health Data" zip and write
its workouts, each with its GPS route, as JSON for server.js to import.

Spawned by POST /api/apple-health/export, never by cron:
  python3 apple_export.py --zip data/apple-export-2.zip --out data/apple-export-2.json [--progress]

It writes nothing to the database itself. server.js reads --out and does every
insert, so the dedup rules (the Shortcut's rows, Garmin copies, manual entries)
live in one place. Routes go through garmin_sync.py's own pipeline
(samples_from_gpx -> route_from_samples -> encode_polyline), so an Apple route
is simplified, paused and timed exactly like a Garmin one.
Story: DECISIONS.md#apple-health-export.
"""

import argparse, io, json, os, re, sys, zipfile
import xml.etree.ElementTree as ET
from datetime import datetime

from garmin_sync import samples_from_gpx, route_from_samples, encode_polyline

# Apple's date format throughout export.xml: local time plus its offset.
APPLE_DATE_FMT = '%Y-%m-%d %H:%M:%S %z'

# Events that stop the workout's clock. Auto-pause (Motion*) counts: it stops
# the timer the same way, and the track jumps across it the same way.
PAUSE_EVENTS = {'HKWorkoutEventTypePause', 'HKWorkoutEventTypeMotionPaused'}
RESUME_EVENTS = {'HKWorkoutEventTypeResume', 'HKWorkoutEventTypeMotionResumed'}


def progress(step, done=None, total=None):
    # Same line format as garmin_sync.py's progress(); server.js reads it.
    if ARGS.progress:
        print(f"PROGRESS {step}" + (f" {done}/{total}" if total else ''), flush=True)


def parse_apple_date(s):
    try:
        return datetime.strptime((s or '').strip(), APPLE_DATE_FMT)
    except ValueError:
        return None


# "HKWorkoutActivityTypeTraditionalStrengthTraining" -> "Traditional Strength
# Training": the same words the Shortcut's Find Workout reports, so both paths
# land on the same app type (server.js's APPLE_TYPE_MAP, else a slug).
def type_name(hk):
    raw = re.sub(r'^HKWorkoutActivityType', '', hk or '')
    return re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', raw).strip()


def to_metres(value, unit):
    per = {'m': 1, 'km': 1000, 'mi': 1609.344, 'ft': 0.3048, 'yd': 0.9144}.get((unit or '').lower())
    return value * per if per else None


def to_kcal(value, unit):
    u = (unit or '').lower()
    if u in ('cal', 'kcal'):  # Health's "Cal" is the food calorie, i.e. kcal
        return value
    if u == 'kj':
        return value / 4.184
    return None


def num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


# Seconds the clock was stopped: Pause/Resume pairs when the workout logged
# them, else elapsed minus active duration (HKWorkout's duration excludes
# pauses). None only when neither is readable, which leaves the route's
# breaks NULL, "unchecked", like Garmin's fetch_paused_s.
def paused_seconds(el, start, end, active_s):
    total, paused_at, seen = 0.0, None, False
    for ev in el.iter('WorkoutEvent'):
        kind, at = ev.get('type'), parse_apple_date(ev.get('date'))
        if not at:
            continue
        if kind in PAUSE_EVENTS:
            seen = True
            paused_at = paused_at or at
        elif kind in RESUME_EVENTS and paused_at:
            total += (at - paused_at).total_seconds()
            paused_at = None
    if paused_at and end:
        total += (end - paused_at).total_seconds()
    if seen:
        return max(0.0, total)
    if start and end and active_s is not None:
        return max(0.0, (end - start).total_seconds() - active_s)
    return None


# One <Workout> element -> the dict server.js imports, or None when it has no
# readable start. Reads both export generations: totals as attributes on
# <Workout> (older iOS) and as <WorkoutStatistics> children (iOS 16 onward).
def workout_from_element(el):
    start, end = parse_apple_date(el.get('startDate')), parse_apple_date(el.get('endDate'))
    if not start:
        return None
    dur = num(el.get('duration'))
    unit = (el.get('durationUnit') or 'min').lower()
    active_s = None if dur is None else dur * {'s': 1, 'sec': 1, 'min': 60, 'hr': 3600, 'h': 3600}.get(unit, 60)

    metres = kcal = avg_hr = None
    if num(el.get('totalDistance')) is not None:
        metres = to_metres(num(el.get('totalDistance')), el.get('totalDistanceUnit'))
    if num(el.get('totalEnergyBurned')) is not None:
        kcal = to_kcal(num(el.get('totalEnergyBurned')), el.get('totalEnergyBurnedUnit'))
    for st in el.iter('WorkoutStatistics'):
        kind = st.get('type') or ''
        if 'Distance' in kind and num(st.get('sum')) is not None:
            metres = to_metres(num(st.get('sum')), st.get('unit'))
        elif kind.endswith('ActiveEnergyBurned') and num(st.get('sum')) is not None:
            kcal = to_kcal(num(st.get('sum')), st.get('unit'))
        elif kind.endswith('HeartRate') and num(st.get('average')) is not None:
            avg_hr = num(st.get('average'))

    route_files = [fr.get('path') for fr in el.iter('FileReference') if fr.get('path')]
    return {
        # Stable across re-exports (the start never changes) and safe as a
        # photo directory name (server.js's PHOTO_EXTERNAL_ID).
        'id': f"applex-{int(start.timestamp())}",
        'type': type_name(el.get('workoutActivityType')),
        'start': start.isoformat(),
        'end': end.isoformat() if end else None,
        'duration': active_s,
        'distance': metres,
        'calories': kcal,
        'avgheartrate': avg_hr,
        'source': el.get('sourceName') or '',
        '_paused_s': paused_seconds(el, start, end, active_s),
        '_route_files': route_files,
    }


# export.xml is gigabytes of <Record> lines; only <Workout> blocks matter.
# Read line by line and hand each block to ElementTree on its own, rather than
# parsing the whole document: memory stays flat, and the DOCTYPE at the top
# (whose internal subset has been malformed in some iOS releases) never
# reaches a parser.
def iter_workouts(stream, total_bytes):
    block, read, last_pct = None, 0, -1
    for line in stream:
        read += len(line)
        pct = int(read * 100 / total_bytes) if total_bytes else 0
        if pct != last_pct and pct % 2 == 0:
            progress('reading', pct, 100)
            last_pct = pct
        s = line.lstrip()
        if block is None:
            if not s.startswith('<Workout '):
                continue
            block = [line]
            if s.rstrip().endswith('/>'):
                yield ''.join(block)
                block = None
            continue
        block.append(line)
        if s.startswith('</Workout>'):
            yield ''.join(block)
            block = None


# The main export file. Its name is localized ("export.xml", "Export.xml",
# "exportieren.xml"), so: the largest .xml that isn't the clinical-records
# export_cda.xml.
def find_export_xml(zf):
    xmls = [i for i in zf.infolist() if i.filename.lower().endswith('.xml')
            and 'cda' not in os.path.basename(i.filename).lower()]
    return max(xmls, key=lambda i: i.file_size) if xmls else None


def route_for(zf, by_basename, workout):
    for ref in workout['_route_files']:
        info = by_basename.get(os.path.basename(ref))
        if not info:
            continue
        samples = samples_from_gpx(zf.read(info))
        if len(samples) < 2:
            continue
        points, breaks, times, elev, hr = route_from_samples(samples, workout['_paused_s'])
        if len(points) < 2:
            continue
        return {'polyline': encode_polyline(points), 'breaks': breaks, 'times': times, 'elev': elev, 'hr': hr}
    return None


def read_export(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        info = find_export_xml(zf)
        if not info:
            raise ValueError('No export.xml in this zip - is it the Health app\'s "Export All Health Data" file?')
        by_basename = {os.path.basename(i.filename): i for i in zf.infolist() if i.filename.lower().endswith('.gpx')}
        workouts, unreadable = [], 0
        with zf.open(info) as raw:
            text = io.TextIOWrapper(raw, encoding='utf-8', errors='replace')
            for block in iter_workouts(text, info.file_size):
                try:
                    w = workout_from_element(ET.fromstring(block))
                except ET.ParseError:
                    w = None
                if w:
                    workouts.append(w)
                else:
                    unreadable += 1
        with_routes = [w for w in workouts if w['_route_files']]
        for i, w in enumerate(with_routes):
            progress('routes', i + 1, len(with_routes))
            w['route'] = route_for(zf, by_basename, w)
        for w in workouts:
            w.setdefault('route', None)
            del w['_paused_s'], w['_route_files']
        return {'workouts': workouts, 'unreadable': unreadable}


def main():
    result = read_export(ARGS.zip)
    tmp = ARGS.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f)
    os.replace(tmp, ARGS.out)
    routes = sum(1 for w in result['workouts'] if w['route'])
    print(f"Read {len(result['workouts'])} workouts, {routes} with a route"
          + (f", {result['unreadable']} unreadable" if result['unreadable'] else ''))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--progress', action='store_true')
    ARGS = ap.parse_args()
    try:
        main()
    except Exception as e:
        print(f"EXPORT_ERROR {e}", file=sys.stderr)
        sys.exit(1)
else:
    ARGS = argparse.Namespace(progress=False)
