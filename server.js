const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const net     = require('net');
const zlib    = require('zlib');
const { execFile } = require('child_process');
const db      = require('./db');
const exerciseLibrary = require('./exercise_library');

const app = express();

// ── Request timing log ─────────────────────────────────────────────────────────
// Tells a slow server apart from a slow network when the app is slow to open.
// It records:
//   - every page load ("GET /"), so a slow launch can be matched by time;
//   - any request taking >= SLOW_REQUEST_MS, or ABORTED by the client before
//     the server finished. "Finished" means handed to the kernel's socket
//     buffers, so a stall purely on the network side logs as a normal fast
//     load -- which is what makes the two distinguishable;
//   - any stall of the event loop itself, which delays a request's ARRIVAL
//     and so never shows up in that request's own duration.
// A page load that is missing, or arrives late, points at the network.
//
// Under data/ because that is the only path that survives a rebuild. Writes
// are async and after the response, so the log never slows a request down.
// Capped by a single rotation to .1 at TIMING_LOG_MAX_BYTES.
// Story: DECISIONS.md#slow-launch-diagnosis.
const TIMING_LOG = path.join(__dirname, 'data', 'request-timing.log');
const TIMING_LOG_MAX_BYTES = 1024 * 1024;
const SLOW_REQUEST_MS = 1000;

function logTiming(msg) {
  const d = new Date();
  const line = `${d.toLocaleString('sv-SE')}.${String(d.getMilliseconds()).padStart(3, '0')} ${msg}\n`;
  fs.stat(TIMING_LOG, (err, st) => {
    const append = () => fs.appendFile(TIMING_LOG, line, e => { if (e) console.error('request-timing.log:', e.message); });
    if (!err && st.size > TIMING_LOG_MAX_BYTES) fs.rename(TIMING_LOG, TIMING_LOG + '.1', append);
    else append();
  });
}

// A token in a query string (the Apple Shortcut's ?token=) must never reach a
// log line. Only the log's copy is redacted, never the request.
function redactUrl(url) {
  return String(url).replace(/([?&]token=)[^&]*/gi, '$1REDACTED');
}

// ── Host check (DNS rebinding) ─────────────────────────────────────────────────
// There's no login (see getUserId), so the one thing between a web page on the
// phone and this whole API is the browser's same-origin rule. DNS rebinding
// gets around that: a malicious site re-points ITS OWN domain at this server's LAN IP,
// and the browser then treats this server as that site. The request still
// carries the attacker's domain in Host, and that's what this refuses.
// Everything legitimate arrives by IP (LAN, Tailscale), localhost (the cron
// sync, the harnesses) or a private name, none of which an attacker can point
// at this box. Set WT_ALLOWED_HOSTS (comma-separated) for any other name.
// A missing Host (HTTP/1.0 tools) is allowed: a browser always sends one.
const PRIVATE_HOST_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.ts.net'];
const EXTRA_ALLOWED_HOSTS = new Set((process.env.WT_ALLOWED_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean));

function hostAllowed(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return net.isIP(h) !== 0
    || h === 'localhost'
    || !h.includes('.')
    || PRIVATE_HOST_SUFFIXES.some(s => h.endsWith(s))
    || EXTRA_ALLOWED_HOSTS.has(h);
}

app.use((req, res, next) => {
  if (hostAllowed(req.hostname)) return next();
  logTiming(`REFUSED Host ${JSON.stringify(req.hostname)} ${req.method} ${redactUrl(req.originalUrl)} from ${req.ip}`);
  res.status(403).type('text').send(
    `Host "${req.hostname}" is not an address this server answers to. ` +
    `Use its IP, or add the name to WT_ALLOWED_HOSTS.`);
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  // Read now: once an aborted client's socket is torn down, req.ip is
  // undefined -- exactly the line this log most needs a sender on.
  const ip = req.ip;
  const done = outcome => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    if (req.path === '/' || ms >= SLOW_REQUEST_MS || outcome !== 'ok') {
      logTiming(`${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ${ms}ms ${outcome} from ${ip}`);
    }
  };
  res.on('finish', () => done('ok'));
  res.on('close', () => { if (!res.writableFinished) done('ABORTED'); });
  next();
});

// Event-loop stall detector: a timer that fires late by >= SLOW_REQUEST_MS
// means nothing (requests included) could run for that long. hrtime, not
// Date, so an NTP clock step can't fake one. unref'd so it never holds the
// process open.
{
  const LAG_CHECK_MS = 500;
  let expected = process.hrtime.bigint() + BigInt(LAG_CHECK_MS * 1e6);
  setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Math.round(Number(now - expected) / 1e6);
    expected = now + BigInt(LAG_CHECK_MS * 1e6);
    if (lag >= SLOW_REQUEST_MS) logTiming(`EVENT LOOP BLOCKED ~${lag}ms`);
  }, LAG_CHECK_MS).unref();
}

// The 10mb limit is load-bearing: POST /api/import sends the ENTIRE dataset as
// one JSON body, and body-parser's 100kb default would reject a restore before
// the route runs, with only a generic "Failed to restore backup" in the UI.
// History grows ~600 bytes per workout. Story: DECISIONS.md#import-atomicity.
app.use(express.json({ limit: '10mb' }));

// Sends a large, rarely-changing text body gzipped to any client that accepts
// it (index.html is ~1.5 MB, ~0.45 MB gzipped, and the phone often launches
// over Tailscale). Hand-rolled on zlib rather than the `compression` package
// because package.json is not edited casually (the Pi's lockfile has to be
// regenerated with it).
// The gzip and the ETag are computed once per body and cached under `slot`
// (one per resource, holding only its current version). The gzipped variant
// gets its own ETag, as HTTP requires of a different byte stream; res.send()
// then answers a matching If-None-Match with a 304 itself.
const gzipCache = new Map(); // slot -> { body, etag, gz }
function sendCompressible(req, res, slot, body, type) {
  let entry = gzipCache.get(slot);
  if (!entry || entry.body !== body) {
    entry = {
      body,
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"',
      gz: zlib.gzipSync(body),
    };
    gzipCache.set(slot, entry);
  }
  res.vary('Accept-Encoding');
  res.type(type);
  if (req.acceptsEncodings('gzip', 'identity') === 'gzip') {
    res.set('Content-Encoding', 'gzip');
    res.set('ETag', entry.etag.slice(0, -1) + '-gz"');
    res.send(entry.gz);
  } else {
    res.set('ETag', entry.etag);
    res.send(body);
  }
}

// Every JSON answer under /api over GZIP_JSON_MIN_BYTES goes out gzipped to a
// client that accepts it. Startup pulls ~850 KB of JSON (daily Garmin data,
// history, the liturgical calendar, check-ins) that shrinks 7-15x, about half
// a second on a phone over cellular and the VPN. Per response and async, unlike
// sendCompressible: these bodies are per user and change with every write, so
// there is nothing to cache, and zlib.gzip runs off the event loop where
// gzipSync would hold every other request for each big one. res.send() then
// gives the gzipped bytes their own ETag and answers a matching If-None-Match
// with a 304, as it does for the plain ones. Below the threshold the header
// and gzip's own framing cost more than they save.
// Story: DECISIONS.md#states-errors-and-speed.
const GZIP_JSON_MIN_BYTES = 1024;
app.use('/api', (req, res, next) => {
  res.json = obj => {
    const body = JSON.stringify(obj);
    if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
    if (body === undefined || Buffer.byteLength(body) < GZIP_JSON_MIN_BYTES) return res.send(body);
    res.vary('Accept-Encoding');
    if (req.acceptsEncodings('gzip', 'identity') !== 'gzip') return res.send(body);
    zlib.gzip(body, (err, gz) => {
      if (err) return res.send(body);
      res.set('Content-Encoding', 'gzip');
      res.send(gz);
    });
    return res;
  };
  next();
});

