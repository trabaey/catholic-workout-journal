#!/usr/bin/env python3
"""
garmin_sync.py — fetch recent Garmin Connect activities, sleep scores and
daily recovery data, and sync them into Catholic Workout Journal.

Run on the Pi, inside the container:
  sudo docker exec workout-tracker python3 garmin_sync.py [--user-id N]
  sudo docker exec workout-tracker python3 garmin_sync.py --all   # every credentialed user

pi's crontab runs --all every morning; the schedule and its log are in
OPERATIONS.md. Every run is safe to repeat: activities dedupe on external_id
and a re-fetched day is written back unchanged. Story: DECISIONS.md#cron-sync.

Dependencies are pinned in requirements.txt. Credentials are per-user files
under data/; load_credentials() has the precedence chain.
"""

import os, sys, argparse, re, math, time, subprocess, fcntl, requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from time import monotonic
from garminconnect import (Garmin, GarminConnectAuthenticationError, GarminConnectConnectionError,
                           GarminConnectNotFoundError, GarminConnectTooManyRequestsError)

# Per-user token cache: a directory, python-garminconnect's own tokenstore
# convention, under data/ so it survives rebuilds. User 1's path has no id
# suffix and must never change, or a deploy forces a re-MFA for that account.
# Must match server.js's tokenStoreDir(userId) character for character, or a
# credential change in the UI won't invalidate the directory a sync actually
# reads. Story: DECISIONS.md#per-user-sync-credentials.
def token_store_for(user_id):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if user_id == 1:
        return os.path.join(script_dir, 'data', '.garminconnect')
    return os.path.join(script_dir, 'data', f'.garminconnect-{user_id}')

# scripts/backfill_garmin_timestamps.py imports this name; it only ever works
# on user 1.
TOKEN_STORE = token_store_for(1)

# --all's user list: every data/garmin-{id}.env, discovered rather than
# hardcoded so a newly connected user needs no crontab edit. User 1 is always
# included: load_credentials() gives that account a legacy fallback, so it may
# have no per-user file at all.
def discover_credentialed_user_ids(data_dir=None):
    # data_dir is overridable for testing/verify_garmin_sync.py.
    if data_dir is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        data_dir = os.path.join(script_dir, 'data')
    ids = {1}
    if os.path.isdir(data_dir):
        for fname in os.listdir(data_dir):
            m = re.match(r'^garmin-(\d+)\.env$', fname)
            if m:
                ids.add(int(m.group(1)))
    return sorted(ids)

# This run's outcome, POSTed to the server at the end (see __main__) so a cron
# run's failure reaches the app's error badge, not just a log on the Pi. Set
# immediately before every exit point rather than derived from the unwinding
# exception: the MFA exit happens inside a library callback, so there is no
# single place to catch it. userId is set once at startup.
#
# The message is what a person reads on the badge and the Settings card, so a
# known failure is worded as what happened and what to do next, never as the
# exception's own text (that carries URLs and SSO detail, and goes to stdout,
# the Pi's log). rate_limited tells the page to step its Sync buttons back.
_status = {'ok': None, 'mfa_required': False, 'rate_limited': False, 'message': '', 'userId': 1}

# --dry-run makes the whole run INERT, and this flag is the single choke point
# that guarantees it: every _set_status becomes a no-op, so the stored outcome
# (and garminSyncErrorBadge) stays exactly as the last real sync left it.
# Suppressing only the POST would not do — several failure paths set a status
# and exit, and __main__ stamps a success on any run that ends without one.
# Auth and rate-limit failures are silenced too; the operator is watching
# stdout.
_dry_run = False

# Set by every place that catches a Garmin 429. Once set, main() makes no
# further Garmin request: it posts what already came back and exits
# RATE_LIMITED_EXIT, which --all reads as "stop for this IP". Nothing resets
# it; one run is one process.
_rate_limited = False
RATE_LIMITED_EXIT = 3
# Garmin limits the IP, and a retry while limited only extends it, so the next
# step is to wait. Two openings, for whether anything landed first.
RATE_LIMITED_WAIT = ('Wait a few hours, or leave it to the morning sync: syncing again '
                     'sooner can make the limit last longer.')
RATE_LIMITED_NOTHING = ('Garmin is limiting how often this app can ask, so nothing was synced. '
                        + RATE_LIMITED_WAIT)
RATE_LIMITED_PARTWAY = ('Garmin is limiting how often this app can ask, so the sync stopped '
                        'part way. What arrived before that is saved. ' + RATE_LIMITED_WAIT)

def _note_rate_limit():
    global _rate_limited
    _rate_limited = True

# WHERE A RUN IS, and how long each part took. progress() marks the start of a
# step; with --progress (the browser-started sync) it also prints a line
# server.js reads off stdout as it arrives, so the Sync button can say what it
# is waiting for. The format is a contract with server.js's
# GARMIN_PROGRESS_RE: "PROGRESS <step>" or "PROGRESS <step> <done>/<total>".
#
# Every run ends with timings_line() in its output, cron runs included: it is
# what a slow sync is diagnosed from, step by step.
_show_progress = False
_timer = {'step': None, 'since': None, 'secs': {}}

def progress(step, done=None, total=None):
    now = monotonic()
    if _timer['step'] != step:
        _close_step(now)
        _timer['step'], _timer['since'] = step, now
    if _show_progress:
        print(f"PROGRESS {step}" + (f" {done}/{total}" if done is not None and total else ''))

def _close_step(now):
    if _timer['step'] is not None:
        secs = _timer['secs']
        secs[_timer['step']] = secs.get(_timer['step'], 0.0) + now - _timer['since']
        _timer['step'] = None

def timings_line():
    """'Timings: login 1.2 s · sleep 2.0 s · ... · total 6.3 s', closing the
    step still open. '' when no step ever started."""
    _close_step(monotonic())
    secs = _timer['secs']
    if not secs:
        return ''
    parts = [f"{k} {v:.1f} s" for k, v in secs.items()]
    return 'Timings: ' + ' · '.join(parts) + f" · total {sum(secs.values()):.1f} s"

# ONE SYNC PER USER AT A TIME, across every way one starts: the cron, both
# Sync buttons, a second device, an SSH run. Two at once double the burst
# Garmin sees and race to refresh the same saved sign-in. An flock on a file
# under data/, so it spans processes and is released by the kernel however the
# holder exits. NOT inside the token store: server.js deletes that directory
# on a credential change, and a lock on an unlinked file excludes nobody.
#
# A run that finds it held prints SYNC_IN_PROGRESS (server.js relays it as a
# 409) and exits SYNC_BUSY_EXIT WITHOUT setting a status: the run that holds
# the lock reports the outcome.
SYNC_BUSY_EXIT = 4
_sync_lock = None

def sync_lock_path(user_id):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, 'data', f'.garmin-sync-{user_id}.lock')

def acquire_sync_lock(user_id):
    """True if this process now holds the user's sync lock, False if another
    run does. Held until the process exits."""
    global _sync_lock
    path = sync_lock_path(user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, 'a')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return False
    _sync_lock = fh
    return True

def _set_status(ok, message, mfa_required=False, rate_limited=False):
    if _dry_run:
        return
    _status['ok'] = ok
    _status['message'] = message
    _status['mfa_required'] = mfa_required
    _status['rate_limited'] = rate_limited


# A failed sign-in, in words: (message, rate_limited). The library raises
# three kinds here and each needs a different next step, so they are told
# apart rather than printed. An auth failure with a code supplied is the code:
# the password already got far enough to make Garmin send one.
def login_failure_status(exc, mfa_code=None):
    if isinstance(exc, GarminConnectTooManyRequestsError):
        return RATE_LIMITED_NOTHING, True
    if isinstance(exc, GarminConnectAuthenticationError):
        if mfa_code:
            return ("Garmin didn't accept that code. Press Sync again and Garmin will "
                    "email a new one."), False
        return ("Garmin didn't accept the email and password. Disconnect Garmin in "
                "Settings and connect it again with the right ones, or sign in at "
                "connect.garmin.com to check the account isn't locked."), False
    return ("Garmin's sign-in didn't answer normally, so nothing was synced. "
            "Try again later."), False

def _report_status():
    """Best-effort POST of this run's outcome. Never raises — a reporting
    failure must not change the script's own exit code."""
    if _status['ok'] is None:
        return
    try:
        requests.post(f"{WORKOUT_API}/api/garmin/sync-status", json=_status, timeout=5)
    except Exception as e:
        print(f"  (couldn't report sync status: {e})")

