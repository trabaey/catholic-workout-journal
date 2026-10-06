// trails.js — the trails near a home base, from OpenStreetMap, for the Map
// tab's Trail Quests mode.
//
// THE DATA IS OPENSTREETMAP'S, asked for through the Overpass API. Not
// OpenTrailMap: that is OSM US's VIEWER of the same data, with no query API,
// and its trail tiles are not for public use. Its rules for what counts as a
// trail are CC0, though (osmus/tileservice renderer/layers/trails.yml), and
// TRAIL CANDIDATES below follow them. © OpenStreetMap contributors, ODbL.
//
// Everything here is PURE except fetchTrailArea, so a harness can require
// this file without starting the server. The route, the cache files, the
// retry timers and the shutdown guard live in server.js beside the weather
// block, which this mirrors.
//
// ONLY NAMED TRAILS AND SIGNED ROUTES, by the user's choice: a quest is a
// real trail you could look up ("Salt Creek Trail"), never one of the hundreds
// of unnamed connector paths a town has. A way with no name still counts when
// it is part of a hiking or cycling route relation, under the route's name.

// The area asked for: the home base rounded to AREA_STEP_DEG, and a box
// AREA_KM either side of that. AREA_KM is the largest quest radius (20 km)
// plus the slack rounding can move the centre by, so ONE fetch serves every
// radius and every pin that rounds to the same place.
//
// WHAT LEAVES THE PI is that box: 0.05 degrees is about 5 km, roughly naming
// your town. Never the pin itself, never a track, never who asked.
const AREA_STEP_DEG = 0.05;
const AREA_KM = 23;
const KM_PER_DEG = 111.32;

// Bumped whenever trailsFromOverpass changes what it returns. server.js puts
// it in the cache file's name, so an older file is MISSING, never served.
const TRAILS_FORMAT = 1;

// Trails shorter than this are left out: a named 80 m connector is not a quest.
const MIN_TRAIL_M = 300;
// Pieces of one name join into one trail when they share a node or their ends
// are this close. Bridges the gap where a trail crosses a road (the crossing
// itself is a footway=crossing, never a candidate) without merging two parks'
// "Nature Trail"s.
const JOIN_M = 150;
const MAX_NAME = 100;

// A named FOOTWAY or CYCLEWAY whose name ends in a street suffix is a
// sidewalk tagged with its street's name, an old habit the [!"footway"]
// filter can't see. A path keeps it: "Old Mill Road Trail" ends in Trail.
const STREETISH = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|highway|hwy)\.?$/i;

const ROUTE_TYPES = 'hiking|foot|walking|running|bicycle|mtb|horse';

const round5 = v => Math.round(v * 1e5) / 1e5;

function areaFor(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  const step = v => Math.round(Math.round(v / AREA_STEP_DEG) * AREA_STEP_DEG * 100) / 100;
  const clat = step(lat), clon = step(lon);
  const dlat = AREA_KM / KM_PER_DEG;
  const dlon = AREA_KM / (KM_PER_DEG * Math.cos(clat * Math.PI / 180));
  const r4 = v => Math.round(v * 1e4) / 1e4;
  return {
    key: `${clat.toFixed(2)},${clon.toFixed(2)}`,
    lat: clat, lon: clon,
    bbox: [r4(clat - dlat), r4(clon - dlon), r4(clat + dlat), r4(clon + dlon)],   // [s, w, n, e]
  };
}

// TRAIL CANDIDATES, after OSM US's trail layer:
//   - path, bridleway and cycleway always;
//   - footway and steps only with NO footway=* subtag, which is how
//     sidewalks, crossings and access aisles are told apart;
//   - track only with foot or bicycle access, since most rural tracks are
//     farm lanes;
//   - never private, along a road (is_sidepath), marked trail=no, informal
//     (social trails), an area (a plaza drawn as a loop) or indoors.
// Of those, the NAMED ones, and those in a route relation of a foot or bike
// kind. Road members of a route are never candidates, so a signed on-street
// bike route counts only for its off-road parts, and a long route only for
// its parts inside the box. Ways first, with geometry; then the routes, with
// their member lists, so trailsFromOverpass can tell whose ways are whose.
//
// maxsize makes an oversized answer fail on Overpass's side, never by
// filling the Pi's memory. A smaller declared timeout than the default makes
// the server likelier to accept the query at all.
function overpassQuery(bbox) {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:90][maxsize:268435456][bbox:${s},${w},${n},${e}];
(
  way["highway"~"^(path|bridleway|cycleway)$"];
  way["highway"~"^(footway|steps)$"][!"footway"];
  way["highway"="track"]["foot"~"^(yes|designated|permissive)$"];
  way["highway"="track"]["bicycle"~"^(yes|designated|permissive)$"];
)->.cand;
way.cand["access"!~"^(no|private)$"]["is_sidepath"!="yes"]["trail"!="no"]["informal"!="yes"]["area"!="yes"][!"indoor"]->.trails;
rel(bw.trails)["type"="route"]["route"~"^(${ROUTE_TYPES})$"]->.routes;
(way.trails["name"]; way.trails(r.routes););
out geom;
.routes out body;`;
}

function haversineM(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const p1 = a[0] * rad, p2 = b[0] * rad, dp = p2 - p1, dl = (b[1] - a[1]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const lineM = pts => pts.slice(1).reduce((m, p, i) => m + haversineM(pts[i], p), 0);

// A name as it may be shown: control characters out, whitespace collapsed,
// capped. It is still UNTRUSTED TEXT from the internet, and the browser
// escapes it everywhere it goes.
function cleanName(s) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1).trimEnd()}…` : t;
}
const nameKey = s => cleanName(s).toLowerCase();