// index.html goes through sendCompressible; everything else under public/
// stays on express.static. Re-read when its mtime changes, so an edit shows
// up without a restart when running locally outside Docker.
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
let indexHtml = { mtimeMs: -1, body: '' };
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const st = fs.statSync(INDEX_HTML);
    if (st.mtimeMs !== indexHtml.mtimeMs) indexHtml = { mtimeMs: st.mtimeMs, body: fs.readFileSync(INDEX_HTML, 'utf8') };
    res.set('Cache-Control', 'public, max-age=0'); // what express.static sent: always revalidate
    sendCompressible(req, res, 'index', indexHtml.body, 'html');
  } catch (e) {
    next(e);
  }
});
// The RepDB illustrations live in the bind mount (exercise_library.js says
// why), at the same /repdb/ URLs they always had. Mounted BEFORE public/ so a
// stale public/repdb/ left on disk by an older deploy can never shadow them.
app.use('/repdb', express.static(exerciseLibrary.REPDB_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// No login/password (see db.js's users table comment) — the frontend picks a
// user once via a pre-boot gate and sends its choice on every request as
// this header. Trusted outright: the server is reachable only on the LAN and
// the owner's tailnet, and the Host check above keeps a web page from
// borrowing a browser to reach it. An absent or malformed header means user 1,
// so a cached frontend, a raw curl or a script lands somewhere sane.
function getUserId(req) {
  const id = parseInt(req.headers['x-user-id'], 10);
  return Number.isInteger(id) && id > 0 ? id : 1;
}

// ONE RULE: the user id a request RESOLVES to must exist, or it is a 400 —
// never rows filed under a user_id nothing will display. It asserts
// getUserId's RESULT rather than re-parsing the header, so every fallback to 1
// passes with no duplicated parsing to drift. POST /api/garmin/sync and
// /api/garmin/sync-status give the same 400 for the same reason.
//
// The exact path /api/users is EXEMPT: it is how a client discovers its
// identity (the pre-boot picker) and repairs it (bootWithUserGate's check that
// a stored id still exists), and both requests carry the header being
// validated — gating it would leave a tab holding a dead id unable to reach
// the picker that fixes it. It is the exact path, not a prefix: PATCH
// /api/users/:id is gated, since editing the roster is an action taken by
// someone who must exist.
//
// USER 1 MUST ALWAYS EXIST AND STAY PICKABLE. Every headerless caller
// (garmin_sync.py, scripts/prune_empty_checkins.js, a raw curl) resolves to
// it, so PATCH /api/users/:id refuses to archive it and no route deletes a user.
// Story: DECISIONS.md#unknown-user-ids, DECISIONS.md#archiving-a-user.
app.use('/api', (req, res, next) => {
  if (req.path === '/users') return next();
  const id = getUserId(req);
  if (!db.userExists(id)) {
    return res.status(400).json({ error: `No such user id ${id}` });
  }
  next();
});

// ── Users ──────────────────────────────────────────────────────────────────────
// Powers the frontend's pre-boot "who's using this?" picker AND the People card
// in Settings. Returns ARCHIVED users too, carrying the flag — see db.getUsers
// for why one list rather than a ?all=1 mode, and which two call sites in
// index.html have to filter it.
app.get('/api/users', (req, res) => {
  try { res.json(db.getUsers()); }
  catch (e) { console.error('GET /api/users', e); res.status(500).json({ error: e.message }); }
});

// No X-User-Id scoping — creating a user isn't an action taken AS a user, and
// this route is exempt from the gate above for a second reason too (see there).
// An ABSENT or MALFORMED id still defaults to 1; a NUMERIC one for a user
// nobody created is a 400, not a row filed under a ghost.
// Story: DECISIONS.md#unknown-user-ids.
app.post('/api/users', (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const emoji = (req.body?.emoji || '').toString().trim() || '👤';
    res.json(db.createUser({ name, emoji }));
  } catch (e) {
    console.error('POST /api/users', e);
    res.status(500).json({ error: e.message });
  }
});

// Rename, re-emoji, archive and un-archive. Validation mirrors
// PATCH /api/routines/:id exactly: a name present but blank is a 400, an emoji
// is taken as-is, and only the keys actually sent are merged.
//
// ANY USER MAY EDIT ANY USER — the one PATCH here with no ownership check.
// Ownership checks elsewhere keep one person out of another's DATA; the roster
// belongs to the household, and on a LAN app with no auth a per-user lock on
// fixing a name typo would be ceremony, not security.
//
// THERE IS NO DELETE. Archiving keeps every per-user table's rows and keeps
// db.userExists true, so the gate above needs no exception and an archived
// user's open tab is never 400'd mid-session. See the users table comment in
// db.js. Story: DECISIONS.md#archiving-a-user.
app.patch('/api/users/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.getUsers().find(u => u.id === id);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const { name, emoji, archived } = req.body || {};
    const fields = {};
    // `?? ''`: an explicit null is a blank, a 400 for the name, never a 500.
    if (name !== undefined) {
      const trimmed = (name ?? '').toString().trim();
      if (!trimmed) return res.status(400).json({ error: 'Name is required' });
      fields.name = trimmed;
    }
    if (emoji !== undefined) fields.emoji = (emoji ?? '').toString().trim() || '👤';
    if (archived !== undefined) {
      if (typeof archived !== 'boolean') {
        return res.status(400).json({ error: 'archived must be true or false' });
      }
      // The constraint the /api gate's comment records: getUserId falls back to
      // 1, so hiding id 1 from the picker would leave a box whose every
      // headerless caller still resolves to a user nobody can choose.
      if (archived && id === 1) {
        return res.status(400).json({ error: 'User 1 cannot be archived' });
      }
      fields.archived = archived;
    }

    const updated = db.updateUser(id, fields);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    // Archiving revokes both sync methods, using exactly what the two
    // disconnect routes call. Required, not tidiness: garmin_sync.py's --all
    // discovery globs data/garmin-{id}.env and never consults the users table,
    // and POST /api/apple-health/sync resolves identity from the token index
    // alone — either would keep syncing someone hidden from every view.
    // Un-archiving cannot restore them (the secrets are gone); the confirm
    // says so.
    //
    // Runs AFTER the row is written, because it cannot be undone: if
    // updateUser fails, the worst case must be credentials still in place,
    // never an active user with both connections destroyed.
    if (fields.archived === true && !existing.archived) {
      deleteGarminCredentialsFile(id);
      wipeTokenStore(id);
      deleteAppleToken(id);
      db.clearGarminSyncStatus(id);
      db.clearAppleSyncStatus(id);
    }

    res.json(updated);
  } catch (e) {
    console.error('PATCH /api/users/:id', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Lifts ──────────────────────────────────────────────────────────────────────
app.get('/api/lifts', (req, res) => {
  try {
    res.json(db.getLifts(getUserId(req)));
  } catch (e) {
    console.error('GET /api/lifts', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/lifts/:routineId', (req, res) => {
  try {
    const routineId = parseInt(req.params.routineId, 10);
    const routine = db.getRoutines(getUserId(req)).find(r => r.id === routineId && !r.archived);
    if (!routine) return res.status(400).json({ error: 'Invalid routine' });
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Body must be an array' });
    db.setLifts(routineId, req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/lifts/:routineId', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Routines ───────────────────────────────────────────────────────────────────
app.get('/api/routines', (req, res) => {
  try {
    res.json(db.getRoutines(getUserId(req)));
  } catch (e) {
    console.error('GET /api/routines', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routines', (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const emoji = (req.body?.emoji || '🏋️').toString();
    res.json(db.createRoutine({ name, emoji }, getUserId(req)));
  } catch (e) {
    console.error('POST /api/routines', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/routines/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Ids are one AUTOINCREMENT sequence shared by every user, so a row is
    // only reachable through its owner's list.
    if (!db.getRoutines(getUserId(req)).some(r => r.id === id)) {
      return res.status(404).json({ error: 'Routine not found' });
    }
    const { name, emoji, position, target_per_week } = req.body || {};
    const fields = {};
    if (name !== undefined) {
      const trimmed = name.toString().trim();
      if (!trimmed) return res.status(400).json({ error: 'Name is required' });
      fields.name = trimmed;
    }
    if (emoji !== undefined) fields.emoji = emoji.toString();
    if (position !== undefined) fields.position = parseInt(position, 10);
    // null clears the target. Anything else must be a real sessions-per-week
    // number — a string "1" is refused rather than coerced, like a 0, since
    // the planner divides 7 by it.
    if (target_per_week !== undefined) {
      if (target_per_week !== null && !(typeof target_per_week === 'number'
          && Number.isFinite(target_per_week) && target_per_week > 0 && target_per_week <= 7)) {
        return res.status(400).json({ error: 'target_per_week must be null or a number above 0 and at most 7' });
      }
      fields.target_per_week = target_per_week;
    }
    const updated = db.updateRoutine(id, fields);
    if (!updated) return res.status(404).json({ error: 'Routine not found' });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /api/routines/:id', e);
    res.status(500).json({ error: e.message });
  }
});

// Soft delete (archive). The routine is also dropped from every plan dated
// today or later — see db.archiveRoutine.
app.delete('/api/routines/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Owner-checked like PATCH above; archiveRoutine also edits the plans
    // naming it, so this guards the owner's planner too.
    if (!db.getRoutines(getUserId(req)).some(r => r.id === id)) {
      return res.status(404).json({ error: 'Routine not found' });
    }
    const clearedPlanDates = db.archiveRoutine(id);
    res.json({ ok: true, clearedPlanDates });
  } catch (e) {
    console.error('DELETE /api/routines/:id', e);
    res.status(500).json({ error: e.message });
  }
});

// Every exercise name that exists in ANY user's routines — deliberately
// unscoped, same as the name-keyed tables below, so the Add Exercise
// autocomplete offers a name another user created.
app.get('/api/exercise-names', (req, res) => {
  try {
    res.json(db.getAllExerciseNames());
  } catch (e) {
    console.error('GET /api/exercise-names', e);
    res.status(500).json({ error: e.message });
  }
});

// The RepDB exercise library, already translated into this app's tags by
// exercise_library.js (which carries the rules). Unscoped, like the names
// above: it is reference data, identical for everyone. ~650 KB, so it is
// serialised ONCE and sent through sendCompressible, which gzips it once and
// gives it a stable ETag, so a returning browser gets a 304 instead of the body.
// No snapshot installed is an empty array (every fresh install, until Settings
// downloads one); an unreadable one is a 500 the frontend treats the same way.
// Either way the app keeps working, just without images or prefill.
// Story: DECISIONS.md#repdb-exercise-library.
let exerciseLibraryJSON = null;
app.get('/api/exercise-library', (req, res) => {
  try {
    if (!exerciseLibraryJSON) exerciseLibraryJSON = JSON.stringify(exerciseLibrary.buildLibrary());
    sendCompressible(req, res, 'library', exerciseLibraryJSON, 'application/json');
  } catch (e) {
    console.error('GET /api/exercise-library', e);
    res.status(500).json({ error: e.message });
  }
});

// Settings' library card: is a snapshot installed, and the one-click install.
// The install downloads RepDB's own published copy (exercise_library.js's
// installSnapshot) rather than anything this repo ships, because the licence
// forbids redistributing the dataset. One at a time: a second click while one
// runs is a 409, not a second download racing the first to the same rename.
app.get('/api/exercise-library/status', (req, res) => {
  try { res.json(exerciseLibrary.snapshotStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
let libraryInstall = null;
app.post('/api/exercise-library/install', async (req, res) => {
  if (libraryInstall) return res.status(409).json({ error: 'A download is already running' });
  libraryInstall = exerciseLibrary.installSnapshot();
  try {
    const status = await libraryInstall;
    exerciseLibraryJSON = null;
    res.json(status);
  } catch (e) {
    console.error('POST /api/exercise-library/install', e);
    res.status(502).json({ error: e.message });
  } finally {
    libraryInstall = null;
  }
});

// ── Exercise Category Overrides ─────────────────────────────────────────────────
// Category for a name that is in no live routine. The balance analytic reads
// every history entry ever logged, so a renamed or dropped exercise still
// needs somewhere to be tagged.
app.get('/api/exercise-category-overrides', (req, res) => {
  try {
    res.json(db.getExerciseCategoryOverrides());
  } catch (e) {
    console.error('GET /api/exercise-category-overrides', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-category-overrides/:name', (req, res) => {
  try {
    const category = (req.body?.category || '').toString().trim();
    if (!category) return res.status(400).json({ error: 'Category is required' });
    db.setExerciseCategoryOverride(req.params.name, category);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-category-overrides/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Exercise Form Notes ──────────────────────────────────────────────────────────
// How-to + common-mistakes write-up, name-keyed for the same reason as the
// category overrides above (survives renames/removal from every routine).
app.get('/api/exercise-form-notes', (req, res) => {
  try {
    res.json(db.getExerciseFormNotes());
  } catch (e) {
    console.error('GET /api/exercise-form-notes', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-form-notes/:name', (req, res) => {
  try {
    const how_to   = (req.body?.how_to || '').toString();
    const mistakes = (req.body?.mistakes || '').toString();
    db.setExerciseFormNote(req.params.name, how_to, mistakes);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-form-notes/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// Which exercises have no external load (pull ups, push ups, dips). Name-keyed
// for the same reason as the two above. Only flagged names come back, so the
// response is a plain { [name]: true } set.
app.get('/api/exercise-weightless', (req, res) => {
  try {
    res.json(db.getExerciseWeightless());
  } catch (e) {
    console.error('GET /api/exercise-weightless', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-weightless/:name', (req, res) => {
  try {
    db.setExerciseWeightless(req.params.name, !!req.body?.weightless);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-weightless/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// Which exercises are measured in SECONDS held rather than reps (a plank, a
// hang). Same presence-only { [name]: true } shape as the weightless flag
// above; a flagged exercise's set reps field holds whole seconds — see
// exercise_meta's CREATE TABLE comment in db.js.
app.get('/api/exercise-timed', (req, res) => {
  try {
    res.json(db.getExerciseTimed());
  } catch (e) {
    console.error('GET /api/exercise-timed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-timed/:name', (req, res) => {
  try {
    db.setExerciseTimed(req.params.name, !!req.body?.timed);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-timed/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// "Just log it" exercises — logged as sets and reps and ranked at nothing: no
// weight field, no PR, no overload suggestion, no goal, no tonnage. Same
// presence-only shape as the two flags above; see exercise_meta's CREATE TABLE
// comment in db.js for what it suppresses and why a mobility set still counts
// as a working set.
app.get('/api/exercise-unranked', (req, res) => {
  try {
    res.json(db.getExerciseUnranked());
  } catch (e) {
    console.error('GET /api/exercise-unranked', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-unranked/:name', (req, res) => {
  try {
    db.setExerciseUnranked(req.params.name, !!req.body?.unranked);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-unranked/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// Each user's defaults for an exercise — weight, reps, sets, rest_sec, emoji,
// video — keyed by name and SCOPED TO THE USER, unlike the shared tags above:
// see exercise_defaults' CREATE TABLE in db.js. The truth behind every
// routine's copy; a PUT replaces the name's whole row and mirrors it onto that
// user's routine rows. rest_sec outside 5-900 is stored as NULL (the app
// default), the same coercion a routine PUT applies.
app.get('/api/exercise-defaults', (req, res) => {
  try {
    res.json(db.getExerciseDefaults(getUserId(req)));
  } catch (e) {
    console.error('GET /api/exercise-defaults', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-defaults/:name', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const stored = db.setExerciseDefaults(getUserId(req), req.params.name, req.body);
    if (!stored) return res.status(400).json({ error: 'Exercise name is required' });
    res.json(stored);
  } catch (e) {
    console.error('PUT /api/exercise-defaults/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// Fractional exercise → muscle attribution, driving the working-sets-per-muscle
// metric. Name-keyed for the same reason as the three above. PUT replaces one
// exercise's whole attribution rather than patching a single muscle — see
// db.setExerciseMuscles.
app.get('/api/exercise-muscles', (req, res) => {
  try {
    res.json(db.getExerciseMuscles());
  } catch (e) {
    console.error('GET /api/exercise-muscles', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-muscles/:name', (req, res) => {
  try {
    db.setExerciseMuscles(req.params.name, req.body?.muscles || {});
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-muscles/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// Movement-pattern tags (hinge/knee, unilateral) — only the axes the
// per-exercise `category` column can't already express. Name-keyed, same as above.
app.get('/api/exercise-patterns', (req, res) => {
  try {
    res.json(db.getExercisePatterns());
  } catch (e) {
    console.error('GET /api/exercise-patterns', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercise-patterns/:name', (req, res) => {
  try {
    // laterality is passed through UNDEFINED when the key is absent, never
    // coerced to null: db.setExercisePattern then falls back to the
    // `unilateral` boolean, which is how a backup without laterality restores.
    // An explicit null clears it.
    db.setExercisePattern(req.params.name, {
      hinge_knee: req.body?.hinge_knee ?? null,
      laterality: req.body?.laterality,
      unilateral: !!req.body?.unilateral,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/exercise-patterns/:name', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Exercise Merge ───────────────────────────────────────────────────────────────
// Folds one exercise name into another everywhere it appears — see
// db.mergeExerciseNames for everything it rewrites.
app.post('/api/exercises/merge', (req, res) => {
  try {
    const canonical = (req.body?.canonical || '').toString().trim();
    const alias     = (req.body?.alias || '').toString().trim();
    if (!canonical || !alias) return res.status(400).json({ error: 'canonical and alias are required' });
    // Compare EXACTLY, not case-insensitively: a case-only pair ("Pull Ups"
    // vs "Pull ups") is a real duplicate that must be mergeable.
    // db.mergeExerciseNames handles that path explicitly.
    if (canonical === alias) {
      return res.status(400).json({ error: 'canonical and alias must be different' });
    }
    res.json(db.mergeExerciseNames(canonical, alias, getUserId(req)));
  } catch (e) {
    console.error('POST /api/exercises/merge', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Day Schedule (retired) ─────────────────────────────────────────────────────
// Read-only; the dated planner replaced it (see db.js's day_schedule
// comment). Served only because the JSON backup carries it. No PUT: nothing
// edits a retired table, and POST /api/import restores it through
// db.setScheduleDay directly.
app.get('/api/schedule', (req, res) => {
  try {
    res.json(db.getSchedule(getUserId(req)));
  } catch (e) {
    console.error('GET /api/schedule', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Planned workouts ───────────────────────────────────────────────────────────
app.get('/api/plans', (req, res) => {
  try {
    res.json(db.getPlans(getUserId(req)));
  } catch (e) {
    console.error('GET /api/plans', e);
    res.status(500).json({ error: e.message });
  }
});

// Four because a planner cell draws a 2x2 of emoji and nothing more. A UI
// limit, enforced here so a raw API write can't store a day no view can draw.
// index.html's MAX_PLANS_PER_DAY must agree.
const MAX_PLANS_PER_DAY = 4;

// Replaces the day's whole list ({ items: [workout, ...] }, [] clears it), the
// same whole-array contract as PUT /api/lifts/:routineId. Each item must be
// something the Log tab could log: one of this user's routines as lift-N, or
// an activity_types key other than the bare 'lift' that no picker offers.
//
// An item ALREADY stored on this day is accepted even if it no longer
// qualifies, which matters for exactly one case: a past day planned with a
// routine that has since been archived. Validating the whole list fresh would
// make that day uneditable, since every edit re-sends the dead item. A write
// is rejected only for what it INTRODUCES — the same reasoning as
// normalizeGoal's merged-row check.
app.put('/api/plans/:date', (req, res) => {
  try {
    // Normalized then shape-checked, same order and reason as PUT /api/checkins/:date.
    const date = db.normalizeDateStr(req.params.date);
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    if (items.length > MAX_PLANS_PER_DAY) {
      return res.status(400).json({ error: `at most ${MAX_PLANS_PER_DAY} workouts per day` });
    }
    const userId = getUserId(req);
    const stored = db.getPlans(userId)[date] || [];
    const liveRoutines = new Set(db.getRoutines(userId).filter(r => !r.archived).map(r => `lift-${r.id}`));
    const types = db.getActivityTypes();
    for (const item of items) {
      const known = typeof item === 'string' && (/^lift-\d+$/.test(item)
        ? liveRoutines.has(item)
        : item !== 'lift' && Object.prototype.hasOwnProperty.call(types, item));
      if (!known && !stored.includes(item)) {
        return res.status(400).json({ error: `not a loggable workout: ${JSON.stringify(item)}` });
      }
    }
    db.setPlanDay(date, items, userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/plans/:date', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Shared date validation ───────────────────────────────────────────────────
// CLAUDE.md's date rule — every stored date is ISO YYYY-MM-DD — is enforced
// once per write path, and this is the check they all share.
// db.normalizeDateStr rewrites the legacy M/D/YYYY form and passes anything
// else through untouched, so without this "tomorrow" would be stored verbatim
// into PRIMARY KEY and UNIQUE columns that parseDateKey() cannot read back.
//
// ALWAYS CHECK AFTER db.normalizeDateStr, never before, or a legacy-shaped date
// from an old cached client is rejected instead of normalized —
// verify_backend.js asserts that round trip.
//
// NOT GATED: POST /api/import and POST /api/garmin/sync write through
// db.upsertCheckin directly. A restore is a record of what was, the same
// reasoning that keeps db.restoreGoal outside normalizeGoal.
//
// NO plausibility bound on distance from today: the check-in day is not the
// calendar day (see checkinDayStr) and back-filling an old day is legitimate.
function isIsoDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
// Optional date field: null/undefined/'' all mean "not set" and are fine.
function invalidOptionalDate(v) { return v !== undefined && v !== null && v !== '' && !isIsoDate(v); }

// ── History ────────────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    res.json(db.getHistory(getUserId(req)));
  } catch (e) {
    console.error('GET /api/history', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/history', (req, res) => {
  try {
    const bad = validateHistoryFields(req.body, { requireType: true });
    if (bad) return res.status(400).json({ error: bad });
    const id = db.addHistory(req.body, {}, getUserId(req));
    res.json({ id });
  } catch (e) {
    console.error('POST /api/history', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/history/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Owner-checked: ids are one AUTOINCREMENT sequence shared by every user.
    if (!db.historyBelongsToUser(id, getUserId(req))) {
      return res.status(404).json({ error: 'History entry not found' });
    }
    // requireType:false — a PATCH is a partial update and need not mention it.
    const bad = validateHistoryFields(req.body, { requireType: false });
    if (bad) return res.status(400).json({ error: bad });
    db.updateHistory(id, req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/history/:id', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/history/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!db.historyBelongsToUser(id, getUserId(req))) {
      return res.status(404).json({ error: 'History entry not found' });
    }
    // The workout goes; a niggle that started in it is still a real thing
    // that happened, so it loses its link rather than its row.
    db.transaction(() => {
      db.unlinkInjuriesFromHistory(id);
      db.deleteHistory(id);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/history/:id', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Bulk Import ────────────────────────────────────────────────────────────────
// Accepts the backup JSON the frontend produces. How each table replays:
//   - routines/lifts and schedule: replaced;
//   - history: appended, or replaced when `replaceHistory` is set;
//   - bodyweight/checkins: upsert by date; plans: upsert a whole day by date;
//   - activityTypes and the name-keyed exercise tables: upsert by key;
//   - exerciseDefaults: the restoring user's, upsert by name, after routines;
//   - pregnancyInfo: a user_id-keyed singleton, upserts;
//   - lifePhases: natural key (user_id, label, start_date), a replay adds nothing;
//   - garminDaily, activityRoutes, routeSegments and checkinFlagPrefs: natural
//     keys, converge on a replay;
//   - goals/injuries/pregnancyMilestones: no natural key, so each list the
//     payload carries REPLACES the user's rows of that kind (injuries take
//     their follow-ups with them); a second restore changes nothing;
//   - injuryCheckins: upsert on (injury_id, date), with injury_id remapped
//     onto the fresh ids restoreInjury hands out.
//
// THE WHOLE THING IS ONE TRANSACTION, the most important property of this
// route: it DESTROYS before it writes (clearHistory, archiving every routine),
// and one malformed record must roll all of it back rather than leave history
// half-refilled. Everything in here must stay SYNCHRONOUS — an `await` would
// commit early and run the rest outside the transaction. verify_dedup.js
// asserts this at the source. Story: DECISIONS.md#import-atomicity.
app.post('/api/import', (req, res) => {
  try {
    const { routines, lifts, schedule, plans, history, replaceHistory,
             bodyweight, checkins, activityTypes, users, exerciseCategoryOverrides, exerciseFormNotes,
             exerciseWeightless, exerciseMuscles, exercisePatterns, exerciseTimed,
             exerciseUnranked, exerciseDefaults,
             goals, injuries, injuryCheckins, pregnancyInfo, pregnancyMilestones,
             lifePhases, garminDaily, activityRoutes, routeSegments, checkinFlagPrefs } = req.body;
    // Restore is scoped to ONE user at a time, same as every other route —
    // see db.addHistory's comment for why a row's own embedded user_id
    // (present since export is a plain SELECT *) is deliberately ignored
    // rather than trusted.
    const userId = getUserId(req);

    db.transaction(() => {

      // Two backup shapes: current ones carry a `routines` array alongside
      // `lifts` keyed by routine id; legacy A/B/C ones carry `lifts` keyed by
      // the letters 'A'/'B'/'C' and no `routines`. Both go through the same
      // archive, recreate and remap path below.
      const isLegacyLifts = !Array.isArray(routines) && lifts &&
        ['A', 'B', 'C'].some(l => Array.isArray(lifts[l]));

      // VALIDATE BEFORE DESTROYING. restoreRoutine silently skips a routine
      // whose exercise array is missing, so a payload with `routines` but no
      // matching `lifts` would archive every live routine and recreate them
      // empty — nothing throws, and there is no un-archive UI.
      //
      // LIVE routines only: an archived one legitimately has no exercise list,
      // and is recreated empty so old history can still resolve its name.
      if (Array.isArray(routines) && routines.length) {
        const missing = routines
          .filter(r => !r.archived && !Array.isArray(lifts?.[String(r.id)]))
          .map(r => r.name);
        if (missing.length) {
          throw new Error(
            `Backup is missing the exercise list for ${missing.length} routine(s): ` +
            `${missing.join(', ')}. Nothing was changed.`
          );
        }
      }

      // `routines.length`, not just `Array.isArray`: `routines: []` must not
      // reach the archive loop, which would recreate nothing and also drop
      // every upcoming plan naming those routines — without anything throwing.
      let liftIdMap = null; // old id/letter (string) -> new routine id (number)
      if (isLegacyLifts || (Array.isArray(routines) && routines.length)) {
        liftIdMap = {};
        for (const existing of db.getRoutines(userId)) {
          // keepLoggedToday: false: history is about to be replaced and the
          // routine recreated under a new id, so a done item kept on today's
          // plan would name a dead routine (see archiveRoutine).
          if (!existing.archived) db.archiveRoutine(existing.id, { keepLoggedToday: false });
        }

        if (isLegacyLifts) {
          ['A', 'B', 'C'].forEach((letter) => {
            if (!Array.isArray(lifts[letter])) return;
            const created = db.createRoutine({ name: `Lift ${letter}`, emoji: '🏋️' }, userId);
            liftIdMap[letter] = created.id;
            db.setLifts(created.id, lifts[letter]);
          });
        } else {
          // ARCHIVED ROUTINES ARE RECREATED TOO. History references a routine
          // by id; an unmapped row would keep its old id string, which may now
          // belong to a different routine, and show the wrong name and emoji.
          //
          // Live ones are created FIRST so createRoutine's sequential
          // `position` reproduces the backup's display order without the
          // archived ones interleaving into it. Archiving a just-created
          // routine is safe here — no plan names it yet, and the plans block
          // below runs afterwards.
          const restoreRoutine = (r, archiveAfter) => {
            // target_per_week may be absent. Not re-validated, same as every
            // other table a restore replays.
            const target = typeof r.target_per_week === 'number' ? r.target_per_week : null;
            const created = db.createRoutine({ name: r.name, emoji: r.emoji, target_per_week: target }, userId);
            liftIdMap[String(r.id)] = created.id;
            // An archived routine's rows must not write over a live one's
            // exercise defaults; the seed below fills any name only it has.
            if (Array.isArray(lifts?.[String(r.id)])) db.setLifts(created.id, lifts[String(r.id)], { writeDefaults: !archiveAfter });
            if (archiveAfter) db.archiveRoutine(created.id);
          };
          for (const r of routines) if (!r.archived) restoreRoutine(r, false);
          for (const r of routines) if (r.archived)  restoreRoutine(r, true);
        }
      }

      if (schedule) {
        for (const [day, data] of Object.entries(schedule)) {
          const mapped = { ...data };
          if (liftIdMap && mapped.liftDay != null && liftIdMap[mapped.liftDay] != null) {
            mapped.liftDay = String(liftIdMap[mapped.liftDay]);
          }
          db.setScheduleDay(day, mapped, userId);
        }
      }

      // Dated plans, { [date]: [workout, ...] }. AFTER the routines block, and
      // it has to be: archiving the old routines there drops them from every
      // plan dated today or later, and this puts those days back with their
      // lift-N items remapped onto the recreated routines' ids, the same remap
      // history gets below. setPlanDay replaces a day's list, so replaying the
      // same backup twice is idempotent. Not re-validated, same as every other
      // table here: a restore is a record of what was.
      if (plans && typeof plans === 'object' && !Array.isArray(plans)) {
        for (const [date, list] of Object.entries(plans)) {
          if (!Array.isArray(list)) continue;
          const mapped = list.filter(w => typeof w === 'string').map(w => {
            const m = /^lift-(.+)$/.exec(w);
            return m && liftIdMap?.[m[1]] != null ? `lift-${liftIdMap[m[1]]}` : w;
          });
          db.setPlanDay(date, mapped, userId);
        }
      }

      // An empty history list with replaceHistory THROWS, rolling everything
      // back: `[]` would otherwise clear every workout and insert nothing, and
      // the frontend always sends replaceHistory: true. An empty list means a
      // truncated or hand-edited file, not "restore all but history".
      if (Array.isArray(history) && !history.length && replaceHistory) {
        throw new Error('Backup contains an empty history list. Nothing was changed.');
      }
      // Old history id -> the fresh one addHistory hands back, for
      // injuries.history_id below. Same problem as injuryIdMap: a replayed
      // row never keeps its id.
      const historyIdMap = {};
      if (Array.isArray(history) && history.length) {
        if (replaceHistory) db.clearHistory(userId);
        for (const record of history) {
          const mapped = { ...record };
          if (liftIdMap && mapped.type === 'lift' && mapped.lift != null && liftIdMap[mapped.lift] != null) {
            mapped.lift = String(liftIdMap[mapped.lift]);
          }
          // preserveSyncedAt: a restore replays history as it WAS, so a synced
          // activity keeps its real sync time rather than Date.now(), which
          // would drop the whole backlog into the journal-nag queue at once.
          // This route is the only caller that passes it.
          const newId = db.addHistory(mapped, { preserveSyncedAt: true }, userId);
          if (record?.id != null) historyIdMap[record.id] = newId;
        }
      }

      if (Array.isArray(bodyweight)) {
        for (const row of bodyweight) {
          if (!row?.date) continue;
          db.addBodyWeight(row.timestamp || Date.now(), row.date, row.weight_kg, userId);
        }
      }

      if (Array.isArray(checkins)) {
        for (const row of checkins) {
          if (!row?.date) continue;
          db.upsertCheckin(row.date, row, userId);
        }
      }

      if (Array.isArray(activityTypes)) {
        for (const row of activityTypes) db.restoreActivityType(row);
      }

      // users is global like activityTypes, not scoped to the restoring
      // user — see the comment on the users table's CREATE TABLE.
      if (Array.isArray(users)) {
        for (const row of users) db.restoreUser(row);
      }

      // The seven name-keyed exercise attributes, restored from ONE list — see
      // db.NAME_KEYED_EXERCISE_TABLES (forgetting one silently deletes that tag
      // for every exercise). Order matches that constant; verify_backend.js
      // asserts every table in it is handled here. Each payload is
      // { [exerciseName]: value } and each setter REPLACES that name's value,
      // so this restores exactly what was exported.
      const nameKeyedRestorers = {
        exercise_category_overrides: (name, v) => db.setExerciseCategoryOverride(name, v),
        exercise_form_notes:         (name, v) => db.setExerciseFormNote(name, v?.how_to, v?.mistakes),
        // A name present with a falsy value means "not weightless", which
        // setExerciseWeightless stores by deleting the row.
        exercise_weightless:         (name, v) => db.setExerciseWeightless(name, !!v),
        exercise_muscles:            (name, v) => db.setExerciseMuscles(name, v),
        exercise_patterns:           (name, v) => db.setExercisePattern(name, v || {}),
        exercise_timed:              (name, v) => db.setExerciseTimed(name, !!v),
        exercise_unranked:           (name, v) => db.setExerciseUnranked(name, !!v),
      };
      const nameKeyedPayloads = {
        exercise_category_overrides: exerciseCategoryOverrides,
        exercise_form_notes:         exerciseFormNotes,
        exercise_weightless:         exerciseWeightless,
        exercise_muscles:            exerciseMuscles,
        exercise_patterns:           exercisePatterns,
        exercise_timed:              exerciseTimed,
        exercise_unranked:           exerciseUnranked,
      };
      // These attributes are shared by every user, so a stale personal backup
      // must not overwrite tags for names it never mentions. When the payload
      // carries personal data (routines/lifts/history/goals), only names that
      // appear in THAT data are restored. A payload with none of those (a
      // name-keyed-only import, as the round-trip tests send) is applied
      // exactly as exported, since there is nothing to scope against.
      //
      // Residual risk: a name both users share can still be regressed by a
      // stale restore — there is no per-field updated_at to detect a newer
      // value. Same class as DECISIONS.md#cross-user-tag-wipe-on-merge.
      const isFullerRestore = (Array.isArray(routines) && routines.length > 0) ||
        (lifts && typeof lifts === 'object' && Object.keys(lifts).length > 0) ||
        (Array.isArray(history) && history.length > 0) ||
        (Array.isArray(goals) && goals.length > 0);
      const payloadExerciseNames = new Set();
      if (isFullerRestore) {
        if (lifts && typeof lifts === 'object') {
          for (const arr of Object.values(lifts)) {
            if (!Array.isArray(arr)) continue;
            for (const ex of arr) {
              const n = (ex?.name || '').trim().toLowerCase();
              if (n) payloadExerciseNames.add(n);
            }
          }
        }
        if (Array.isArray(history)) {
          for (const record of history) {
            if (record?.type !== 'lift' || !Array.isArray(record.exercises)) continue;
            for (const ex of record.exercises) {
              const n = (ex?.name || '').trim().toLowerCase();
              if (n) payloadExerciseNames.add(n);
            }
          }
        }
        if (Array.isArray(goals)) {
          for (const g of goals) {
            const n = (g?.exercise_name || '').trim().toLowerCase();
            if (n) payloadExerciseNames.add(n);
          }
        }
      }
      for (const table of db.NAME_KEYED_EXERCISE_TABLES) {
        const payload = nameKeyedPayloads[table];
        if (!payload || typeof payload !== 'object') continue;
        for (const [name, value] of Object.entries(payload)) {
          if (isFullerRestore && !payloadExerciseNames.has((name || '').trim().toLowerCase())) continue;
          nameKeyedRestorers[table](name, value);
        }
      }

      // Goals, injuries and pregnancy milestones have no natural key, so each
      // list the payload CARRIES replaces the user's rows of that kind, the
      // way history does: restoring a recent backup must not double them, and
      // restoring the same file twice must change nothing the second time. A
      // payload without the key leaves that kind alone. Unlike history, an
      // EMPTY list is honoured: having no goals is an ordinary state to back
      // up. Story: DECISIONS.md#import-atomicity.
      //
      // user_id is forced to the restoring user here, same reasoning as
      // db.addHistory: a row's own embedded user_id (present since export is
      // a plain SELECT *) is never trusted, only ever overwritten.
      if (Array.isArray(goals)) {
        db.clearGoals(userId);
        for (const row of goals) db.restoreGoal({ ...row, user_id: userId });
      }

      // injuries replay as fresh inserts, so the id a row lands on here is NOT
      // the id it had in the backup — and injury_checkins references injuries
      // by id. Remap through this map or every restored daily follow-up points
      // at the wrong injury (or at nothing at all). clearInjuries takes the old
      // follow-ups with the old injuries.
      const injuryIdMap = {};
      if (Array.isArray(injuries)) {
        db.clearInjuries(userId);
        for (const row of injuries) {
          // history_id is remapped or NULLed, never kept raw: without the
          // workout in this payload the old id names nothing, or worse, some
          // other workout that happens to hold it now.
          const history_id = row?.history_id != null ? (historyIdMap[row.history_id] ?? null) : null;
          const newId = db.restoreInjury({ ...row, history_id, user_id: userId });
          if (row?.id != null && newId != null) injuryIdMap[row.id] = newId;
        }
      }
      if (Array.isArray(injuryCheckins)) {
        for (const row of injuryCheckins) {
          // Fall back to the raw id for a partial import that carries
          // injuryCheckins without the injuries array to remap against.
          db.restoreInjuryCheckin(row, injuryIdMap[row?.injury_id] ?? row?.injury_id);
        }
      }

      // pregnancy_info is a user_id-keyed singleton (like apple_sync_status),
      // so restorePregnancyInfo upserts rather than plain-inserting — a
      // second restore of the same backup must not throw a PK collision.
      if (pregnancyInfo && typeof pregnancyInfo === 'object') {
        db.restorePregnancyInfo(pregnancyInfo, userId);
      }
      // Replaced, like goals above.
      if (Array.isArray(pregnancyMilestones)) {
        db.clearPregnancyMilestones(userId);
        for (const row of pregnancyMilestones) db.restorePregnancyMilestone(row, userId);
      }
      if (Array.isArray(lifePhases)) {
        for (const row of lifePhases) db.restoreLifePhase(row, userId);
      }
      // Converges on a re-restore by its natural key, (user_id, date), rather
      // than by clearing first: the restore is the upsert. See
      // restoreGarminDaily.
      if (Array.isArray(garminDaily)) {
        for (const row of garminDaily) db.restoreGarminDaily(row, userId);
      }
      // (user_id, external_id) is a natural key, so this converges on a
      // re-restore. NOT run through validateRouteFields, for the reason
      // db.restoreGoal stays outside normalizeGoal: the write path is the
      // gateway, the restore path is not.
      //
      // Routes need not travel with history: they reference an activity by
      // external_id, which survives a restore unchanged. A route whose
      // activity is missing is invisible through the join until it returns.
      if (Array.isArray(activityRoutes)) {
        for (const row of activityRoutes) db.restoreActivityRoute(row, userId);
      }
      // (user_id, name) is the natural key: an upsert, so a replay converges.
      // Outside routeSegmentError for the same reason routes skip
      // validateRouteFields here.
      if (Array.isArray(routeSegments)) {
        for (const row of routeSegments) db.restoreRouteSegment(row, userId);
      }
      // (user_id, period, key) is the natural key: an upsert, so a replay
      // converges. Outside the API's checks, like the two above. A check-in
      // naming a chip this list lacks still renders (checkinFlagDefs).
      if (Array.isArray(checkinFlagPrefs)) {
        for (const row of checkinFlagPrefs) db.restoreCheckinFlagPref(row, userId);
      }

      // The restoring user's exercise defaults, AFTER the routines block: the
      // routine rows wrote theirs through already, and this puts back the
      // exported truth on top, including names in no live routine. An older
      // backup without the key leaves the routine rows' values, and the seed
      // fills any name only an archived routine carried.
      if (exerciseDefaults && typeof exerciseDefaults === 'object' && !Array.isArray(exerciseDefaults)) {
        for (const [name, d] of Object.entries(exerciseDefaults)) {
          if (d && typeof d === 'object') db.setExerciseDefaults(userId, name, d);
        }
      }
      db.seedExerciseDefaultsFromRoutines();
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/import', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Full database backup ────────────────────────────────────────────────────────
// Streams a raw, point-in-time-consistent copy of the entire SQLite file
// (every table, automatically — see db.backupDatabase for why this exists
// alongside the JSON export). Restoring is deliberately manual, never in-app:
// replace data/workout.db, DELETE the leftover -wal and -shm files, restart
// the container (OPERATIONS.md, Backup & Restore). The sidecar deletion is
// required: a WAL is bound to its database by filename only, so a stale one
// is replayed over the restored file.
app.get('/api/backup/db', async (req, res) => {
  let tmpPath;
  try {
    tmpPath = await db.backupDatabase();
    const filename = `workout_full_backup_${db.isoDateStr()}.db`;
    res.download(tmpPath, filename, (err) => {
      fs.unlink(tmpPath, () => {});
      if (err) console.error('GET /api/backup/db (download)', err);
    });
  } catch (e) {
    console.error('GET /api/backup/db', e);
    if (tmpPath) fs.unlink(tmpPath, () => {});
    res.status(500).json({ error: e.message });
  }
});

// ── Backup job status ──────────────────────────────────────────────────────────
// The reporting contract for the two backup cron jobs, mirroring
// POST /api/garmin/sync-status: each script POSTs its outcome at the end of
// every run (failure paths included), the browser GETs it for the top-bar
// badge. See db.js's backup_status table comment. Story:
// DECISIONS.md#backup-monitoring.
//
// Not user-scoped: a database backup covers everybody's data at once. Same
// LAN-only trust boundary as POST /api/garmin/sync-status.
//
// A CLOSED vocabulary: the job names are wired into both scripts and the
// badge's staleness thresholds, so an unknown one is a typo — and a typo that
// created its own row would report healthy while the real job stayed silent.
const BACKUP_JOBS = ['dump', 'pull'];

app.get('/api/backup/status', (req, res) => {
  try {
    res.json(db.getBackupStatus());
  } catch (e) {
    console.error('GET /api/backup/status', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/status', (req, res) => {
  try {
    const { job, ok, message } = req.body || {};
    if (!BACKUP_JOBS.includes(job)) {
      return res.status(400).json({ error: `job must be one of: ${BACKUP_JOBS.join(', ')}` });
    }
    res.json(db.setBackupStatus(job, { ok: !!ok, message }));
  } catch (e) {
    console.error('POST /api/backup/status', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Top-bar snapshot (the iPhone widget) ───────────────────────────────────────
// The top bar is computed ONLY in index.html, from its whole loaded dataset.
// Rather than re-derive streaks, plan suggestions and chips a second time here,
// the app PUTs what renderWeekStrip just drew and the widget
// (scripts/topbar_widget.js) GETs it back. So a snapshot is only as fresh as
// the last time the app was open; it carries its own date and computed_at so
// the widget can say how old it is.
//
// Held in memory, per user, and nowhere else: it is derived, the next app
// open rebuilds it, and keeping it out of workout.db keeps it out of both
// backup paths. A restart forgets it; GET answers null until the app is next
// opened. Story: DECISIONS.md#top-bar-widget.
const topbarSnapshots = new Map();
const TOPBAR_SNAPSHOT_MAX_BYTES = 32 * 1024;

app.get('/api/topbar-snapshot', (req, res) => {
  res.json(topbarSnapshots.get(getUserId(req)) || null);
});

app.put('/api/topbar-snapshot', (req, res) => {
  const snap = req.body;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return res.status(400).json({ error: 'snapshot must be an object' });
  }
  if (!isIsoDate(snap.date) || !Array.isArray(snap.dots)) {
    return res.status(400).json({ error: 'snapshot needs an ISO date and a dots array' });
  }
  if (JSON.stringify(snap).length > TOPBAR_SNAPSHOT_MAX_BYTES) {
    return res.status(400).json({ error: `snapshot over ${TOPBAR_SNAPSHOT_MAX_BYTES} bytes` });
  }
  const stored = { ...snap, received_at: new Date().toISOString() };
  topbarSnapshots.set(getUserId(req), stored);
  res.json(stored);
});

// ── Body Weight ────────────────────────────────────────────────────────────────
app.get('/api/bodyweight', (req, res) => {
  try { res.json(db.getBodyWeight(getUserId(req))); }
  catch (e) { console.error('GET /api/bodyweight', e); res.status(500).json({ error: e.message }); }
});

// The range matches BODY_WEIGHT_MIN/MAX in index.html. The UI already
// enforces it; this exists so a stale cached page, a hand-edited restore or a
// curl can't store a weigh-in that bodyWeightOn() would then impute across a
// 30-day window of bodyweight sets.
const BODY_WEIGHT_MIN = 50, BODY_WEIGHT_MAX = 300;

app.post('/api/bodyweight', (req, res) => {
  try {
    const { weight_kg, date, timestamp } = req.body;
    const kg = parseFloat(weight_kg);
    if (!weight_kg || isNaN(kg)) return res.status(400).json({ error: 'Invalid weight' });
    if (kg < BODY_WEIGHT_MIN || kg > BODY_WEIGHT_MAX) {
      return res.status(400).json({ error: `weight_kg must be between ${BODY_WEIGHT_MIN} and ${BODY_WEIGHT_MAX}` });
    }
    // Optional — omitted means today. Normalized first, same order and reason
    // as PUT /api/checkins/:date; see "Shared date validation".
    const day = date ? db.normalizeDateStr(date) : null;
    if (invalidOptionalDate(day)) return res.status(400).json({ error: 'date must be YYYY-MM-DD or null' });
    db.addBodyWeight(
      timestamp || Date.now(),
      day       || db.isoDateStr(),
      kg,
      getUserId(req)
    );
    res.json({ ok: true });
  } catch (e) { console.error('POST /api/bodyweight', e); res.status(500).json({ error: e.message }); }
});

// POST upserts on the UNIQUE date, so this is the only way to say "that
// reading was wrong" rather than "it was this other number". A hard delete:
// one measurement per day, and a wrong one is noise, not history.
app.delete('/api/bodyweight/:date', (req, res) => {
  try {
    const { changes } = db.deleteBodyWeight(req.params.date, getUserId(req));
    if (!changes) return res.status(404).json({ error: 'No body weight logged for that date' });
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/bodyweight/:date', e); res.status(500).json({ error: e.message }); }
});

// ── Check-ins (morning / evening) ────────────────────────────────────────────────
app.get('/api/checkins', (req, res) => {
  try { res.json(db.getCheckins(getUserId(req))); }
  catch (e) { console.error('GET /api/checkins', e); res.status(500).json({ error: e.message }); }
});

// READ-ONLY ON PURPOSE, and the only route this table has for the browser.
// There is no PUT/PATCH/DELETE because these are measurements, not entries:
// the sole writer is POST /api/garmin/sync. That is the same stance
// PUT /api/checkins/:date takes by omitting the Garmin sleep columns from its
// validKeys allow-list, applied to a whole table instead of two columns.
app.get('/api/garmin-daily', (req, res) => {
  try { res.json(db.getGarminDaily(getUserId(req))); }
  catch (e) { console.error('GET /api/garmin-daily', e); res.status(500).json({ error: e.message }); }
});

// ── Activity routes (GPS polylines) ────────────────────────────────────────────
// Story: DECISIONS.md#route-heatmap.

// A polyline is ~6 characters per point, so 24 KB is about 4,000 points —
// several times the longest simplified ride, and a hard ceiling for the same
// reason as MAX_CHECKIN_TEXT (an oversized write is a one-way door), with
// more force since a script writes this in a loop.
const MAX_ROUTE_CHARS = 24 * 1024;

// How many missing routes ?wanted=1 hands out at a time. See
// db.getRoutelessActivityIds for why a cap is load-bearing rather than tidy.
const ROUTE_WANTED_DEFAULT = 25;
const ROUTE_WANTED_MAX = 500;

// Server-side only to validate — the map draws with its own copy in
// public/index.html, and garmin_sync.py holds the matching ENCODER. A
// mismatched pair does not throw, it draws a plausible wrong line, so
// testing/route_fixture.json pins one known track in all three and each
// harness asserts against it.
//
// Returns null on anything malformed rather than throwing, so a hostile body
// is a 400 and not a 500.
function decodePolyline(str) {
  if (typeof str !== 'string' || !str.length) return null;
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    const deltas = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        if (i >= str.length || shift > 30) return null;
        b = str.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) return null;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      deltas.push((result & 1) ? ~(result >> 1) : (result >> 1));
    }
    lat += deltas[0];
    lon += deltas[1];
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

// Returns an error string, or null when the route is coherent. The house
// shape, same as validateCheckinFields and lifePhaseError.
//
// THE RANGE CHECK ONLY PARTLY GUARDS AGAINST A SWAPPED LAT/LON. It rejects a
// swap only where a longitude past +/-90 becomes an impossible latitude. It
// does NOT catch one east of 90W, which includes most of the eastern US
// (a longitude of -86.5 is a legal latitude). What catches a swap is LOOKING AT
// THE MAP — the browser screenshot gate in OPERATIONS.md. verify_backend.js
// pins both cases.
function validateRouteFields(route) {
  if (!route || typeof route !== 'object') return 'route must be an object';
  if (route.external_id == null || String(route.external_id) === '') return 'external_id is required';
  if (typeof route.polyline !== 'string' || !route.polyline.length) return 'polyline must be a non-empty string';
  if (route.polyline.length > MAX_ROUTE_CHARS) {
    return `polyline exceeds ${MAX_ROUTE_CHARS} characters (${route.polyline.length})`;
  }
  const pts = decodePolyline(route.polyline);
  if (!pts) return 'polyline is not a valid encoded polyline';
  if (pts.length < 2) return 'polyline must decode to at least 2 points';
  for (const [la, lo] of pts) {
    if (!Number.isFinite(la) || la < -90 || la > 90) return `latitude ${la} is out of range`;
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) return `longitude ${lo} is out of range`;
  }
  // breaks: the pause-jump segments garmin_sync.py found (db.js's CREATE TABLE
  // explains NULL vs []). Optional -- absent stores NULL, "not checked", which
  // re-queues the route -- but when present each must name a real segment of
  // THIS polyline, strictly ascending. An index that points past the end or
  // at the wrong segment would not throw anywhere; it would quietly leave a
  // jump drawn or cut a real road out.
  if (route.breaks != null) {
    if (!Array.isArray(route.breaks)) return 'breaks must be an array of segment indices';
    let prev = -1;
    for (const i of route.breaks) {
      if (!Number.isInteger(i) || i < 0 || i > pts.length - 2) {
        return `break ${i} is not a segment of a ${pts.length}-point polyline`;
      }
      if (i <= prev) return 'breaks must be strictly ascending';
      prev = i;
    }
  }
  // times: seconds since the first sample, ONE PER POINT, never decreasing --
  // the map times segments by interpolating between them, so one out of step
  // shifts every effort after it. Optional like breaks (absent stores NULL
  // and re-queues), and [] is the sync's "checked, the samples had none".
  if (route.times != null) {
    if (!Array.isArray(route.times)) return 'times must be an array of seconds';
    if (route.times.length && route.times.length !== pts.length) {
      return `times has ${route.times.length} entries for a ${pts.length}-point polyline`;
    }
    let prev = 0;
    for (const t of route.times) {
      if (!Number.isInteger(t) || t < 0) return `time ${t} is not a whole number of seconds`;
      if (t < prev) return 'times must never decrease';
      prev = t;
    }
  }
  // elev and hr: the watch's reading at each point, for the outing summary's
  // profile. Same optional-and-[] rule as times, but an entry may be null (no
  // reading there). The ranges only catch a garbled value; anything a body or
  // a planet allows passes.
  for (const [key, lo, hi] of [['elev', -500, 9000], ['hr', 20, 260]]) {
    const v = route[key];
    if (v == null) continue;
    if (!Array.isArray(v)) return `${key} must be an array`;
    if (v.length && v.length !== pts.length) return `${key} has ${v.length} entries for a ${pts.length}-point polyline`;
    for (const x of v) {
      if (x !== null && (!Number.isFinite(x) || x < lo || x > hi)) return `${key} value ${x} is out of range`;
    }
  }
  return null;
}

// Bounds are recomputed from the polyline rather than trusted from the body:
// they are what the map fits its view to before decoding anything, so a wrong
// one sends the viewport somewhere empty and looks like missing data.
function boundsOf(points) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const [la, lo] of points) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  return [minLat, minLon, maxLat, maxLon];
}

app.get('/api/activity-routes', (req, res) => {
  try {
    const userId = getUserId(req);

    // The work queue for garmin_sync.py and backfill_garmin_routes.py: which
    // routes are missing from this same collection.
    if (req.query.wanted) {
      const asked = parseInt(req.query.limit, 10);
      const limit = Number.isInteger(asked) && asked > 0
        ? Math.min(asked, ROUTE_WANTED_MAX)
        : ROUTE_WANTED_DEFAULT;
      return res.json(db.getRoutelessActivityIds(userId, limit));
    }

    // NO RESPONSE MEMO, deliberately. Unlike the exercise library this is
    // per-user, mutable and read once a session — and it is a JOIN, so a
    // history write changes it while activity_routes sits still, which no
    // cheap fingerprint tracks. Express's weak ETag still gives a 304.
    // ?profile=1 adds elev and hr, for the JSON backup only.
    res.json(db.getActivityRoutes(userId, { profile: !!req.query.profile }));
  } catch (e) {
    console.error('GET /api/activity-routes', e);
    res.status(500).json({ error: e.message });
  }
});

// One outing's route WITH its elevation and heart rate, for the outing
// summary in the Log and Journal tabs -- which would otherwise have to pull
// every route the user has to draw one. 404 for an activity with no route,
// or one that is not this user's.
app.get('/api/activity-routes/:externalId', (req, res) => {
  try {
    const r = db.getActivityRouteWithProfile(req.params.externalId, getUserId(req));
    if (!r) return res.status(404).json({ error: 'No route for that activity' });
    res.json(r);
  } catch (e) {
    console.error('GET /api/activity-routes/:externalId', e);
    res.status(500).json({ error: e.message });
  }
});

// The sole writer, called by garmin_sync.py and backfill_garmin_routes.py --
// never by the browser, which has no GPS to offer.
//
// PER-ROUTE validation with partial success, reported, rather than an
// all-or-nothing 400: one corrupt track in a batch must not throw away the
// rest. A malformed ENVELOPE is still a 400.
//
// `none` (optional) lists activities Garmin answered with NO track, recorded
// in activity_route_misses so the ?wanted=1 queue stops offering them. Garmin
// ids only, the same all-digits rule the queue applies, and checked as a whole
// before anything is written: it is part of the envelope.
app.post('/api/activity-routes', (req, res) => {
  try {
    const userId = getUserId(req);
    const { routes, none = [] } = req.body || {};
    if (!Array.isArray(routes)) return res.status(400).json({ error: 'routes must be an array' });
    if (!Array.isArray(none) || !none.every(id => /^[0-9]+$/.test(String(id)))) {
      return res.status(400).json({ error: 'none must be an array of Garmin activity ids' });
    }

    let stored = 0;
    const rejected = [];
    for (const route of routes) {
      const err = validateRouteFields(route);
      if (err) {
        rejected.push({ external_id: route && route.external_id, error: err });
        continue;
      }
      const pts = decodePolyline(route.polyline);
      db.upsertActivityRoute({
        external_id: route.external_id,
        polyline: route.polyline,
        point_count: pts.length,
        bounds: boundsOf(pts),
        fetched_at: Date.now(),
        breaks: Array.isArray(route.breaks) ? route.breaks : null,
        times: Array.isArray(route.times) ? route.times : null,
        elev: Array.isArray(route.elev) ? route.elev : null,
        hr: Array.isArray(route.hr) ? route.hr : null,
      }, userId);
      stored++;
    }
    // A new route is a new place and time to look up. Not awaited: the sync
    // that POSTed this must not wait on a third party.
    if (stored) fillActivityWeather();
    const missing = none.length ? db.markRoutesMissing(none.map(String), userId) : 0;
    res.json({ stored, rejected, missing });
  } catch (e) {
    console.error('POST /api/activity-routes', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Activity photos ─────────────────────────────────────────────────────────
// Photos taken on an outing, shown in its summary. FILES under
// data/photos/{user_id}/{external_id}/, NOT rows: the directory is the index,
// so there is no table for a restore to remap, and the nightly whole-file DB
// snapshots don't carry every photo again each night. The flip side is that
// GET /api/backup/db and the JSON export do NOT include them --
// scripts/pull_backups.sh copies the directory instead.
// Story: DECISIONS.md#outing-summary.
//
// Keyed by external_id, the natural key routes use, so a photo outlives a
// history row's fresh id on restore and re-attaches if a deleted activity is
// synced again. The client shrinks each one to a JPEG before upload (which
// also drops EXIF location), so the server only ever stores JPEG and checks
// its magic bytes rather than trusting the Content-Type.
//
// Every path segment is matched against a pattern before it touches the
// filesystem, so neither id can climb out of the user's directory.
//
// A name's 13 digits are the moment the photo was TAKEN when the phone could
// read that from its EXIF (POST ?taken=), else the moment it was uploaded, so
// names sort in the order the photos were taken. An upload made after the
// outing carries a moment outside it, so a name's time is never mistaken for
// a point along the route. Story: DECISIONS.md#photos-everywhere.
//
// Each photo may carry a small thumbnail beside it, `<name>.thumb.jpg`, made
// by the client: the server has no image library. The list never shows one
// (PHOTO_NAME doesn't match it), and deleting the photo deletes it too.
const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const PHOTO_THUMB_MAX_BYTES = 512 * 1024;
const PHOTOS_PER_ACTIVITY = 8;
const PHOTO_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PHOTO_NAME = /^[0-9]{13}-[0-9a-f]{8}\.jpg$/;
// The earliest capture time accepted; the latest is a day and a half past
// the server's clock, which covers any timezone and a phone's clock drift.
const PHOTO_TAKEN_MIN_MS = Date.UTC(2000, 0, 1);
const PHOTO_TAKEN_SLACK_MS = 36 * 60 * 60 * 1000;

function photoDir(userId, externalId) {
  return path.join(DATA_DIR, 'photos', String(userId), externalId);
}

function photoThumbName(name) {
  return name.replace(/\.jpg$/, '.thumb.jpg');
}

function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

function listPhotos(userId, externalId) {
  try {
    return fs.readdirSync(photoDir(userId, externalId)).filter(n => PHOTO_NAME.test(n)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function photoParamsError(req) {
  if (!PHOTO_EXTERNAL_ID.test(req.params.externalId)) return 'not an activity id';
  if (req.params.name !== undefined && !PHOTO_NAME.test(req.params.name)) return 'not a photo name';
  return null;
}

// Every outing's list at once, { [external_id]: [name, ...] }, so a view
// drawing many days knows which have photos without asking one by one. An
// outing with none is absent rather than an empty list.
app.get('/api/activity-photos', (req, res) => {
  try {
    const userId = getUserId(req);
    let dirs;
    try {
      dirs = fs.readdirSync(path.join(DATA_DIR, 'photos', String(userId)), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return res.json({});
      throw e;
    }
    const out = {};
    for (const d of dirs) {
      if (!d.isDirectory() || !PHOTO_EXTERNAL_ID.test(d.name)) continue;
      const names = listPhotos(userId, d.name);
      if (names.length) out[d.name] = names;
    }
    res.json(out);
  } catch (e) {
    console.error('GET /api/activity-photos', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/activity-photos/:externalId', (req, res) => {
  try {
    const err = photoParamsError(req);
    if (err) return res.status(400).json({ error: err });
    res.json(listPhotos(getUserId(req), req.params.externalId));
  } catch (e) {
    console.error('GET /api/activity-photos', e);
    res.status(500).json({ error: e.message });
  }
});

// A name is never reused (time + random), so the bytes behind it never change.
app.get('/api/activity-photos/:externalId/:name', (req, res) => {
  const err = photoParamsError(req);
  if (err) return res.status(400).json({ error: err });
  const file = path.join(photoDir(getUserId(req), req.params.externalId), req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No such photo' });
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('image/jpeg').sendFile(file);
});

// A thumbnail is made from the photo it sits beside, so once made it never
// changes either. Until one exists (a photo from before thumbnails, or one
// whose PUT failed) this answers with the PHOTO itself, marked
// X-Photo-Thumb: missing and never cached, and the client makes the
// thumbnail from it and PUTs it back: one request, where a 404 would cost a
// second fetch and a console error in every browser.
app.get('/api/activity-photos/:externalId/:name/thumb', (req, res) => {
  const err = photoParamsError(req);
  if (err) return res.status(400).json({ error: err });
  const dir = photoDir(getUserId(req), req.params.externalId);
  const thumb = path.join(dir, photoThumbName(req.params.name));
  if (fs.existsSync(thumb)) {
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    return res.type('image/jpeg').sendFile(thumb);
  }
  const photo = path.join(dir, req.params.name);
  if (!fs.existsSync(photo)) return res.status(404).json({ error: 'No such photo' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Photo-Thumb', 'missing');
  res.type('image/jpeg').sendFile(photo);
});

// Idempotent: a second PUT replaces the first. Only beside a photo that
// exists, so a thumbnail never outlives its photo or names one never stored.
app.put('/api/activity-photos/:externalId/:name/thumb',
  express.raw({ type: 'image/jpeg', limit: PHOTO_THUMB_MAX_BYTES }),
  (req, res) => {
    try {
      const err = photoParamsError(req);
      if (err) return res.status(400).json({ error: err });
      const dir = photoDir(getUserId(req), req.params.externalId);
      if (!fs.existsSync(path.join(dir, req.params.name))) return res.status(404).json({ error: 'No such photo' });
      if (!isJpeg(req.body)) return res.status(400).json({ error: 'body must be a JPEG image (Content-Type: image/jpeg)' });
      const thumb = photoThumbName(req.params.name);
      const tmp = path.join(dir, `.${thumb}.tmp`);
      fs.writeFileSync(tmp, req.body);
      fs.renameSync(tmp, path.join(dir, thumb));
      res.status(204).end();
    } catch (e) {
      console.error('PUT /api/activity-photos thumb', e);
      res.status(500).json({ error: e.message });
    }
  });

app.post('/api/activity-photos/:externalId',
  express.raw({ type: 'image/jpeg', limit: PHOTO_MAX_BYTES }),
  (req, res) => {
    try {
      const err = photoParamsError(req);
      if (err) return res.status(400).json({ error: err });
      // ?taken= is optional: the phone sends it only when the photo's EXIF
      // carried a capture time. Malformed or implausible is refused rather
      // than silently replaced, so a client bug can't pass as "no time".
      let stamp = Date.now();
      if (req.query.taken !== undefined) {
        const taken = String(req.query.taken);
        const ms = /^[0-9]{13}$/.test(taken) ? Number(taken) : NaN;
        if (!(ms >= PHOTO_TAKEN_MIN_MS && ms <= Date.now() + PHOTO_TAKEN_SLACK_MS)) {
          return res.status(400).json({ error: 'taken must be a capture time in epoch milliseconds' });
        }
        stamp = ms;
      }
      const userId = getUserId(req), externalId = req.params.externalId;
      if (!db.hasExternalId(externalId, userId)) return res.status(404).json({ error: 'No such activity' });
      if (!isJpeg(req.body)) {
        return res.status(400).json({ error: 'body must be a JPEG image (Content-Type: image/jpeg)' });
      }
      const buf = req.body;
      if (listPhotos(userId, externalId).length >= PHOTOS_PER_ACTIVITY) {
        return res.status(409).json({ error: `at most ${PHOTOS_PER_ACTIVITY} photos per activity` });
      }
      const dir = photoDir(userId, externalId);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${String(stamp).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}.jpg`;
      // Written under a name the list ignores, then renamed: a half-written
      // file is never listed.
      const tmp = path.join(dir, `.${name}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(dir, name));
      res.status(201).json({ name, photos: listPhotos(userId, externalId) });
    } catch (e) {
      console.error('POST /api/activity-photos', e);
      res.status(500).json({ error: e.message });
    }
  });

app.delete('/api/activity-photos/:externalId/:name', (req, res) => {
  try {
    const err = photoParamsError(req);
    if (err) return res.status(400).json({ error: err });
    const userId = getUserId(req), externalId = req.params.externalId;
    const file = path.join(photoDir(userId, externalId), req.params.name);
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'No such photo' });
      throw e;
    }
    try { fs.unlinkSync(path.join(photoDir(userId, externalId), photoThumbName(req.params.name))); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const left = listPhotos(userId, externalId);
    if (!left.length) { try { fs.rmdirSync(photoDir(userId, externalId)); } catch (e) {} }
    res.json({ photos: left });
  } catch (e) {
    console.error('DELETE /api/activity-photos', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Route segments ──────────────────────────────────────────────────────────
// A stretch the user marked on a route, timed by the CLIENT on every outing of
// the same type that covers it -- efforts are derived, never stored (see the
// route_segments table comment). Same ownership pattern as life phases: ids
// are one sequence across users, so a row is reachable only through its
// owner's list. Story: DECISIONS.md#route-segments.
//
// A PATCH may move the stretch as well as rename it ("Adjust ends"). Its type
// never changes: a run segment stays a run segment. Moving it re-times every
// effort, which is safe because none is stored, and the editor says so
// before it saves. Story: DECISIONS.md#route-segments.
const SEGMENT_NAME_MAX = 60;
// A sanity floor, not the UI's: the editor asks for 100 m, and the polyline
// round trip can take a metre or two off that.
const SEGMENT_MIN_M = 50;

function polylineLengthM(pts) {
  const R = 6371008.8, rad = Math.PI / 180;
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [la1, lo1] = pts[i - 1], [la2, lo2] = pts[i];
    const h = Math.sin((la2 - la1) * rad / 2) ** 2
      + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin((lo2 - lo1) * rad / 2) ** 2;
    m += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return m;
}

function segmentNameError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'name is required';
  if (name.trim().length > SEGMENT_NAME_MAX) return `name must be at most ${SEGMENT_NAME_MAX} characters`;
  return null;
}

// Returns an error string, or null. The polyline gets the route checks minus
// external_id, since a segment references no activity.
function routeSegmentError(body) {
  const nameErr = segmentNameError(body.name);
  if (nameErr) return nameErr;
  if (typeof body.type !== 'string' || !body.type.trim()) return 'type is required';
  if (db.NON_ROUTE_TYPES.includes(body.type)) return `a ${body.type} has no route to mark a segment on`;
  return segmentPolylineError(body.polyline);
}

function segmentPolylineError(polyline) {
  if (typeof polyline !== 'string' || !polyline.length) return 'polyline must be a non-empty string';
  if (polyline.length > MAX_ROUTE_CHARS) return `polyline exceeds ${MAX_ROUTE_CHARS} characters`;
  const pts = decodePolyline(polyline);
  if (!pts || pts.length < 2) return 'polyline must decode to at least 2 points';
  for (const [la, lo] of pts) {
    if (!Number.isFinite(la) || la < -90 || la > 90) return `latitude ${la} is out of range`;
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) return `longitude ${lo} is out of range`;
  }
  if (polylineLengthM(pts) < SEGMENT_MIN_M) return `a segment must be at least ${SEGMENT_MIN_M} m long`;
  return null;
}

app.get('/api/route-segments', (req, res) => {
  try { res.json(db.getRouteSegments(getUserId(req))); }
  catch (e) { console.error('GET /api/route-segments', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/route-segments', (req, res) => {
  try {
    const userId = getUserId(req);
    const body = req.body || {};
    const err = routeSegmentError(body);
    if (err) return res.status(400).json({ error: err });
    const name = body.name.trim();
    if (db.routeSegmentNameTaken(userId, name)) {
      return res.status(409).json({ error: `You already have a segment called "${name}"` });
    }
    res.json(db.createRouteSegment({
      name, type: body.type.trim(), polyline: body.polyline,
      length_m: Math.round(polylineLengthM(decodePolyline(body.polyline)) * 10) / 10,
    }, userId));
  } catch (e) { console.error('POST /api/route-segments', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/route-segments/:id', (req, res) => {
  try {
    const userId = getUserId(req);
    const id = parseInt(req.params.id, 10);
    if (!db.getRouteSegments(userId).some(s => s.id === id)) {
      return res.status(404).json({ error: 'Segment not found' });
    }
    const { name, polyline } = req.body || {};
    if (name === undefined && polyline === undefined) return res.status(400).json({ error: 'nothing to change: send name and/or polyline' });
    const err = (name !== undefined && segmentNameError(name)) || (polyline !== undefined && segmentPolylineError(polyline));
    if (err) return res.status(400).json({ error: err });
    if (name !== undefined && db.routeSegmentNameTaken(userId, name.trim(), id)) {
      return res.status(409).json({ error: `You already have a segment called "${name.trim()}"` });
    }
    res.json(db.updateRouteSegment(id, {
      name: name !== undefined ? name.trim() : undefined,
      polyline,
      length_m: polyline !== undefined ? Math.round(polylineLengthM(decodePolyline(polyline)) * 10) / 10 : undefined,
    }));
  } catch (e) { console.error('PATCH /api/route-segments/:id', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/route-segments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!db.getRouteSegments(getUserId(req)).some(s => s.id === id)) {
      return res.status(404).json({ error: 'Segment not found' });
    }
    db.deleteRouteSegment(id);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/route-segments/:id', e); res.status(500).json({ error: e.message }); }
});

// ── Check-in chips ──────────────────────────────────────────────────────────
// One user's own chips (c_ keys) and their show/hide choices for the built-in
// ones; the two row kinds are in the checkin_flag_prefs table comment. The
// built-in list itself lives in index.html, so the server tells the kinds
// apart by the c_ prefix alone. Every write answers with the user's WHOLE
// list: a move renumbers its neighbours, and the list is a handful of rows.
// Story: DECISIONS.md#custom-check-in-chips.
//
// MAX_CUSTOM_FLAGS counts archived chips too, since each one still names a
// key on past days. Together with the built-ins it stays under MAX_FLAG_KEYS,
// so a check-in with every chip ticked still saves.
const CHECKIN_FLAG_PERIODS = ['morning', 'evening'];
const MAX_CUSTOM_FLAGS = 16;
const CHECKIN_FLAG_LABEL_MAX = 40;
const CHECKIN_FLAG_EMOJI_MAX = 16;
const CHECKIN_FLAG_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

function checkinFlagLabelError(label) {
  if (typeof label !== 'string' || !label.trim()) return 'label is required';
  if (label.trim().length > CHECKIN_FLAG_LABEL_MAX) return `label must be at most ${CHECKIN_FLAG_LABEL_MAX} characters`;
  return null;
}

function checkinFlagEmojiError(emoji) {
  if (emoji === undefined || emoji === null) return null;
  if (typeof emoji !== 'string') return 'emoji must be a string or null';
  if (emoji.trim().length > CHECKIN_FLAG_EMOJI_MAX) return `emoji must be at most ${CHECKIN_FLAG_EMOJI_MAX} characters`;
  return null;
}

// Case-insensitive, across the period's custom chips, archived ones included:
// two chips with one name would be one question asked twice.
function checkinFlagLabelClash(userId, period, label, exceptKey = null) {
  const want = label.trim().toLowerCase();
  const hit = db.getCustomCheckinFlags(userId, period)
    .find(r => r.key !== exceptKey && String(r.label).trim().toLowerCase() === want);
  if (!hit) return null;
  return hit.hidden
    ? `"${hit.label}" is archived. Show it again from Settings instead`
    : `You already have a chip called "${hit.label}"`;
}

// true/false/0/1 to 0/1; anything else is undefined, which the caller rejects.
function checkinFlagHiddenValue(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  return undefined;
}

app.get('/api/checkin-flags', (req, res) => {
  try { res.json(db.getCheckinFlagPrefs(getUserId(req))); }
  catch (e) { console.error('GET /api/checkin-flags', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/checkin-flags', (req, res) => {
  try {
    const userId = getUserId(req);
    const { period, label, emoji } = req.body || {};
    if (!CHECKIN_FLAG_PERIODS.includes(period)) return res.status(400).json({ error: 'period must be morning or evening' });
    const err = checkinFlagLabelError(label) || checkinFlagEmojiError(emoji);
    if (err) return res.status(400).json({ error: err });
    if (db.getCustomCheckinFlags(userId, period).length >= MAX_CUSTOM_FLAGS) {
      return res.status(400).json({ error: `You can have at most ${MAX_CUSTOM_FLAGS} of your own ${period} chips, archived ones included` });
    }
    const clash = checkinFlagLabelClash(userId, period, label);
    if (clash) return res.status(409).json({ error: clash });
    const row = db.createCustomCheckinFlag({ period, label: label.trim(), emoji: (emoji || '').trim() }, userId);
    res.json({ created: row, prefs: db.getCheckinFlagPrefs(userId) });
  } catch (e) { console.error('POST /api/checkin-flags', e); res.status(500).json({ error: e.message }); }
});

// A custom chip takes label, emoji, hidden (archive) and move (-1 or 1). A
// built-in chip takes hidden alone, where null returns it to the code's
// default; sick can never be hidden (see the table comment).
app.patch('/api/checkin-flags/:period/:key', (req, res) => {
  try {
    const userId = getUserId(req);
    const { period, key } = req.params;
    if (!CHECKIN_FLAG_PERIODS.includes(period) || !CHECKIN_FLAG_KEY_RE.test(key)) {
      return res.status(404).json({ error: 'Chip not found' });
    }
    const body = req.body || {};
    const { label, emoji, hidden, move } = body;
    if (key.startsWith(db.CUSTOM_FLAG_PREFIX)) {
      if (!db.getCheckinFlagPref(userId, period, key)) return res.status(404).json({ error: 'Chip not found' });
      if ([label, emoji, hidden, move].every(v => v === undefined)) {
        return res.status(400).json({ error: 'nothing to change: send label, emoji, hidden or move' });
      }
      const err = (label !== undefined && checkinFlagLabelError(label)) || checkinFlagEmojiError(emoji)
        || (hidden !== undefined && checkinFlagHiddenValue(hidden) === undefined && 'hidden must be true or false')
        || (move !== undefined && move !== -1 && move !== 1 && 'move must be -1 or 1');
      if (err) return res.status(400).json({ error: err });
      if (label !== undefined) {
        const clash = checkinFlagLabelClash(userId, period, label, key);
        if (clash) return res.status(409).json({ error: clash });
      }
      db.transaction(() => {
        db.updateCustomCheckinFlag(userId, period, key, {
          label: label !== undefined ? label.trim() : undefined,
          emoji: emoji !== undefined ? (emoji || '').trim() : undefined,
          hidden: hidden !== undefined ? checkinFlagHiddenValue(hidden) : undefined,
        });
        if (move !== undefined) db.moveCustomCheckinFlag(userId, period, key, move);
      });
      return res.json({ prefs: db.getCheckinFlagPrefs(userId) });
    }
    if (Object.keys(body).some(k => k !== 'hidden') || hidden === undefined) {
      return res.status(400).json({ error: 'a built-in chip can only be shown or hidden: send hidden alone' });
    }
    if (key === 'sick') {
      return res.status(400).json({ error: 'Sick is always offered: the sick-day analytics read it' });
    }
    const value = hidden === null ? null : checkinFlagHiddenValue(hidden);
    if (value === undefined) return res.status(400).json({ error: 'hidden must be true, false or null' });
    db.setBuiltinCheckinFlagHidden(userId, period, key, value);
    res.json({ prefs: db.getCheckinFlagPrefs(userId) });
  } catch (e) { console.error('PATCH /api/checkin-flags', e); res.status(500).json({ error: e.message }); }
});

// Custom chips only, and only while no check-in has ever ticked it: the row is
// what names the key on those days. A used chip is archived instead.
app.delete('/api/checkin-flags/:period/:key', (req, res) => {
  try {
    const userId = getUserId(req);
    const { period, key } = req.params;
    if (!CHECKIN_FLAG_PERIODS.includes(period) || !key.startsWith(db.CUSTOM_FLAG_PREFIX)) {
      return res.status(400).json({ error: 'only a chip you made can be deleted; hide a built-in one instead' });
    }
    const row = db.getCheckinFlagPref(userId, period, key);
    if (!row) return res.status(404).json({ error: 'Chip not found' });
    const used = db.checkinFlagUseCount(userId, period, key);
    if (used) {
      return res.status(409).json({ error: `"${row.label}" is ticked on ${used} day${used === 1 ? '' : 's'}. Archive it instead, so those days keep their label` });
    }
    db.deleteCheckinFlagPref(userId, period, key);
    res.json({ prefs: db.getCheckinFlagPrefs(userId) });
  } catch (e) { console.error('DELETE /api/checkin-flags', e); res.status(500).json({ error: e.message }); }
});

// Every check-in VALUE rule lives here; the PUT route allowlists the keys.
// Every rating is an integer 1-10 with no zero (Story:
// DECISIONS.md#rating-scale-1-10). CHECKIN_SCALES is the one list of which
// check-in keys ARE rating scales; the loop and its error message both read it.
//
// Flags are validated for SHAPE ONLY, never membership: the MORNING_FLAGS /
// EVENING_FLAGS vocabulary lives in index.html so adding a flag needs no
// server edit, and a user's own chips (POST /api/checkin-flags) need none
// either. MAX_FLAG_KEYS is an abuse ceiling, not a vocabulary: it sits above
// every built-in chip plus MAX_CUSTOM_FLAGS, so ticking all of them saves.
const CHECKIN_SCALES = {
  morning_sleep:   [1, 10], morning_feeling: [1, 10],
  evening_energy:  [1, 10], evening_feeling: [1, 10], evening_eating: [1, 10],
};
const CHECKIN_TEXT   = ['morning_planned_type', 'evening_journal', 'day_journal', 'morning_prayer'];
const CHECKIN_BOOLS  = ['morning_sick', 'evening_sick'];
const CHECKIN_STAMPS = ['morning_timestamp', 'evening_timestamp'];
const CHECKIN_FLAGS  = ['morning_flags', 'evening_flags'];
const MAX_FLAG_KEYS  = 64;
// The daily fast, validated for SHAPE ONLY — same rule and same reason as the
// flag blobs above: FAST_SUBJECTS lives in index.html so a new suggestion needs
// no server edit, and a subject typed into the "something else" box is free
// text that no allowlist here could ever anticipate.
//
// What IS enforced is the pair's relationship to each other: morning_fasts is
// the ARRAY of subject ids, evening_fasts an OBJECT keyed by those ids. Only
// the three outcome words are closed, because unlike a subject they are a
// vocabulary this app defines rather than one the user writes.
const FAST_OUTCOMES     = ['kept', 'partial', 'broke'];
const MAX_FAST_SUBJECTS = 12;
const MAX_FAST_ID_LEN   = 120;
// Per-field ceiling for the free-text check-in columns. ~10,000 words: past any
// journal entry a person writes, well short of anything that hurts.
//
// An oversized write is a ONE-WAY DOOR: express.json accepts 10 MB,
// auto_vacuum is 0 and nothing runs VACUUM, so clearing the text later does
// not give the space back — and the row replicates into every retained Pi dump
// and desktop copy.
const MAX_CHECKIN_TEXT = 64 * 1024;

// Returns an error string, or null when every present field is coherent.
// Absent keys are always fine — this endpoint is a partial upsert by design.
function validateCheckinFields(fields) {
  for (const [key, [min, max]] of Object.entries(CHECKIN_SCALES)) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < min || v > max) return `${key} must be an integer ${min}-${max} or null`;
  }
  for (const key of CHECKIN_BOOLS) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (v !== 0 && v !== 1) return `${key} must be 0, 1 or null`;
  }
  for (const key of CHECKIN_STAMPS) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 0) return `${key} must be an integer timestamp or null`;
  }
  for (const key of CHECKIN_TEXT) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `${key} must be a string or null`;
    if (v.length > MAX_CHECKIN_TEXT) return `${key} is longer than ${MAX_CHECKIN_TEXT} characters`;
  }
  for (const key of CHECKIN_FLAGS) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return `${key} must be an object or null`;
    if (Object.keys(v).length > MAX_FLAG_KEYS) return `${key} carries more than ${MAX_FLAG_KEYS} keys`;
  }
  const fastErr = validateFastFields(fields);
  if (fastErr) return fastErr;
  return null;
}

// Split out of validateCheckinFields only because it is the one check-in field
// with an internal structure worth reading as its own block; it is called from
// there and nowhere else, so the PUT gate is still the single entry point.
//
// The size ceiling (MAX_CHECKIN_TEXT) is checked on the WHOLE serialized blob,
// not per note: twelve notes each under it would otherwise total twelve times it.
function validateFastFields(fields) {
  const subjects = fields.morning_fasts;
  if (subjects !== undefined && subjects !== null) {
    if (!Array.isArray(subjects)) return 'morning_fasts must be an array or null';
    if (subjects.length > MAX_FAST_SUBJECTS) return `morning_fasts carries more than ${MAX_FAST_SUBJECTS} subjects`;
    for (const s of subjects) {
      if (typeof s !== 'string' || !s.trim()) return 'morning_fasts entries must be non-empty strings';
      if (s.length > MAX_FAST_ID_LEN) return `a morning_fasts entry is longer than ${MAX_FAST_ID_LEN} characters`;
    }
    if (JSON.stringify(subjects).length > MAX_CHECKIN_TEXT) return `morning_fasts is longer than ${MAX_CHECKIN_TEXT} characters`;
  }

  const results = fields.evening_fasts;
  if (results !== undefined && results !== null) {
    if (typeof results !== 'object' || Array.isArray(results)) return 'evening_fasts must be an object or null';
    const keys = Object.keys(results);
    if (keys.length > MAX_FAST_SUBJECTS) return `evening_fasts carries more than ${MAX_FAST_SUBJECTS} subjects`;
    for (const k of keys) {
      if (!k.trim() || k.length > MAX_FAST_ID_LEN) return `an evening_fasts key is empty or longer than ${MAX_FAST_ID_LEN} characters`;
      const r = results[k];
      if (typeof r !== 'object' || r === null || Array.isArray(r)) return 'evening_fasts values must be objects';
      if (r.outcome !== undefined && r.outcome !== null && !FAST_OUTCOMES.includes(r.outcome)) {
        return `an evening_fasts outcome must be one of ${FAST_OUTCOMES.join(', ')} or null`;
      }
      if (r.note !== undefined && r.note !== null && typeof r.note !== 'string') return 'an evening_fasts note must be a string or null';
    }
    if (JSON.stringify(results).length > MAX_CHECKIN_TEXT) return `evening_fasts is longer than ${MAX_CHECKIN_TEXT} characters`;
  }
  return null;
}

// The value rules for history's own columns.
//
// RPE is bounded here but deliberately NOT folded into CHECKIN_SCALES: it is a
// SEPARATE CURRENCY, never compared to the check-in scales, and its own
// constant stops an edit to one from redefining the other.
//
// date must be ISO ("Shared date validation"). Safe here: dateKey() sends ISO
// on every frontend write, and the legacy restore path is POST /api/import,
// which does not come through this function.
//
// NOT an allowlist, and must never become one. Type-specific fields
// (distance, pace, exercises, ...) travel in the `data` JSON blob so a new
// workout type stays a frontend-only change.
//
// Returns an error string, or null. `requireType` is false on PATCH, which is a
// partial update and may legitimately not mention the type at all.
const RPE_RANGE = [1, 10];
function validateHistoryFields(body, { requireType }) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be an object';
  const { type, rpe, date, timestamp, name, note } = body;
  if (requireType) {
    if (typeof type !== 'string' || !type.trim()) return 'type must be a non-empty string';
  } else if (type !== undefined && (typeof type !== 'string' || !type.trim())) {
    return 'type must be a non-empty string';
  }
  if (rpe !== undefined && rpe !== null) {
    const [min, max] = RPE_RANGE;
    if (!Number.isInteger(rpe) || rpe < min || rpe > max) return `rpe must be an integer ${min}-${max} or null`;
  }
  if (invalidOptionalDate(date)) return 'date must be YYYY-MM-DD or null';
  if (timestamp !== undefined && timestamp !== null) {
    if (!Number.isInteger(timestamp) || timestamp < 0) return 'timestamp must be a non-negative integer or null';
  }
  // snow/grooming are blob keys, checked for TYPE only: their vocabulary is
  // the frontend's (SNOW_SURFACES), and a value list here would be the
  // allowlist this function must never become.
  for (const [k, v] of [['name', name], ['note', note], ['snow', body.snow], ['grooming', body.grooming]]) {
    if (v !== undefined && v !== null && typeof v !== 'string') return `${k} must be a string or null`;
  }
  return null;
}

// Partial upsert — send only the fields for the period being submitted
// (morning_sleep/morning_feeling/morning_timestamp, or evening_*).
app.put('/api/checkins/:date', (req, res) => {
  try {
    // Normalize BEFORE checking, so a legacy M/D/YYYY date from an old cached
    // client is rewritten rather than rejected. See "Shared date validation".
    const date = db.normalizeDateStr(req.params.date);
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const validKeys = ['morning_sleep','morning_feeling','morning_planned_type','morning_timestamp','morning_sick',
                        'morning_flags',
                        'evening_energy','evening_feeling','evening_eating','evening_journal','evening_timestamp','evening_sick',
                        'evening_flags','day_journal',
                        'morning_fasts','morning_prayer','evening_fasts'];
    const fields = {};
    for (const k of validKeys) if (k in req.body) fields[k] = req.body[k];
    const bad = validateCheckinFields(fields);
    if (bad) return res.status(400).json({ error: bad });
    const result = db.upsertCheckin(date, fields, getUserId(req));
    res.json(result);
  } catch (e) { console.error('PUT /api/checkins/:date', e); res.status(500).json({ error: e.message }); }
});

// No UI calls this; scripts/prune_empty_checkins.js does. It exists because
// the date is a PRIMARY KEY typed from the URL, so a wrong one cannot be fixed
// by re-saving, and an empty row is an artifact every reader must gate out.
// User-scoped, 404 when nothing was deleted, like DELETE /api/bodyweight/:date.
// db.deleteCheckin does NOT cascade that date's injury_checkins — see its
// comment.
app.delete('/api/checkins/:date', (req, res) => {
  try {
    const date = db.normalizeDateStr(req.params.date);
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const { changes } = db.deleteCheckin(date, getUserId(req));
    if (!changes) return res.status(404).json({ error: 'No check-in recorded for that date' });
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/checkins/:date', e); res.status(500).json({ error: e.message }); }
});

// ── Goals ──────────────────────────────────────────────────────────────────────
// Nine target types — see db.js's goals table comment for what each measures
// and, crucially, what unit its target_value is in, since they differ per type
// and nothing here or in SQL enforces that. "Current value" is computed live on
// the frontend, never stored.
//
// The four activity-type-keyed types are grouped because every rule below
// treats them identically: they all require an activity_type and none of them
// touch an exercise.
const ACTIVITY_GOAL_TYPES = ['pace', 'distance_time', 'distance', 'weekly_distance'];
// The three exercise-keyed types, grouped for the same reason: each requires
// an exercise_name and owns it. exercise_reps and exercise_hold are the two
// COUNT types (whole reps, whole seconds) and the two that carry added_lbs.
const EXERCISE_GOAL_TYPES = ['exercise_1rm', 'exercise_reps', 'exercise_hold'];
const COUNT_GOAL_TYPES = ['exercise_reps', 'exercise_hold'];
const GOAL_TYPES = [...EXERCISE_GOAL_TYPES, 'body_weight', ...ACTIVITY_GOAL_TYPES, 'climb_grade'];
const GOAL_KEYS = ['type', 'exercise_name', 'activity_type', 'target_value', 'added_lbs', 'target_distance_km', 'climb_scale', 'direction', 'target_date', 'achieved_at'];

// A climb_grade target is a GRADE NUMBER on its scale, the encoding
// index.html's climbGradeNumber() defines: V0-V17 are 0-17; YDS 5.5-5.9 are
// 5-9, and 5.10-5.15 split into a minus (N) and a plus (N + 0.5), the only
// grades the pickers offer up there. Anything else names no grade at all.
// Story: DECISIONS.md#climb-grade-goals.
function isClimbGradeNumber(scale, n) {
  if (!Number.isFinite(n)) return false;
  if (scale === 'v') return Number.isInteger(n) && n >= 0 && n <= 17;
  if (scale === 'yds') {
    if (n >= 5 && n <= 9) return Number.isInteger(n);
    return n >= 10 && n <= 15.5 && Number.isInteger(n * 2);
  }
  return false;
}

// Every rule that makes a goal row coherent lives here, as data — and BOTH
// write paths go through normalizeGoal below, which is the only thing that
// applies them.
//
// Collected rather than short-circuited on the first failure, and each tagged
// with the field it concerns, so PATCH can compare two rows' worth of
// violations. A rule added here participates in that comparison automatically;
// that is the point of the split.
function goalViolations(row) {
  const out = [];
  const type = row.type;
  if (!GOAL_TYPES.includes(type)) out.push({ field: 'type', message: 'Invalid goal type' });
  if (EXERCISE_GOAL_TYPES.includes(type) && !row.exercise_name) {
    out.push({ field: 'exercise_name', message: 'exercise_name is required' });
  }
  if (ACTIVITY_GOAL_TYPES.includes(type) && !row.activity_type) {
    out.push({ field: 'activity_type', message: 'activity_type is required' });
  }
  // A distance_time goal is meaningless without its distance, and on the
  // frontend a missing one looks like "No data yet". A loud 400 here instead.
  if (type === 'distance_time' && !(parseFloat(row.target_distance_km) > 0)) {
    out.push({ field: 'target_distance_km', message: 'target_distance_km is required' });
  }
  // `> 0`, not merely "is a number": a target at or below zero is met by any
  // set ever logged (achievement is write-once) or, for pace, never met.
  // Checked against the value actually STORED, which for the count types is
  // the ROUNDED one, so a 0.4 rep target cannot become a literal 0.
  //
  // climb_grade is the exception, and a stricter one: its target must name a
  // real grade on its scale, and V0 is a real grade whose number is 0.
  const targetNum = parseFloat(row.target_value);
  const targetStored = COUNT_GOAL_TYPES.includes(type) ? Math.round(targetNum) : targetNum;
  if (type === 'climb_grade') {
    if (row.climb_scale !== 'v' && row.climb_scale !== 'yds') {
      out.push({ field: 'climb_scale', message: "climb_scale must be 'v' or 'yds'" });
    } else if (!isClimbGradeNumber(row.climb_scale, targetNum)) {
      out.push({ field: 'target_value', message: 'target_value must be a grade on its scale' });
    }
  } else if (!(targetStored > 0)) {
    out.push({ field: 'target_value', message: 'target_value must be greater than 0' });
  }
  // direction is CHECKED, never coerced: a typo'd 'atmost' coerced to
  // 'at_least' would silently invert a body-weight cut into a bulk. Only a
  // value that is PRESENT and wrong is rejected; absent falls through to
  // normalizeGoal's default.
  if (row.direction != null && row.direction !== '' &&
      row.direction !== 'at_least' && row.direction !== 'at_most') {
    out.push({ field: 'direction', message: "direction must be 'at_least' or 'at_most'" });
  }
  // ISO, via the shared helper ("Shared date validation").
  if (invalidOptionalDate(row.target_date)) {
    out.push({ field: 'target_date', message: 'target_date must be YYYY-MM-DD or null' });
  }
  return out;
}

// The single gateway for every goal write from the API. Returns { error } or
// { fields } — never throws on bad input. `existing` is null on create.
//
// VALIDATION RUNS AGAINST THE MERGED ROW, not the patch: a partial update is
// judged as the goal it turns the row into, so a PATCH can never produce a
// row POST would reject (e.g. re-typing a pace goal to reps must not keep its
// 'at_most' direction or lack an exercise_name).
function normalizeGoal(input, existing = null) {
  const patch = {};
  for (const k of GOAL_KEYS) if (k in input) patch[k] = input[k];
  const merged = { ...(existing || {}), ...patch };
  const type = merged.type;

  // A PATCH IS REJECTED ONLY FOR PROBLEMS IT INTRODUCES. db.restoreGoal
  // bypasses this function, so a stored row may violate a current rule, and
  // the app's PATCH callers send {achieved_at} alone — judging them against
  // untouched rules would strand such a row.
  //
  // A violation is forgiven only when (a) `existing` already had it AND (b) the
  // patch doesn't touch the field it concerns: forgive what was inherited,
  // never what was just written. {exercise_name:''} on a nameless row is still
  // a 400; {achieved_at} passes; re-typing a row into coherence still works.
  const inherited = existing ? new Set(goalViolations(existing).map(v => v.field)) : new Set();
  const fatal = goalViolations(merged)
    .filter(v => !(inherited.has(v.field) && !(v.field in patch)));
  if (fatal.length) return { error: fatal[0].message };

  // Reps are a count and a hold is whole seconds, so the count types store a
  // rounded target — 12.4 would display as 12 while goalMet() compares 12.4.
  // The input's step="1" is only a hint.
  //
  // Only assigned when finite: an INHERITED bad target_value is left as
  // stored (db.updateGoal skips undefined) rather than overwritten with NaN.
  const target = parseFloat(merged.target_value);
  if (Number.isFinite(target)) {
    patch.target_value = COUNT_GOAL_TYPES.includes(type) ? Math.round(target) : target;
  }

  // EVERY TYPE-SCOPED FIELD IS REWRITTEN FROM THE TYPE, so a field a type
  // doesn't own is nulled rather than left invisible on the row. Only for a
  // type we understand: on a row whose inherited violation IS its type, a
  // forgiven {achieved_at} PATCH must not strip the data needed to re-type it.
  if (GOAL_TYPES.includes(type)) {
    // The count types only, meaning ADDED load as the exercise's sets do.
    // A real 0 rather than null, so "bodyweight" is stated, not inferred.
    // NEGATIVE means assistance: "8 reps at -20" is 8 reps with at most 20 lbs
    // of help, and -10 x 8 satisfies it (less assistance is harder).
    // Story: DECISIONS.md#timed-exercises.
    const addedNum = parseFloat(merged.added_lbs);
    patch.added_lbs = COUNT_GOAL_TYPES.includes(type) ? (Number.isFinite(addedNum) ? addedNum : 0) : null;
    patch.target_distance_km = type === 'distance_time' ? parseFloat(merged.target_distance_km) : null;
    patch.climb_scale = type === 'climb_grade' ? merged.climb_scale : null;
    // A leftover exercise_name is NOT inert even though nothing displays it:
    // mergeExerciseNames rewrites goals.exercise_name with no type filter, and
    // POST /api/import scopes name-keyed restores by it.
    patch.exercise_name = EXERCISE_GOAL_TYPES.includes(type) ? merged.exercise_name : null;
    patch.activity_type = ACTIVITY_GOAL_TYPES.includes(type) ? merged.activity_type : null;
  }

  // Direction is a property of the TYPE wherever "better" has one reading —
  // reps and distance go up, a race time goes down. body_weight is genuinely
  // user-chosen (bulk or cut). exercise_1rm and pace read merged.direction
  // rather than being pinned, so a bare {achieved_at} PATCH never rewrites
  // direction on a restored row.
  // Story: DECISIONS.md#reps-goals, DECISIONS.md#distance-time-goals.
  const FORCED_DIRECTION = {
    exercise_reps:   'at_least',
    exercise_hold:   'at_least',
    distance:        'at_least',
    weekly_distance: 'at_least',
    distance_time:   'at_most',
    climb_grade:     'at_least',
  };
  // Same known-type guard as above. goalViolations rejects a present-but-
  // invalid direction, so the fallback here only supplies a MISSING one.
  if (GOAL_TYPES.includes(type)) {
    patch.direction = FORCED_DIRECTION[type]
                   || (merged.direction === 'at_most' ? 'at_most' : 'at_least');
  }

  if (existing) {
    const locked = goalSubjectChange(input, patch, existing);
    if (locked) return { error: `A goal's ${locked} can't be changed — add a new goal instead` };
    Object.assign(patch, goalTargetEdit(input, patch, existing));
  }

  return { fields: patch };
}

// A GOAL'S SUBJECT IS FIXED; ONLY ITS BAR MOVES. Type, exercise, activity,
// race distance, cut/bulk direction and the load a count must be hit at
// decide which sessions the goal reads, so changing one is a different goal:
// dumbbell bench is not barbell bench with a new target. An edit may change
// the target and the deadline, nothing else.
//
// Compared on the NORMALIZED value, and only for keys the caller sent: the
// edit form sends only target_value and target_date, but a caller sending the
// whole row unchanged is not an edit of its subject. A stored value that is
// no answer at all (blank, or a type this server doesn't know, both reachable
// through restoreGoal) may still be written, so a stranded row stays
// repairable rather than delete-only.
const GOAL_SUBJECT_KEYS = ['type', 'exercise_name', 'activity_type', 'target_distance_km', 'climb_scale', 'direction', 'added_lbs'];
const GOAL_SUBJECT_LABELS = {
  type: 'type', exercise_name: 'exercise', activity_type: 'activity',
  target_distance_km: 'distance', climb_scale: 'grade scale', direction: 'direction', added_lbs: 'load',
};
function sameGoalValue(a, b) {
  const blank = v => v == null || v === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}
function goalSubjectChange(input, patch, existing) {
  const unanswered = k => existing[k] == null || existing[k] === ''
    || (k === 'type' && !GOAL_TYPES.includes(existing.type));
  const key = GOAL_SUBJECT_KEYS.find(k =>
    k in input && k in patch && !unanswered(k) && !sameGoalValue(patch[k], existing[k]));
  return key ? GOAL_SUBJECT_LABELS[key] : null;
}

// A target edit keeps the old bar as a step in target_history, a JSON list of
// { value, until } oldest first: `value` was the target up to (not including)
// the local date `until`, and target_value holds from the last `until` on. The
// PRs tab draws it as a staircase and dates an achievement no earlier than
// the last step. Several edits in one day keep that day's STARTING value, and
// one that returns to it removes the step.
//
// It also voids the achievement on record, which was decided against the old
// bar; the client's next scan re-decides it against the new one. A PATCH that
// sets achieved_at itself (the scan, the reopen button) is never
// second-guessed. created_at never moves: the goal is the same goal.
function goalTargetEdit(input, patch, existing) {
  if (!('target_value' in input) || sameGoalValue(patch.target_value, existing.target_value)) return {};
  let history = [];
  try { history = JSON.parse(existing.target_history || '[]'); } catch (e) { history = []; }
  if (!Array.isArray(history)) history = [];
  const today = db.isoDateStr();
  const last = history[history.length - 1];
  if (last && last.until === today) {
    if (sameGoalValue(last.value, patch.target_value)) history.pop();
  } else {
    history.push({ value: existing.target_value, until: today });
  }
  const out = { target_history: history.length ? JSON.stringify(history) : null };
  if (!('achieved_at' in input)) out.achieved_at = null;
  return out;
}

app.get('/api/goals', (req, res) => {
  try { res.json(db.getGoals(getUserId(req))); }
  catch (e) { console.error('GET /api/goals', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/goals', (req, res) => {
  try {
    const { error, fields } = normalizeGoal(req.body || {});
    if (error) return res.status(400).json({ error });
    res.json(db.createGoal(fields, getUserId(req)));
  } catch (e) { console.error('POST /api/goals', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/goals/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.getGoal(id);
    // getGoal is by-id only (see db.js), so the ownership check happens here,
    // against the user_id its SELECT * carries.
    if (!existing || existing.user_id !== getUserId(req)) return res.status(404).json({ error: 'Goal not found' });
    const { error, fields } = normalizeGoal(req.body || {}, existing);
    if (error) return res.status(400).json({ error });
    res.json(db.updateGoal(id, fields));
  } catch (e) { console.error('PATCH /api/goals/:id', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/goals/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.getGoal(id);
    if (!existing || existing.user_id !== getUserId(req)) return res.status(404).json({ error: 'Goal not found' });
    db.deleteGoal(id);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/goals/:id', e); res.status(500).json({ error: e.message }); }
});

// ── Injuries ─────────────────────────────────────────────────────────────────
// A structured injury/pain log — deliberately independent of the one-tap
// `injury` key inside checkins.evening_flags; see db.js's injuries table
// comment for why.
app.get('/api/injuries', (req, res) => {
  try { res.json(db.getInjuries(getUserId(req))); }
  catch (e) { console.error('GET /api/injuries', e); res.status(500).json({ error: e.message }); }
});

// severity is optional (null = "not rated") but if present must be a real
// 1-10 integer.
function invalidSeverity(v) {
  return v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > 10);
}

// A niggle is the lighter record — see the injuries table comment.
const INJURY_KINDS = ['injury', 'niggle'];

// The two injury dates, normalized then shape-checked like every other date
// route ("Shared date validation"). started_date is NOT NULL, so on a PATCH it
// can be changed but not cleared; resolved_date null (or '') means active.
// The order check runs only when this request touches a date: a stored row
// that already breaks it can still be edited in every other way, the same
// "reject only what you introduce" rule normalizeGoal follows.
function injuryDateError(fields, existing = null) {
  for (const k of ['started_date', 'resolved_date']) {
    if (!(k in fields)) continue;
    if (fields[k] === '') fields[k] = null;
    if (fields[k] != null) fields[k] = db.normalizeDateStr(fields[k]);
  }
  if ('started_date' in fields && existing && fields.started_date == null) return 'started_date cannot be cleared';
  if (invalidOptionalDate(fields.started_date)) return 'started_date must be YYYY-MM-DD';
  if (invalidOptionalDate(fields.resolved_date)) return 'resolved_date must be YYYY-MM-DD or null';
  if ('started_date' in fields || 'resolved_date' in fields) {
    const merged = { ...(existing || {}), ...fields };
    if (merged.started_date && merged.resolved_date && merged.resolved_date < merged.started_date) {
      return 'resolved_date must not be before started_date';
    }
  }
  return null;
}

app.post('/api/injuries', (req, res) => {
  try {
    const body_part = (req.body?.body_part || '').toString().trim();
    if (!body_part) return res.status(400).json({ error: 'body_part is required' });
    const { severity, started_date, notes, pt_plan, kind, history_id } = req.body || {};
    if (invalidSeverity(severity)) return res.status(400).json({ error: 'severity must be an integer 1-10 or null' });
    if (kind !== undefined && !INJURY_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${INJURY_KINDS.join(', ')}` });
    const dates = started_date !== undefined ? { started_date } : {};
    const dateErr = injuryDateError(dates);
    if (dateErr) return res.status(400).json({ error: dateErr });
    // The workout it started in. Checked for ownership like PATCH
    // /api/history/:id, or one user could hang an injury off another's session.
    if (history_id != null && !(Number.isInteger(history_id) && db.historyBelongsToUser(history_id, getUserId(req)))) {
      return res.status(400).json({ error: 'history_id must name one of your own workouts' });
    }
    res.json(db.createInjury({ body_part, severity, started_date: dates.started_date, notes, pt_plan, kind, history_id }, getUserId(req)));
  } catch (e) { console.error('POST /api/injuries', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/injuries/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Owner-checked: ids are one AUTOINCREMENT sequence shared by every user.
    const existing = db.getInjuries(getUserId(req)).find(i => i.id === id);
    if (!existing) {
      return res.status(404).json({ error: 'Injury not found' });
    }
    // history_id is deliberately absent: the workout an injury started in is
    // set once at creation and only ever moved by the server itself.
    const validKeys = ['body_part', 'severity', 'started_date', 'resolved_date', 'notes', 'pt_plan', 'resolution_summary', 'kind'];
    const fields = {};
    for (const k of validKeys) if (k in req.body) fields[k] = req.body[k];
    if ('severity' in fields && invalidSeverity(fields.severity)) {
      return res.status(400).json({ error: 'severity must be an integer 1-10 or null' });
    }
    if ('kind' in fields && !INJURY_KINDS.includes(fields.kind)) {
      return res.status(400).json({ error: `kind must be one of ${INJURY_KINDS.join(', ')}` });
    }
    const dateErr = injuryDateError(fields, existing);
    if (dateErr) return res.status(400).json({ error: dateErr });
    const updated = db.updateInjury(id, fields);
    if (!updated) return res.status(404).json({ error: 'Injury not found' });
    res.json(updated);
  } catch (e) { console.error('PATCH /api/injuries/:id', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/injuries/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Owner-checked like PATCH above; deleteInjury also cascades to that
    // injury's injury_checkins.
    if (!db.getInjuries(getUserId(req)).some(i => i.id === id)) {
      return res.status(404).json({ error: 'Injury not found' });
    }
    db.deleteInjury(id);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/injuries/:id', e); res.status(500).json({ error: e.message }); }
});

// ── Injury check-ins ─────────────────────────────────────────────────────────
// The per-(injury, date) daily follow-up asked inside the morning/evening
// check-in cards: pain today, whether it cost you sleep or a workout, and
// whether you did your PT. Separate from /api/checkins because it's keyed
// per injury, not just per date — see db.js's injury_checkins comment.
app.get('/api/injury-checkins', (req, res) => {
  try { res.json(db.getInjuryCheckins(getUserId(req))); }
  catch (e) { console.error('GET /api/injury-checkins', e); res.status(500).json({ error: e.message }); }
});

// Partial upsert, same contract as PUT /api/checkins/:date — send only the
// period being saved and the other one is left untouched.
app.put('/api/injury-checkins/:injuryId/:date', (req, res) => {
  try {
    const injuryId = parseInt(req.params.injuryId, 10);
    if (!Number.isInteger(injuryId)) return res.status(400).json({ error: 'invalid injuryId' });
    // Already decoded by Express — never decode again, or a literal '%'
    // corrupts it. Normalized then shape-checked ("Shared date validation").
    const date = db.normalizeDateStr(req.params.date);
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    // No orphan rows: a tab left open across a delete must not write a
    // follow-up for an injury that no longer exists.
    if (!db.getInjuries(getUserId(req)).some(i => i.id === injuryId)) {
      return res.status(404).json({ error: 'Injury not found' });
    }
    const validKeys = ['morning_pain', 'morning_affected_sleep',
                       'evening_pain', 'evening_affected_workout', 'evening_pt_done',
                       'workout_pain', 'evening_trend', 'evening_note'];
    const fields = {};
    for (const k of validKeys) if (k in req.body) fields[k] = req.body[k];
    // Same reasoning as validateCheckinFields above. Pain runs 1-10 with
    // 10 = worst (inverted against every other scale in the app — see db.js's
    // injury_checkins comment); the three yes/no answers are 0/1, and null
    // is meaningful on all of them: "this question wasn't asked".
    for (const k of ['morning_pain', 'evening_pain', 'workout_pain']) {
      const v = fields[k];
      if (v === undefined || v === null) continue;
      if (!Number.isInteger(v) || v < 1 || v > 10) return res.status(400).json({ error: `${k} must be an integer 1-10 or null` });
    }
    for (const k of ['morning_affected_sleep', 'evening_affected_workout', 'evening_pt_done']) {
      const v = fields[k];
      if (v === undefined || v === null) continue;
      if (v !== 0 && v !== 1) return res.status(400).json({ error: `${k} must be 0, 1 or null` });
    }
    // evening_trend is a closed vocabulary (matches the picker in
    // index.html's evening injury check-in block), unlike the check-in
    // flags' shape-only validation — there's no frontend-only extension path
    // for this one, so membership is worth enforcing here.
    if (fields.evening_trend !== undefined && fields.evening_trend !== null &&
        !['worse', 'same', 'better'].includes(fields.evening_trend)) {
      return res.status(400).json({ error: `evening_trend must be 'worse', 'same', 'better' or null` });
    }
    // Same free-text shape and ceiling as CHECKIN_TEXT (MAX_CHECKIN_TEXT).
    // Empty string becomes null: every "unanswered" value on this table is
    // NULL, not ''.
    if (fields.evening_note !== undefined && fields.evening_note !== null) {
      if (typeof fields.evening_note !== 'string') return res.status(400).json({ error: 'evening_note must be a string or null' });
      if (fields.evening_note.length > MAX_CHECKIN_TEXT) return res.status(400).json({ error: `evening_note is longer than ${MAX_CHECKIN_TEXT} characters` });
      fields.evening_note = fields.evening_note.trim() || null;
    }
    res.json(db.upsertInjuryCheckin(injuryId, date, fields));
  } catch (e) { console.error('PUT /api/injury-checkins/:injuryId/:date', e); res.status(500).json({ error: e.message }); }
});

// ── Pregnancy tracking ───────────────────────────────────────────────────────
// Ordinary user data (not a secret, unlike the sync credentials below) — a
// small dedicated table for dated milestones/conception/due date; day-to-day
// symptoms ride the check-in flag mechanism instead (MORNING_FLAGS/
// EVENING_FLAGS in index.html). Story: DECISIONS.md#pregnancy-tracking.
//
// Every date is ISO-checked ("Shared date validation"); these dates also feed
// the Calendar's derived trimester and due-date markers.

app.get('/api/pregnancy', (req, res) => {
  try { res.json(db.getPregnancyInfo(getUserId(req)) || {}); }
  catch (e) { console.error('GET /api/pregnancy', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/pregnancy', (req, res) => {
  try {
    const { conception_date, due_date, notes } = req.body || {};
    for (const [k, v] of [['conception_date', conception_date], ['due_date', due_date]]) {
      if (invalidOptionalDate(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD or null` });
    }
    res.json(db.setPregnancyInfo(getUserId(req), { conception_date, due_date, notes }));
  } catch (e) { console.error('PUT /api/pregnancy', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/pregnancy-milestones', (req, res) => {
  try { res.json(db.getPregnancyMilestones(getUserId(req))); }
  catch (e) { console.error('GET /api/pregnancy-milestones', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/pregnancy-milestones', (req, res) => {
  try {
    const label = (req.body?.label || '').toString().trim();
    if (!label) return res.status(400).json({ error: 'label is required' });
    const date = (req.body?.date || '').toString().trim();
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const notes = req.body?.notes;
    res.json(db.createPregnancyMilestone({ date, label, notes }, getUserId(req)));
  } catch (e) { console.error('POST /api/pregnancy-milestones', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/pregnancy-milestones/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Owner-checked, same pattern as goals/injuries.
    if (!db.getPregnancyMilestones(getUserId(req)).some(m => m.id === id)) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    const validKeys = ['date', 'label', 'notes'];
    const fields = {};
    for (const k of validKeys) if (k in req.body) fields[k] = req.body[k];
    // date and label are NOT NULL, so present-but-empty is a 400 rather than
    // a "clear it" (or an opaque 500 from SQLite).
    if ('date' in fields && !isIsoDate(fields.date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    if ('label' in fields && !(typeof fields.label === 'string' && fields.label.trim())) {
      return res.status(400).json({ error: 'label must be a non-empty string' });
    }
    const updated = db.updatePregnancyMilestone(id, fields);
    if (!updated) return res.status(404).json({ error: 'Milestone not found' });
    res.json(updated);
  } catch (e) { console.error('PATCH /api/pregnancy-milestones/:id', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/pregnancy-milestones/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!db.getPregnancyMilestones(getUserId(req)).some(m => m.id === id)) {
      return res.status(404).json({ error: 'Milestone not found' });
    }
    db.deletePregnancyMilestone(id);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/pregnancy-milestones/:id', e); res.status(500).json({ error: e.message }); }
});

// ── Life phases ─────────────────────────────────────────────────────────────
// A per-user dated stretch (newborn, travel, illness) whose untrained days the
// frontend excuses from its training-frequency numbers — see the life_phases
// table comment in db.js. Same ownership pattern as the milestones above: ids
// are one AUTOINCREMENT sequence shared by every user, so a row is only
// reachable through its owner's list. Story: DECISIONS.md#life-phases.
//
// The one rule beyond date shapes: end_date is never before start_date. PATCH
// checks it on the MERGED row, since moving only the start past a stored end
// is as wrong as sending both. An empty end_date means ongoing (null).
function lifePhaseError(p) {
  if (!(typeof p.label === 'string' && p.label.trim())) return 'label is required';
  if (!isIsoDate(p.start_date)) return 'start_date must be YYYY-MM-DD';
  if (p.end_date != null && !isIsoDate(p.end_date)) return 'end_date must be YYYY-MM-DD or null';
  if (p.end_date != null && p.end_date < p.start_date) return 'end_date must not be before start_date';
  if (p.emoji != null && typeof p.emoji !== 'string') return 'emoji must be a string or null';
  if (p.notes != null && typeof p.notes !== 'string') return 'notes must be a string or null';
  return null;
}

function lifePhaseFields(body) {
  const out = {};
  for (const k of ['label', 'emoji', 'start_date', 'end_date', 'notes']) {
    if (!(k in body)) continue;
    let v = body[k];
    if (typeof v === 'string') v = v.trim();
    out[k] = (v === '' && k !== 'label') ? null : v;
  }
  return out;
}

app.get('/api/life-phases', (req, res) => {
  try { res.json(db.getLifePhases(getUserId(req))); }
  catch (e) { console.error('GET /api/life-phases', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/life-phases', (req, res) => {
  try {
    const fields = { emoji: null, end_date: null, notes: null, ...lifePhaseFields(req.body || {}) };
    const err = lifePhaseError(fields);
    if (err) return res.status(400).json({ error: err });
    res.json(db.createLifePhase(fields, getUserId(req)));
  } catch (e) { console.error('POST /api/life-phases', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/life-phases/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.getLifePhases(getUserId(req)).find(p => p.id === id);
    if (!existing) return res.status(404).json({ error: 'Life phase not found' });
    const fields = lifePhaseFields(req.body || {});
    const err = lifePhaseError({ ...existing, ...fields });
    if (err) return res.status(400).json({ error: err });
    res.json(db.updateLifePhase(id, fields));
  } catch (e) { console.error('PATCH /api/life-phases/:id', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/life-phases/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!db.getLifePhases(getUserId(req)).some(p => p.id === id)) {
      return res.status(404).json({ error: 'Life phase not found' });
    }
    db.deleteLifePhase(id);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/life-phases/:id', e); res.status(500).json({ error: e.message }); }
});

// ── Sync credentials (Garmin + Apple) ───────────────────────────────────────
// Per-user credentials are flat files under data/, never a DB table, so they
// can never enter GET /api/backup/db (a whole-file .backup()) or the JSON
// export. Story: DECISIONS.md#per-user-sync-credentials.
const DATA_DIR = path.join(__dirname, 'data');

// Every credential file goes through this, never a bare writeFileSync, which
// truncates first and so can leave a half-written file after a crash — and
// readAppleTokensIndex() reads an unparseable index as {}, silently revoking
// every Apple token. Write-temp-then-rename is atomic within a filesystem.
// The temp name carries the pid so concurrent writers can't collide, and the
// mode is set at open time so the file is never briefly world-readable.
function writeFileAtomic(filePath, contents, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents, opts);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function garminEnvPath(userId) { return path.join(DATA_DIR, `garmin-${userId}.env`); }
// User 1 only (CLAUDE.md, "Sync credentials").
function legacyGarminEnvPaths() {
  return [path.join(DATA_DIR, 'garmin.env'), path.join(__dirname, '.env'), path.join(__dirname, 'workout-tracker.env')];
}
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
// Returns {email, password} or null. User 1 alone falls back to the
// data/garmin.env -> .env -> workout-tracker.env chain.
function readGarminCredentials(userId) {
  const own = parseEnvFile(garminEnvPath(userId));
  if (own?.GARMIN_EMAIL && own?.GARMIN_PASSWORD) return { email: own.GARMIN_EMAIL, password: own.GARMIN_PASSWORD };
  if (userId === 1) {
    for (const p of legacyGarminEnvPaths()) {
      const parsed = parseEnvFile(p);
      if (parsed?.GARMIN_EMAIL && parsed?.GARMIN_PASSWORD) return { email: parsed.GARMIN_EMAIL, password: parsed.GARMIN_PASSWORD };
    }
  }
  return null;
}
function writeGarminCredentials(userId, email, password) {
  writeFileAtomic(garminEnvPath(userId), `GARMIN_EMAIL=${email}\nGARMIN_PASSWORD=${password}\n`, { mode: 0o600 });
}
function deleteGarminCredentialsFile(userId) {
  const p = garminEnvPath(userId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
// Must match garmin_sync.py's token_store_for(user_id) character for
// character, or a credential change here wouldn't invalidate the session the
// next sync reads. User 1's data/.garminconnect/ must never move (CLAUDE.md).
function tokenStoreDir(userId) {
  return userId === 1 ? path.join(DATA_DIR, '.garminconnect') : path.join(DATA_DIR, `.garminconnect-${userId}`);
}
function wipeTokenStore(userId) {
  try { fs.rmSync(tokenStoreDir(userId), { recursive: true, force: true }); }
  catch (e) { console.error('wipeTokenStore', e); }
}

function appleTokensIndexPath() { return path.join(DATA_DIR, 'apple_sync_tokens.json'); }
function appleTokenFilePath(userId) { return path.join(DATA_DIR, `apple-${userId}.token`); }
function readAppleTokensIndex() {
  try { return JSON.parse(fs.readFileSync(appleTokensIndexPath(), 'utf8')) || {}; }
  catch { return {}; }
}
// The most important atomic write here (see writeFileAtomic).
function writeAppleTokensIndex(idx) {
  writeFileAtomic(appleTokensIndexPath(), JSON.stringify(idx, null, 2));
}
function getAppleToken(userId) {
  const p = appleTokenFilePath(userId);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
}
// Also doubles as the "regenerate" action — the old URL 401s immediately
// once the index no longer maps it to this user.
function setAppleToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  writeFileAtomic(appleTokenFilePath(userId), token, { mode: 0o600 });
  const idx = readAppleTokensIndex();
  for (const k of Object.keys(idx)) if (idx[k] === userId) delete idx[k];
  idx[token] = userId;
  writeAppleTokensIndex(idx);
  return token;
}
// The INDEX goes first: it is the half that authorizes a sync, so if the
// second step fails the token is already dead. A leftover file is harmless;
// a live index entry is not.
function deleteAppleToken(userId) {
  const idx = readAppleTokensIndex();
  for (const k of Object.keys(idx)) if (idx[k] === userId) delete idx[k];
  writeAppleTokensIndex(idx);
  const p = appleTokenFilePath(userId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function resolveUserIdByAppleToken(token) {
  if (!token) return null;
  const uid = readAppleTokensIndex()[token];
  return Number.isInteger(uid) ? uid : null;
}
function buildAppleSyncUrl(req, token) {
  return `${req.protocol}://${req.get('host')}/api/apple-health/sync?token=${token}`;
}

app.get('/api/garmin/credentials', (req, res) => {
  try {
    const creds = readGarminCredentials(getUserId(req));
    res.json(creds ? { connected: true, email: creds.email } : { connected: false });
  } catch (e) { console.error('GET /api/garmin/credentials', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/garmin/credentials', (req, res) => {
  try {
    const userId = getUserId(req);
    const email = (req.body?.email || '').toString().trim();
    const password = (req.body?.password || '').toString();
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    writeGarminCredentials(userId, email, password);
    // Neither a cached session nor a sync OUTCOME from a possibly DIFFERENT
    // Garmin account may survive a credential change. See
    // db.clearGarminSyncStatus.
    wipeTokenStore(userId);
    db.clearGarminSyncStatus(userId);
    res.json({ connected: true, email });
  } catch (e) { console.error('PUT /api/garmin/credentials', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/garmin/credentials', (req, res) => {
  try {
    const userId = getUserId(req);
    deleteGarminCredentialsFile(userId);
    wipeTokenStore(userId);
    db.clearGarminSyncStatus(userId);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/garmin/credentials', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/apple-health/credentials', (req, res) => {
  try {
    const userId = getUserId(req);
    const token = getAppleToken(userId);
    res.json(token ? { connected: true, token, syncUrl: buildAppleSyncUrl(req, token) } : { connected: false });
  } catch (e) { console.error('GET /api/apple-health/credentials', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/apple-health/credentials', (req, res) => {
  try {
    const userId = getUserId(req);
    const token = setAppleToken(userId);
    res.json({ connected: true, token, syncUrl: buildAppleSyncUrl(req, token) });
  } catch (e) { console.error('PUT /api/apple-health/credentials', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/apple-health/credentials', (req, res) => {
  try {
    const userId = getUserId(req);
    deleteAppleToken(userId);
    db.clearAppleSyncStatus(userId);
    res.json({ ok: true });
  } catch (e) { console.error('DELETE /api/apple-health/credentials', e); res.status(500).json({ error: e.message }); }
});

// ── Garmin Sync ───────────────────────────────────────────────────────────────
// Called by garmin_sync.py, never the browser, with the activities, sleep and
// recovery for the user it was invoked for (--user-id, see
// /api/garmin/trigger), reported back in the body since there is no
// X-User-Id here.

// ONE reconcile path for /api/garmin/sync and /api/apple-health/sync: the
// merge branch deletes data if it is wrong, so it must never exist as two
// copies that drift.
//
// A DENY-LIST of types where the manual entry wins. Everything else is
// sync-wins: the device's GPS/HR/calorie data beats a manual estimate, and the
// manual entry's note/RPE/title and snow tags are carried over first since no
// device sets them. The loggable set is OPEN (any synced or minted type), so sync-wins
// must be the default an unrecognized type falls into. Lift and climb are the
// exceptions: a device reports only a bare duration/calorie summary for them,
// while the manual entry holds sets or route detail — so the synced duplicate
// is discarded, all but its device-only fields (training load and effect),
// which are copied onto the manual row. Story: DECISIONS.md#garmin-dedup.
const MANUAL_WINS_TYPES = ['lift', 'climb'];

// A device's measured best efforts inside one activity, { [meters]: seconds }
// (garmin_sync.py's best_efforts_from_activity). Whatever arrives is reduced to
// integer-meter keys with finite positive seconds, or dropped entirely, so a
// malformed payload can never plant something the race-time records would then
// rank. Returns null when nothing survives. Story: DECISIONS.md#measured-race-times.
function sanitizeBestEfforts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [meters, secs] of Object.entries(raw)) {
    if (!/^\d{1,6}$/.test(meters) || Number(meters) <= 0) continue;
    if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0 || secs > 7 * 86400) continue;
    out[meters] = secs;
  }
  return Object.keys(out).length ? out : null;
}

// Garmin's training load and training effect for one activity
// (garmin_sync.py's training_effect_from_activity). Same stance as
// sanitizeBestEfforts: whatever arrives is bounded or dropped, and a dropped
// key is DELETED from the activity rather than kept as junk, so it can neither
// be stored nor overwrite a good stored value on the refresh arm. Returns the
// surviving keys as an object, empty when none survived.
// Story: DECISIONS.md#vo2-max-and-training-load.
const TRAINING_EFFECT_BOUNDS = { trainingLoad: [0, 5000], aerobicTE: [0, 5], anaerobicTE: [0, 5] };
function sanitizeTrainingEffect(activity) {
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(TRAINING_EFFECT_BOUNDS)) {
    const v = activity[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[key] = Math.round(v * 10) / 10;
    else delete activity[key];
  }
  const label = activity.trainingEffectLabel;
  if (typeof label === 'string' && /^[A-Z0-9_]{1,40}$/.test(label)) out.trainingEffectLabel = label;
  else delete activity.trainingEffectLabel;
  Object.assign(activity, out);
  return out;
}

function syncActivitiesForUser(activities, userId, sourceLabel) {
  let imported  = 0;
  let skipped   = 0;
  let merged    = 0;
  let refreshed = 0;

  for (const activity of activities) {
    const bestEfforts = sanitizeBestEfforts(activity.bestEfforts);
    if (bestEfforts) activity.bestEfforts = bestEfforts; else delete activity.bestEfforts;
    const deviceFields = { ...sanitizeTrainingEffect(activity), ...(bestEfforts ? { bestEfforts } : {}) };

    // Every type a device sends gets an activity_types row (a no-op if known),
    // whether or not this activity is imported, so the "categorize this"
    // reminder always has the complete list.
    db.ensureActivityType(activity.type);

    // Skip if THIS USER already stored this external id. Per user because
    // Apple's external_id may be a synthesized `type+start-time`, which two
    // people who trained together can share.
    //
    // The DEVICE-ONLY fields (measured splits, training load and effect) are
    // still written onto the stored row: no form edits them, and it is how a
    // deep --limit sync backfills them.
    if (activity.external_id && db.hasExternalId(activity.external_id, userId)) {
      if (db.refreshDeviceFields(activity.external_id, userId, deviceFields)) refreshed++;
      skipped++;
      continue;
    }

    // Only auto-resolves when the match is unambiguous (see
    // db.findLikelyDuplicate); otherwise both entries are kept as-is.
    const candidates = db.findManualCandidates(activity.date, activity.type, userId);
    const dup = db.findLikelyDuplicate(candidates, activity);

    if (dup && !MANUAL_WINS_TYPES.includes(activity.type)) {
      if (activity.note == null && dup.note != null) activity.note = dup.note;
      if (activity.rpe  == null && dup.rpe  != null) activity.rpe  = dup.rpe;
      // The typed title too; Garmin's own label is `name`, not `title`.
      if (activity.title == null && dup.title) activity.title = dup.title;
      // And the snow tags, which only a person can judge.
      if (activity.snow == null && dup.snow) activity.snow = dup.snow;
      if (activity.grooming == null && dup.grooming) activity.grooming = dup.grooming;
      console.log(`${sourceLabel} sync: merging manual entry #${dup.id} ("${dup.name || dup.type}", ${dup.date}) into synced activity ${activity.external_id} — kept note/RPE/title/snow`);
      // ATOMIC: this deletes the manual entry — the only copy of its note and
      // RPE — and inserts the synced one; a throw between must lose nothing.
      // A niggle linked to the manual entry (injuries.history_id) moves to
      // the synced row inside the same transaction.
      db.transaction(() => {
        db.deleteHistory(dup.id);
        const newId = db.addHistory(activity, {}, userId);
        db.relinkInjuries(dup.id, newId);
      });
      merged++;
      imported++;
    } else if (dup) {
      // The device's load and training effect still come across: Garmin's own
      // totals include this session, so dropping them hides a session its load
      // counts. Everything else about the duplicate is discarded.
      const carried = db.addDeviceFieldsToManual(dup.id, userId, deviceFields);
      console.log(`${sourceLabel} sync: keeping manual entry #${dup.id} ("${dup.name || dup.type}", ${dup.date}) — discarding bare ${sourceLabel} duplicate ${activity.external_id}${carried ? ', device fields carried over' : ''}`);
      if (carried) refreshed++;
      merged++;
    } else {
      db.addHistory(activity, {}, userId);
      imported++;
    }
  }

  return { imported, skipped, merged, refreshed };
}

app.post('/api/garmin/sync', (req, res) => {
  try {
    const { activities, sleep, recovery, userId: bodyUserId } = req.body;
    const userId = Number.isInteger(bodyUserId) ? bodyUserId : 1;
    // --user-id comes from a cron line, validated nowhere upstream, so an
    // unknown id is an explicit 400 rather than rows under a user nothing
    // displays.
    if (!db.getUsers().some(u => u.id === userId)) {
      return res.status(400).json({ error: `No such user id ${userId}` });
    }
    if (!Array.isArray(activities)) {
      return res.status(400).json({ error: 'activities must be an array' });
    }

    // `sleep` is a LIST of day summaries, newest first — a trailing window, so
    // a score Garmin finalizes days later still lands (fetch_sleep_window). A
    // bare object is also accepted. Story: DECISIONS.md#sleep-backfill-window.
    const sleepDays = Array.isArray(sleep) ? sleep : (sleep ? [sleep] : []);
    for (const s of sleepDays) {
      if (!s || !s.date) continue;
      // Write ONLY what Garmin returned: upsertCheckin keeps an omitted key but
      // overwrites on an explicit null, so a `?? null` here would let a
      // partial response wipe a good stored score.
      const fields = {};
      if (Number.isFinite(s.score)) fields.garmin_sleep_score = Math.round(s.score);
      if (typeof s.qualifier === 'string' && s.qualifier) fields.garmin_sleep_qualifier = s.qualifier;
      if (Object.keys(fields).length) db.upsertCheckin(s.date, fields, userId);

      // The same night's overnight READINGS go to garmin_daily, not checkins:
      // they are measurements, and the readiness verdict baselines them beside
      // resting HR and HRV. Only the score stays on checkins (it predates
      // garmin_daily). One decimal, the way vo2max keeps one, because a
      // whole-number round would flatten the small drifts these exist to show.
      // Skin temperature is SIGNED, so its bounds are symmetric; a sentinel is
      // kept out upstream by skinTempDataExists (fetch_sleep_summary).
      // Story: DECISIONS.md#readiness-verdict.
      const dec1 = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null;
      const readings = {};
      if (dec1(s.resp_rate, 4, 40) != null) readings.resp_rate = dec1(s.resp_rate, 4, 40);
      if (Number.isFinite(s.sleep_minutes) && s.sleep_minutes >= 1 && s.sleep_minutes <= 1440) readings.sleep_minutes = Math.round(s.sleep_minutes);
      if (dec1(s.skin_temp_dev, -5, 5) != null) readings.skin_temp_dev = dec1(s.skin_temp_dev, -5, 5);
      if (Object.keys(readings).length) db.upsertGarminDaily(s.date, readings, userId);
    }

    // `recovery` has the same shape and contract as `sleep`. It goes to
    // garmin_daily, not checkins, because none of it is self-report. The
    // write-only-what-arrived rule matters even more here: these come from
    // several Garmin endpoints, so a partial response is the normal case.
    // Story: DECISIONS.md#garmin-recovery-signals.
    const recoveryDays = Array.isArray(recovery) ? recovery : (recovery ? [recovery] : []);
    const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
    // Garmin's word-shaped fields (TRAINING_STATUS, AEROBIC_LOW_SHORTAGE):
    // stored as sent when they look like one, dropped otherwise.
    const word = v => typeof v === 'string' && /^[A-Z0-9_]{1,40}$/.test(v) ? v : null;
    for (const r of recoveryDays) {
      if (!r || !r.date) continue;
      const fields = {};
      // Ranges are sanity bounds, not physiology: a sentinel like 0 or -1 is
      // dropped rather than stored as a measurement a baseline averages in.
      // stress_avg's sentinel is ROUTINE — Garmin sends -1 or -2 on days with
      // no stress data — so its lower bound of 0 must never accept negatives.
      if (num(r.resting_hr, 20, 200) != null) fields.resting_hr = num(r.resting_hr, 20, 200);
      if (num(r.hrv_overnight, 1, 400) != null) fields.hrv_overnight = num(r.hrv_overnight, 1, 400);
      if (num(r.steps, 0, 200000) != null) fields.steps = num(r.steps, 0, 200000);
      if (num(r.body_battery_high, 0, 100) != null) fields.body_battery_high = num(r.body_battery_high, 0, 100);
      if (num(r.body_battery_low, 0, 100) != null) fields.body_battery_low = num(r.body_battery_low, 0, 100);
      if (num(r.readiness_score, 0, 100) != null) fields.readiness_score = num(r.readiness_score, 0, 100);
      if (num(r.stress_avg, 0, 100) != null) fields.stress_avg = num(r.stress_avg, 0, 100);
      // A total includes the resting burn, so nothing real is near 0; a 0
      // there is an unworn day's placeholder. Active burn can be a real 0.
      if (num(r.calories_total, 300, 20000) != null) fields.calories_total = num(r.calories_total, 300, 20000);
      if (num(r.calories_active, 0, 15000) != null) fields.calories_active = num(r.calories_active, 0, 15000);
      if (typeof r.hrv_status === 'string' && r.hrv_status) fields.hrv_status = r.hrv_status;
      if (typeof r.readiness_level === 'string' && r.readiness_level) fields.readiness_level = r.readiness_level;
      // VO2 max keeps ONE decimal: Garmin's precise value moves in tenths, and
      // num()'s rounding to a whole number would flatten exactly the drift the
      // VO2 Max card exists to show. Story: DECISIONS.md#vo2-max-and-training-load.
      if (Number.isFinite(r.vo2max) && r.vo2max >= 10 && r.vo2max <= 100) fields.vo2max = Math.round(r.vo2max * 10) / 10;
      // Loads are non-negative by construction; a 0 is real (a fortnight off
      // decays acute load to it), so the lower bound is 0, not 1.
      for (const key of ['load_acute', 'load_chronic', 'load_optimal_min', 'load_optimal_max',
        'focus_low_aerobic', 'focus_high_aerobic', 'focus_anaerobic',
        'focus_low_aerobic_min', 'focus_low_aerobic_max', 'focus_high_aerobic_min',
        'focus_high_aerobic_max', 'focus_anaerobic_min', 'focus_anaerobic_max']) {
        if (num(r[key], 0, 20000) != null) fields[key] = num(r[key], 0, 20000);
      }
      if (word(r.training_status)) fields.training_status = r.training_status;
      if (word(r.focus_feedback)) fields.focus_feedback = r.focus_feedback;
      if (Object.keys(fields).length) db.upsertGarminDaily(r.date, fields, userId);
    }

    const result = syncActivitiesForUser(activities, userId, 'Garmin');
    console.log(`Garmin sync: imported ${result.imported}, merged ${result.merged}, skipped ${result.skipped}, device fields refreshed ${result.refreshed}`);
    res.json(result);
  } catch (e) {
    console.error('POST /api/garmin/sync', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Apple Health Sync ────────────────────────────────────────────────────────
// Apple has no pull API, so an iOS Shortcut reads HealthKit workouts and
// PUSHES them here. Identity travels via `?token=`, a per-user secret from
// PUT /api/apple-health/credentials baked into that user's Shortcut URL; an
// unknown or revoked token 401s and never falls back to a default user.
//
// Deliberately minimal until a real Shortcut round-trips: { activities:
// [{ type, date, timestamp, duration, calories, external_id }] }, no sleep or
// weight. `external_id` must be stable per workout (a HealthKit UUID, or a
// synthesized `type+start-time`) — dedup depends on it.
//
// This POST is the whole sync, so the route records its own outcome via
// setAppleSyncStatus (Garmin's script POSTs its outcome separately).
app.post('/api/apple-health/sync', (req, res) => {
  const userId = resolveUserIdByAppleToken(req.query.token);
  if (!userId) return res.status(401).json({ error: 'Unknown or revoked sync token' });
  try {
    const { activities } = req.body;
    if (!Array.isArray(activities)) {
      return res.status(400).json({ error: 'activities must be an array' });
    }
    const result = syncActivitiesForUser(activities, userId, 'Apple');
    console.log(`Apple sync: imported ${result.imported}, merged ${result.merged}, skipped ${result.skipped}`);
    db.setAppleSyncStatus(userId, {
      ok: true,
      message: `Imported ${result.imported}, merged ${result.merged}, skipped ${result.skipped}`,
    });
    res.json(result);
  } catch (e) {
    console.error('POST /api/apple-health/sync', e);
    db.setAppleSyncStatus(userId, { ok: false, message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// The Apple sync error badge's source, for the CURRENT user; null (nothing to
// show) for a user with no Apple sync.
app.get('/api/apple-health/sync-status', (req, res) => {
  try { res.json(db.getAppleSyncStatus(getUserId(req))); }
  catch (e) { console.error('GET /api/apple-health/sync-status', e); res.status(500).json({ error: e.message }); }
});

// ── Activity Types ───────────────────────────────────────────────────────────────
// Emoji/label per activity `type` — curated built-ins, anything a sync has
// seen (db.ensureActivityType) and anything minted by hand. categorized=0
// rows are placeholders awaiting a real emoji/label.
app.get('/api/activity-types', (req, res) => {
  try {
    res.json(db.getActivityTypes());
  } catch (e) {
    console.error('GET /api/activity-types', e);
    res.status(500).json({ error: e.message });
  }
});

// Mint a type by hand, for a sport nothing has synced. The key is DERIVED from
// the label, never supplied: history rows are stored under it, so it is an
// identity key like an exercise name. Slugged to Garmin's typeKey shape
// (lowercase, underscores) so a later sync of the same sport can land on it.
const ACTIVITY_KEY_MAX = 40;
function slugActivityKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, ACTIVITY_KEY_MAX);
}

// Shared by POST and PATCH so the two can't drift. Checks the TYPE, never
// coerces: String({}) would slug to `object_object` and mint a real row.
function readActivityTypeBody(body) {
  const label = body?.label;
  const emoji = body?.emoji;
  if (typeof label !== 'string' || typeof emoji !== 'string') return { error: 'label and emoji must be strings' };
  const trimmedLabel = label.trim();
  const trimmedEmoji = emoji.trim();
  if (!trimmedLabel || !trimmedEmoji) return { error: 'label and emoji are required' };
  return { label: trimmedLabel, emoji: trimmedEmoji };
}

app.post('/api/activity-types', (req, res) => {
  try {
    const { label, emoji, error } = readActivityTypeBody(req.body);
    if (error) return res.status(400).json({ error });
    const key = slugActivityKey(label);
    // A label of nothing but punctuation slugs to an empty string, which would
    // otherwise insert a row keyed '' that no history row can ever match.
    if (!key) return res.status(400).json({ error: 'label must contain a letter or a digit' });
    const created = db.createActivityType(key, { label, emoji });
    if (!created) return res.status(409).json({ error: `You already have an activity type called "${label}"` });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /api/activity-types', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/activity-types/:key', (req, res) => {
  try {
    const { label, emoji, error } = readActivityTypeBody(req.body);
    if (error) return res.status(400).json({ error });
    const updated = db.updateActivityType(req.params.key, { label, emoji });
    if (!updated) return res.status(404).json({ error: 'Activity type not found' });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /api/activity-types/:key', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Garmin Sync Status ────────────────────────────────────────────────────────
// "Did the last attempt work", separate from the data route.
// garmin_sync.py POSTs here at the end of every run however it was invoked —
// the only way a failed cron sync reaches the UI. Per-user: GET via the
// browser's X-User-Id, POST via the userId in the body.
app.get('/api/garmin/sync-status', (req, res) => {
  try { res.json(db.getGarminSyncStatus(getUserId(req))); }
  catch (e) { console.error('GET /api/garmin/sync-status', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/garmin/sync-status', (req, res) => {
  try {
    const { ok, mfa_required, rate_limited, message, userId: bodyUserId } = req.body || {};
    const userId = Number.isInteger(bodyUserId) ? bodyUserId : 1;
    // Same check and same reason as POST /api/garmin/sync: the id comes from a
    // cron line, not the users table, and a status row for a user nobody can
    // pick is one no badge will ever show.
    if (!db.userExists(userId)) return res.status(400).json({ error: `No such user id ${userId}` });
    res.json(db.setGarminSyncStatus(userId, {
      ok: !!ok, mfa_required: !!mfa_required, rate_limited: !!rate_limited, message,
    }));
  } catch (e) {
    console.error('POST /api/garmin/sync-status', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Garmin Trigger ────────────────────────────────────────────────────────────
// Called by the browser's "Sync Garmin" button. Spawns garmin_sync.py with
// --user-id so it knows whose credentials and token store to use.
// Two-step MFA: without a cached token the script exits with "MFA_REQUIRED",
// relayed as { mfaRequired: true }; the browser asks for the code and POSTs
// again with { mfaCode }. A cached token skips it until it expires.
//
// SOMEONE IS WAITING ON THIS ONE, so it asks for less than the cron does:
// sleep and recovery only back to the last successful sync
// (--catch-up-since, see garmin_sync.py's CATCH_UP_MIN_DAYS) and a few routes,
// leaving the full windows and the route backlog to the 9am run.
//
// The timeout covers a full MFA sign-in plus that work with room to spare.
// Killing a run is costly: after an MFA code it means asking for a new one.
// The env override exists for testing/verify_sync_credentials.js.
const GARMIN_TRIGGER_TIMEOUT_MS = Number(process.env.GARMIN_TRIGGER_TIMEOUT_MS) || 120000;
const GARMIN_MANUAL_ROUTE_BATCH = 5;

// Each user's browser-started run, as its last PROGRESS line said: which step
// it is on, for GET below and the Sync button's label. In memory, because
// only a run this process spawned can be watched (the cron's never pass
// through here). garmin_sync.py's progress() owns the line format.
const GARMIN_PROGRESS_RE = /^PROGRESS ([a-z_]+)(?: (\d+)\/(\d+))?$/;
const garminSyncRuns = new Map();

app.get('/api/garmin/trigger', (req, res) => {
  const run = garminSyncRuns.get(getUserId(req));
  res.json({ running: run ? { step: run.step, done: run.done, total: run.total, startedAt: run.startedAt } : null });
});

app.post('/api/garmin/trigger', (req, res) => {
  const userId = getUserId(req);
  if (!readGarminCredentials(userId)) {
    return res.status(400).json({ ok: false, output: "Garmin isn't connected for this user yet." });
  }

  const scriptPath = path.join(__dirname, 'garmin_sync.py');
  const mfaCode = (req.body?.mfaCode || '').toString().trim();

  // Defense in depth — execFile doesn't invoke a shell, but keep input sane
  if (mfaCode && !/^[0-9]{4,8}$/.test(mfaCode)) {
    return res.status(400).json({ ok: false, output: 'MFA code must be 4-8 digits' });
  }

  const args = [scriptPath, '--user-id', String(userId), '--progress',
    '--route-batch', String(GARMIN_MANUAL_ROUTE_BATCH)];
  const lastSuccess = db.getGarminSyncStatus(userId)?.last_success_at;
  if (lastSuccess) args.push('--catch-up-since', db.isoDateStr(new Date(lastSuccess)));
  if (mfaCode) args.push('--mfa-code', mfaCode);
  console.log(`Triggering Garmin sync: python3 ${args.join(' ')}`);

  // The run is entered in garminSyncRuns at its first PROGRESS line, not at
  // spawn, and removed only if the entry is still its own: a second press
  // while one runs spawns a script that exits busy at once, and must neither
  // replace the real run's progress nor clear it.
  const run = { step: 'starting', done: null, total: null, startedAt: Date.now() };
  let pending = '';
  const child = execFile('python3', args, { timeout: GARMIN_TRIGGER_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (garminSyncRuns.get(userId) === run) garminSyncRuns.delete(userId);
    const output = (stdout + stderr).trim();

    // Killed by the timeout, so the script never reported: say so here, or
    // the badge keeps showing whatever the run before this one left.
    if (err && err.killed) {
      console.error(`Garmin sync timed out after ${GARMIN_TRIGGER_TIMEOUT_MS} ms:`, output);
      db.setGarminSyncStatus(userId, {
        ok: false,
        message: `The sync took longer than ${garminTimeoutWords()} and was stopped. Anything saved `
          + 'before then is kept. Try again later, or leave it to the morning sync.',
      });
      return res.status(500).json({ ok: false, timedOut: true, output });
    }

    if (output.includes('MFA_REQUIRED')) {
      console.log('Garmin sync: MFA code required');
      return res.json({ ok: false, mfaRequired: true, output });
    }
    // Another sync for this user holds garmin_sync.py's lock (a cron run, the
    // other Sync button, another device). Not a failure: that run reports.
    if (output.includes('SYNC_IN_PROGRESS')) {
      return res.status(409).json({ ok: false, busy: true, output });
    }
    if (err && err.code !== 0) {
      console.error('Garmin sync error:', output);
      return res.status(500).json({ ok: false, output });
    }
    console.log('Garmin sync output:', output);
    res.json({ ok: true, output });
  });
  child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const m = GARMIN_PROGRESS_RE.exec(line.trim());
      if (!m) continue;
      run.step = m[1];
      run.done = m[2] ? Number(m[2]) : null;
      run.total = m[3] ? Number(m[3]) : null;
      garminSyncRuns.set(userId, run);
    }
  });
});

function garminTimeoutWords() {
  const ms = GARMIN_TRIGGER_TIMEOUT_MS;
  return ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

// ── Liturgical calendar ──────────────────────────────────────────────────────
// Feeds the badge above every journal entry: the day's feast(s), its season,
// and where it falls in the liturgical year. Source is the Liturgical Calendar
// API's US national calendar — the USCCB proper, so Epiphany lands on the
// Sunday between Jan 2-8 and the US-only celebrations (John Neumann, Kateri
// Tekakwitha, Independence Day) are present.
//
// A third party, in an app that otherwise computes what it shows, because
// liturgical precedence is intricate and a wrong feast is WRONG, not rough.
// Nothing approximates to fill a gap: a year that cannot be fetched is absent
// from the response and its badges render nothing.
// Story: DECISIONS.md#liturgical-day.
//
// The DEV path, deliberately, not the versioned /api/v5/: corrections land on
// dev first, and v5 is wrong on days dev gets right (e.g. it doesn't transfer
// St Vincent to Jan 23 when the US Day of Prayer takes Jan 22, and colours the
// Sacred Heart red). The cost is that dev's shape can change without notice;
// if it does, fetchLitcalYear's "no usable days" throw leaves that year blank
// rather than wrong, and cached years are unaffected.
const LITCAL_NATION     = 'US';
const LITCAL_TIMEOUT_MS = 20000;
const LITCAL_BASE = 'https://litcal.johnromanodorazio.com/api/dev';
const litcalUrl = year => `${LITCAL_BASE}/calendar/nation/${LITCAL_NATION}/${year}?year_type=CIVIL`;
// Every celebration the nation's calendar knows, with its USUAL date — the
// only structured way to learn what a day would have been. The year's calendar
// drops an impeded memorial outright and mentions it only in English prose
// (its `messages`), which this app does not parse.
const litcalEventsUrl = `${LITCAL_BASE}/events/nation/${LITCAL_NATION}`;

// THE CACHE NEVER EXPIRES, and that is a property of the data rather than a
// shortcut: a civil year's calendar is fully determined and cannot change once
// published. Under data/ because that is the one directory OMV only mounts and
// never regenerates (CLAUDE.md). Derived, so it is deliberately in neither
// backup path — deleting a file is how you force a refetch (OPERATIONS.md).
//
// The FILE NAME CARRIES THE FORMAT (-v2: days carry `impeded`). A file without
// impeded entries can't be told apart from one whose year simply had none, so
// only a new name forces the refetch that adds them. The unversioned file is
// read only as a fallback while the upstream is unreachable, and is removed
// once its replacement is written.
function litcalCachePath(year) { return path.join(DATA_DIR, `litcal-${LITCAL_NATION}-${year}-v2.json`); }
function litcalLegacyCachePath(year) { return path.join(DATA_DIR, `litcal-${LITCAL_NATION}-${year}.json`); }

// A US-proper celebration arrives as "[ US ] Saint John Neumann, Bishop" (or
// "[ USA ] ..."). The bracket marks which calendar contributed the entry; it is
// not part of the saint's name.
function litcalDisplayName(name) {
  return String(name || '').replace(/^\[\s*[A-Za-z]+\s*\]\s*/, '').trim();
}

// grade, as the API ranks a celebration:
//   0 weekday · 1 commemoration · 2 optional memorial · 3 Memorial · 4 Feast
//   5 Feast of the Lord (and every ordinary Sunday) · 6 Solemnity
//   7 above a solemnity (Easter, Christmas, Ash Wednesday, Holy Week)
// 1 and 2 are the two a priest MAY take and may equally leave — the pair that
// does not bind, which is what separates them below.
const LITCAL_OPTIONAL_GRADES = new Set([1, 2]);

// A day's entries are a weekday line, some feasts and some vigils, mixed.
// THREE TRAPS, each of which renders visibly wrong output if missed:
//
//  1. A VIGIL IS NOT THE DAY. Saturday vigils are filed under Saturday's date,
//     so is_vigil_mass entries are dropped.
//
//  2. THE WEEKDAY LINE AND THE FEASTS ARE DIFFERENT ENTRIES, and on many days
//     an obligatory memorial or higher replaces the weekday entry outright.
//     Grade 5 ON A SUNDAY is the Sunday itself (the weekday line); grade 5 on
//     a WEEKDAY is a Feast of the Lord and is crowned — hence the day-of-week
//     test in isTemporal.
//
//  3. AN OPTIONAL MEMORIAL DOES NOT COLOUR THE DAY. Colour and season come
//     from the highest OBLIGATORY entry. liturgical_year and psalter_week
//     appear only on the weekday or Sunday entry.
//
// When a day has nothing but optional memorials, the colour falls back to the
// highest-graded entry; only the tint can be off, never the text.
//
// IMPEDED: a fixed-date memorial or higher that the year's calendar does not
// carry ANYWHERE is listed on its usual date as `impeded`, with `by` naming
// the entry that outranked it there (St Francis under a Sunday). Matched on
// event_key, so a celebration TRANSFERRED to another date is not impeded — it
// already shows on the day it moved to. Two guards keep this to what the
// calendar actually displaced:
//   - grade >= 3 only. An optional memorial gives way to every Sunday and
//     every privileged weekday, so listing those is noise, not news.
//   - something on that date must OUTRANK it. The events list is today's;
//     a memorial added to the calendar after the year being trimmed is
//     missing from that year for a different reason, and on an ordinary
//     weekday nothing outranks it, so it is not reported.
// `events` null (the events list could not be fetched) leaves `impeded` off.
const LITCAL_IMPEDED_MIN_GRADE = 3;

function trimLitcalYear(payload, events = null) {
  const byDate = {};
  for (const e of (payload && payload.litcal) || []) {
    if (e.is_vigil_mass) continue;
    const date = String(e.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    (byDate[date] = byDate[date] || []).push(e);
  }

  const isTemporal = e => e.grade === 0 || (e.grade === 5 && e.day_of_the_week_iso8601 === 7);
  const out = {};
  for (const [date, events] of Object.entries(byDate)) {
    const temporal  = events.find(isTemporal) || null;
    const feasts    = events.filter(e => !isTemporal(e)).sort((a, b) => b.grade - a.grade);
    const byGrade   = [...events].sort((a, b) => b.grade - a.grade);
    const colorFrom = byGrade.find(e => !LITCAL_OPTIONAL_GRADES.has(e.grade)) || byGrade[0];

    const day = {
      season: (colorFrom.liturgical_season_lcl) || '',
      color:  (colorFrom.color && colorFrom.color[0]) || '',
    };
    if (temporal) {
      day.weekday = litcalDisplayName(temporal.name);
      if (temporal.liturgical_year) day.cycle   = temporal.liturgical_year;
      if (temporal.psalter_week)    day.psalter = temporal.psalter_week;
    }
    if (feasts.length) {
      day.feasts = feasts.map(e => ({ name: litcalDisplayName(e.name), grade: e.grade }));
    }
    out[date] = day;
  }

  if (events) {
    const keptKeys = new Set(Object.values(byDate).flat().map(e => e.event_key));
    const year = (Object.keys(byDate)[0] || '').slice(0, 4);
    for (const ev of events) {
      if (ev.type !== 'fixed' || !(ev.grade >= LITCAL_IMPEDED_MIN_GRADE) || keptKeys.has(ev.event_key)) continue;
      const date = `${year}-${String(ev.month).padStart(2, '0')}-${String(ev.day).padStart(2, '0')}`;
      if (!byDate[date] || !out[date]) continue;   // Feb 29 in a common year, or a day outside the payload
      const top = byDate[date].reduce((a, b) => (b.grade > a.grade ? b : a));
      if (!(top.grade > ev.grade)) continue;
      (out[date].impeded = out[date].impeded || []).push({
        name: litcalDisplayName(ev.name), grade: ev.grade, by: litcalDisplayName(top.name),
      });
    }
  }
  return out;
}

async function fetchLitcalJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(LITCAL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`responded ${res.status}`);
  return res.json();
}

// `complete` false means the year itself arrived but the events list did not,
// so the days carry no `impeded`: served, but never cached, since the cache is
// permanent and would freeze the gap in. The next request tries again.
async function fetchLitcalYear(year) {
  const [payload, events] = await Promise.all([
    fetchLitcalJson(litcalUrl(year)),
    fetchLitcalJson(litcalEventsUrl).then(j => {
      const list = j && j.litcal_events;
      return Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : null);
    }).catch(e => { console.error('Liturgical events list unavailable:', e.message); return null; }),
  ]);
  const days = trimLitcalYear(payload, events);
  if (!Object.keys(days).length) throw new Error('no usable days in the response');
  return { days, complete: !!events };
}

// In-flight requests are shared rather than duplicated: on a cold start the
// browser's post-boot request and warmLiturgicalCache() below ask for the same years
// within milliseconds of each other, and each year's ~460 KB download should
// happen once.
const litcalInFlight = new Map();

async function liturgicalYear(year) {
  try {
    const cached = fs.readFileSync(litcalCachePath(year), 'utf8');
    return JSON.parse(cached);
  } catch (e) { /* not cached yet, or a truncated file — refetch below */ }

  if (!litcalInFlight.has(year)) {
    litcalInFlight.set(year, fetchLitcalYear(year)
      .then(({ days, complete }) => {
        if (complete) {
          writeFileAtomic(litcalCachePath(year), JSON.stringify(days));
          fs.rm(litcalLegacyCachePath(year), { force: true }, () => {});
        }
        return days;
      })
      .catch(e => {
        try { return JSON.parse(fs.readFileSync(litcalLegacyCachePath(year), 'utf8')); }
        catch (_) { throw e; }
      })
      .finally(() => litcalInFlight.delete(year)));
  }
  return litcalInFlight.get(year);
}

// WHICH YEARS: every year the database holds a dated row in, plus the current
// one — exactly the years a badge can render for. The server decides, so the
// frontend makes one request with no list to build.
//
// The frontend fires that request AFTER first paint, never inside init()'s
// Promise.all: an uncached year waits up to LITCAL_TIMEOUT_MS on the upstream,
// and joined to boot that would hold the loading screen.
//
// Clamped because the span comes from user data, where one junk-dated row
// would otherwise fetch years nobody will look at.
const LITCAL_MAX_YEARS = 12;

function liturgicalYearsNeeded() {
  const thisYear = new Date().getFullYear();
  const { min, max } = db.getDataYearSpan();
  const first = Math.max(min || thisYear, thisYear - LITCAL_MAX_YEARS + 1);
  const last  = Math.min(Math.max(max || thisYear, thisYear), thisYear + 1);
  const years = [];
  for (let y = Math.min(first, last); y <= last; y++) years.push(y);
  return years;
}

// Not user-scoped: a calendar is the same for everyone, like /api/backup/status.
// A year that cannot be fetched is OMITTED rather than nulled or 500ing the
// request — every other year still renders its badges, and the frontend's
// liturgicalDayFor() already treats an absent year as "say nothing".
app.get('/api/liturgical', async (req, res) => {
  const out = {};
  await Promise.all(liturgicalYearsNeeded().map(async year => {
    try {
      out[year] = await liturgicalYear(year);
    } catch (e) {
      console.error(`Liturgical calendar ${year} unavailable:`, e.message);
    }
  }));
  res.json(out);
});

// Fire-and-forget at boot so the first browser request is served from disk
// instead of waiting on two ~460 KB downloads. Deliberately not awaited and
// deliberately not fatal: a Pi that comes up before its network does must still
// serve the app, just without badges until a later request fills the cache.
function warmLiturgicalCache() {
  for (const year of liturgicalYearsNeeded()) {
    liturgicalYear(year).catch(e => console.error(`Liturgical calendar ${year} not cached:`, e.message));
  }
}

// ── Activity weather ─────────────────────────────────────────────────────────
// What it was like out there for each routed activity, from Open-Meteo's
// historical-forecast API (free, no key, hourly, high-resolution models back
// to 2021). The table comment in db.js says what a row means.
// Story: DECISIONS.md#activity-weather.
//
// WHAT LEAVES THE PI: the route's start point ROUNDED TO 2 DECIMALS (about a
// kilometre, finer than the model grid, so no accuracy is lost) and the dates.
// Never the track, never who ran it.
//
// The whole activity window is asked for, not one reading, because "was it
// raining on this run" is a question about the hours you were out: a single
// snapshot at the start misses the shower in the second half.
// WT_WEATHER_API is for the harnesses only: verify_backend.js points it at a
// local fake, and 'off' keeps a test that stores routes off the internet.
const WEATHER_API = process.env.WT_WEATHER_API || 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const WEATHER_HOURLY = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m',
  'wind_speed_10m', 'wind_gusts_10m', 'precipitation', 'snowfall', 'weather_code'];
const WEATHER_TIMEOUT_MS = 20000;
// Paced well under the free tier's 600 calls a minute; a whole backlog of a
// few hundred activities still drains in a couple of minutes.
const WEATHER_GAP_MS = 250;
const WEATHER_BATCH = 300;
// An activity whose length is unknown is assumed to be an hour long.
const WEATHER_DEFAULT_S = 3600;

const roundCoord = v => Math.round(v * 100) / 100;
const utcDay = s => new Date(s * 1000).toISOString().slice(0, 10);

// The instant [startS, endS] (epoch seconds) an activity spanned. The route's
// own clock wins: its last time is the elapsed time from first sample to
// last, pauses included, which is the span the weather applies to.
function activityWindow(a) {
  const startS = Math.floor(a.timestamp / 1000);
  const fromRoute = Array.isArray(a.times) && a.times.length ? a.times[a.times.length - 1] : null;
  const len = fromRoute > 0 ? fromRoute : (db.durationSec(a.duration) || WEATHER_DEFAULT_S);
  return { startS, endS: startS + Math.round(len) };
}

// Linear interpolation at x over hourly samples, or null past either end or
// next to a missing value.
function interpAt(times, vals, x) {
  for (let i = 0; i < times.length; i++) {
    if (times[i] === x) return vals[i] ?? null;
    if (times[i] > x) {
      if (i === 0) return null;
      const a = vals[i - 1], b = vals[i];
      if (a == null || b == null) return null;
      return a + (b - a) * (x - times[i - 1]) / (times[i] - times[i - 1]);
    }
  }
  return null;
}

// Time-weighted mean over [a, b] of an INSTANTANEOUS series (temperature,
// wind): trapezoids between a, every whole hour inside, and b. A 20-minute
// run at 9:10 is 9:10-9:30's temperature, not 9:00's and 10:00's averaged.
function windowMean(times, vals, a, b) {
  const xs = [a, ...times.filter(t => t > a && t < b), b];
  let area = 0, span = 0;
  for (let k = 0; k + 1 < xs.length; k++) {
    const y0 = interpAt(times, vals, xs[k]), y1 = interpAt(times, vals, xs[k + 1]);
    if (y0 == null || y1 == null) continue;
    area += (y0 + y1) / 2 * (xs[k + 1] - xs[k]);
    span += xs[k + 1] - xs[k];
  }
  return span > 0 ? area / span : null;
}

// Open-Meteo's hourly block -> one activity_weather row's measurements.
//
// Two kinds of series, read differently. Temperature, humidity, dew point and
// wind are INSTANTANEOUS at each hour, so they are averaged over the window.
// Precipitation, snowfall, gusts and the weather code describe the HOUR
// ENDING at each timestamp, so each hour counts by how much of it the
// activity overlapped: the rain total is weighted, the peaks take any hour
// touched at all.
function summarizeWeather(hourly, startS, endS) {
  const H = 3600;
  const times = (hourly && hourly.time) || [];
  const series = k => (hourly && Array.isArray(hourly[k]) ? hourly[k] : []);
  const round1 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const mean = k => round1(windowMean(times, series(k), startS, endS));

  let precip = null, snow = null, precipMax = null, gustMax = null, codeMax = null;
  times.forEach((t, i) => {
    const overlap = Math.min(t, endS) - Math.max(t - H, startS);
    if (overlap <= 0) return;
    const frac = overlap / H;
    const p = series('precipitation')[i], sn = series('snowfall')[i];
    const g = series('wind_gusts_10m')[i], c = series('weather_code')[i];
    if (p != null) { precip = (precip || 0) + p * frac; precipMax = Math.max(precipMax ?? 0, p); }
    if (sn != null) snow = (snow || 0) + sn * frac;
    if (g != null) gustMax = Math.max(gustMax ?? 0, g);
    if (c != null) codeMax = Math.max(codeMax ?? 0, c);
  });

  return {
    temp_c: mean('temperature_2m'),
    feels_like_c: mean('apparent_temperature'),
    humidity_pct: mean('relative_humidity_2m'),
    dew_point_c: mean('dew_point_2m'),
    wind_kmh: mean('wind_speed_10m'),
    gust_kmh: round1(gustMax),
    precip_mm: round1(precip),
    precip_max_mmh: round1(precipMax),
    snow_cm: round1(snow),
    weather_code: codeMax,
  };
}

// One activity's row, or a throw, of three kinds. `checked`: Open-Meteo
// understood the question and has no answer (a 400, a date or place outside
// its coverage), so the caller stores an empty row. `stopPass`: nothing will
// get through right now (no network, a timeout, a 429), so the pass ends.
// Anything else (a 5xx) is this one request's problem.
async function fetchActivityWeather(a) {
  const pts = decodePolyline(a.polyline);
  if (!pts || !pts.length) { const e = new Error('route has no points'); e.checked = true; throw e; }
  const lat = roundCoord(pts[0][0]), lon = roundCoord(pts[0][1]);
  const { startS, endS } = activityWindow(a);
  // A whole day either side of the UTC dates: the interpolation needs the
  // hour before the start and after the end, and the model's hours are UTC.
  const qs = new URLSearchParams({
    latitude: lat, longitude: lon,
    start_date: utcDay(startS - 3600), end_date: utcDay(endS + 3600),
    hourly: WEATHER_HOURLY.join(','), timeformat: 'unixtime', timezone: 'GMT',
  });
  let res;
  try {
    res = await fetch(`${WEATHER_API}?${qs}`, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  } catch (e) {
    e.stopPass = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Open-Meteo responded ${res.status}`);
    e.checked = res.status === 400;
    e.stopPass = res.status === 429;
    throw e;
  }
  const body = await res.json();
  return { external_id: a.external_id, lat, lon, ...summarizeWeather(body.hourly, startS, endS) };
}

// The queue also holds each PROVISIONAL row (fetched within a day of the
// activity) once that day has passed, so yesterday's weather is always asked
// for once more: Open-Meteo revises its most recent hours, and a run synced
// straight after it can be cached as dry when the model later has it in
// drizzle. The table comment in db.js has the rule.
//
// SINGLE-FLIGHT: every trigger (boot, a route POST, the browser's GET) shares
// the pass already running rather than starting a second one against the same
// queue. The queue is just "rows not yet written", so the next trigger resumes
// wherever a pass stopped.
//
// A pass ends early on a `stopPass` failure, which would fail every remaining
// call too. Any other transient failure sets THAT activity aside for an hour
// (in memory; a restart forgets it) and the pass carries on, so one request
// Open-Meteo keeps failing can never hold up the activities behind it.
let weatherFill = null;
const weatherRetryAt = new Map();   // `${user_id}:${external_id}` -> epoch ms
const WEATHER_RETRY_MS = 60 * 60 * 1000;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function fillActivityWeather() {
  if (WEATHER_API === 'off') return Promise.resolve();
  if (weatherFill) return weatherFill;
  weatherFill = (async () => {
    let done = 0;
    for (const a of db.getWeatherlessActivities(WEATHER_BATCH)) {
      if (shuttingDown) break;
      const key = `${a.user_id}:${a.external_id}`;
      if (weatherRetryAt.get(key) > Date.now()) continue;
      try {
        db.upsertActivityWeather(await fetchActivityWeather(a), a.user_id);
        done++;
      } catch (e) {
        if (e.stopPass) { console.error(`Activity weather paused after ${done}:`, e.message); break; }
        if (!e.checked) {
          console.error(`Activity weather for ${a.external_id} deferred:`, e.message);
          weatherRetryAt.set(key, Date.now() + WEATHER_RETRY_MS);
          continue;
        }
        // A provisional row's recheck keeps the numbers it had.
        if (a.refetch) { db.settleActivityWeather(a.user_id, a.external_id); continue; }
        const pts = decodePolyline(a.polyline) || [[0, 0]];
        db.upsertActivityWeather({ external_id: a.external_id, lat: roundCoord(pts[0][0]),
                                   lon: roundCoord(pts[0][1]) }, a.user_id);
      }
      await sleepMs(WEATHER_GAP_MS);
    }
    if (done) console.log(`Activity weather: filled ${done}`);
  })().catch(e => console.error('Activity weather fill failed:', e.message))
    .finally(() => { weatherFill = null; });
  return weatherFill;
}

// Answers from the table at once and never waits on the fill: a new activity's
// weather appears on the browser's next refresh. The fill is kicked here too,
// so a Pi that booted offline catches up as soon as someone opens the app.
app.get('/api/activity-weather', (req, res) => {
  try {
    const out = db.getActivityWeather(getUserId(req));
    fillActivityWeather();
    res.json(out);
  } catch (e) {
    console.error('GET /api/activity-weather', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Catholic Workout Journal running on http://0.0.0.0:${PORT}`);
  logTiming('server started'); // so a deploy/restart is visible in the timing log
  warmLiturgicalCache();
  fillActivityWeather();
});

// ── Shutdown ────────────────────────────────────────────────────────────────────
// These handlers let the database close cleanly on a deploy, and must be
// installed EXPLICITLY: exec-form CMD makes node PID 1, and Linux discards a
// default-disposition signal sent to PID 1 with no handler. Without them,
// SIGTERM does nothing and docker SIGKILLs after its grace period, skipping
// the clean-close checkpoint. See db.closeDatabase. Story:
// DECISIONS.md#wal-durability.
//
// The database is closed AFTER the server stops accepting connections, so no
// request can be mid-query against a closing handle.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;   // a second Ctrl-C must not re-enter this
  shuttingDown = true;
  console.log(`${signal} received, closing database...`);
  server.close(() => {
    db.closeDatabase();
    process.exit(0);
  });
  // Don't let a hung keep-alive connection burn the whole grace period and end
  // in the SIGKILL this exists to avoid. Docker allows 10s by default.
  setTimeout(() => {
    console.error('Shutdown timed out waiting for connections; closing anyway.');
    db.closeDatabase();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