def load_credentials(user_id=1):
    """
    Load GARMIN_EMAIL/GARMIN_PASSWORD (and anything else in the file) from the
    first credentials file that exists: data/garmin-{user_id}.env, written by
    PUT /api/garmin/credentials. User 1 alone falls back to data/garmin.env ->
    .env -> workout-tracker.env, the paths that account used before per-user
    credentials. data/ comes first because OMV only mounts it; the last two
    are rewritten by OMV on rebuild. setdefault, so a real environment
    variable beats the file.

    This is the ONE copy of the precedence; scripts/backfill_garmin_timestamps.py
    reuses it. Only ever CALL it from __main__, never at import time: the test
    harness and the backfill both import this module, and an import-time call
    would read secrets and send the harness into a live Garmin login.
    Story: DECISIONS.md#per-user-sync-credentials.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(script_dir, 'data', f'garmin-{user_id}.env')]
    if user_id == 1:
        candidates += [
            os.path.join(script_dir, 'data', 'garmin.env'),
            os.path.join(script_dir, '.env'),
            os.path.join(script_dir, 'workout-tracker.env'),
        ]
    env_path = next((p for p in candidates if os.path.exists(p)), None)
    if env_path:
        print(f"Loading credentials from {os.path.relpath(env_path, script_dir)}")
        with open(env_path) as f:
            for line in f:
                line = line.strip().strip('\r')
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
    else:
        print(f"WARNING: no credentials file found for user {user_id} (checked "
              f"{', '.join(os.path.relpath(p, script_dir) for p in candidates)})")


def make_mfa_getter(cli_code):
    """
    Returns the function garminconnect calls when MFA is actually required.
    - If a code was supplied via --mfa-code, return it directly (no prompt).
    - If running interactively (SSH terminal), prompt with input().
    - If running non-interactively with no code (e.g. spawned by the browser's
      "Sync Garmin" button), we can't prompt for one — print a marker and
      exit so the caller (server.js) can ask the user for a code and retry.
    """
    if cli_code:
        return lambda: cli_code
    def prompt():
        if not sys.stdin.isatty():
            _set_status(False, 'Garmin needs a sign-in code. Press Sync and Garmin will email one; '
                               'type it in when the box appears.', mfa_required=True)
            print("MFA_REQUIRED")
            sys.exit(2)
        print("  Garmin sent you an MFA code by email.")
        return input("  Enter MFA code: ").strip()
    return prompt

# ── Config ─────────────────────────────────────────────────────────────────────
# GARMIN_EMAIL/GARMIN_PASSWORD are read inside main(), after load_credentials().
WORKOUT_API    = os.environ.get('WORKOUT_API', 'http://localhost:3000')
ACTIVITY_LIMIT = int(os.environ.get('GARMIN_LIMIT', '30'))
# Page size when --limit asks for more than one page. Garmin documents no upper
# bound for get_activities' count, so one huge request risks a silent
# truncation; paging also gives the only end-of-history signal there is, a
# short page.
ACTIVITY_PAGE_SIZE = 100
# Trailing days of sleep score re-requested every run (see fetch_sleep_window).
# --sleep-days overrides it for a one-off deep backfill.
SLEEP_LOOKBACK_DAYS = int(os.environ.get('GARMIN_SLEEP_DAYS', '7'))
# The same for daily recovery data, which Garmin finalizes even later (HRV,
# readiness) or revises into the next morning (Body Battery). Its own constant
# because a day costs THREE calls here against sleep's one (the recovery
# summary), plus training status for the first TRAINING_STATUS_DAYS. Story:
# DECISIONS.md#garmin-recovery-signals, DECISIONS.md#vo2-max-and-training-load.
RECOVERY_LOOKBACK_DAYS = int(os.environ.get('GARMIN_RECOVERY_DAYS', '7'))
# How many of those days also ask get_training_status (the fourth call). Its
# blocks are dated by Garmin, and a day's load is final once the day is over,
# so today and yesterday are all a daily run needs: yesterday's final value
# lands on today's run, today's on tomorrow's. The other days would only
# re-send values already stored. scripts/backfill_garmin_recovery.py
# --training-only covers anything older. Story: DECISIONS.md#vo2-max-and-training-load.
TRAINING_STATUS_DAYS = int(os.environ.get('GARMIN_TRAINING_STATUS_DAYS', '2'))
# Seconds between two DAYS of the sleep and recovery windows. Without it the
# ~30 per-day requests go out in a few seconds, back to back, which reads as
# scraping; every other loop here (routes, the backfills) already paces itself.
DAY_SLEEP_S = float(os.environ.get('GARMIN_DAY_SLEEP', '1.0'))
# A BROWSER-STARTED SYNC CATCHES UP; THE CRON HEALS. server.js passes the date
# of the user's last successful sync (--catch-up-since), and the sleep and
# recovery windows then reach back only to it: everything older was asked about
# then, and the 9am cron's full window re-asks for anything Garmin finalized
# late. Never fewer than this many days, because yesterday's final values (its
# load, a late sleep score) only exist the morning after. Each day left out is
# four requests and a paced second the person pressing Sync doesn't wait for.
# Story: DECISIONS.md#manual-sync-catch-up.
CATCH_UP_MIN_DAYS = 2

# Missing routes one ordinary sync fills in, from the server's work queue
# (GET /api/activity-routes?wanted=1). Small on purpose: an uncapped queue is a
# request burst that gets rate limited. A backlog drains over a few nights, or
# at once via scripts/backfill_garmin_routes.py. Story: DECISIONS.md#route-heatmap.
ROUTE_BATCH = int(os.environ.get('GARMIN_ROUTE_BATCH', '25'))
# Seconds between two activity-detail requests. Routes are the only per-ACTIVITY
# call this script makes -- everything else is per-day or one page for the lot --
# so this is the one loop that can look like scraping if it runs flat out.
ROUTE_SLEEP_S = float(os.environ.get('GARMIN_ROUTE_SLEEP', '1.0'))
# What to ask Garmin for. maxpoly caps the points it returns; 4000 is its own
# default and is far more than survives simplification, so the shape is never
# what limits quality here.
MAX_POLY_POINTS = 4000
# The chart metrics (elevation, heart rate) come in the SAME request, so asking
# for them costs no extra call -- only a bigger answer. Matched to the GPS
# samples by time (metric_series), so the two caps are kept equal.
MAX_CHART_POINTS = MAX_POLY_POINTS
# Douglas-Peucker tolerance. Every kept point costs ~6 characters in the
# database and in every retained backup copy of it, so this knob decides
# whether routes take a few hundred KB or a few MB. At 8 m a road run keeps its
# corners and loses the jitter of standing still at a light.
SIMPLIFY_TOLERANCE_M = float(os.environ.get('GARMIN_ROUTE_TOLERANCE_M', '8'))
# The same idea in TIME, for the per-point times the map's segments are timed
# from. Between two kept points the map assumes an even pace, so a point is
# also kept wherever that assumption would put its time off by more than this.
# A stop at a light, a hill walked: the points that time them survive.
SIMPLIFY_TOLERANCE_S = float(os.environ.get('GARMIN_ROUTE_TOLERANCE_S', '3'))
# And again for elevation and heart rate, which the outing summary draws
# straight between kept points. A long straight road at an even pace keeps
# only its ends by distance and time alone, so a hill along it would be drawn
# flat. A point is also kept where the line would put either series off by more
# than this. Above an altimeter's metre of noise and a wrist sensor's few beats,
# so neither keeps points for jitter. Story: DECISIONS.md#outing-summary.
SIMPLIFY_TOLERANCE_ELEV_M = 3.0
SIMPLIFY_TOLERANCE_HR = 8.0
# A PAUSE YOU KEPT MOVING THROUGH: two consecutive samples at least this far
# apart in time AND in space, within the time the watch was actually paused.
# See pause_indices.
PAUSE_GAP_S = 60
PAUSE_HOP_M = 50
PAUSE_BUDGET_SLACK_S = 5

# ── Garmin type → app type mapping ─────────────────────────────────────────────
TYPE_MAP = {
    'running':           'run',
    'trail_running':     'run',
    'treadmill_running': 'run',
    'cycling':           'bike',
    'road_biking':       'bike',
    'mountain_biking':   'bike',
    'indoor_cycling':    'bike',
    'virtual_ride':      'bike',
    'strength_training': 'lift',
    'rock_climbing':     'climb',
    'bouldering':        'climb',
    # Mapped rather than left raw: unmapped it becomes its own app type, with
    # the generic cardio fields (a pace for climbing), climbing stats split
    # across two types, and — outside MANUAL_WINS_TYPES — no dedup against a
    # session already logged by hand.
    'indoor_climbing':   'climb',
    'hiking':            'hike',
    'walking':           'walk',
    'casual_walking':    'walk',
    'fitness_walking':   'walk',
    'indoor_walking':    'walk',
}

# ── Helpers ────────────────────────────────────────────────────────────────────
def fmt_duration(seconds):
    """Seconds -> 'H:MM:SS' or 'M:SS'."""
    seconds = int(seconds or 0)
    h, rem  = divmod(seconds, 3600)
    m, s    = divmod(rem, 60)
    return f"{h}:{m:02}:{s:02}" if h else f"{m}:{s:02}"

def fmt_pace(distance_m, duration_s):
    """Metres + seconds -> 'M:SS/km' pace string. Returns '' if inputs are missing."""
    if not distance_m or not duration_s or distance_m < 100:
        return ''
    km          = distance_m / 1000
    # Round the TOTAL seconds, then split, or a 5:59.8 pace prints as "5:60".
    secs_per_km = int(round(duration_s / km))
    m, s = divmod(secs_per_km, 60)
    return f"{m}:{s:02} /km"

def parse_start_time(activity):
    """
    Returns (timestamp_ms, date_str), from two DIFFERENT Garmin fields on
    purpose:

      timestamp_ms — a TRUE UTC epoch, from `beginTimestamp` (already epoch
                     ms) or, failing that, `startTimeGMT`.
      date_str     — the LOCAL calendar day, ISO YYYY-MM-DD, from
                     `startTimeLocal`. Must match index.html's dateKey()
                     character for character, or a synced activity lands on
                     a day the UI never looks up.

    The frontend day-buckets by `timestamp` but displays `date`, so the
    timestamp must be a real instant and the date the day you trained. Never
    derive one from the other, and never convert startTimeLocal through
    zoneinfo: travel has put the recorded offsets anywhere from +4h to +8h, so
    no single home zone is safe.

    A change here never repairs stored rows (the sync skips known
    external_ids); scripts/backfill_garmin_timestamps.py does.
    Story: DECISIONS.md#garmin-timestamps.
    """
    dt_local = datetime.strptime(activity['startTimeLocal'], '%Y-%m-%d %H:%M:%S')
    date_str = dt_local.date().isoformat()

    begin_ms = activity.get('beginTimestamp')
    if isinstance(begin_ms, (int, float)) and not isinstance(begin_ms, bool) and begin_ms > 0:
        return int(begin_ms), date_str

    gmt = activity.get('startTimeGMT')
    if gmt:
        dt_gmt = datetime.strptime(gmt, '%Y-%m-%d %H:%M:%S')
        return int(dt_gmt.replace(tzinfo=timezone.utc).timestamp() * 1000), date_str

    # Neither UTC field: degrade to local-as-UTC rather than drop the activity.
    # Not expected to run; it exists so an API change degrades, not crashes.
    return int(dt_local.replace(tzinfo=timezone.utc).timestamp() * 1000), date_str

def transform(activity):
    """
    One Garmin activity -> a flat history record for POST /api/garmin/sync.
    Every type syncs: TYPE_MAP only renames common ones, and anything else uses
    Garmin's raw typeKey as the app type with the generic cardio fields. The
    server registers a first-seen type (db.ensureActivityType) and prompts for
    an emoji. None only when Garmin sent no typeKey.
    """
    type_key = activity.get('activityType', {}).get('typeKey', '')
    app_type = TYPE_MAP.get(type_key) or type_key
    if not app_type:
        return None

    timestamp_ms, date_str = parse_start_time(activity)

    distance_m = activity.get('distance') or 0
    duration_s = activity.get('duration') or 0
    avg_hr     = activity.get('averageHR')
    elev_gain  = activity.get('elevationGain')
    calories   = activity.get('calories')

    record = {
        'timestamp':   timestamp_ms,
        'date':        date_str,
        'type':        app_type,
        'name':        activity.get('activityName', ''),
        'external_id': str(activity['activityId']),
        'source':      'garmin',
    }

    if app_type == 'lift':
        # Garmin doesn't know which routine — leave lift blank so you can
        # tag it manually from the History view if needed.
        record['lift'] = None
        if calories is not None:
            record['calories'] = round(calories)
        if duration_s:
            record['duration'] = fmt_duration(duration_s)

    elif app_type == 'climb':
        if duration_s:
            record['duration'] = fmt_duration(duration_s)

    else:
        # Every other type, curated or newly seen, gets the same generic
        # fields; one that doesn't apply comes back empty (fmt_pace's own
        # guard). Bike gets no pace: cyclists think in speed.
        record['distance'] = round(distance_m / 1000, 2)
        record['duration'] = fmt_duration(duration_s)
        if app_type != 'bike':
            record['pace'] = fmt_pace(distance_m, duration_s)
        if elev_gain is not None:
            record['elevationGain'] = round(elev_gain)
        if avg_hr is not None:
            record['avgHR'] = round(avg_hr)
        if calories is not None:
            record['calories'] = round(calories)

    rpe = rpe_from_activity(activity)
    if rpe is not None:
        record['rpe'] = rpe

    # Lift and climb carry no distance, so no split can mean anything there.
    efforts = best_efforts_from_activity(activity)
    if efforts and app_type not in ('lift', 'climb'):
        record['bestEfforts'] = efforts

    record.update(training_effect_from_activity(activity))

    return record


# Garmin's own measure of what one activity cost you, from the activity-LIST
# payload -- free, the same reasoning as rpe_from_activity below:
#   trainingLoad         activityTrainingLoad, Garmin's EPOC-based load. The
#                        per-session unit its 7-day acute load (garmin_daily's
#                        load_acute) is the sum of, so the two share a scale.
#   aerobicTE/anaerobicTE  0.0-5.0 training effect, one decimal.
#   trainingEffectLabel  Garmin's word for the session's main benefit
#                        (TEMPO, VO2MAX, RECOVERY, ...). UNKNOWN is what it says
#                        for a session with no benefit to name, so it is
#                        dropped rather than stored as if it were a label.
# Every key is independently absent -- an activity recorded without heart rate
# has none of them -- and a missing one is omitted, never zeroed, so the
# server's refresh arm cannot overwrite a stored value with nothing.
# Story: DECISIONS.md#vo2-max-and-training-load.
def training_effect_from_activity(activity):
    out = {}

    def num(key, lo, hi):
        v = activity.get(key)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return None
        return round(float(v), 1) if lo <= v <= hi else None

    load = num('activityTrainingLoad', 0, 5000)
    if load is not None:
        out['trainingLoad'] = load
    aerobic = num('aerobicTrainingEffect', 0, 5)
    if aerobic is not None:
        out['aerobicTE'] = aerobic
    anaerobic = num('anaerobicTrainingEffect', 0, 5)
    if anaerobic is not None:
        out['anaerobicTE'] = anaerobic
    label = activity.get('trainingEffectLabel')
    if isinstance(label, str) and label and label != 'UNKNOWN':
        out['trainingEffectLabel'] = label
    return out


# The effort rating you give on the watch after saving an activity, on the
# app's 1-10 RPE scale -- or None when you skipped the prompt. Garmin stores it
# as 10-100 in steps of 10 (`directWorkoutRpe`). Read from the activity-LIST
# payload only, never by fetching each activity's summary: that would be one
# extra request per activity on every sync, the shape that already hits rate
# limits in the route fetch. A missing, zero or non-numeric value is None, so
# the record carries no `rpe` key at all and the server's dedup merge keeps a
# hand-entered one (see syncActivitiesForUser). Story:
# DECISIONS.md#garmin-first-cardio-log.
def rpe_from_activity(activity):
    raw = activity.get('directWorkoutRpe')
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw <= 0:
        return None
    return max(1, min(10, int(round(raw / 10))))

# Garmin's fastest split at each standard distance INSIDE one activity -- the
# measured times behind its own PR screen ("5K 24:39") -- as {meters: seconds},
# e.g. {'1000': 290.8, '1609': 471.6, '5000': 1478.9}. Read from the
# activity-LIST payload's fastestSplit_<meters> keys, so it costs no request of
# its own, the same reasoning as rpe_from_activity above. Garmin only sends a
# key for a distance the activity actually covered, which is the whole point:
# the app ranks race-time records on these before it estimates anything.
# Keys are strings because they become JSON object keys; None when there are
# none, so the record carries no `bestEfforts` key at all.
# Story: DECISIONS.md#measured-race-times.
_FASTEST_SPLIT_KEY = re.compile(r'^fastestSplit_(\d+)$')

def best_efforts_from_activity(activity):
    out = {}
    for key, value in activity.items():
        m = _FASTEST_SPLIT_KEY.match(key)
        if not m or isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(value) or value <= 0:
            continue
        out[m.group(1)] = round(float(value), 1)
    return out or None

# One night's sleep: the score, for comparison against the app's own morning
# check-in rating, plus three overnight readings the readiness verdict uses as
# illness signals: respiration, time asleep and skin temperature. All five come
# from this ONE call. Returns None (rather than raising) if Garmin has none of
# them for that day — e.g. the watch hasn't synced to Garmin Connect since
# waking — and any one may be absent on its own.
#
# WHERE EACH FIELD LIVES is pinned by testing/garmin_sleep_fixture.json, a real
# payload: respiration and sleep time inside dailySleepDTO, skin temperature at
# the TOP level beside it. Skin temperature is read only when Garmin says
# skinTempDataExists: the deviation is signed, so a sentinel like -1 would pass
# any range check and be stored as a real cold night.
#
# `day` is a parameter, not datetime.now(), because a score Garmin hasn't
# finalized yet has to be asked for again LATER — see fetch_sleep_window below.
def fetch_sleep_summary(api, day):
    try:
        data = api.get_sleep_data(day.isoformat()) or {}
        dto = data.get('dailySleepDTO') or {}
        overall = (dto.get('sleepScores') or {}).get('overall') or {}
        score, qualifier = overall.get('value'), overall.get('qualifierKey')
        sleep_s = dto.get('sleepTimeSeconds')
        readings = {
            'resp_rate': dto.get('averageRespirationValue'),
            # Garmin reports 0 for a night it never saw; server.js's lower
            # bound of 1 minute drops that rather than storing no sleep.
            'sleep_minutes': round(sleep_s / 60) if isinstance(sleep_s, (int, float)) else None,
            'skin_temp_dev': data.get('avgSkinTempDeviationC') if data.get('skinTempDataExists') else None,
        }
        if score is None and qualifier is None and all(v is None for v in readings.values()):
            return None
        # calendarDate is the wake-up day this sleep session belongs to —
        # trust it over the requested day in case of any midnight-boundary
        # edge cases.
        cal_date = dto.get('calendarDate')
        d = datetime.strptime(cal_date, '%Y-%m-%d').date() if cal_date else day
        # Same ISO YYYY-MM-DD key shape as parse_start_time above — see the
        # note there, and index.html's dateKey().
        return {'date': d.isoformat(), 'score': score, 'qualifier': qualifier, **readings}
    except GarminConnectTooManyRequestsError:
        # Deliberately NOT swallowed by the except below — fetch_sleep_window
        # has to see this to stop the loop instead of hammering Garmin once
        # per remaining day. Story: DECISIONS.md#sleep-backfill-window.
        raise
    except Exception as e:
        print(f"  Sleep data unavailable for {day.isoformat()}: {e}")
        return None

# How many trailing days a browser-started sync asks about: back to `since`
# (the ISO date of the last successful sync) inclusive, at least
# CATCH_UP_MIN_DAYS, never more than the run's own window `full_days`. No date,
# or one that doesn't parse, is a first sync: the whole window.
def catch_up_days(since, full_days, today=None):
    if full_days <= 0 or not since:
        return full_days
    try:
        since_day = datetime.strptime(since, '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return full_days
    today = today or datetime.now().date()
    span = (today - since_day).days + 1
    return max(min(span, full_days), min(CATCH_UP_MIN_DAYS, full_days))


# The last `days` days of sleep scores, newest first — NOT just last night.
# Garmin often finalizes a score after the morning cron has run, so re-asking
# over a trailing window lets a late score self-heal on the next run.
#
# Unconditional: it does not first ask the server which dates are missing.
# Re-fetching a stored day is a no-op, and not coupling this script to a read
# endpoint is worth the few extra requests.
#
# De-duplicated on the RETURNED date: two requested days can resolve to one
# session via calendarDate, and two entries for one date would let whichever
# landed last win. Story: DECISIONS.md#sleep-backfill-window.
def fetch_sleep_window(api, days, today=None, sleep_between=None):
    today = today or datetime.now().date()
    pause = DAY_SLEEP_S if sleep_between is None else sleep_between
    out, seen = [], set()
    try:
        for i in range(days):
            if i and pause:
                time.sleep(pause)
            progress('sleep', i + 1, days)
            summary = fetch_sleep_summary(api, today - timedelta(days=i))
            if summary and summary['date'] not in seen:
                seen.add(summary['date'])
                out.append(summary)
    except GarminConnectTooManyRequestsError:
        _note_rate_limit()
        print(f"  Garmin rate-limited the sleep lookback after {len(out)} day(s) "
              f"— keeping what came back, the next run will pick up the rest.")
    return out


# One endpoint's worth of a day's recovery data, isolated so ONE failing
# endpoint cannot cost the others. A day's recovery comes from three endpoints
# that fail independently all the time — readiness is device-gated, HRV needs
# the watch worn overnight — and one try/except around all three would throw
# away a good resting HR because readiness was missing.
#
# A rate limit is re-raised, as in fetch_sleep_summary, so
# fetch_recovery_window can stop the whole walk.
def _recovery_call(label, day, fn):
    try:
        return fn() or {}
    except GarminConnectTooManyRequestsError:
        raise
    except Exception as e:
        print(f"  {label} unavailable for {day.isoformat()}: {e}")
        return {}


def _first_present(d, *keys):
    """First key that carries a usable value. Garmin renames these between
    device generations and library versions, so each metric names every
    spelling we know rather than assuming one.

    Every key listed for a metric must be a different SPELLING of the SAME
    measurement. See the caller: a fallback onto a nearby-but-different
    quantity is worse than a null, because nothing downstream can tell the
    two apart."""
    for k in keys:
        v = d.get(k)
        if v is not None and v != '':
            return v
    return None


# Whether one of fetch_recovery_summary's values is a measurement rather than
# Garmin's "not measured" placeholder. The floors are server.js's own lower
# bounds for these fields (POST /api/garmin/sync), so a value this counts is
# one the server keeps, with one stricter case: 0 steps is the step count of
# a day the watch was never worn, so it is not evidence the day was measured.
_READING_FLOOR = {'resting_hr': 20, 'hrv_overnight': 1, 'steps': 1}

def _is_reading(key, v):
    if isinstance(v, str):
        return bool(v)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return v >= _READING_FLOOR.get(key, 0)


# A day's resting HR, overnight HRV, steps, Body Battery and training
# readiness. Returns None when Garmin had NOTHING for the day, so that a day
# the watch never saw creates no row at all — the same contract
# fetch_sleep_summary has, and what keeps garmin_daily free of empty rows.
#
# Every field is optional and independently absent. Nothing here substitutes a
# 0 for a missing measurement: a null means "not synced", and the table's
# readers depend on that distinction.
def fetch_recovery_summary(api, day):
    iso = day.isoformat()
    stats = _recovery_call('Daily summary', day, lambda: api.get_stats(iso))
    hrv = _recovery_call('HRV', day, lambda: api.get_hrv_data(iso))
    readiness = _recovery_call('Training readiness', day, lambda: api.get_training_readiness(iso))

    # get_training_readiness answers with a single-element LIST on most
    # devices and a bare dict on some; normalize before reading it.
    if isinstance(readiness, list):
        readiness = readiness[0] if readiness else {}
    if not isinstance(readiness, dict):
        readiness = {}

    hrv_summary = hrv.get('hrvSummary') if isinstance(hrv, dict) else None
    hrv_summary = hrv_summary if isinstance(hrv_summary, dict) else {}

    # NO CROSS-QUANTITY FALLBACKS: every alias here is another spelling of the
    # same number (totalSteps/steps). A nearby quantity is never a fallback —
    # not weeklyAvg for overnight HRV, not bodyBatteryMostRecentValue for the
    # day's peak (for a re-requested day it is an end-of-day trough). Once
    # stored, a substituted number is indistinguishable from a measured one: it
    # enters the 60-day median and the 7-day rolling mean and pulls both toward
    # normal, damping exactly the departures this data exists to show.
    out = {
        'resting_hr':        _first_present(stats, 'restingHeartRate'),
        'steps':             _first_present(stats, 'totalSteps', 'steps'),
        'body_battery_high': _first_present(stats, 'bodyBatteryHighestValue'),
        'body_battery_low':  _first_present(stats, 'bodyBatteryLowestValue'),
        'hrv_overnight':     _first_present(hrv_summary, 'lastNightAvg'),
        'hrv_status':        _first_present(hrv_summary, 'status'),
        'readiness_score':   _first_present(readiness, 'score'),
        'readiness_level':   _first_present(readiness, 'level'),
        # Garmin's all-day average stress (0-100), already in `stats`, so no
        # extra call. ONLY the average: it has a stable personal baseline the
        # way resting HR does, which every reader of this table assumes;
        # maxStressLevel and the duration buckets in the same response answer
        # "how hard was today" instead. Story: DECISIONS.md#stress-markers.
        #
        # Garmin answers -1 (sometimes -2) for an unmeasured day, which
        # _first_present passes through. server.js's num(v, 0, 100) bound drops
        # it and must keep doing so: a stored -1 reads as the calmest day on
        # record and drags every baseline after it.
        'stress_avg':        _first_present(stats, 'averageStressLevel'),
    }
    # Garmin can fill in a resting-only calorie estimate for a day the watch
    # never saw. So calories alone don't count as "Garmin had something": they
    # never create a row by themselves, and a day with no other reading keeps
    # the None contract above. Story: DECISIONS.md#daily-calories.
    #
    # Nor do the placeholders an unworn day carries, which is why this asks
    # _is_reading and not "is anything None": stress -1 and 0 steps would
    # otherwise pass here, the server would drop the -1, and the day would be
    # stored as calories plus nothing, counted as measured.
    if not any(_is_reading(k, v) for k, v in out.items()):
        return None
    out['calories_total'] = _first_present(stats, 'totalKilocalories')
    out['calories_active'] = _first_present(stats, 'activeKilocalories')

    # Trust Garmin's own calendarDate over the requested day, for the same
    # midnight-boundary reason fetch_sleep_summary does, and key it in the ISO
    # shape index.html's dateKey() defines.
    cal_date = stats.get('calendarDate')
    d = datetime.strptime(cal_date, '%Y-%m-%d').date() if cal_date else day
    out['date'] = d.isoformat()
    return out


# The recovery counterpart of fetch_sleep_window, and deliberately a separate
# walk rather than a second value returned from that one: the two windows are
# independently sized (--sleep-days vs --recovery-days), and either can be set
# to 0 without disturbing the other.
#
# Training status is asked only for the first TRAINING_STATUS_DAYS days; see
# that constant.
def fetch_recovery_window(api, days, today=None, sleep_between=None,
                          training_days=None):
    today = today or datetime.now().date()
    pause = DAY_SLEEP_S if sleep_between is None else sleep_between
    training_days = TRAINING_STATUS_DAYS if training_days is None else training_days
    fragments = []
    try:
        for i in range(days):
            if i and pause:
                time.sleep(pause)
            progress('recovery', i + 1, days)
            day = today - timedelta(days=i)
            summary = fetch_recovery_summary(api, day)
            if summary:
                fragments.append(summary)
            if i < training_days:
                fragments.extend(fetch_training_status(api, day))
    except GarminConnectTooManyRequestsError:
        _note_rate_limit()
        print(f"  Garmin rate-limited the recovery lookback after {len(fragments)} fragment(s) "
              f"— keeping what came back, the next run will pick up the rest.")
    return merge_daily_fragments(fragments)


# Folds per-date fragments into one entry per date, in first-seen order. The
# recovery summary and fetch_training_status's three fragments each carry their
# OWN date, which need not be the day that was asked about, so two requests can
# each contribute part of one date's row. The first non-null value for a key
# wins: the window walks newest first, and a later fragment for the same date
# is the same measurement re-reported, not a newer one. A None never becomes a
# key at all, which is what lets the server's conditional build leave a stored
# value alone.
def merge_daily_fragments(fragments):
    merged = {}
    for frag in fragments:
        entry = merged.setdefault(frag['date'], {'date': frag['date']})
        for k, v in frag.items():
            if v is not None and k not in entry:
                entry[k] = v
    return list(merged.values())


def _iso_date(s):
    try:
        return datetime.strptime(s, '%Y-%m-%d').date().isoformat()
    except (TypeError, ValueError):
        return None


# Garmin keys training status and load balance by DEVICE id, because a person
# can own several watches. The one it marks primaryTrainingDevice is the one
# its own app shows; with none marked, the first is all there is.
def _primary_device_entry(device_map):
    if not isinstance(device_map, dict):
        return {}
    entries = [v for v in device_map.values() if isinstance(v, dict)]
    for e in entries:
        if e.get('primaryTrainingDevice'):
            return e
    return entries[0] if entries else {}


# 'PRODUCTIVE_2' -> 'PRODUCTIVE'. The numeric suffix picks which sentence of
# advice Garmin's own app prints under the word; the word is the status.
_FEEDBACK_SUFFIX = re.compile(r'_\d+$')

def _status_word(phrase):
    if not isinstance(phrase, str) or not phrase:
        return None
    return _FEEDBACK_SUFFIX.sub('', phrase)


# VO2 max and training load from ONE call, get_training_status, as a LIST of
# fragments {date, ...fields}, each dated by Garmin's own calendarDate for that
# block -- never by the day that was asked about.
#
# That dating is the point. Every block here is "most recent as of the day
# requested", so asking about Tuesday can hand back a VO2 max last updated on
# Saturday. Stored under Tuesday it would read as a fresh measurement, and the
# trailing window would stamp one reading onto seven days -- a trend line
# made of a single number, looking steadier than the evidence. Keyed on its
# own date, re-asking only rewrites the value where it already is.
#
# Three blocks, all optional and failing independently:
#   mostRecentVO2Max.generic      running/walking VO2 max. vo2MaxPreciseValue
#                                 (49.6) and vo2MaxValue (50.0) are the same
#                                 quantity at two roundings, so the fallback is
#                                 an alias, not a substitute (_first_present).
#   latestTrainingStatusData      7-day acute load, chronic load, and Garmin's
#                                 status word. min/maxTrainingLoadChronic are
#                                 misleadingly named: they are the OPTIMAL
#                                 RANGE FOR THE ACUTE LOAD (0.8x and 1.5x the
#                                 chronic), which Garmin's own load gauge shades.
#   metricsTrainingLoadBalance    the 4-week load split into low aerobic, high
#                                 aerobic and anaerobic, each with Garmin's
#                                 target range -- its "Load Focus" screen.
# Story: DECISIONS.md#vo2-max-and-training-load.
def fetch_training_status(api, day):
    data = _recovery_call('Training status', day, lambda: api.get_training_status(day.isoformat()))
    if not isinstance(data, dict):
        return []
    out = []

    def fragment(date_str, fields):
        d = _iso_date(date_str)
        fields = {k: v for k, v in fields.items() if v is not None}
        if d and fields:
            out.append({'date': d, **fields})

    vo2 = ((data.get('mostRecentVO2Max') or {}).get('generic')) or {}
    fragment(vo2.get('calendarDate'), {
        'vo2max': _first_present(vo2, 'vo2MaxPreciseValue', 'vo2MaxValue'),
    })

    status = _primary_device_entry(
        (data.get('mostRecentTrainingStatus') or {}).get('latestTrainingStatusData'))
    acute = status.get('acuteTrainingLoadDTO') or {}
    fragment(status.get('calendarDate'), {
        'load_acute':       acute.get('dailyTrainingLoadAcute'),
        'load_chronic':     acute.get('dailyTrainingLoadChronic'),
        'load_optimal_min': acute.get('minTrainingLoadChronic'),
        'load_optimal_max': acute.get('maxTrainingLoadChronic'),
        'training_status':  _status_word(status.get('trainingStatusFeedbackPhrase')),
    })

    bal = _primary_device_entry(
        (data.get('mostRecentTrainingLoadBalance') or {}).get('metricsTrainingLoadBalanceDTOMap'))
    fragment(bal.get('calendarDate'), {
        'focus_low_aerobic':      bal.get('monthlyLoadAerobicLow'),
        'focus_high_aerobic':     bal.get('monthlyLoadAerobicHigh'),
        'focus_anaerobic':        bal.get('monthlyLoadAnaerobic'),
        'focus_low_aerobic_min':  bal.get('monthlyLoadAerobicLowTargetMin'),
        'focus_low_aerobic_max':  bal.get('monthlyLoadAerobicLowTargetMax'),
        'focus_high_aerobic_min': bal.get('monthlyLoadAerobicHighTargetMin'),
        'focus_high_aerobic_max': bal.get('monthlyLoadAerobicHighTargetMax'),
        'focus_anaerobic_min':    bal.get('monthlyLoadAnaerobicTargetMin'),
        'focus_anaerobic_max':    bal.get('monthlyLoadAnaerobicTargetMax'),
        'focus_feedback':         _status_word(bal.get('trainingBalanceFeedbackPhrase')),
    })
    return out

# Up to `limit` activities, newest first, in ACTIVITY_PAGE_SIZE pages. The
# ordinary sync asks for one page; paging is for a deep backfill (--limit 2000),
# the only way to reach history from before the app's first sync.
#
# STOPS ON A SHORT PAGE, the only end-of-history signal Garmin gives, so an
# over-large --limit is harmless. `start` advances by what actually came back,
# never by the page size, so a server-side cap below ACTIVITY_PAGE_SIZE neither
# re-reads nor skips.
def fetch_activities(api, limit, page_size=ACTIVITY_PAGE_SIZE):
    if limit <= 0:
        return []
    out = []
    while len(out) < limit:
        want = min(page_size, limit - len(out))
        page = api.get_activities(len(out), want)
        out.extend(page)
        if len(page) < want:
            break
    return out

# One line per activity type, for --dry-run's "what am I about to import".
# Deliberately reports the APP type (post-TYPE_MAP), not Garmin's raw typeKey:
# that's what lands in the history rows and what any newly-seen type will
# prompt to categorize in Settings, so it's the list worth reading before
# committing to it.
def summarize_records(records):
    if not records:
        return 'no supported activities'
    dates = sorted(r['date'] for r in records)
    counts = {}
    for r in records:
        counts[r['type']] = counts.get(r['type'], 0) + 1
    by_type = ', '.join(f"{t} x{n}" for t, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
    return f"{len(records)} activities, {dates[0]} -> {dates[-1]}  |  {by_type}"

# ── GPS routes ─────────────────────────────────────────────
# Everything below is a PURE function except fetch_route and sync_routes, which
# is deliberate: testing/verify_garmin_sync.py can then pin the maths without a
# Garmin account, and testing/route_fixture.json pins encode_polyline against
# the matching decoders in server.js and public/index.html.
# Story: DECISIONS.md#route-heatmap.

EARTH_R_M = 6371008.8


def _haversine_m(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(h)))


# Pulls [(lat, lon, time_ms), ...] out of whatever get_activity_details
# answered with. time_ms is the sample's epoch milliseconds, or None when a
# sample carries none; it is what pause_indices reads.
#
# WITH CHART METRICS (fetch_route asks for them) each sample grows to
# (lat, lon, time_ms, elevation_m, heart_rate), joined by time from
# metric_series -- the polyline's own `altitude` is null on this account's
# watch (probed live). All samples or none get the extra two, so callers can
# test the first. Either may be None where the watch had no reading.
#
# TOLERATES A MISSING geoPolylineDTO AND RETURNS [] RATHER THAN RAISING,
# because "this activity has no GPS" is the normal case for a treadmill run, a
# pool swim or anything logged indoors -- not an error, and not something a
# nightly sync should fail or retry over.
#
# DROPS (0, 0). A dropped fix is reported as null island, and a single one of
# those stretches the activity bounds across the Atlantic, which sends the map
# viewport to the middle of the ocean and reads as missing data rather than as
# one bad point.
def samples_from_details(detail):
    if not isinstance(detail, dict):
        return []
    dto = detail.get('geoPolylineDTO') or {}
    raw = dto.get('polyline') or []
    out = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        lat = p.get('lat', p.get('latitude'))
        lon = p.get('lon', p.get('longitude'))
        if lat is None or lon is None:
            continue
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        t = p.get('time')
        out.append((lat, lon, t if isinstance(t, (int, float)) and not isinstance(t, bool) else None))
    series = metric_series(detail)
    if series and out:
        out = [s + _series_at(series, s[2]) for s in out]
    return out


def points_from_details(detail):
    return [s[:2] for s in samples_from_details(detail)]


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# The details call's chart metrics as [(time_ms, elevation_m, heart_rate), ...]
# sorted by time, or [] when it carried none. Columns are found by KEY in
# metricDescriptors, never by position: the order differs between activities
# and devices. A series this account doesn't record is None throughout, and a
# series that is None on every row makes the whole answer [].
def metric_series(detail):
    if not isinstance(detail, dict):
        return []
    idx = {}
    for d in detail.get('metricDescriptors') or []:
        if isinstance(d, dict) and isinstance(d.get('metricsIndex'), int):
            idx[d.get('key')] = d['metricsIndex']
    ti = idx.get('directTimestamp')
    ei, hi = idx.get('directElevation'), idx.get('directHeartRate')
    if ti is None or (ei is None and hi is None):
        return []
    out = []
    for row in detail.get('activityDetailMetrics') or []:
        m = row.get('metrics') if isinstance(row, dict) else None
        if not isinstance(m, list):
            continue
        get = lambda i: _num(m[i]) if i is not None and i < len(m) else None
        t = get(ti)
        if t is None:
            continue
        out.append((t, get(ei), get(hi)))
    if not any(e is not None or h is not None for _, e, h in out):
        return []
    out.sort(key=lambda r: r[0])
    return out


# Farther than this from any metric row and a sample gets no reading rather
# than a borrowed one from another part of the outing.
SERIES_MATCH_MS = 15_000


# (elevation, heart_rate) of the metric row nearest time_ms, each None when
# there is none within SERIES_MATCH_MS or the row lacks it.
def _series_at(series, time_ms):
    if time_ms is None:
        return (None, None)
    lo, hi = 0, len(series) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if series[mid][0] <= time_ms:
            lo = mid
        else:
            hi = mid
    best = min((series[lo], series[hi]), key=lambda r: abs(r[0] - time_ms))
    if abs(best[0] - time_ms) > SERIES_MATCH_MS:
        return (None, None)
    return (best[1], best[2])


# GPX times are ISO 8601, usually with a trailing Z that fromisoformat only
# accepts from Python 3.11. None for anything unreadable -- a missing time
# costs pause detection for that sample, never the track.
def _gpx_time_ms(el):
    for child in el:
        if child.tag.endswith('time') and child.text:
            try:
                dt = datetime.fromisoformat(child.text.strip().replace('Z', '+00:00'))
            except ValueError:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
    return None


def _gpx_float(el, suffix):
    for child in el.iter():
        if child is not el and child.tag.endswith(suffix) and child.text:
            try:
                return float(child.text.strip())
            except ValueError:
                return None
    return None


# The fallback source, used only when an account or a library version does not
# answer with a geoPolylineDTO. Same contract: [] rather than an exception.
# Elevation (<ele>) and heart rate (Garmin's TrackPointExtension <hr>) ride
# along as samples_from_details' extra two, under the same all-or-none rule.
def samples_from_gpx(data):
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    out = []
    for el in root.iter():
        if not el.tag.endswith('trkpt'):
            continue
        try:
            lat = float(el.attrib['lat'])
            lon = float(el.attrib['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        out.append((lat, lon, _gpx_time_ms(el), _gpx_float(el, 'ele'), _gpx_float(el, 'hr')))
    if not any(s[3] is not None or s[4] is not None for s in out):
        out = [s[:3] for s in out]
    return out


def points_from_gpx(data):
    return [s[:2] for s in samples_from_gpx(data)]


# A PAUSE YOU KEPT MOVING THROUGH. Stop the watch, walk somewhere, press Save:
# the track joins the sample before the stop to the one at the save with a
# straight line across whatever lies between. Returns the indices i where
# samples[i] -> samples[i+1] is such a jump, or None when paused_s is unknown.
#
# Garmin does not mark these (timerStart/timerStop are false on every sample),
# so the pause is read in two steps:
#
#   1. CANDIDATES: consecutive samples at least PAUSE_GAP_S apart in time AND
#      PAUSE_HOP_M apart in space. Time alone would take a long wait at a
#      light; distance alone a fast descent between two sparse samples.
#   2. ONLY AS MUCH AS THE WATCH WAS ACTUALLY PAUSED. paused_s is elapsed time
#      minus timer time (fetch_paused_s); candidates are taken longest gap
#      first while that budget covers them. Without this, a minute with no
#      sample while the timer RAN would be cut too.
#
# PAUSE_BUDGET_SLACK_S absorbs the samples' one-second resolution and is
# granted PER CUT, since every gap carries its own sampling overhead; one
# slack for the whole activity lets several real jumps outrun it.
#
# NO TIMES AT ALL IS None, NOT []: an untimed track (possible via GPX) cannot
# be checked, and [] would store it as "checked, none", never re-queued. A
# paused_s within the slack needs no times, so that one is still [].
#
# Known blind spot: a timer-running recording gap in an activity that ALSO has
# a long stop whose budget covers it; the cost is a short gap in one line. A
# GPS dropout with the timer running stays drawn — the budget does not cover
# it, and the ground was covered.
# Story: DECISIONS.md#a-pause-you-kept-moving-through-is-not-drawn.
def pause_indices(samples, paused_s, gap_s=PAUSE_GAP_S, hop_m=PAUSE_HOP_M):
    if paused_s is None:
        return None
    if paused_s > PAUSE_BUDGET_SLACK_S and not any(len(s) > 2 and s[2] is not None for s in samples):
        return None
    candidates = []
    for i in range(len(samples) - 1):
        a, b = samples[i], samples[i + 1]
        ta, tb = a[2] if len(a) > 2 else None, b[2] if len(b) > 2 else None
        if ta is None or tb is None:
            continue
        dt = (tb - ta) / 1000.0
        if dt >= gap_s and _haversine_m(a[:2], b[:2]) >= hop_m:
            candidates.append((dt, i))
    out, spent = [], 0.0
    for dt, i in sorted(candidates, reverse=True):
        if spent + dt > paused_s + PAUSE_BUDGET_SLACK_S * (len(out) + 1):
            continue
        out.append(i)
        spent += dt
    return sorted(out)


# How long the watch was paused, in seconds: elapsed time minus timer time,
# from the activity's summary. ONE EXTRA REQUEST PER ROUTE, and the only
# place this number exists -- the details call carries neither duration.
#
# None when the summary is missing or unreadable, which makes the route
# UNCHECKED (breaks NULL) rather than guessed: it is stored, drawn whole, and
# asked for again on a later sync. A rate limit is re-raised, because both
# callers stop their loop on it.
def fetch_paused_s(api, activity_id):
    try:
        summary = (api.get_activity(activity_id) or {}).get('summaryDTO') or {}
    except GarminConnectTooManyRequestsError:
        raise
    except Exception as e:
        print(f"    {activity_id}: no activity summary ({e}); pauses left unchecked")
        return None
    elapsed, timer = summary.get('elapsedDuration'), summary.get('duration')
    if not isinstance(elapsed, (int, float)) or not isinstance(timer, (int, float)):
        return None
    return max(0.0, float(elapsed) - float(timer))


# One activity's samples -> (points, breaks, times), ready to store: the
# simplified track, the indices i where points[i] -> points[i+1] is a pause
# jump the map must not draw, and each kept point's time.
#
# breaks is None -- stored as NULL, "unchecked" -- when paused_s is, and the
# track is then simplified whole.
#
# times is whole SECONDS since the first sample, one per kept point, which is
# what the map's segments are timed from. [] -- stored as "checked, none" --
# when any sample has no time (possible via GPX): the map then has nothing to
# time, and a NULL would re-queue the route every night for ever. With times,
# simplification is time-aware too (SIMPLIFY_TOLERANCE_S).
#
# EACH STRETCH BETWEEN PAUSES IS SIMPLIFIED ON ITS OWN, so both ends of every
# jump survive by construction. Simplifying the whole track first and mapping
# the breaks across afterwards would let Douglas-Peucker drop a jump's
# endpoint -- the jump is exactly the kind of straight line it removes points
# from -- and the break would then point at the wrong segment.
#
# The ONE function both the nightly sync and the backfill call, so the two
# cannot drift on what a pause is.
#
# Returns (points, breaks, times, elev, hr). elev (whole metres) and hr (bpm)
# are the KEPT samples' own readings, one per stored point like times, with
# None where the watch had none; both are [] ("checked, none") when the
# samples carry no such series at all. They take part in choosing which points
# are kept (SIMPLIFY_TOLERANCE_ELEV_M / _HR), but they never REMOVE one: every
# point distance or time alone would keep is still kept.
def route_from_samples(samples, paused_s, tolerance_m=SIMPLIFY_TOLERANCE_M,
                       tolerance_s=SIMPLIFY_TOLERANCE_S):
    # A clock that never moves (some Health exports stamp every point of a
    # route with the same instant) is no clock: as untimed, not a track run
    # in 0 s, which would time every segment on it at 0:00.
    timed = bool(samples) and all(len(s) > 2 and s[2] is not None for s in samples) \
        and samples[-1][2] > samples[0][2]
    # Seconds since the first sample, never decreasing: a clock that steps
    # back must not make a later point earlier than the one before it.
    secs = None
    if timed:
        secs, t0, prev = [], samples[0][2], 0
        for s in samples:
            prev = max(prev, int(round((s[2] - t0) / 1000.0)))
            secs.append(prev)
    cuts = pause_indices(samples, paused_s)
    runs = [(0, len(samples) - 1)] if cuts is None else \
        list(zip([0] + [c + 1 for c in cuts], cuts + [len(samples) - 1]))
    profiled = bool(samples) and len(samples[0]) > 4
    rnd = lambda v: None if v is None else int(round(v))
    points, times, breaks, elev, hr = [], [], [], [], []
    for start, end in runs:
        run = [s[:2] for s in samples[start:end + 1]]
        run_secs = secs[start:end + 1] if secs else None
        if points:
            breaks.append(len(points) - 1)
        series = ()
        if profiled:
            seg = samples[start:end + 1]
            series = ((([s[3] for s in seg]), SIMPLIFY_TOLERANCE_ELEV_M), ([s[4] for s in seg], SIMPLIFY_TOLERANCE_HR))
        for i in simplify_indices(run, tolerance_m, run_secs, tolerance_s, series):
            points.append(run[i])
            if run_secs:
                times.append(run_secs[i])
            if profiled:
                elev.append(rnd(samples[start + i][3]))
                hr.append(rnd(samples[start + i][4]))
    if all(v is None for v in elev):
        elev = []
    if all(v is None for v in hr):
        hr = []
    return points, (None if cuts is None else breaks), times, elev, hr


# Length actually travelled: every segment except the pause jumps.
def route_length_m(points, breaks):
    skip = set(breaks or [])
    return sum(_haversine_m(points[i - 1], points[i])
               for i in range(1, len(points)) if (i - 1) not in skip)


def _to_xy(p, lat_cos):
    lat, lon = p
    return (math.radians(lon) * EARTH_R_M * lat_cos, math.radians(lat) * EARTH_R_M)


# Douglas-Peucker, shape-preserving: it keeps the points that carry the corners
# and drops the ones that only repeat a straight line.
#
# NOT a fixed-interval downsample, which is what Garmin's own maxpoly does.
# Uniform sampling at this reduction rounds off the corners -- and a route map
# is mostly corners, because a street grid is. This keeps a square block square
# at a tenth of the points.
#
# ITERATIVE, with an explicit stack, not recursive: the input can be 4000
# points and a pathological track would otherwise hit Python's recursion limit
# in a nightly cron job nobody is watching.
#
# Distances are computed in a local flat projection rather than by haversine
# per candidate. Over one activity the error is far below the 8 m tolerance,
# and it turns an O(n log n) pass with trig in the inner loop into plain
# arithmetic.
def simplify(points, tolerance_m=SIMPLIFY_TOLERANCE_M):
    return [points[i] for i in simplify_indices(points, tolerance_m)]


# The indices simplify() keeps, so a caller can carry anything else aligned
# with the points (their times) across the simplification.
#
# WITH `times` (seconds, one per point) a point is ALSO kept when its time is
# more than tolerance_s off the time an even pace along the chord would give it
# -- the error a segment timed from these points would otherwise carry. Both
# tests are folded into one score, so the recursion still splits at the single
# worst point.
#
# `series` works the same way for any other per-point values: a list of
# (values, tolerance) pairs, a value None where there is no reading (it never
# decides anything, and an end with None skips that series for the chord).
def simplify_indices(points, tolerance_m=SIMPLIFY_TOLERANCE_M, times=None, tolerance_s=SIMPLIFY_TOLERANCE_S,
                     series=()):
    n = len(points)
    if n <= 2 or tolerance_m <= 0:
        return list(range(n))
    use_t = times is not None and tolerance_s > 0
    lat_cos = math.cos(math.radians(points[0][0]))
    xy = [_to_xy(p, lat_cos) for p in points]
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = xy[first]
        bx, by = xy[last]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(first + 1, last):
            px, py = xy[i]
            if seg2 == 0.0:
                t = 0.0
                d = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg2
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            # In tolerances, so 1.0 is the line between dropped and kept. The
            # time the map would give this spot is the chord's, interpolated at
            # the same fraction t it projects to.
            score = d / tolerance_m
            if use_t:
                score = max(score, abs(times[i] - (times[first] + t * (times[last] - times[first]))) / tolerance_s)
            for vals, tol in series:
                a, b, v = vals[first], vals[last], vals[i]
                if a is not None and b is not None and v is not None:
                    score = max(score, abs(v - (a + t * (b - a))) / tol)
            if score > worst:
                worst, worst_i = score, i
        if worst > 1.0:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [i for i in range(n) if keep[i]]


def _encode_signed(v):
    v = ~(v << 1) if v < 0 else (v << 1)
    out = []
    while v >= 0x20:
        out.append(chr((0x20 | (v & 0x1F)) + 63))
        v >>= 5
    out.append(chr(v + 63))
    return ''.join(out)


# The Google encoded polyline algorithm, precision 5 (about 1 m). Roughly six
# characters per point against twenty-two for a JSON lat/lon pair.
#
# ITS DECODERS LIVE IN TWO OTHER LANGUAGES -- server.js validates with one and
# public/index.html draws with another. A mismatched pair does not throw; it
# draws a smooth, plausible, completely wrong line. testing/route_fixture.json
# pins one known track and all three implementations assert against it.
def encode_polyline(points):
    out = []
    lat = lon = 0
    for p in points:
        y = int(round(p[0] * 1e5))
        x = int(round(p[1] * 1e5))
        out.append(_encode_signed(y - lat))
        out.append(_encode_signed(x - lon))
        lat, lon = y, x
    return ''.join(out)


def bounds_of(points):
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return [min(lats), min(lons), max(lats), max(lons)]


def track_length_m(points):
    return sum(_haversine_m(points[i - 1], points[i]) for i in range(1, len(points)))


# One activity's track -> (samples, source): samples as samples_from_details
# gives them, time included, and source 'details', 'gpx', 'none' or 'error'.
# The caller counts sources, because a silent downgrade to the slow path is
# invisible in the routes themselves.
#
# 'NONE' IS A PERMANENT ANSWER, 'ERROR' IS NOT. sync_routes records a 'none'
# so the activity is never asked about again, so it is returned only when
# Garmin ANSWERED the GPX download: a body with no track in it, or a 404. Any
# other failure is 'error' and the activity stays queued. The details call
# alone never decides it, because it is the one that fails for
# argument-shaped reasons (below).
#
# MAXCHART IS 1, NEVER 0: the library rejects 0 as not a positive integer, and
# that ValueError sends every activity down the GPX branch at twice the
# requests with nothing wrong in the data. 1 is the smallest value that keeps
# the response from carrying every metric stream (HR, cadence, power).
#
# A TypeError or ValueError from the kwargs falls back to a bare call, so a
# garminconnect upgrade that renames or re-validates them degrades rather than
# breaks.
#
# A RATE LIMIT IS RE-RAISED FROM EVERY ARM, ahead of each broad except:
# GarminConnectTooManyRequestsError IS an Exception, and swallowing it here
# keeps both callers' loops walking the queue while banned — the burst
# ROUTE_BATCH exists to prevent.
def fetch_route(api, activity_id):
    detail = None
    try:
        detail = api.get_activity_details(activity_id, maxchart=MAX_CHART_POINTS, maxpoly=MAX_POLY_POINTS)
    except GarminConnectTooManyRequestsError:
        raise
    except (TypeError, ValueError) as e:
        print(f"    {activity_id}: detail call rejected its arguments ({e}); retrying bare")
        try:
            detail = api.get_activity_details(activity_id)
        except GarminConnectTooManyRequestsError:
            raise
        except Exception as e2:
            print(f"    detail fetch failed for {activity_id}: {e2}")
    except Exception as e:
        print(f"    detail fetch failed for {activity_id}: {e}")

    pts = samples_from_details(detail)
    if pts:
        return pts, 'details'

    # Only worth a second request when the first came back without geometry.
    try:
        fmt = getattr(Garmin.ActivityDownloadFormat, 'GPX')
        data = api.download_activity(activity_id, dl_fmt=fmt)
        pts = samples_from_gpx(data)
        return pts, ('gpx' if pts else 'none')
    except GarminConnectTooManyRequestsError:
        raise
    except GarminConnectNotFoundError:
        return [], 'none'
    except Exception as e:
        print(f"    GPX fetch failed for {activity_id}: {e}")
        return [], 'error'


# The work queue, asked of the app rather than worked out here: the server
# holds the rows, so it knows which activities have no route yet. That makes
# the nightly sync SELF-HEALING — a failed night, an activity with no GPS the
# first time, or rows that predate routes all drain through the same path with
# no state kept on this side.
def fetch_wanted_routes(user_id, limit):
    resp = requests.get(
        f"{WORKOUT_API}/api/activity-routes",
        params={'wanted': 1, 'limit': limit},
        headers={'X-User-Id': str(user_id)},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# `none` lists activities Garmin answered with no track (fetch_route's 'none'),
# which the server records so its work queue stops offering them.
def post_routes(user_id, routes, none=()):
    resp = requests.post(
        f"{WORKOUT_API}/api/activity-routes",
        json={'routes': routes, 'none': [str(i) for i in none]},
        headers={'Content-Type': 'application/json', 'X-User-Id': str(user_id)},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


# Fetches up to `limit` missing routes and stores them. Returns a one-line
# summary for the sync status message, or '' when there was nothing to do.
#
# FAILS SOFT, ALWAYS. It runs after activities, sleep and recovery are already
# imported, so a Garmin hiccup or an unreachable app here must never turn a
# sync that did its real work into a red badge. The queue is recomputed every
# run, so anything missed is picked up next time.
#
# AN ACTIVITY WITH NO GPS IS RECORDED AS SUCH (post_routes' `none`), so it is
# asked about once and never again. Left queued, every treadmill run, indoor
# ride and pool swim cost two Garmin requests on every sync, forever. Only
# fetch_route's 'none' is recorded, never its 'error': a failed fetch must stay
# queued. Story: DECISIONS.md#route-heatmap.
def sync_routes(api, user_id, limit=ROUTE_BATCH, sleep_between=ROUTE_SLEEP_S, dry_run=False):
    try:
        wanted = fetch_wanted_routes(user_id, limit)
    except Exception as e:
        print(f"Routes: could not ask for the work queue ({e}). Skipping.")
        return ''
    if not wanted:
        return ''

    print(f"Routes: {len(wanted)} activities without one (or without pause breaks, times or elevation yet); fetching...")
    routes, none_ids, failed, fallbacks = [], [], 0, 0
    for i, item in enumerate(wanted):
        activity_id = item.get('external_id')
        if not activity_id:
            continue
        if i and sleep_between:
            time.sleep(sleep_between)
        progress('routes', i + 1, len(wanted))
        try:
            pts, via = fetch_route(api, activity_id)
        except GarminConnectTooManyRequestsError:
            _note_rate_limit()
            print("    rate limited by Garmin - stopping here, the rest will come next run")
            break
        except Exception as e:
            print(f"    {activity_id}: {e}")
            continue
        if via == 'gpx':
            fallbacks += 1
        if via == 'error':
            failed += 1
            continue
        if len(pts) < 2:
            none_ids.append(str(activity_id))
            continue
        try:
            paused_s = fetch_paused_s(api, activity_id)
        except GarminConnectTooManyRequestsError:
            _note_rate_limit()
            print("    rate limited by Garmin - stopping here, the rest will come next run")
            break
        simple, breaks, times, elev, hr = route_from_samples(pts, paused_s)
        routes.append({
            'external_id': str(activity_id),
            'polyline': encode_polyline(simple),
            'breaks': breaks,
            'times': times,
            'elev': elev,
            'hr': hr,
        })
        print(f"    {item.get('date', '?')} {item.get('type', '?')}: "
              f"{len(pts)} -> {len(simple)} points, {route_length_m(simple, breaks) / 1000:.2f} km"
              + (f", {len(breaks)} pause jump(s) cut" if breaks else ''))

    # A permanent downgrade to the GPX path is invisible in the routes, so say
    # it out loud. It means twice the Garmin requests per activity forever.
    if fallbacks:
        print(f"    NOTE: {fallbacks} route(s) came from the GPX fallback, not the details "
              f"call -- that is two requests each. Check the errors above.")
    if dry_run:
        return (f"Routes: would store {len(routes)}"
                + (f", mark {len(none_ids)} without GPS" if none_ids else '') + " (dry run)")
    if not routes and not none_ids:
        return f"Routes: none stored ({failed} failed, retried next run)" if failed else ''
    try:
        result = post_routes(user_id, routes, none_ids)
    except Exception as e:
        print(f"Routes: could not store them ({e}). They will be re-fetched next run.")
        return ''
    for bad in result.get('rejected', []):
        print(f"    REJECTED {bad.get('external_id')}: {bad.get('error')}")
    return (f"Routes: {result.get('stored', 0)} stored"
            + (f", {result.get('missing', 0)} marked without GPS" if none_ids else '')
            + (f", {failed} failed" if failed else '')
            + (f", {len(result.get('rejected', []))} rejected" if result.get('rejected') else ''))

# ── Main ───────────────────────────────────────────────────────────────────────
def main(mfa_code=None, user_id=1, sleep_days=SLEEP_LOOKBACK_DAYS,
         limit=ACTIVITY_LIMIT, dry_run=False, recovery_days=RECOVERY_LOOKBACK_DAYS,
         unattended=False, catch_up_since=None, route_batch=ROUTE_BATCH):
    GARMIN_EMAIL    = os.environ.get('GARMIN_EMAIL', '')
    GARMIN_PASSWORD = os.environ.get('GARMIN_PASSWORD', '')

    if not GARMIN_EMAIL or not GARMIN_PASSWORD:
        print("ERROR: GARMIN_EMAIL and GARMIN_PASSWORD must be set in .env or environment.")
        _set_status(False, "Garmin isn't connected for this user. Connect it in Settings.")
        sys.exit(1)

    if not acquire_sync_lock(user_id):
        print(f"SYNC_IN_PROGRESS: another Garmin sync for user {user_id} is already running; "
              f"leaving it to finish.")
        sys.exit(SYNC_BUSY_EXIT)

    # AN UNATTENDED RUN NEVER LOGS IN WITH THE PASSWORD. login(token_store)
    # falls back to a full email+password login BY ITSELF whenever the cached
    # token won't load or refresh, or the API rejects it. Garmin then emails an
    # MFA code nobody is there to type, and a cron doing that every morning is
    # the repeated-unfinished-login pattern Garmin's sign-in server locks
    # accounts for. Built with no credentials, the library refuses both
    # fallbacks without a request and raises GarminConnectAuthenticationError,
    # reported below as "sign in again from the app", where a person can
    # answer the MFA prompt. The credentials check above still runs, so a user
    # with none configured still reads "not configured".
    #
    # One false alarm is possible: a rate limit during the library's own token
    # refresh is swallowed inside it and looks like a missing token. The token
    # files are untouched, so the next run recovers by itself.
    # Story: DECISIONS.md#cron-sync.
    print(f"Connecting to Garmin Connect as {GARMIN_EMAIL}"
          + (" (unattended: saved sign-in only)" if unattended else '') + " ...")
    if unattended:
        api = Garmin(None, None, prompt_mfa=make_mfa_getter(None))
    else:
        api = Garmin(GARMIN_EMAIL, GARMIN_PASSWORD, prompt_mfa=make_mfa_getter(mfa_code))

    # python-garminconnect's own supported pattern: one call loads the cached
    # session from the per-user token store when valid, or does a full login
    # (calling prompt_mfa if needed) and saves a fresh token. Never reintroduce
    # manual garth.resume()/dump() — it silently broke token caching and forced
    # MFA on every sync. Story: DECISIONS.md#garmin-tokenstore-pattern.
    token_store = token_store_for(user_id)
    os.makedirs(token_store, exist_ok=True)
    progress('login')
    try:
        api.login(token_store)
        print("  Logged in — cached session reused automatically when valid")
    except GarminConnectAuthenticationError as e:
        if unattended:
            print(f"Saved Garmin sign-in unusable ({e}); not logging in with the password unattended.")
            _set_status(False, "Garmin's saved sign-in no longer works. Press Sync in the app to "
                               "sign in again.", mfa_required=True)
            sys.exit(2)
        print(f"Authentication failed: {e}")
        _set_status(False, login_failure_status(e, mfa_code)[0])
        sys.exit(1)
    except GarminConnectTooManyRequestsError as e:
        print(f"Garmin rate-limited the sign-in ({e}).")
        _set_status(False, RATE_LIMITED_NOTHING, rate_limited=True)
        sys.exit(RATE_LIMITED_EXIT)
    except GarminConnectConnectionError as e:
        # Every sign-in strategy failed some other way (a bot challenge, an
        # outage). Not the password, so not worded as one.
        print(f"Garmin sign-in failed: {e}")
        _set_status(False, login_failure_status(e, mfa_code)[0])
        sys.exit(1)

    # A browser-started sync asks only about the days since the last good one
    # (see CATCH_UP_MIN_DAYS); the cron passes no date and keeps its window.
    if catch_up_since:
        sleep_days = catch_up_days(catch_up_since, sleep_days)
        recovery_days = catch_up_days(catch_up_since, recovery_days)
        print(f"Catching up since {catch_up_since}: {sleep_days} day(s) of sleep, "
              f"{recovery_days} of recovery.")

    # --sleep-days 0 skips the lookback and says so, rather than printing
    # "No sleep scores available yet", which reads as a Garmin outage. A deep
    # activity backfill wants this: a year of activities must not drag a year
    # of per-day sleep requests along.
    if sleep_days > 0:
        print(f"Checking sleep data for the last {sleep_days} day(s) ...")
        sleep_entries = fetch_sleep_window(api, sleep_days)
    else:
        print("Skipping the sleep lookback (--sleep-days 0).")
        sleep_entries = []
    for entry in sleep_entries:
        print(f"  Sleep score: {entry['score']} ({entry['qualifier']}) for {entry['date']}"
              f" · resp {entry['resp_rate']} · {entry['sleep_minutes']} min"
              f" · skin temp {entry['skin_temp_dev']}")
    if not sleep_entries and sleep_days > 0:
        # Said out loud, because a silently missing score goes unnoticed. Not
        # said when the lookback was skipped on purpose: nothing is missing.
        print("  No sleep scores available yet.")

    # Same opt-out shape as the sleep lookback above, and for the same reason:
    # a deep activity backfill must not drag three or four requests per day
    # along with it. That is what scripts/backfill_garmin_recovery.py is for.
    # AFTER ANY 429, NO FURTHER GARMIN REQUEST: every step below checks
    # _rate_limited first, and whatever already came back is still posted.
    if _rate_limited:
        print("Skipping the recovery lookback: Garmin rate-limited this run.")
        recovery_entries = []
    elif recovery_days > 0:
        print(f"Checking recovery data for the last {recovery_days} day(s) ...")
        recovery_entries = fetch_recovery_window(api, recovery_days)
    else:
        print("Skipping the recovery lookback (--recovery-days 0).")
        recovery_entries = []
    # Printed per metric, not as a count: several fields are device-gated, and
    # this log shows which ones this watch actually records.
    for entry in recovery_entries:
        got = ', '.join(f"{k}={v}" for k, v in entry.items() if k != 'date' and v is not None)
        print(f"  Recovery for {entry['date']}: {got or 'nothing'}")
    if not recovery_entries and recovery_days > 0:
        print("  No recovery data available yet.")

    if _rate_limited:
        print("Skipping activities: Garmin rate-limited this run.")
        activities = []
    else:
        print(f"Fetching last {limit} activities ...")
        progress('activities')
        try:
            activities = fetch_activities(api, limit)
        except GarminConnectTooManyRequestsError:
            _note_rate_limit()
            print("  Garmin rate-limited the activity list — keeping what came back before it.")
            activities = []
        print(f"  Garmin returned {len(activities)} activities")

    records = [r for a in activities if (r := transform(a)) is not None]
    skipped_types = len(activities) - len(records)
    print(f"  {len(records)} supported  |  {skipped_types} skipped (unsupported type)")

    if dry_run:
        # Stops here on purpose, BEFORE the POST and with _set_status inert (see
        # the _dry_run flag). Nothing below this line is exercised, so a dry run
        # proves what would be SENT, never what the server would do with it —
        # dedup against external_id and any merge with a manual entry are
        # server-side and only observable by running it for real.
        print(f"\nDRY RUN — nothing sent to {WORKOUT_API}")
        print(f"  Would send: {summarize_records(records)}")
        if sleep_entries:
            print(f"  Would send {len(sleep_entries)} sleep score(s)")
        if recovery_entries:
            print(f"  Would send {len(recovery_entries)} day(s) of recovery data")
        print("  Re-run without --dry-run to import. Already-stored activities are "
              "skipped server-side on external_id, so this is safe to repeat.")
        return

    # recovery_entries belongs in this gate too: a rest day with no activity
    # and no sleep score still has a resting HR worth storing, and without it
    # that day would be fetched and then silently dropped on the floor.
    if not records and not sleep_entries and not recovery_entries:
        print("Nothing to sync.")
        # ROUTES STILL RUN HERE: a day with nothing new is when there is spare
        # request budget to drain the route backlog. Returning first would
        # drain it only on days something new was logged.
        route_note = '' if _rate_limited else sync_routes(api, user_id, limit=route_batch,
                                                          dry_run=_dry_run)
        if route_note:
            print(route_note)
        if _rate_limited:
            _set_status(False, RATE_LIMITED_NOTHING, rate_limited=True)
            sys.exit(RATE_LIMITED_EXIT)
        # A successful run that simply found nothing new — must still count as
        # a success so it clears any stale error badge.
        _set_status(True, ('Nothing new to sync.' + ('  |  ' + route_note if route_note else '')))
        return

    print(f"Syncing to {WORKOUT_API}/api/garmin/sync ...")
    progress('saving')
    payload = {'activities': records, 'userId': user_id}
    if sleep_entries:
        payload['sleep'] = sleep_entries
    if recovery_entries:
        payload['recovery'] = recovery_entries
    try:
        resp = requests.post(
            f"{WORKOUT_API}/api/garmin/sync",
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=10,
        )
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Could not connect to {WORKOUT_API}. Is the container running?")
        # Can't report this one anywhere — the server we'd report to is the
        # thing that's unreachable. Left set for consistency regardless.
        _set_status(False, f'Could not reach the app at {WORKOUT_API}.')
        sys.exit(1)

    if resp.ok:
        result = resp.json()
        summary = f"Imported: {result['imported']}  |  Merged duplicates: {result.get('merged', 0)}  |  Already logged (skipped): {result['skipped']}"
        # An already-logged activity still gets Garmin's device-only fields --
        # measured splits, training load and effect -- written onto it
        # (syncActivitiesForUser's refresh arm), which is how a deep --limit
        # run backfills them onto history that predates each field.
        if result.get('refreshed'):
            summary += f"  |  Device fields refreshed: {result['refreshed']}"
        # AFTER the activities are in, never before: the work queue is derived
        # from history rows, so a route asked for ahead of its activity would
        # not be offered at all. This is also why it fails soft -- everything
        # that matters has already been committed by the time it runs.
        route_note = '' if _rate_limited else sync_routes(api, user_id, limit=route_batch,
                                                          dry_run=_dry_run)
        if route_note:
            summary += '  |  ' + route_note
        print(f"Done. {summary}")
        # Checked AFTER sync_routes too, which can be the step that hit it. A
        # red badge on purpose: repeated 429s are the early sign of a sync
        # that asks too much, and the thing to notice.
        if _rate_limited:
            _set_status(False, RATE_LIMITED_PARTWAY, rate_limited=True)
            sys.exit(RATE_LIMITED_EXIT)
        _set_status(True, summary)
    else:
        print(f"API error {resp.status_code}: {resp.text}")
        _set_status(False, f"Garmin's data arrived, but the app couldn't save it (error "
                           f"{resp.status_code}). Try again; if it keeps happening, the reason "
                           f"is in the Pi's container log.")
        sys.exit(1)

if __name__ == '__main__':
    # Line-buffered, because cron redirects stdout to a file and Python
    # block-buffers a non-TTY. Under --all that printed each "=== user N ==="
    # header AFTER the subprocess output it introduces, so one sync read as two.
    sys.stdout.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description='Sync Garmin Connect activities into Catholic Workout Journal.')
    parser.add_argument('--mfa-code', dest='mfa_code', default=None,
                         help='Garmin MFA code (for non-interactive use, e.g. triggered from the browser)')
    parser.add_argument('--user-id', dest='user_id', type=int, default=1,
                         help='Which app user to sync for (defaults to 1, the original/only account '
                              'before per-user sync credentials existed — keeps an un-updated cron '
                              'entry or manual run working unchanged)')
    parser.add_argument('--sleep-days', dest='sleep_days', type=int, default=SLEEP_LOOKBACK_DAYS,
                         help=f'How many trailing days of sleep score to re-request '
                              f'(default {SLEEP_LOOKBACK_DAYS}). Raise it for a one-off backfill of '
                              f'nights Garmin finalized after the cron had already run; days Garmin '
                              f'has nothing for are skipped, never guessed.')
    parser.add_argument('--recovery-days', dest='recovery_days', type=int, default=RECOVERY_LOOKBACK_DAYS,
                         help=f'How many trailing days of recovery data — resting HR, HRV, steps, '
                              f'Body Battery, training readiness, VO2 max, training load — to '
                              f're-request (default {RECOVERY_LOOKBACK_DAYS}). Costs three or four Garmin '
                              f'calls per day, so pass 0 '
                              f'alongside a deep --limit backfill. For a one-off deep recovery '
                              f'backfill use scripts/backfill_garmin_recovery.py, which throttles.')
    parser.add_argument('--limit', dest='limit', type=int, default=ACTIVITY_LIMIT,
                         help=f'How many activities to pull, newest first (default {ACTIVITY_LIMIT}, '
                              f'also settable as GARMIN_LIMIT). Raise it for the one-off deep '
                              f'backfill of everything predating the app\'s first sync — requests '
                              f'are paged {ACTIVITY_PAGE_SIZE} at a time and stop early at the end '
                              f'of your Garmin history, so an over-large value costs nothing. '
                              f'Pair it with --sleep-days 0 and --dry-run.')
    parser.add_argument('--dry-run', dest='dry_run', action='store_true',
                         help='Log in, fetch and transform, then print what WOULD be imported and '
                              'exit without sending anything. Leaves the stored sync status '
                              'untouched, so it never disturbs the in-app error badge.')
    parser.add_argument('--unattended', action='store_true',
                         help='Use the saved sign-in only: if it no longer works, report "sign in '
                              'again" instead of logging in with the password (which makes Garmin '
                              'email an MFA code nobody will type). --all always passes it.')
    parser.add_argument('--catch-up-since', dest='catch_up_since', default=None, metavar='YYYY-MM-DD',
                         help=f'The date of the last successful sync: fetch sleep and recovery back '
                              f'to it only (at least {CATCH_UP_MIN_DAYS} days, at most the usual '
                              f'windows). The Sync button passes it; the cron does not.')
    parser.add_argument('--route-batch', dest='route_batch', type=int, default=ROUTE_BATCH,
                         help=f'How many missing routes this run fetches (default {ROUTE_BATCH}). '
                              f'The Sync button asks for fewer, since someone is waiting.')
    parser.add_argument('--progress', action='store_true',
                         help='Print a PROGRESS line as each step starts, for server.js to show '
                              'on the Sync button.')
    parser.add_argument('--all', action='store_true',
                         help='Sync every app user with stored Garmin credentials instead of just '
                              'one (ignores --user-id/--mfa-code). Used by the twice-daily cron job '
                              'so a newly connected second/third user gets picked up automatically.')
    args = parser.parse_args()

    if args.all:
        # A fresh subprocess per user, NOT an in-process loop over main():
        # load_credentials() uses os.environ.setdefault, so a second user's
        # file could never override the first's, and main() sys.exit()s on
        # several failure paths. One user's MFA or failure must not stop the
        # others, so failures are collected rather than raised.
        #
        # THE ONE EXCEPTION IS A RATE LIMIT (RATE_LIMITED_EXIT). Garmin limits
        # the IP, not the account, so the next user's run would only add
        # requests to a sync Garmin has already told to slow down.
        #
        # Always --unattended: --all is what cron runs, and nobody is there to
        # answer an MFA prompt. See the login block in main().
        user_ids = discover_credentialed_user_ids()
        print(f"--all: syncing {len(user_ids)} user(s): {user_ids}")
        overall_exit = 0
        for uid in user_ids:
            print(f"\n=== user {uid} ===")
            # --limit and --dry-run forward too, so one command covers every
            # account. Each subprocess re-derives its own _dry_run.
            result = subprocess.run([sys.executable, os.path.abspath(__file__),
                                     '--user-id', str(uid),
                                     '--sleep-days', str(args.sleep_days),
                                     '--recovery-days', str(args.recovery_days),
                                     '--limit', str(args.limit),
                                     '--unattended']
                                    + (['--dry-run'] if args.dry_run else []))
            # SYNC_BUSY_EXIT is not a failure: that user's other run is syncing.
            if result.returncode not in (0, SYNC_BUSY_EXIT):
                overall_exit = 1
            if result.returncode == RATE_LIMITED_EXIT:
                print("--all: Garmin rate-limited this IP; not starting the remaining users.")
                break
        sys.exit(overall_exit)

    # Set before load_credentials()/main() so an early failure (missing
    # credentials, auth error) still reports against the right user rather
    # than the default.
    _status['userId'] = args.user_id
    # Before load_credentials()/main() for the same reason _status['userId'] is:
    # the credential-missing path below calls _set_status, and a dry run must
    # not report that either.
    _dry_run = args.dry_run
    _show_progress = args.progress

    load_credentials(args.user_id)

    # Report the outcome, then exit with exactly the code main() would have
    # exited with — server.js still keys off the exit code and the
    # "MFA_REQUIRED" stdout marker, so neither may change here.
    exit_code = 0
    try:
        main(mfa_code=args.mfa_code, user_id=args.user_id, sleep_days=args.sleep_days,
             limit=args.limit, dry_run=args.dry_run, recovery_days=args.recovery_days,
             unattended=args.unattended, catch_up_since=args.catch_up_since,
             route_batch=args.route_batch)
        if _status['ok'] is None:
            _set_status(True, 'Sync completed.')
    except SystemExit as e:
        exit_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except Exception as e:
        # Anything not already instrumented above — better to report a vague
        # failure than to fail silently, which is the whole point of this.
        _set_status(False, "The sync stopped on an error it doesn't recognise. Try again later; "
                           "the details are in the Pi's container log.")
        exit_code = 1
        import traceback; traceback.print_exc()

    timings = timings_line()
    if timings:
        print(timings)
    _report_status()
    sys.exit(exit_code)