// One way's drawable pieces: its points split wherever Overpass gave no
// coordinate (it sends null for a node it could not place), with the node id
// at each end so pieces can be stitched.
function wayPieces(el) {
  const out = [];
  const geom = Array.isArray(el.geometry) ? el.geometry : [];
  const nodes = Array.isArray(el.nodes) && el.nodes.length === geom.length ? el.nodes : null;
  let cur = null;
  geom.forEach((g, i) => {
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) { cur = null; return; }
    if (!cur) out.push(cur = { pts: [], a: nodes ? nodes[i] : null, b: null });
    cur.pts.push([round5(g.lat), round5(g.lon)]);
    cur.b = nodes ? nodes[i] : null;
  });
  return out.filter(p => p.pts.length >= 2);
}

// Pieces joined end to end wherever exactly two of them meet at a node, so a
// trail OSM split at every bridge and junction is drawn, sampled and dashed
// as a few long lines rather than dozens of short ones.
function stitch(pieces) {
  let list = pieces.map(p => ({ ...p, pts: p.pts.slice() }));
  for (let changed = true; changed;) {
    changed = false;
    const at = new Map();
    list.forEach((p, i) => {
      for (const n of [p.a, p.b]) if (n != null) { const l = at.get(n) || []; l.push(i); at.set(n, l); }
    });
    for (const [n, idx] of at) {
      if (idx.length !== 2 || idx[0] === idx[1]) continue;
      let [p, q] = [list[idx[0]], list[idx[1]]];
      if (!p || !q) continue;
      // Orient so p ends at n and q starts at n.
      if (p.a === n) p = { a: p.b, b: p.a, pts: p.pts.slice().reverse() };
      if (q.b === n) q = { a: q.b, b: q.a, pts: q.pts.slice().reverse() };
      if (p.b !== n || q.a !== n) continue;
      list[idx[0]] = { a: p.a, b: q.b, pts: p.pts.concat(q.pts.slice(1)) };
      list[idx[1]] = null;
      changed = true;
      break;
    }
    list = list.filter(Boolean);
  }
  return list.map(p => p.pts);
}

function boundsOf(pieces) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const pts of pieces) for (const [la, lo] of pts) {
    if (la < s) s = la; if (la > n) n = la;
    if (lo < w) w = lo; if (lo > e) e = lo;
  }
  return [s, w, n, e];
}

// Connected groups of one name's ways: union-find over shared nodes and ends
// within JOIN_M.
function components(ways) {
  const parent = ways.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };
  const byNode = new Map();
  ways.forEach((w, i) => {
    for (const n of w.nodes) {
      if (byNode.has(n)) union(i, byNode.get(n)); else byNode.set(n, i);
    }
  });
  const ends = ways.map(w => w.pieces.flatMap(p => [p.pts[0], p.pts[p.pts.length - 1]]));
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      if (find(i) === find(j)) continue;
      if (ends[i].some(a => ends[j].some(b => haversineM(a, b) <= JOIN_M))) union(i, j);
    }
  }
  const groups = new Map();
  ways.forEach((w, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); });
  return [...groups.values()];
}

function makeTrail(id, name, kind, route, osm, ways) {
  const pieces = stitch(ways.flatMap(w => w.pieces));
  const length_m = Math.round(pieces.reduce((m, p) => m + lineM(p), 0));
  if (length_m < MIN_TRAIL_M || !pieces.length) return null;
  return { id, name, kind, route, osm, pieces, length_m, bounds: boundsOf(pieces) };
}

// Overpass's answer -> the trails, each:
//   { id, name, kind: 'route'|'path', route, osm: {type, id}, pieces, length_m, bounds }
// id is 'r<relation>' for a route and 'w<smallest way>' for a named path, the
// only form the browser ever passes to a handler. pieces are [[lat, lon], ...]
// at 5 decimals, as plain arrays: no new polyline encoder to keep in step.
//
// A NAME GROUP LYING WHOLLY INSIDE A ROUTE OF THE SAME NAME IS THAT ROUTE and
// is dropped. One inside a route of ANOTHER name keeps its own quest: "Salt
// Creek Trail" stays a quest when it is also a stretch of a long regional
// route. Pure.
function trailsFromOverpass(json) {
  const els = json && Array.isArray(json.elements) ? json.elements : [];
  const ways = new Map();
  const routes = [];
  for (const el of els) {
    if (el.type === 'way' && Number.isInteger(el.id)) {
      const tags = el.tags || {};
      const pieces = wayPieces(el);
      if (!pieces.length) continue;
      ways.set(el.id, { id: el.id, tags, name: cleanName(tags.name), pieces,
                        nodes: Array.isArray(el.nodes) ? el.nodes : [] });
    } else if (el.type === 'relation' && Number.isInteger(el.id)) {
      routes.push(el);
    }
  }

  const out = [];
  const routeOf = new Map();   // way id -> [{ key, relId }]
  for (const rel of routes) {
    const tags = rel.tags || {};
    const name = cleanName(tags.name) || cleanName(tags.ref);
    if (!name) continue;
    const members = (rel.members || [])
      .filter(m => m && m.type === 'way' && ways.has(m.ref))
      .map(m => ways.get(m.ref));
    const unique = [...new Map(members.map(w => [w.id, w])).values()];
    if (!unique.length) continue;
    const t = makeTrail(`r${rel.id}`, name, 'route', String(tags.route || ''),
                        { type: 'relation', id: rel.id }, unique);
    if (!t) continue;
    out.push(t);
    for (const w of unique) {
      const l = routeOf.get(w.id) || [];
      l.push({ key: nameKey(name), relId: rel.id });
      routeOf.set(w.id, l);
    }
  }

  const byName = new Map();
  for (const w of ways.values()) {
    if (!w.name) continue;
    const hw = w.tags.highway;
    if ((hw === 'footway' || hw === 'cycleway') && STREETISH.test(w.name) && !routeOf.has(w.id)) continue;
    const k = nameKey(w.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(w);
  }
  for (const [k, list] of byName) {
    for (const group of components(list)) {
      const sameRoute = group.every(w => (routeOf.get(w.id) || []).some(r => r.key === k));
      if (sameRoute) continue;
      const first = Math.min(...group.map(w => w.id));
      const t = makeTrail(`w${first}`, group[0].name, 'path', null, { type: 'way', id: first }, group);
      if (t) out.push(t);
    }
  }
  return out;
}

// Overpass answers 200 with a `remark` and a PARTIAL elements list when the
// query hit its time or memory limit. That is a failure, never a result:
// cached, it would hide half the trails for a month.
function overpassFailed(json) {
  return !json || !Array.isArray(json.elements)
    || (typeof json.remark === 'string' && /runtime error|timed out|out of memory/i.test(json.remark));
}

const USER_AGENT = 'CatholicWorkoutJournal/1.0 (self-hosted; +https://github.com/trabaey/catholic-workout-journal)';

// Asks each server in turn. A 429, a 5xx, a timeout or a partial answer moves
// on to the next; a 400 or 406 stops at once, since every server would refuse
// the same query (a 406 is a missing User-Agent, which the public instance
// has refused since 2026). The error says which: `rateLimited` when any
// server answered 429, `fatal` for a query or configuration fault.
async function fetchTrailArea(query, { urls, fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  let last = new Error('no Overpass server configured');
  let rateLimited = false;
  for (const url of urls || []) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT,
                   Accept: 'application/json' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = new Error(`${url}: ${e.message}`);
      continue;
    }
    if (res.status === 400 || res.status === 406) {
      const e = new Error(`${url} refused the query (${res.status})`);
      e.fatal = true;
      throw e;
    }
    if (!res.ok) {
      if (res.status === 429) rateLimited = true;
      last = new Error(`${url} responded ${res.status}`);
      continue;
    }
    let json;
    try { json = await res.json(); } catch (e) { last = new Error(`${url}: unreadable answer`); continue; }
    if (overpassFailed(json)) { last = new Error(`${url}: ${json && json.remark || 'no elements'}`); continue; }
    return json;
  }
  last.rateLimited = rateLimited;
  throw last;
}

module.exports = {
  AREA_KM, TRAILS_FORMAT, areaFor, overpassQuery, trailsFromOverpass, overpassFailed, fetchTrailArea,
};
