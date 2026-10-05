const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');

// Ensure the data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'workout.db'));
db.pragma('journal_mode = WAL');

// FULL, not WAL's default NORMAL: NORMAL can acknowledge a commit that lives
// only in the page cache, and a Pi with no UPS on a USB disk loses it on a
// power cut — while the DB still passes integrity_check. An fsync per commit
// costs nothing at a handful of writes a day. Story: DECISIONS.md#wal-durability.
db.pragma('synchronous = FULL');

// ── Schema ─────────────────────────────────────────────────────────────────────
db.exec(`
  -- Per-routine exercise definitions: the DEFAULT session targets, not a
  -- record of anything performed (that is history, which nothing here
  -- touches). routine_id links to routines.id.
  --
  -- position is the display and workout order. A reorder PUTs the whole array
  -- back through /api/lifts/:routineId; there is no partial reorder endpoint.
  --
  -- category is the balance taxonomy (upper_push | upper_pull | legs_push |
  -- legs_pull), tagged PER EXERCISE, never per routine.
  --
  -- lift is dead: always the empty string, never read, kept because no column
  -- is ever dropped.
  --
  -- rest_sec is the rest countdown after a set is ticked Done, in whole
  -- seconds; NULL means the app default. Story:
  -- DECISIONS.md#rest-timer-between-sets.
  --
  -- weight, reps, sets, rest_sec, emoji and video are a MIRROR here: the
  -- truth is exercise_defaults, one row per (user, exercise name). setLifts
  -- writes each row through to it and getLifts reads it back over the row,
  -- so the same exercise in two routines cannot carry two rest times.
  CREATE TABLE IF NOT EXISTS exercises (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    lift     TEXT NOT NULL,
    position INTEGER NOT NULL,
    name     TEXT NOT NULL,
    weight   TEXT DEFAULT '',
    reps     TEXT DEFAULT '',
    sets     INTEGER DEFAULT 3,
    video    TEXT DEFAULT ''
  );

  -- RETIRED: the old per-weekday default workout type, superseded by
  -- planned_workouts. Only a JSON restore writes it and nothing in the app
  -- reads it; it is kept as the record of pre-planner days, served read-only
  -- by GET /api/schedule and carried by the JSON backup. It is history, so
  -- archiving a routine leaves it alone. lift_day holds a ROUTINE ID, as a
  -- string, when the type is a lift routine. Story: DECISIONS.md#dated-plans.
  CREATE TABLE IF NOT EXISTS day_schedule (
    day_key  TEXT PRIMARY KEY,
    type     TEXT NOT NULL,
    name     TEXT NOT NULL,
    lift_day TEXT
  );

  -- Every logged workout or activity. Type-specific fields (sets, distance,
  -- routes climbed) live in the data JSON blob, so a new workout type is a
  -- frontend-only change.
  --
  -- external_id dedupes synced activities, unique PER USER (see the index
  -- below), and makes a re-sync idempotent — which also means a sync cannot
  -- repair a stored row; scripts/backfill_garmin_timestamps.py does that.
  --
  -- synced_at is the IMPORT time, separate from timestamp (the workout start),
  -- so a backlog sync does not read as a pile of fresh entries.
  --
  -- data.reviewed (true, or absent) marks a synced row whose fill-in card was
  -- saved or skipped; set only by that card, never by a sync.
  -- Story: DECISIONS.md#garmin-first-cardio-log.
  --
  -- timestamp is a UTC instant; date is the LOCAL calendar day. Neither is
  -- derivable from the other (parse_start_time in garmin_sync.py).
  -- No natural unique key: a JSON restore REPLACES the user's history
  -- (replaceHistory, which the app always sends); without that flag the
  -- restored rows are appended.
  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    date      TEXT NOT NULL,
    type      TEXT NOT NULL,
    name      TEXT,
    lift      TEXT,
    rpe       INTEGER,
    note      TEXT,
    data      TEXT
  );

  -- One weigh-in per (date, user). weight_kg is a LEGACY NAME and stores
  -- POUNDS; nothing converts it.
  --
  -- Entered only via Check-In -> Morning. date is the CHECK-IN DAY
  -- (checkinDayStr() in index.html), so a 00:30 weigh-in belongs to the day
  -- that just ended.
  --
  -- Rows are deletable (DELETE /api/bodyweight/:date) because a mistyped
  -- weigh-in is not inert: bodyWeightOn() imputes from the nearest one, so it
  -- reweights every bodyweight set's tonnage for up to 30 days around it.
  CREATE TABLE IF NOT EXISTS body_weight (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    date      TEXT NOT NULL UNIQUE,
    weight_kg REAL NOT NULL
  );

  -- DEAD. Read only by migrateLegacyLiftsToRoutines() on a pre-routines
  -- install, never written. Kept because no table is dropped; do not build on it.
  CREATE TABLE IF NOT EXISTS lift_names (
    lift TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  -- User-created lift routines, managed in Settings -> Lift Routines.
  -- position drives display order.
  --
  -- archived is a SOFT DELETE, kept forever: past sessions must still resolve
  -- the routine's name and emoji, which is why getRoutines() returns archived
  -- rows too.
  --
  -- target_per_week is an optional sessions-per-week aim, NULL for none,
  -- limited to (0, 7] by PATCH /api/routines/:id. It feeds only the planner's
  -- suggestions (planSuggestionsFor in index.html), overriding the rhythm
  -- learned from history. Story: DECISIONS.md#plan-sheet-and-workout-suggestions.
  CREATE TABLE IF NOT EXISTS routines (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    emoji    TEXT NOT NULL DEFAULT '🏋️',
    position INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  -- Who's using the app, seeded with two rows (see the seed block below the
  -- migrations). No password: LAN-only, identity picked at a frontend gate.
  -- Per-user tables carry user_id; exercises and injury_checkins are scoped
  -- TRANSITIVELY through routine_id/injury_id. The name-keyed exercise tables
  -- and activity_types are shared on purpose — one exercise library, separate
  -- workouts.
  --
  -- In the JSON backup (exportData, POST /api/import, restoreUser), restored
  -- by upsert-by-id since this table is global.
  --
  -- archived is a SOFT DELETE and the only removal there is; no route deletes
  -- a user. It keeps every row the person owns and only hides them from the
  -- picker, because a cascade across every per-user table would be the most
  -- destructive statement in this file. userExists() ignores the flag on
  -- purpose, so the /api gate needs no exception. Archiving does revoke the
  -- user's Garmin and Apple credentials, since the cron and the Apple token
  -- index never consult this table. Story: DECISIONS.md#archiving-a-user.
  CREATE TABLE IF NOT EXISTS users (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '👤'
  );

  -- SEVEN NAME-KEYED ATTRIBUTES: category, form notes, weightless, muscles,
  -- movement patterns, timed and unranked. Keyed by exercise NAME because
  -- every read path scans all history, including names since renamed or
  -- dropped from every routine. mergeExerciseNames, POST /api/import and
  -- exportData must each carry ALL SEVEN, or that tag is silently deleted;
  -- they are listed once as NAME_KEYED_EXERCISE_TABLES below this schema
  -- block, which verify_backend.js checks all three against.
  --
  -- Six are columns of ONE table, exercise_meta. Only exercise_muscles is
  -- separate, being one-to-many (several muscles per exercise).
  --
  -- goals.exercise_name is one more holder of an exercise name, not in the
  -- list because it is a column on an unrelated table. A merge must rewrite
  -- it too, or the goal is orphaned with no UI to repair it.
  --
  -- exercise_meta: one row per name, so a new scalar tag is an additive
  -- column, not a new table plus route plus merge step. It superseded four
  -- one-table-per-tag tables below, which were migrated into it once by
  -- migrateNameKeyedTablesToExerciseMeta() and are now frozen, never read or
  -- written. NULL, the empty string or 0 means "not set", and
  -- pruneExerciseMetaIfEmpty() deletes a row once every column is back there,
  -- so "untagged" is one state. A NEW COLUMN MUST BE TAUGHT TO
  -- pruneExerciseMetaIfEmpty, or a row carrying only that tag is deleted when
  -- any sibling is cleared. Story: DECISIONS.md#exercise-meta-consolidation.
  --
  -- What the columns mean:
  --   category -- the balance taxonomy for names in no live routine; an
  --     untagged exercise is a real gap in the balance numbers, so Settings
  --     nags about it.
  --   how_to, mistakes -- the Form write-up. Text only by design: images that
  --     can legally be re-served were judged the hard part.
  --   weightless -- the set's weight is ADDED weight: empty or 0 is bodyweight,
  --     negative is assistance, so -20 beats -30. Turning it on clears the
  --     exercise's default weight, or an old total-bodyweight number re-logs
  --     itself as added weight.
  --   hinge_knee -- 'hinge' | 'knee' | 'neither' | NULL (not reviewed). Only
  --     the axes category cannot express; push/pull and upper/lower live there.
  --
  -- The add/edit forms write every tag unconditionally, so a form must first
  -- LOAD what the name already carries (loadExerciseTagsIntoForm), or adding a
  -- tagged exercise to a second routine wipes its tags.
  -- Story: DECISIONS.md#settings-grouping.
  --
  -- timed, laterality and unranked arrive by addColumnIfMissing, not in the
  -- CREATE TABLE below:
  --   timed -- reps hold whole SECONDS (a plank, a hang), in history and in
  --     exercises.reps alike. Orthogonal to weightless (a max hang is both).
  --     No tonnage; ranks on load then seconds, never an Epley 1RM.
  --     Story: DECISIONS.md#timed-exercises.
  --   laterality -- NULL | 'bilateral' | 'independent' | 'unilateral'; NULL
  --     is "not reviewed". SUPERSEDES the unilateral boolean, which is kept
  --     written in sync so the two never contradict. 'independent' is two
  --     dumbbells: both sides at once, each limb on its own load. NULL counts
  --     toward NEITHER side of Balance Ratios and is reported as unclassified
  --     (balanceSidesOf); a unilateral set counts as one set, not two.
  --     Story: DECISIONS.md#laterality-and-independent-load.
  --   unranked -- logged as sets and reps only: no weight field, PR, overload
  --     suggestion, goal or tonnage. Still a working set, still attributed to
  --     muscles. OVERRIDES weightless and composes with timed.
  --     Story: DECISIONS.md#unranked-exercises.
  CREATE TABLE IF NOT EXISTS exercise_meta (
    name       TEXT PRIMARY KEY,
    category   TEXT,
    how_to     TEXT NOT NULL DEFAULT '',
    mistakes   TEXT NOT NULL DEFAULT '',
    weightless INTEGER NOT NULL DEFAULT 0,
    hinge_knee TEXT,
    unilateral INTEGER NOT NULL DEFAULT 0,
    timed      INTEGER NOT NULL DEFAULT 0
  );

  -- FROZEN: superseded by exercise_meta.category, migrated once, kept
  -- because no table is dropped.
  CREATE TABLE IF NOT EXISTS exercise_category_overrides (
    name     TEXT PRIMARY KEY,
    category TEXT NOT NULL
  );

  -- FROZEN: superseded by exercise_meta.how_to and mistakes.
  CREATE TABLE IF NOT EXISTS exercise_form_notes (
    name     TEXT PRIMARY KEY,
    how_to   TEXT NOT NULL DEFAULT '',
    mistakes TEXT NOT NULL DEFAULT ''
  );

  -- FROZEN: superseded by exercise_meta.weightless.
  CREATE TABLE IF NOT EXISTS exercise_weightless (
    name       TEXT PRIMARY KEY,
    weightless INTEGER NOT NULL DEFAULT 1
  );

  -- Fractional exercise -> muscle attribution, behind the working-sets-per-
  -- muscle metric. A TABLE, not code, so it retunes without a rebuild. Names
  -- are trimmed and lowercased.
  --
  -- FRACTIONS NEED NOT SUM TO 1.0: this is stimulus per muscle, not a
  -- probability. 1.0 primary / 0.5 secondary / 0.3 minor, so a barbell row
  -- is back 1.0 + biceps 0.5 + rear_delts 0.3 = 1.8. Do not normalize it.
  --
  -- Seeded once, only while empty, from DEFAULT_EXERCISE_MUSCLES, so retuning
  -- is never overwritten. A PUT replaces a name's WHOLE map: drop a muscle by
  -- omitting it, never by sending 0. Two editors write it (the Unmapped
  -- Exercises quick-add and the exercise popup), and each must round-trip a
  -- muscle it does not offer itself (MUSCLE_OPTIONS in index.html), or the
  -- whole-map replace deletes it.
  -- Story: DECISIONS.md#settings-grouping.
  CREATE TABLE IF NOT EXISTS exercise_muscles (
    name     TEXT NOT NULL,
    muscle   TEXT NOT NULL,
    fraction REAL NOT NULL,
    PRIMARY KEY (name, muscle)
  );

  -- One user's DEFAULTS for one exercise: what a new session starts from
  -- (weight, reps, sets), the rest countdown after a set is ticked Done
  -- (rest_sec, whole seconds, NULL = the app default) and the emoji and video
  -- it shows. name is keyed trimmed and lowercased, like every name-keyed
  -- table.
  --
  -- PER USER, unlike exercise_meta: muscles and flags describe the movement,
  -- but a default weight or rest is one person's prescription. So it is NOT
  -- in NAME_KEYED_EXERCISE_TABLES (the shared ones); mergeExerciseNames,
  -- POST /api/import and exportData each carry it by hand.
  --
  -- THE SOURCE OF TRUTH for these six fields: they belong to the exercise,
  -- not to a routine, and survive it leaving every active routine. The same
  -- columns on exercises are a mirror (setLifts writes through, getLifts reads
  -- back over the rows). Filled from those rows by
  -- seedExerciseDefaultsFromRoutines, which only ever fills a missing row.
  -- Story: DECISIONS.md#exercise-defaults.
  CREATE TABLE IF NOT EXISTS exercise_defaults (
    user_id  INTEGER NOT NULL,
    name     TEXT NOT NULL,
    weight   TEXT NOT NULL DEFAULT '',
    reps     TEXT NOT NULL DEFAULT '',
    sets     INTEGER NOT NULL DEFAULT 3,
    rest_sec INTEGER,
    emoji    TEXT NOT NULL DEFAULT '',
    video    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, name)
  );

  -- FROZEN: superseded by exercise_meta.hinge_knee, laterality and unilateral.
  CREATE TABLE IF NOT EXISTS exercise_patterns (
    name       TEXT PRIMARY KEY,
    hinge_knee TEXT,
    unilateral INTEGER
  );

  -- The loggable workout types. type_key is the app's history.type value: a
  -- curated built-in (run, bike, lift, climb, ...) or a raw Garmin/Apple type
  -- key such as skate_skiing_ws. categorized=0 marks a placeholder inserted by
  -- ensureActivityType when a sync meets an unknown type, and "any
  -- categorized=0 row" is exactly what the reminder badge shows.
  CREATE TABLE IF NOT EXISTS activity_types (
    type_key    TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    emoji       TEXT NOT NULL DEFAULT '🏅',
    categorized INTEGER NOT NULL DEFAULT 1
  );

  -- Outcome of the latest Garmin sync attempt, from the browser button or the
  -- cron run, so a failed cron sync shows in the app. This CREATE is the
  -- original singleton shape; migrateGarminSyncStatusPerUser below rebuilds
  -- it keyed by user_id.
  --
  -- last_success_at only moves FORWARD, so a later failure cannot erase when
  -- it last worked. garmin_sync.py must POST before EVERY exit, the MFA exit
  -- inside the library callback included. "Nothing to sync" counts as
  -- success, so a stale badge clears itself. rate_limited marks a run Garmin
  -- turned away with a 429, which the page answers by stepping its Sync
  -- buttons back for a while; added after the per-user rebuild below, which
  -- predates it. NOT in the JSON backup: live state, not user data.
  CREATE TABLE IF NOT EXISTS garmin_sync_status (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_attempt_at INTEGER,
    ok              INTEGER,
    mfa_required    INTEGER,
    message         TEXT,
    last_success_at INTEGER
  );

  -- The same, per user, for Apple sync (an iOS Shortcut POSTing to
  -- /api/apple-health/sync). No mfa_required: a Shortcut has no login
  -- handshake. NOT in the JSON backup.
  CREATE TABLE IF NOT EXISTS apple_sync_status (
    user_id         INTEGER PRIMARY KEY,
    last_attempt_at INTEGER,
    ok              INTEGER,
    message         TEXT,
    last_success_at INTEGER
  );

  -- The same shape for the NIGHTLY BACKUP, keyed by JOB: 'dump'
  -- (scripts/backup_db.sh, on the Pi) and 'pull' (scripts/pull_backups.sh, on
  -- the dev machine). Both POST at the end of every run, failures included.
  --
  -- last_success_at only moves FORWARD. The frontend also treats a row gone
  -- QUIET as bad, since a cron that never fires never reports a failure
  -- (backupErrorBadge and BACKUP_STALE_DAYS in index.html). NOT in the JSON
  -- backup. Story: DECISIONS.md#backup-monitoring.
  CREATE TABLE IF NOT EXISTS backup_status (
    job             TEXT PRIMARY KEY,
    last_attempt_at INTEGER,
    ok              INTEGER,
    message         TEXT,
    last_success_at INTEGER
  );

  -- One row per (date, user). Every morning_* and evening_* column is
  -- INDEPENDENTLY NULLABLE and the two periods UPSERT INDEPENDENTLY: an
  -- evening save must never clear the morning's. upsertCheckin writes only
  -- the keys it is given; verify_backend.js asserts both directions.
  --
  -- Columns added by migration below:
  --   morning_flags, evening_flags -- JSON blobs of yes/no flags, one column
  --     per period, so a new flag is a frontend-only change. Read through
  --     parseCheckinFlags, written through serializeFlags, which stores only
  --     flags that are set. morning_sick/evening_sick are REAL COLUMNS, not
  --     flags; the sick-day analytics read them directly.
  --   day_journal -- an independent free-text field, NOT evening_journal. Its
  --     save must never stamp a period timestamp: a note is not a check-in.
  --   morning_fasts, evening_fasts, morning_prayer -- the daily fast and prayer
  --     intention. morning_fasts is a JSON ARRAY of subject ids; evening_fasts
  --     is a JSON OBJECT KEYED BY THOSE SAME IDS, since an evening outcome is
  --     always about a subject the morning declared. Written through
  --     serializeJsonColumn. Story: DECISIONS.md#daily-fast-and-prayer.
  --   garmin_sleep_score, garmin_sleep_qualifier -- written only by
  --     garmin_sync.py.
  --
  -- morning_planned_type accepts 'rest', a normal loggable type (REST_TYPE).
  --
  -- date IS THE CHECK-IN DAY, NOT THE CALENDAR DAY ITS TIMESTAMPS FALL ON:
  -- the tab stays on yesterday until 3am, and yesterday's evening can be
  -- backfilled next morning. Readers key off date and treat the timestamps as
  -- booleans; do not "repair" the mismatch. See checkinDayStr() in index.html.
  -- Story: DECISIONS.md#check-in-day.
  --
  -- Value ranges and the ISO date shape are enforced at PUT
  -- /api/checkins/:date (validateCheckinFields in server.js), not here. POST
  -- /api/import and POST /api/garmin/sync call upsertCheckin directly, outside
  -- that gate (see isIsoDate in server.js).
  --
  -- Rows are deletable (DELETE /api/checkins/:date, used by
  -- scripts/prune_empty_checkins.js): a row can hold nothing but a timestamp,
  -- and a wrong date is a primary key that re-saving cannot correct.
  CREATE TABLE IF NOT EXISTS checkins (
    date                 TEXT PRIMARY KEY,
    morning_sleep        INTEGER,
    morning_feeling      INTEGER,
    morning_planned_type TEXT,
    morning_timestamp    INTEGER,
    evening_energy       INTEGER,
    evening_feeling      INTEGER,
    evening_eating       INTEGER,
    evening_journal      TEXT,
    evening_timestamp    INTEGER
  );

  -- What the watch measured about a day, as opposed to what you said (that is
  -- checkins). WRITTEN ONLY BY garmin_sync.py: there is no PUT, and clearing
  -- a check-in must never clear a measurement.
  -- Story: DECISIONS.md#garmin-recovery-signals.
  --
  -- date is GARMIN'S calendarDate, not the check-in day; the two disagree
  -- before 3am, correctly.
  --
  -- NULL MEANS "NOT SYNCED", NEVER ZERO: a null step count is not a day you
  -- did not move. POST /api/garmin/sync writes only keys Garmin answered, so
  -- a partial response never nulls a stored value.
  --
  -- The composite key was declared at birth, so there is no rebuild with a
  -- frozen column list: a new metric is one addColumnIfMissing call.
  -- (user_id, date) is a natural key, so restoring twice is idempotent.
  CREATE TABLE IF NOT EXISTS garmin_daily (
    date              TEXT NOT NULL,
    user_id           INTEGER NOT NULL,
    resting_hr        INTEGER,   -- bpm, overnight resting heart rate
    hrv_overnight     INTEGER,   -- ms, overnight average HRV
    hrv_status        TEXT,      -- Garmin's own word for it: BALANCED, LOW, UNBALANCED, POOR
    steps             INTEGER,
    body_battery_high INTEGER,   -- 0-100, the day's peak
    body_battery_low  INTEGER,   -- 0-100, the day's trough
    readiness_score   INTEGER,   -- 0-100, Garmin's composite training readiness
    readiness_level   TEXT,      -- its matching label, e.g. READY, LOW, PRIME
    stress_avg        INTEGER,   -- 0-100, the day's average all-day stress level
    -- VO2 max and training load, each dated by Garmin's own calendarDate for
    -- its block; see the addColumnIfMissing block that added them.
    vo2max            REAL,      -- ml/kg/min, one decimal
    load_acute        INTEGER,   -- 7-day acute training load
    load_chronic      INTEGER,   -- ~4-week chronic training load
    load_optimal_min  INTEGER,   -- optimal range for load_acute, low edge
    load_optimal_max  INTEGER,   -- ...and high edge
    training_status   TEXT,      -- PRODUCTIVE, MAINTAINING, DETRAINING, ...
    focus_low_aerobic      INTEGER,  -- 4-week Load Focus split, and each
    focus_high_aerobic     INTEGER,  -- one's target range below
    focus_anaerobic        INTEGER,
    focus_low_aerobic_min  INTEGER,
    focus_low_aerobic_max  INTEGER,
    focus_high_aerobic_min INTEGER,
    focus_high_aerobic_max INTEGER,
    focus_anaerobic_min    INTEGER,
    focus_anaerobic_max    INTEGER,
    focus_feedback    TEXT,      -- Garmin's verdict, e.g. AEROBIC_LOW_SHORTAGE
    -- Three overnight readings from the sleep payload, dated by ITS
    -- calendarDate (the wake-up day); see the addColumnIfMissing block.
    resp_rate         REAL,      -- breaths/min, average while asleep
    sleep_minutes     INTEGER,   -- time asleep, naps excluded
    skin_temp_dev     REAL,      -- deg C, SIGNED deviation from the watch's own baseline
    -- The day's energy estimate, from the daily summary; see the
    -- addColumnIfMissing block. Resting burn is total minus active.
    calories_total    INTEGER,   -- kcal, resting + active
    calories_active   INTEGER,   -- kcal above resting
    PRIMARY KEY (date, user_id)
  );

  -- Nine types: exercise_1rm (estimated 1RM), exercise_reps (reps at a
  -- load), exercise_hold (seconds held at a load), body_weight, pace,
  -- distance_time (a time for a fixed distance), distance (longest single
  -- outing), weekly_distance and climb_grade (send a grade on one scale).
  --
  -- The CURRENT value is never stored: the frontend recomputes it from the
  -- same helpers the PRs tab uses, so it cannot go stale. achieved_at is
  -- client-computed too (detectGoalAchievements in index.html) and
  -- WRITE-ONCE: set to the date the target was first hit, and kept even if
  -- the value later regresses. Only an edit of the target voids it.
  -- Story: DECISIONS.md#goal-tracking.
  --
  -- A goal's SUBJECT never changes after creation (type, exercise, activity,
  -- distance, direction, added_lbs): a PATCH may move only target_value and
  -- target_date. Each target move is kept in target_history; see
  -- goalSubjectChange and goalTargetEdit in server.js.
  --
  -- EVERY API WRITE GOES THROUGH normalizeGoal(input, existing) in server.js,
  -- POST and PATCH alike, validating the MERGED row. It owns the type list,
  -- each type's required fields and units, and which types carry added_lbs.
  -- A new goal type means teaching normalizeGoal.
  --
  -- restoreGoal stays OUTSIDE normalizeGoal, so stored rows may break current
  -- rules, and PATCH rejects only violations the patch itself introduces.
  -- No natural key, so a restore that carries goals REPLACES the user's
  -- goals (clearGoals) rather than adding the backup's beside them.
  --
  -- direction (at_least | at_most) makes "met" unambiguous without storing a
  -- baseline; exercise_reps and exercise_hold are always at_least.
  CREATE TABLE IF NOT EXISTS goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,     -- see the eight types in the comment above
    exercise_name TEXT,               -- set when type = 'exercise_1rm', 'exercise_reps' or 'exercise_hold'
    activity_type TEXT,                -- set for pace/distance_time/distance/weekly_distance
    -- UNITS ARE PER TYPE and nothing here enforces that: lbs (exercise_1rm,
    -- body_weight), decimal min/km (pace), whole REPS (exercise_reps), whole
    -- SECONDS held (exercise_hold), SECONDS (distance_time), km (distance), km
    -- per week (weekly_distance), a GRADE NUMBER on climb_scale (climb_grade:
  -- V6 is 6, 5.9 is 9, 5.12- is 12, 5.12+ is 12.5 -- see climbGradeNumber in
  -- index.html; a number rather than a list index, so it never shifts).
    target_value  REAL NOT NULL,
    -- Only for exercise_reps and exercise_hold: the load the target must be
    -- hit at, meaning what the exercise's sets mean -- ADDED load for a
    -- weightless exercise (0 or NULL is bodyweight, negative is assistance),
    -- total load otherwise.
    added_lbs     REAL,
    -- Only for distance_time: the distance, in km from RACE_DISTANCES, that a
    -- run is normalized TO. A run qualifies inside the RACE_BAND_MIN..MAX
    -- multiple of it and its time is Riegel-converted, so target_value is
    -- compared against an ESTIMATE and the UI says so.
    -- Story: DECISIONS.md#distance-time-goals.
    target_distance_km REAL,
    -- Only for climb_grade: 'v' (bouldering) or 'yds' (routes). The two
    -- scales are never compared, so the scale is part of the goal's subject.
    climb_scale   TEXT,
    direction     TEXT NOT NULL DEFAULT 'at_least',  -- 'at_least' | 'at_most'
    target_date   TEXT,
    created_at    INTEGER NOT NULL,
    achieved_at   INTEGER,
    -- JSON list of earlier targets, oldest first: [{ value, until }], where
    -- value was the target before the local date until. NULL until the first
    -- target edit. Written only by goalTargetEdit in server.js.
    target_history TEXT
  );

  -- A structured injury log, separate from the one-tap 'injury' evening flag,
  -- which stays as the "something new hurts that is not logged yet" signal.
  -- Any row with resolved_date NULL raises a top-bar badge.
  --
  -- pt_plan is free text shown beside the evening "Did my PT" toggle.
  -- resolution_summary is the closing note asked for on resolve, separate
  -- from notes so both stories stay readable. No natural key: a restore
  -- replays plain inserts.
  --
  -- kind is 'injury' or 'niggle'. A niggle has no badge, a pain-only
  -- check-in row, and closes itself after a few quiet days
  -- (autoCloseQuietNiggles in index.html).
  --
  -- history_id is the workout it started in, NULL if logged from Settings.
  -- That id is NOT stable, and three paths handle it: the Garmin sync-wins
  -- merge repoints it (relinkInjuries, inside that transaction), POST
  -- /api/import remaps it or NULLs it, and deleting the workout NULLs it
  -- (unlinkInjuriesFromHistory).
  --
  -- tracked_since (ms) is when the row was logged or last reopened, moved
  -- only by updateInjury. The niggle auto-close counts quiet days from it, so
  -- a retroactive or reopened niggle does not close on save. NULL on old rows.
  -- Story: DECISIONS.md#injury-from-workout.
  CREATE TABLE IF NOT EXISTS injuries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    body_part     TEXT NOT NULL,
    severity      INTEGER,            -- 1-10, optional, "at onset" (see injury_checkins)
    started_date  TEXT NOT NULL,
    resolved_date TEXT,                -- NULL = still active
    notes         TEXT                 -- the onset story, written at creation
  );

  -- The daily follow-up on an injury: the injuries row records what hurts
  -- and severity AT ONSET; this records how it tracks day to day. Keyed per
  -- (injury, date), not per date, so two active injuries never blur together.
  --
  -- morning_* and evening_* upsert independently, like checkins. No period
  -- timestamps: the yes/no columns are written as an explicit 0 when their
  -- period is saved, so 0 ("answered no") and NULL ("never saved") already
  -- differ, which is what the PT-adherence denominator reads.
  --
  -- No FOREIGN KEY, like the rest of the schema; deleteInjury() clears the
  -- child rows itself.
  --
  -- (injury_id, date) is a natural key, so a restore UPSERTS. But the parent
  -- replays with a FRESH id, so POST /api/import must remap injury_id onto
  -- what restoreInjury returns. Never export injuryCheckins without injuries.
  --
  -- Pain runs 1-10 with 10 = WORST, inverted against every other scale.
  -- Asked only for UNRESOLVED injuries.
  --
  -- Columns added by migration below: workout_pain, a third pain slot asked
  -- at the end of a lift session (a workout is neither morning nor evening);
  -- evening_trend, the self-reported worse/same/better shown beside the
  -- computed trend; and evening_note, free text per (injury, date) that the
  -- Journal tab searches like day_journal. Story: DECISIONS.md#injury-daily-notes.
  CREATE TABLE IF NOT EXISTS injury_checkins (
    injury_id                INTEGER NOT NULL,
    date                     TEXT NOT NULL,
    morning_pain             INTEGER,   -- 1-10, 10 = worst (same direction as injuries.severity)
    morning_affected_sleep   INTEGER,   -- 0/1
    evening_pain             INTEGER,   -- 1-10, 10 = worst
    evening_affected_workout INTEGER,   -- 0/1
    evening_pt_done          INTEGER,   -- 0/1
    PRIMARY KEY (injury_id, date)
  );

  -- One row per user; no row means "not tracking a pregnancy". The week
  -- number is never stored: the client derives it from due_date (falling
  -- back to conception_date). Story: DECISIONS.md#pregnancy-tracking.
  CREATE TABLE IF NOT EXISTS pregnancy_info (
    user_id         INTEGER PRIMARY KEY,
    conception_date TEXT,
    due_date        TEXT,
    notes           TEXT
  );

  -- Dated milestones (appointments, trimester markers). Carries its own
  -- user_id, since pregnancy_info has no id of its own to join through.
  CREATE TABLE IF NOT EXISTS pregnancy_milestones (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date    TEXT NOT NULL,
    label   TEXT NOT NULL,
    notes   TEXT
  );

  -- A dated stretch of life (a newborn, travel, an illness layoff), per user.
  -- end_date NULL means ongoing, covering future days too.
  --
  -- Only the stretch is stored. The client derives the rest: a day inside a
  -- phase with nothing but rest logged is EXCUSED, left out of every
  -- how-often and how-long-since number. A trained day counts as normal, so
  -- a phase can only help. Logging a workout later un-excuses the day with
  -- nothing to fix.
  --
  -- label is free text, emoji optional. end_date >= start_date, checked on
  -- the MERGED row by PATCH. (user_id, label, start_date) is a natural key:
  -- restoreLifePhase skips a match, so restoring twice does not duplicate.
  -- Story: DECISIONS.md#life-phases.
  CREATE TABLE IF NOT EXISTS life_phases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    label      TEXT NOT NULL,
    emoji      TEXT,
    start_date TEXT NOT NULL,
    end_date   TEXT,
    notes      TEXT
  );

  -- One user's changes to the check-in chips: the chips they made, and which
  -- built-in chips they show or hide. Story: DECISIONS.md#custom-check-in-chips.
  --
  -- One row per (user_id, period, key), two kinds told apart by the key:
  --   c_ key -- a chip the user made. label is required, emoji optional, and
  --     position orders it inside the card's last group, Mine.
  --   any other key -- a built-in chip from MORNING_FLAGS / EVENING_FLAGS in
  --     index.html. Only hidden means anything; label, emoji and position
  --     stay NULL, because the code owns that chip.
  -- The server needs only the prefix, never the built-in list, so a new
  -- built-in chip is still a frontend-only change. A built-in key must never
  -- start with c_.
  --
  -- hidden: on a built-in row, 1 hides a chip the code shows and 0 shows one
  -- the code retired; no row follows the code. On a c_ row, 1 is archived.
  -- sick is never hidden: the sick-day analytics read its real column, so a
  -- hidden chip would silently stop that data.
  --
  -- A c_ chip ticked on ANY day is archived, never deleted (DELETE answers
  -- 409): this row is the only thing that turns the stored key back into an
  -- emoji and a label on those days. The key is minted once from the first
  -- label and never changes, so a rename relabels history safely.
  --
  -- (user_id, period, key) is the natural key a restore upserts on, so
  -- restoring twice converges.
  CREATE TABLE IF NOT EXISTS checkin_flag_prefs (
    user_id    INTEGER NOT NULL,
    period     TEXT NOT NULL,     -- morning or evening
    key        TEXT NOT NULL,
    label      TEXT,              -- c_ chips only
    emoji      TEXT,              -- c_ chips only
    position   INTEGER,           -- c_ chips only: order within Mine
    hidden     INTEGER,
    created_at INTEGER,
    PRIMARY KEY (user_id, period, key)
  );

  -- Dated workout plans, up to four per day, edited in the Check-In planner.
  --
  -- workout holds the Log tab type picker's value: lift-N for routine N,
  -- otherwise an activity_types key. position is planning order, and the
  -- order the Log tab offers them. A plan is an intention, never a record:
  -- whether it was done is derived from history, never stored.
  --
  -- A day is ONE unit: PUT /api/plans/:date replaces every row for
  -- (user_id, date), positions always 0..n-1, so a restore upserts cleanly.
  --
  -- Archiving a routine deletes its rows from today on, except today's rows
  -- for sessions already logged (see archiveRoutine). Earlier rows stay and
  -- still resolve the kept routine's name. Story: DECISIONS.md#dated-plans.
  CREATE TABLE IF NOT EXISTS planned_workouts (
    user_id  INTEGER NOT NULL,
    date     TEXT NOT NULL,
    position INTEGER NOT NULL,
    workout  TEXT NOT NULL,
    PRIMARY KEY (user_id, date, position)
  );

  -- One GPS track per synced activity, as a Google encoded polyline at
  -- precision 5 (about a quarter the size of JSON lat/lon pairs).
  -- Story: DECISIONS.md#route-heatmap.
  --
  -- KEYED ON (user_id, external_id), NEVER history.id: history replays with
  -- FRESH ids on restore, so a history_id would need remapping. The natural
  -- key makes restoreActivityRoute a plain upsert. Only a synced activity has
  -- an external_id, so only it can carry a route.
  --
  -- User scoping comes from the JOIN back to history. An orphaned route is
  -- invisible through it and re-attaches if the activity is re-synced, so
  -- there is no cascade to forget.
  --
  -- bounds is stored so the map can fit its view without decoding every
  -- polyline. point_count is AFTER simplification.
  --
  -- breaks is a JSON array of segment indices i (points[i] to points[i+1])
  -- that are PAUSE JUMPS, which the map draws around. garmin_sync.py finds
  -- them from the raw sample timestamps (pause_indices). NULL IS NOT []: NULL
  -- means never checked and queues the row for a re-fetch; [] means checked,
  -- none found.
  --
  -- times is a JSON array of whole seconds since the first sample, ONE PER
  -- STORED POINT, which the map times its segments from. Same NULL rule:
  -- NULL means fetched before times were kept and queues the row; [] means
  -- checked, the samples had none.
  --
  -- elev (whole metres) and hr (bpm) are the watch's readings at each stored
  -- point, for the outing summary's profile, one per point like times with a
  -- null entry where the watch had no reading. The same NULL rule again: NULL
  -- queues the row, [] means checked, none recorded. Left out of the bulk
  -- read the Map tab makes, which never draws them.
  CREATE TABLE IF NOT EXISTS activity_routes (
    user_id     INTEGER NOT NULL,
    external_id TEXT NOT NULL,   -- the Garmin activityId, as history.external_id stores it
    polyline    TEXT NOT NULL,   -- encoded polyline, precision 5, WGS84
    point_count INTEGER NOT NULL,
    bounds      TEXT NOT NULL,   -- JSON [minLat, minLon, maxLat, maxLon]
    fetched_at  INTEGER NOT NULL,
    breaks      TEXT,            -- JSON [i, ...] of pause-jump segments; NULL = not checked yet
    times       TEXT,            -- JSON [s, ...], one per point; NULL = not fetched with times yet
    elev        TEXT,            -- JSON [m|null, ...], one per point; NULL = not fetched with it yet
    hr          TEXT,            -- JSON [bpm|null, ...], one per point; NULL = not fetched with it yet
    PRIMARY KEY (user_id, external_id)
  );

  -- Synced activities Garmin was asked about and ANSWERED with no track: a
  -- treadmill run, an indoor ride, a pool swim. A row takes the activity out
  -- of the route work queue for good; without it every one cost two Garmin
  -- requests on every sync, forever. Only garmin_sync.py writes it, through
  -- POST /api/activity-routes, and only for a definite answer, never for a
  -- failed fetch. Story: DECISIONS.md#route-heatmap.
  --
  -- A CACHE, like activity_weather: in the whole-file DB snapshot, NOT in the
  -- JSON backup. A restore simply asks about those activities once more. No
  -- delete, and a row is harmless if a route is later stored anyway.
  CREATE TABLE IF NOT EXISTS activity_route_misses (
    user_id     INTEGER NOT NULL,
    external_id TEXT NOT NULL,   -- as history.external_id and activity_routes store it
    checked_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, external_id)
  );

  -- A stretch of ground the user marked on one of their routes, to be timed
  -- on every outing of the same type that covers it. Story:
  -- DECISIONS.md#route-segments.
  --
  -- ONLY THE STRETCH IS STORED, never an effort. Efforts are derived on the
  -- client from activity_routes.times on every render, like PRs from history,
  -- so a re-fetched route, a deleted activity or a retuned matcher can never
  -- leave a stale time behind.
  --
  -- (user_id, name) is UNIQUE, case-insensitively, and is the natural key a
  -- restore upserts on, so restoring twice converges. The id is only an API
  -- handle and is never exported as a reference. type is an activity_types
  -- key: a run segment never times a ride. length_m is computed by the server
  -- from the polyline, never trusted from a body.
  CREATE TABLE IF NOT EXISTS route_segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL COLLATE NOCASE,
    type       TEXT NOT NULL,
    polyline   TEXT NOT NULL,   -- encoded polyline, precision 5, as activity_routes
    length_m   REAL NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );

  -- The weather an outdoor activity happened in: the line under it and the
  -- Weather and Pace card. Story: DECISIONS.md#activity-weather.
  --
  -- A CACHE OF A THIRD PARTY, re-derivable at any time. server.js fills it
  -- from Open-Meteo's hourly history at the route's START POINT, over the
  -- hours the activity spanned. So it rides in the whole-file DB snapshot but
  -- NOT in the JSON backup; a restore onto a fresh install simply refills it.
  --
  -- ONLY AN ACTIVITY WITH A ROUTE gets a row. The start point is the only
  -- location the app has, and one without GPS was usually indoors, where the
  -- weather outside would be a wrong answer rather than a missing one.
  --
  -- A ROW MEANS CHECKED. Every measurement is nullable, and a row of nulls
  -- means Open-Meteo had nothing for that place and time. A fetch that FAILED
  -- (network, 5xx, rate limit) writes no row, so the next fill retries it. No
  -- delete, for the same reason as garmin_daily.
  --
  -- A row is FINAL once fetched_at is at least a day after the activity
  -- started, and never asked for again. One fetched sooner is PROVISIONAL: the
  -- model's recent hours are still being revised (drizzle appears overnight),
  -- so it is fetched exactly once more after that day has passed. See
  -- WEATHER_SETTLE_MS in getWeatherlessActivities.
  --
  -- Metric, as the API sends it; converted only for display. temp_c,
  -- feels_like_c, humidity_pct, dew_point_c and wind_kmh are TIME-WEIGHTED
  -- MEANS over the activity. precip_mm and snow_cm are TOTALS that fell while
  -- you were out, each hour weighted by how much of it the activity covered.
  -- gust_kmh, precip_max_mmh and weather_code (WMO) are the highest value of
  -- any hour the activity touched. lat and lon are the ROUNDED coordinates
  -- actually sent to the API, never the raw start point.
  CREATE TABLE IF NOT EXISTS activity_weather (
    user_id        INTEGER NOT NULL,
    external_id    TEXT NOT NULL,   -- as history.external_id and activity_routes store it
    lat            REAL NOT NULL,
    lon            REAL NOT NULL,
    temp_c         REAL,
    feels_like_c   REAL,
    humidity_pct   REAL,
    dew_point_c    REAL,
    wind_kmh       REAL,
    gust_kmh       REAL,
    precip_mm      REAL,
    precip_max_mmh REAL,
    snow_cm        REAL,
    weather_code   INTEGER,
    fetched_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, external_id)
  );
`);

// The seven name-keyed exercise ATTRIBUTES. Each must be carried by
// mergeExerciseNames, restored by POST /api/import and included in
// exportData(); missing any one SILENTLY DELETES that tag. verify_backend.js
// asserts all three paths cover every entry, so an eighth tag fails a test.
//
// The values are opaque, stable keys, not table names: only exercise_muscles
// is still a real table (see the exercise_meta comment). Consumers treat them
// as strings only. It is a list, not a table of carry rules, because the rules
// differ per attribute and each is documented at its own merge step.
// Story: DECISIONS.md#exercise-meta-consolidation.
const NAME_KEYED_EXERCISE_TABLES = [
  'exercise_category_overrides',
  'exercise_form_notes',
  'exercise_weightless',
  'exercise_muscles',
  'exercise_patterns',
  'exercise_timed',
  'exercise_unranked',
];

// ── Date key helpers ─────────────────────────────────────────────────────────
// Every stored date key is ISO YYYY-MM-DD, matching index.html's dateKey().
// These two helpers are this file's side of that contract.
//
// isoDateStr() builds a local-time ISO key. Never use toLocaleDateString()
// for a key: its shape depends on the runtime's locale.
function isoDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// normalizeDateStr() converts a legacy M/D/YYYY string to ISO and passes
// anything else through, so it is always safe to apply. Every write path that
// takes a caller-supplied date runs it, so an old JSON backup cannot
// reintroduce the legacy shape on import.
function normalizeDateStr(s) {
  if (typeof s !== 'string') return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return s;
  const [, mo, da, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
}

// ── Additive schema migrations ────────────────────────────────────────────────
// Every change below is an additive ALTER that runs on every boot.
// addColumnIfMissing checks PRAGMA table_info first, so "already there" is an
// explicit no-op and every real failure (a typo'd type, a missing table)
// THROWS. Never wrap a migration in a bare catch: boot failing loudly is the
// correct outcome, and verify_backend.js is the only harness that runs this
// file.
function addColumnIfMissing(table, column, decl) {
  const cols = db.pragma(`table_info(${table})`);
  if (!cols.length) throw new Error(`addColumnIfMissing: table "${table}" does not exist`);
  if (cols.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  console.log(`Migration: added ${column} column to ${table}`);
  return true;
}

// Its unique index is keyed on (user_id, external_id), so it lives after the
// user_id block below. See "Deduping synced activities".
addColumnIfMissing('history', 'external_id', 'external_id TEXT');

// ⚠ ORDERING TRAP — READ BEFORE ADDING A `checkins` COLUMN HERE.
// migrateCheckinsCompositeKey() below rebuilds this table from an EXPLICIT,
// frozen column list and runs AFTER these calls. On a database that has not
// run it yet, a column added only here is created and then SILENTLY DROPPED.
// So a new checkins column goes in THREE places: here, the checkins_new
// CREATE TABLE, and that migration's INSERT/SELECT pair. verify_backend.js
// asserts they agree. migrateDayScheduleCompositeKey and
// migrateBodyWeightCompositeUnique freeze their columns the same way.
//
// Deriving the list from PRAGMA table_info would not fix it: the rebuild
// exists to produce a DIFFERENT shape, so the new key is named by hand anyway.
addColumnIfMissing('checkins', 'morning_planned_type', 'morning_planned_type TEXT');

// Populated by garmin_sync.py, not by the user directly.
addColumnIfMissing('checkins', 'garmin_sleep_score', 'garmin_sleep_score INTEGER');
addColumnIfMissing('checkins', 'garmin_sleep_qualifier', 'garmin_sleep_qualifier TEXT');

// 0/1/NULL per period: you can be fine in the morning and sick by evening.
addColumnIfMissing('checkins', 'morning_sick', 'morning_sick INTEGER');
addColumnIfMissing('checkins', 'evening_sick', 'evening_sick INTEGER');

// JSON blobs of yes/no flags; see the checkins CREATE TABLE comment.
addColumnIfMissing('checkins', 'evening_flags', 'evening_flags TEXT');
addColumnIfMissing('checkins', 'morning_flags', 'morning_flags TEXT');

// Independent of both periods; its save never stamps a period timestamp
// (saveDayJournal() in index.html).
addColumnIfMissing('checkins', 'day_journal', 'day_journal TEXT');

// The daily fast and prayer intention, all optional.
// morning_fasts is a JSON ARRAY of subject ids in display order, e.g.
// ["meat","youtube","other:Reading the news"]; a custom subject is its text
// behind an other: prefix, so it never collides with a curated id.
// evening_fasts is a JSON OBJECT keyed by those ids:
// {"meat":{"outcome":"kept"},"youtube":{"outcome":"broke","note":"..."}}.
// Blobs, so the vocabulary (FAST_SUBJECTS in index.html) stays frontend-only;
// one column per period, so each rides its own period's upsert.
// Story: DECISIONS.md#daily-fast-and-prayer.
addColumnIfMissing('checkins', 'morning_fasts', 'morning_fasts TEXT');
addColumnIfMissing('checkins', 'evening_fasts', 'evening_fasts TEXT');
addColumnIfMissing('checkins', 'morning_prayer', 'morning_prayer TEXT');

// The import time, separate from timestamp (the workout's start); see the
// history CREATE TABLE comment.
addColumnIfMissing('history', 'synced_at', 'synced_at INTEGER');

// Free-text PT plan shown beside the evening "Did my PT" toggle; optional.
addColumnIfMissing('injuries', 'pt_plan', 'pt_plan TEXT');

// The load qualifier of an exercise_reps/exercise_hold goal ("8 reps at +25
// lbs"); NULL for every other type and reads as bodyweight.
addColumnIfMissing('goals', 'added_lbs', 'added_lbs REAL');

// A distance_time goal's target distance in km; NULL for every other type,
// which normalizeGoal enforces.
addColumnIfMissing('goals', 'target_distance_km', 'target_distance_km REAL');
addColumnIfMissing('goals', 'climb_scale', 'climb_scale TEXT');

// Earlier targets of an edited goal, drawn as the chart's staircase.
addColumnIfMissing('goals', 'target_history', 'target_history TEXT');

// None of the exercises columns below has a table rebuild, so each line is the
// whole job. category starts NULL rather than guessed.
addColumnIfMissing('exercises', 'routine_id', 'routine_id INTEGER');
addColumnIfMissing('exercises', 'category', 'category TEXT');
addColumnIfMissing('exercises', 'emoji', `emoji TEXT DEFAULT ''`);
// NULL is "use the app default", a real state. Story: DECISIONS.md#rest-timer-between-sets.
addColumnIfMissing('exercises', 'rest_sec', 'rest_sec INTEGER');

// The soft delete behind the People card (see the users comment). NOT NULL
// DEFAULT 0, so existing users read as active. No rebuild covers users, so the
// three-place column rule does not apply here.
addColumnIfMissing('users', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');

// See exercise_meta's CREATE TABLE comment for what each means, and teach
// pruneExerciseMetaIfEmpty about any new one. exercise_meta has no frozen
// column list, so the CREATE TABLE plus these lines is the whole job.
addColumnIfMissing('exercise_meta', 'timed', 'timed INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('exercise_meta', 'laterality', 'laterality TEXT');
addColumnIfMissing('exercise_meta', 'unranked', 'unranked INTEGER NOT NULL DEFAULT 0');

// Carry unilateral = 1 onto laterality, idempotently and never over a value
// set since. A 0 is NOT carried as 'bilateral': the boolean's 0 meant both
// "bilateral" and "never tagged", so those stay NULL for review.
db.prepare(`
  UPDATE exercise_meta SET laterality = 'unilateral'
  WHERE unilateral = 1 AND laterality IS NULL
`).run();

// Scopes these tables to a user. DEFAULT 1, so pre-existing rows read as user
// 1 and an INSERT that omits user_id lands on user 1, never on nobody.
// exercises and injury_checkins are scoped through routine_id/injury_id instead.
addColumnIfMissing('routines',     'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('day_schedule', 'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('history',      'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('body_weight',  'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('checkins',     'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('goals',        'user_id', 'user_id INTEGER DEFAULT 1');
addColumnIfMissing('injuries',     'user_id', 'user_id INTEGER DEFAULT 1');

// See the routines table comment. NULL is "no target".
addColumnIfMissing('routines', 'target_per_week', 'target_per_week REAL');

// Stores a real user_id = 1 where the column is NULL, so no raw dump or tool
// that ignores SQLite's virtual default ever sees a NULL. A no-op after the
// first run.
function backfillUserIds() {
  for (const table of ['routines', 'day_schedule', 'history', 'body_weight', 'checkins', 'goals', 'injuries']) {
    const { changes } = db.prepare(`UPDATE ${table} SET user_id = 1 WHERE user_id IS NULL`).run();
    if (changes) console.log(`Migration: backfilled user_id on ${changes} row(s) in ${table}`);
  }
}
backfillUserIds();

// ── Deduping synced activities ───────────────────────────────────────────────
// The unique index behind history.external_id. It must come after the user_id
// column and its backfill above, since it is keyed on (user_id, external_id).
//
// PER USER, not global: an Apple Shortcut may send a synthesized key such as
// type+start-time, so two people starting a walk in the same minute send the
// SAME external_id, and a global index would silently skip the second.
// hasExternalId() takes a userId for the same reason; keep the two in step.
//
// The DROP removes the old global index, so every database converges on this
// one. No rebuild is needed (the constraint is an index), and both statements
// are no-ops once converged.
db.exec('DROP INDEX IF EXISTS idx_history_external_id');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_history_external_id_user
         ON history(user_id, external_id) WHERE external_id IS NOT NULL`);

// The composite-key rebuilds: SQLite cannot ALTER a key in place, so each
// rebuilds its table keyed on user_id as well, or one user's upsert would
// overwrite another's row on the same key. Each is a no-op once migrated
// (PRAGMA table_info's pk is > 0 for a key column). Each copies a FROZEN
// column list; see the ordering trap above the checkins columns.
//
// day_schedule -> (day_key, user_id).
function migrateDayScheduleCompositeKey() {
  const cols = db.pragma('table_info(day_schedule)');
  const userIdCol = cols.find(c => c.name === 'user_id');
  if (userIdCol && userIdCol.pk > 0) return; // already migrated
  console.log('Migration: day_schedule -> composite (day_key, user_id) primary key...');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE day_schedule_new (
        day_key  TEXT NOT NULL,
        user_id  INTEGER NOT NULL DEFAULT 1,
        type     TEXT NOT NULL,
        name     TEXT NOT NULL,
        lift_day TEXT,
        PRIMARY KEY (day_key, user_id)
      );
      INSERT INTO day_schedule_new (day_key, user_id, type, name, lift_day)
        SELECT day_key, COALESCE(user_id, 1), type, name, lift_day FROM day_schedule;
      DROP TABLE day_schedule;
      ALTER TABLE day_schedule_new RENAME TO day_schedule;
    `);
  })();
  console.log('Migration: day_schedule composite key done');
}
migrateDayScheduleCompositeKey();

// body_weight -> UNIQUE (date, user_id). Guarded on a unique index covering
// exactly those two columns.
function migrateBodyWeightCompositeUnique() {
  const hasComposite = db.pragma('index_list(body_weight)').some(idx => {
    if (!idx.unique) return false;
    const cols = db.pragma(`index_info(${idx.name})`).map(c => c.name).sort();
    return cols.length === 2 && cols[0] === 'date' && cols[1] === 'user_id';
  });
  if (hasComposite) return; // already migrated
  console.log('Migration: body_weight -> composite (date, user_id) unique constraint...');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE body_weight_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        date      TEXT NOT NULL,
        weight_kg REAL NOT NULL,
        user_id   INTEGER NOT NULL DEFAULT 1,
        UNIQUE (date, user_id)
      );
      INSERT INTO body_weight_new (id, timestamp, date, weight_kg, user_id)
        SELECT id, timestamp, date, weight_kg, COALESCE(user_id, 1) FROM body_weight;
      DROP TABLE body_weight;
      ALTER TABLE body_weight_new RENAME TO body_weight;
    `);
  })();
  console.log('Migration: body_weight composite unique done');
}
migrateBodyWeightCompositeUnique();

// checkins -> (date, user_id). Its column list must carry every checkins
// column added above (the three-place rule).
function migrateCheckinsCompositeKey() {
  const cols = db.pragma('table_info(checkins)');
  const userIdCol = cols.find(c => c.name === 'user_id');
  if (userIdCol && userIdCol.pk > 0) return; // already migrated
  console.log('Migration: checkins -> composite (date, user_id) primary key...');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE checkins_new (
        date                   TEXT NOT NULL,
        user_id                INTEGER NOT NULL DEFAULT 1,
        morning_sleep          INTEGER,
        morning_feeling        INTEGER,
        morning_planned_type   TEXT,
        morning_timestamp      INTEGER,
        evening_energy         INTEGER,
        evening_feeling        INTEGER,
        evening_eating         INTEGER,
        evening_journal        TEXT,
        evening_timestamp      INTEGER,
        garmin_sleep_score     INTEGER,
        garmin_sleep_qualifier TEXT,
        morning_sick           INTEGER,
        evening_sick           INTEGER,
        evening_flags          TEXT,
        morning_flags          TEXT,
        day_journal            TEXT,
        morning_fasts          TEXT,
        evening_fasts          TEXT,
        morning_prayer         TEXT,
        PRIMARY KEY (date, user_id)
      );
      INSERT INTO checkins_new (date, user_id, morning_sleep, morning_feeling, morning_planned_type,
        morning_timestamp, evening_energy, evening_feeling, evening_eating, evening_journal,
        evening_timestamp, garmin_sleep_score, garmin_sleep_qualifier, morning_sick, evening_sick,
        evening_flags, morning_flags, day_journal, morning_fasts, evening_fasts, morning_prayer)
      SELECT date, COALESCE(user_id, 1), morning_sleep, morning_feeling, morning_planned_type,
        morning_timestamp, evening_energy, evening_feeling, evening_eating, evening_journal,
        evening_timestamp, garmin_sleep_score, garmin_sleep_qualifier, morning_sick, evening_sick,
        evening_flags, morning_flags, day_journal, morning_fasts, evening_fasts, morning_prayer
      FROM checkins;
      DROP TABLE checkins;
      ALTER TABLE checkins_new RENAME TO checkins;
    `);
  })();
  console.log('Migration: checkins composite key done');
}
migrateCheckinsCompositeKey();

// garmin_sync_status -> keyed by user_id, like apple_sync_status. The old
// singleton row becomes user 1's. Story: DECISIONS.md#per-user-sync-credentials.
function migrateGarminSyncStatusPerUser() {
  const cols = db.pragma('table_info(garmin_sync_status)');
  const userIdCol = cols.find(c => c.name === 'user_id');
  if (userIdCol && userIdCol.pk > 0) return; // already migrated
  console.log('Migration: garmin_sync_status -> per-user (user_id PRIMARY KEY)...');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE garmin_sync_status_new (
        user_id         INTEGER PRIMARY KEY,
        last_attempt_at INTEGER,
        ok              INTEGER,
        mfa_required    INTEGER,
        message         TEXT,
        last_success_at INTEGER
      );
      INSERT INTO garmin_sync_status_new (user_id, last_attempt_at, ok, mfa_required, message, last_success_at)
        SELECT 1, last_attempt_at, ok, mfa_required, message, last_success_at FROM garmin_sync_status WHERE id = 1;
      DROP TABLE garmin_sync_status;
      ALTER TABLE garmin_sync_status_new RENAME TO garmin_sync_status;
    `);
  })();
  console.log('Migration: garmin_sync_status per-user done');
}
migrateGarminSyncStatusPerUser();
// AFTER the rebuild, which copies a frozen column list and would drop it on a
// database that has not been rebuilt yet.
addColumnIfMissing('garmin_sync_status', 'rate_limited', 'rate_limited INTEGER');

// Rewrites any legacy M/D/YYYY date to ISO. Only rows containing a slash are
// touched, so it is idempotent and resumable. Keys on the implicit rowid, which
// every table here has even with a composite primary key.
function migrateDatesToISO() {
  const DATE_COLUMNS = [
    ['history', 'date'],
    ['body_weight', 'date'],
    ['checkins', 'date'],
    ['injuries', 'started_date'],
    ['injuries', 'resolved_date'],
    ['injury_checkins', 'date'],
    ['goals', 'target_date'],
  ];
  for (const [table, col] of DATE_COLUMNS) {
    const rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table} WHERE ${col} LIKE '%/%'`).all();
    if (!rows.length) continue;
    console.log(`Migration: ${table}.${col} -> ISO dates (${rows.length} rows)...`);
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    db.transaction(() => {
      for (const r of rows) upd.run(normalizeDateStr(r.v), r.rid);
    })();
  }
}
migrateDatesToISO();

// ── One-time data migration: legacy A/B/C lifts → routines table ──────────────
// Turns a pre-routines install's fixed A/B/C lifts into routines rows and
// remaps every letter reference (exercises.routine_id, day_schedule.lift_day,
// history.lift) to the new id. Runs only when routines is empty and lift_names
// has rows, which only an old install has. Migrated exercises get no category:
// the old groupings mixed categories, so guessing would encode a mistake.
// Story: DECISIONS.md#routines-refactor.
function migrateLegacyLiftsToRoutines() {
  const routineCount = db.prepare('SELECT COUNT(*) as n FROM routines').get().n;
  if (routineCount > 0) return;
  const liftNameRows = db.prepare('SELECT * FROM lift_names').all();
  if (!liftNameRows.length) return; // fresh install — nothing to migrate

  console.log('Migration: converting legacy A/B/C lifts to routines table...');
  const liftNameMap = {};
  for (const row of liftNameRows) liftNameMap[row.lift] = row.name;

  const insRoutine   = db.prepare('INSERT INTO routines (name, emoji, position, archived) VALUES (?, ?, ?, 0)');
  const updExercises = db.prepare('UPDATE exercises SET routine_id = ? WHERE lift = ?');
  const updSchedule  = db.prepare('UPDATE day_schedule SET lift_day = ? WHERE lift_day = ?');
  const updHistory   = db.prepare('UPDATE history SET lift = ? WHERE lift = ?');

  db.transaction(() => {
    ['A', 'B', 'C'].forEach((letter, i) => {
      const name = liftNameMap[letter] || `Lift ${letter}`;
      const { lastInsertRowid: routineId } = insRoutine.run(name, '🏋️', i);
      updExercises.run(routineId, letter);
      updSchedule.run(String(routineId), letter);
      updHistory.run(String(routineId), letter);
    });
  })();
  console.log('Migration: legacy lifts converted to routines');
}
migrateLegacyLiftsToRoutines();

// ── One-time data migration: four name-keyed tables → exercise_meta ───────────
// Copies the four frozen tables into exercise_meta, one row per name, in one
// transaction. Guarded on exercise_meta being empty; the sources are never
// modified.
function migrateNameKeyedTablesToExerciseMeta() {
  const already = db.prepare('SELECT COUNT(*) as n FROM exercise_meta').get().n;
  if (already > 0) return;
  const names = new Set();
  for (const t of ['exercise_category_overrides', 'exercise_form_notes', 'exercise_weightless', 'exercise_patterns']) {
    for (const r of db.prepare(`SELECT name FROM ${t}`).all()) names.add(r.name);
  }
  if (!names.size) return;
  console.log(`Migration: consolidating ${names.size} exercise name(s) into exercise_meta...`);
  const cat = db.prepare('SELECT category FROM exercise_category_overrides WHERE name = ?');
  const fn  = db.prepare('SELECT how_to, mistakes FROM exercise_form_notes WHERE name = ?');
  const wl  = db.prepare('SELECT weightless FROM exercise_weightless WHERE name = ?');
  const pat = db.prepare('SELECT hinge_knee, unilateral FROM exercise_patterns WHERE name = ?');
  const ins = db.prepare(`
    INSERT INTO exercise_meta (name, category, how_to, mistakes, weightless, hinge_knee, unilateral)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const name of names) {
      const c = cat.get(name), f = fn.get(name), w = wl.get(name), p = pat.get(name);
      ins.run(name, c?.category ?? null, f?.how_to ?? '', f?.mistakes ?? '', w?.weightless ? 1 : 0, p?.hinge_knee ?? null, p?.unilateral ? 1 : 0);
    }
  })();
  console.log('Migration: exercise_meta consolidation complete');
}
migrateNameKeyedTablesToExerciseMeta();

// ── exercise_defaults, filled from routine rows ─────────────────────────────
// Every (user, name) with no exercise_defaults row gets one, copied from that
// user's routine rows: ACTIVE routines first, then the newest routine, then
// the first position, since INSERT OR IGNORE keeps the first row it sees. So
// a name now only in an archived routine keeps the rest it had there.
//
// Runs on every boot and after every POST /api/import, and is safe to: it
// only ever FILLS a missing row, never overwrites one, so it cannot revert an
// edit. Nothing deletes a defaults row except a merge, which renames the
// alias's routine rows first, so the seed has nothing to bring back.
function seedExerciseDefaultsFromRoutines() {
  const added = db.prepare(`
    INSERT OR IGNORE INTO exercise_defaults (user_id, name, weight, reps, sets, rest_sec, emoji, video)
    SELECT r.user_id, lower(trim(e.name)), COALESCE(e.weight, ''), COALESCE(e.reps, ''), COALESCE(e.sets, 3),
           e.rest_sec, COALESCE(e.emoji, ''), COALESCE(e.video, '')
    FROM exercises e JOIN routines r ON r.id = e.routine_id
    WHERE trim(e.name) != '' AND r.user_id IS NOT NULL
    ORDER BY r.archived ASC, r.id DESC, e.position ASC
  `).run().changes;
  if (added) console.log(`Migration: ${added} exercise default(s) filled from routine rows`);
}
seedExerciseDefaultsFromRoutines();

// ── Climb grade normalization ────────────────────────────────────────────────
// The canonical grades are the UI's pickers: V0-V17, 5.5-5.9 plain, and
// 5.10-5.15 as -/+ pairs with no plain grade. migrateClimbGrades rewrites
// stored grades to match. Anything it cannot confidently parse is LEFT AS-IS,
// never guessed or blanked; Settings lists those for a manual fix.
const VALID_CLIMB_GRADES = new Set([
  ...Array.from({ length: 18 }, (_, i) => `V${i}`),
  '5.5', '5.6', '5.7', '5.8', '5.9',
  ...['5.10', '5.11', '5.12', '5.13', '5.14', '5.15'].flatMap(b => [`${b}-`, `${b}+`]),
]);

function normalizeClimbGrade(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (VALID_CLIMB_GRADES.has(s)) return s; // already canonical

  const v = s.match(/^v\s*(\d{1,2})$/i);
  if (v) {
    const n = parseInt(v[1], 10);
    return n >= 0 && n <= 17 ? `V${n}` : null;
  }

  // YDS: optional letter (a-d) and/or +/- modifier.
  const yds = s.match(/^5\s*\.\s*(\d{1,2})\s*([abcd])?\s*([+-])?$/i);
  if (yds) {
    const n = parseInt(yds[1], 10);
    if (n < 5 || n > 15) return null;
    const base = `5.${n}`;
    // Below 5.10 the scale has no sub-grades, so any letter/modifier is
    // noise — drop it rather than inventing a "5.9+" that isn't on the list.
    if (n < 10) return VALID_CLIMB_GRADES.has(base) ? base : null;
    const letter = (yds[2] || '').toLowerCase();
    const mod = yds[3] || '';
    // a/b -> minus, c/d -> plus; an explicit +/- wins. A bare "5.11" rounds
    // DOWN to the minus: it was never claimed as the harder half, and
    // inflating a PR is worse than under-crediting one.
    const suffix = mod || (letter === 'c' || letter === 'd' ? '+' : '-');
    const out = `${base}${suffix}`;
    return VALID_CLIMB_GRADES.has(out) ? out : null;
  }
  return null; // unparseable — caller leaves the original untouched
}

// Rewrites only rows that change, so every later boot is a no-op.
function migrateClimbGrades() {
  const rows = db.prepare("SELECT id, data FROM history WHERE type = 'climb' AND data IS NOT NULL").all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE history SET data = ? WHERE id = ?');
  let changed = 0;

  db.transaction(() => {
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.data); } catch (e) { continue; }
      if (!Array.isArray(parsed?.routes) || !parsed.routes.length) continue;

      let rowChanged = false;
      const routes = parsed.routes.map(r => {
        const norm = normalizeClimbGrade(r?.grade);
        if (norm && norm !== r.grade) { rowChanged = true; return { ...r, grade: norm }; }
        return r;
      });
      if (rowChanged) { upd.run(JSON.stringify({ ...parsed, routes }), row.id); changed++; }
    }
  })();

  if (changed) console.log(`Migration: normalized climb grades in ${changed} history entr${changed === 1 ? 'y' : 'ies'}`);
}
migrateClimbGrades();

// The injury columns; see the injuries and injury_checkins comments for what
// each means.
// workout_pain: 1-10, 10 = worst, written for the workout's date through the
// same PUT the check-in periods use. NULL on a day with no lift session.
// Story: DECISIONS.md#injury-tracking-three-touchpoint-gaps.
addColumnIfMissing('injury_checkins', 'workout_pain', 'workout_pain INTEGER');

// resolution_summary: the closing note asked for on resolve, kept apart from
// the onset note. Story: DECISIONS.md#injury-tracking-three-touchpoint-gaps.
addColumnIfMissing('injuries', 'resolution_summary', 'resolution_summary TEXT');

// Logging a niggle or injury from a workout. Story: DECISIONS.md#injury-from-workout.
addColumnIfMissing('injuries', 'kind',       "kind TEXT NOT NULL DEFAULT 'injury'");
addColumnIfMissing('injuries', 'history_id', 'history_id INTEGER');
addColumnIfMissing('injuries', 'tracked_since', 'tracked_since INTEGER');

// evening_trend: 'worse' | 'same' | 'better', or NULL when unasked. Shown
// BESIDE the computed trend, never replacing it.
// Story: DECISIONS.md#injury-tracking-three-touchpoint-gaps.
addColumnIfMissing('injury_checkins', 'evening_trend', 'evening_trend TEXT');

// evening_note: free text per (injury, date). server.js stores an empty
// string as NULL, so blank and unanswered are one state (no denominator needs
// them apart). Story: DECISIONS.md#injury-daily-notes.
addColumnIfMissing('injury_checkins', 'evening_note', 'evening_note TEXT');

// The garmin_daily metrics added after birth. Each is one addColumnIfMissing
// plus its entry in GARMIN_DAILY_COLUMNS, without which upsertGarminDaily
// never writes it.
//
// stress_avg: the all-day average stress (0-100), from the daily summary
// fetch_recovery_summary already requests. NULL is "not synced", never calm:
// Garmin answers -1/-2 for no reading, and server.js's 0-100 bound drops those.
// Story: DECISIONS.md#stress-markers.
addColumnIfMissing('garmin_daily', 'stress_avg', 'stress_avg INTEGER');

// VO2 max and training load, from fetch_training_status. Each is dated by
// GARMIN'S calendarDate for its own block, so a VO2 max sits only on the day
// it was last updated rather than across the trailing window.
//   vo2max            ml/kg/min, one decimal (running/walking based)
//   load_acute        7-day acute training load, Garmin's EPOC-based units
//   load_chronic      its ~4-week chronic load
//   load_optimal_min  the OPTIMAL RANGE for load_acute (Garmin misnames these
//   load_optimal_max  min/maxTrainingLoadChronic; they are 0.8x / 1.5x chronic)
//   training_status   Garmin's word: PRODUCTIVE, MAINTAINING, DETRAINING, ...
//   focus_*           the 4-week "Load Focus" split -- low aerobic, high
//                     aerobic, anaerobic -- each with Garmin's target range,
//                     and focus_feedback, its verdict (AEROBIC_LOW_SHORTAGE)
// All of it is watch-recorded load only: lifting logged in the app is not in
// it. Story: DECISIONS.md#vo2-max-and-training-load.
addColumnIfMissing('garmin_daily', 'vo2max', 'vo2max REAL');
for (const col of ['load_acute', 'load_chronic', 'load_optimal_min', 'load_optimal_max',
  'focus_low_aerobic', 'focus_high_aerobic', 'focus_anaerobic',
  'focus_low_aerobic_min', 'focus_low_aerobic_max', 'focus_high_aerobic_min',
  'focus_high_aerobic_max', 'focus_anaerobic_min', 'focus_anaerobic_max']) {
  addColumnIfMissing('garmin_daily', col, `${col} INTEGER`);
}
addColumnIfMissing('garmin_daily', 'training_status', 'training_status TEXT');
addColumnIfMissing('garmin_daily', 'focus_feedback', 'focus_feedback TEXT');

// Overnight respiration, sleep time and skin temperature, all read from the
// get_sleep_data payload fetch_sleep_summary already requests, so they cost no
// Garmin call. They are the readiness verdict's illness signals beside resting
// HR and HRV.
//   resp_rate      breaths/min, one decimal (averageRespirationValue)
//   sleep_minutes  sleepTimeSeconds / 60; naps are Garmin's separate field
//   skin_temp_dev  deg C against the WATCH'S own baseline, one decimal and
//                  SIGNED: a negative value is a real reading, never a sentinel.
//                  Device-gated, and absent until the watch has calibrated.
// Story: DECISIONS.md#readiness-verdict.
addColumnIfMissing('garmin_daily', 'resp_rate', 'resp_rate REAL');
addColumnIfMissing('garmin_daily', 'sleep_minutes', 'sleep_minutes INTEGER');
addColumnIfMissing('garmin_daily', 'skin_temp_dev', 'skin_temp_dev REAL');

// The day's calorie burn, from the get_stats summary fetch_recovery_summary
// already requests, so no extra Garmin call.
//   calories_total   totalKilocalories: Garmin's resting estimate + active
//   calories_active  activeKilocalories: the part above resting
// Watch-measured only: a lift that was never recorded on the watch is counted
// as ordinary daytime movement, so lifting days read low. An ALL-DAY metric:
// today's row is a running total until the next morning's sync re-fetches it.
// Story: DECISIONS.md#daily-calories.
addColumnIfMissing('garmin_daily', 'calories_total', 'calories_total INTEGER');
addColumnIfMissing('garmin_daily', 'calories_active', 'calories_active INTEGER');

// Pause-jump segments and per-point times (see the CREATE TABLE comment).
// NULL on existing rows means "not checked", which queues them for a re-fetch.
addColumnIfMissing('activity_routes', 'breaks', 'breaks TEXT');
addColumnIfMissing('activity_routes', 'times', 'times TEXT');
addColumnIfMissing('activity_routes', 'elev', 'elev TEXT');
addColumnIfMissing('activity_routes', 'hr', 'hr TEXT');

// One-time rescale of the old 1-5 and 0-5 ratings to 1-10. Guarded on PRAGMA
// user_version, NOT on the data: a migrated 4 and an unmigrated 4 look the
// same, so a second run would double-apply and corrupt. user_version is used
// nowhere else; a future one-shot migration must take the next number. Runs
// after the addColumnIfMissing calls, since it rescales workout_pain. RPE is
// a separate currency and is never touched. Story: DECISIONS.md#rating-scale-1-10.
const RATING_SCALE_MIGRATION_VERSION = 1;
function migrateRatingScalesTo10() {
  if (db.pragma('user_version', { simple: true }) >= RATING_SCALE_MIGRATION_VERSION) return;

  // [table, column, oldMin] — oldMin is 1 for every field except the two
  // evening 0-5 scales. Formula: oldMin===1 -> round((v-1)/4*9)+1;
  // oldMin===0 -> round(v/5*9)+1. Direction (higher=worse for pain/severity)
  // is preserved automatically since it's a monotonic rescale either way.
  const COLUMNS = [
    ['checkins', 'morning_sleep', 1], ['checkins', 'morning_feeling', 1],
    ['checkins', 'evening_eating', 1],
    ['checkins', 'evening_energy', 0], ['checkins', 'evening_feeling', 0],
    ['injury_checkins', 'morning_pain', 1], ['injury_checkins', 'evening_pain', 1],
    ['injury_checkins', 'workout_pain', 1],
    ['injuries', 'severity', 1],
  ];
  const rescale = (v, oldMin) => oldMin === 0
    ? Math.round(v / 5 * 9) + 1
    : Math.round((v - 1) / 4 * 9) + 1;

  let totalChanged = 0;
  db.transaction(() => {
    for (const [table, col, oldMin] of COLUMNS) {
      const rows = db.prepare(`SELECT rowid AS rid, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all();
      if (!rows.length) continue;
      const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
      let changed = 0;
      for (const r of rows) {
        const nv = rescale(r.v, oldMin);
        if (nv !== r.v) { upd.run(nv, r.rid); changed++; }
      }
      if (changed) console.log(`Migration: ${table}.${col} rescaled 1-5${oldMin === 0 ? ' (0-5)' : ''} -> 1-10 (${changed} rows)`);
      totalChanged += changed;
    }
    db.pragma(`user_version = ${RATING_SCALE_MIGRATION_VERSION}`);
  })();
  if (totalChanged) console.log(`Migration: rating scales -> 1-10 complete (${totalChanged} values rewritten)`);
}
migrateRatingScalesTo10();

// ── Default routines + exercises (a fresh install only: routines empty) ──────
const DEFAULT_ROUTINES = [
  { name: 'Lift A', exercises: [
    { name: 'DB bench press',         weight: '50', reps: '10', sets: 3, video: '', category: 'upper_push' },
    { name: 'Incline DB fly',         weight: '35', reps: '12', sets: 3, video: '', category: 'upper_push' },
    { name: 'Close-grip floor press', weight: '45', reps: '10', sets: 2, video: '', category: 'upper_push' },
    { name: 'OHD tricep extension',   weight: '25', reps: '12', sets: 2, video: '', category: 'upper_push' }
  ]},
  { name: 'Lift B', exercises: [
    { name: 'Bent-over row',   weight: '45', reps: '10', sets: 3, video: '', category: 'upper_pull' },
    { name: 'Single-arm row',  weight: '50', reps: '10', sets: 3, video: '', category: 'upper_pull' },
    { name: 'Hammer curl',     weight: '30', reps: '12', sets: 3, video: '', category: 'upper_pull' },
    { name: 'Supinated curl',  weight: '25', reps: '12', sets: 2, video: '', category: 'upper_pull' },
    { name: 'Reverse curl',    weight: '20', reps: '12', sets: 2, video: '', category: 'upper_pull' }
  ]},
  { name: 'Lift C', exercises: [
    { name: 'Goblet squat',      weight: '60', reps: '10', sets: 3, video: '', category: 'legs_push' },
    { name: 'Romanian deadlift', weight: '60', reps: '10', sets: 3, video: '', category: 'legs_pull' },
    { name: 'Lateral raise',     weight: '15', reps: '15', sets: 3, video: '', category: 'upper_push' },
    { name: 'Face pull',         weight: '30', reps: '15', sets: 3, video: '', category: 'upper_pull' },
    { name: 'Arnold press',      weight: '35', reps: '10', sets: 2, video: '', category: 'upper_push' }
  ]}
];

const routineCount = db.prepare('SELECT COUNT(*) as n FROM routines').get().n;
if (routineCount === 0) {
  console.log('Seeding default routines + exercises...');
  const insRoutine = db.prepare('INSERT INTO routines (name, emoji, position, archived) VALUES (?, ?, ?, 0)');
  DEFAULT_ROUTINES.forEach(({ name, exercises }, i) => {
    const { lastInsertRowid: routineId } = insRoutine.run(name, '🏋️', i);
    setLifts(routineId, exercises);
  });
}

// ── Default activity types (seeded once, idempotent) ───────────────────────────
// The curated built-ins, seeded categorized=1. Any other synced type is
// inserted by ensureActivityType() with categorized=0.
const DEFAULT_ACTIVITY_TYPES = [
  { type_key: 'run',    label: 'Run',    emoji: '🏃' },
  { type_key: 'bike',   label: 'Bike',   emoji: '🚴' },
  { type_key: 'climb',  label: 'Climb',  emoji: '🧗' },
  { type_key: 'hike',   label: 'Hike',   emoji: '🥾' },
  { type_key: 'walk',   label: 'Walk',   emoji: '🚶' },
  { type_key: 'lift',   label: 'Lift',   emoji: '🏋️' },
  { type_key: 'rest',   label: 'Rest',   emoji: '😴' },
];
const activityTypeCount = db.prepare('SELECT COUNT(*) as n FROM activity_types').get().n;
if (activityTypeCount === 0) {
  console.log('Seeding default activity types...');
  const insType = db.prepare('INSERT INTO activity_types (type_key, label, emoji, categorized) VALUES (?, ?, ?, 1)');
  for (const t of DEFAULT_ACTIVITY_TYPES) insType.run(t.type_key, t.label, t.emoji);
}

// A synced type's STARTING name and emoji, from Garmin's or Apple's type key:
// sentence case, with the key's version and "winter sport" suffixes dropped
// ("skate_skiing_ws" -> "Skate skiing", "kayaking_v2" -> "Kayaking"), and the
// sport's own emoji where it has an obvious one. Settings renames either; this
// only decides what a new type looks like before anyone does.
const ACTIVITY_TYPE_EMOJI = [
  [/kayak|canoe|paddl/, '🛶'], [/row/, '🚣'], [/swim/, '🏊'], [/surf/, '🏄'], [/sail/, '⛵'],
  [/snowboard/, '🏂'], [/ski/, '⛷️'], [/skat/, '⛸️'], [/snowshoe|hik/, '🥾'],
  [/mountain_bik/, '🚵'], [/cycl|bik/, '🚴'], [/run/, '🏃'], [/walk/, '🚶'], [/climb|boulder/, '🧗'],
  [/yoga|pilates|stretch|meditat|breath/, '🧘'], [/strength|weight/, '🏋️'], [/golf/, '⛳'],
  [/tennis|pickleball|padel/, '🎾'], [/soccer|football/, '⚽'], [/basketball/, '🏀'],
  [/box|martial/, '🥊'], [/danc/, '💃'], [/fish/, '🎣'], [/horse/, '🐎'],
];
function defaultActivityTypeLabel(typeKey) {
  const s = typeKey.replace(/_(ws|v\d+)$/, '').split('_').filter(Boolean).join(' ').replace(/\bhiit\b/, 'HIIT');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : typeKey;
}
function defaultActivityTypeEmoji(typeKey) {
  return (ACTIVITY_TYPE_EMOJI.find(([re]) => re.test(typeKey)) || [])[1] || '🏅';
}

// Brings an existing type still wearing the OLD automatic name ("Skate
// Skiing Ws", every word capitalised and the suffix kept) up to the one
// above, and an uncategorized one's placeholder 🏅 with it. Never touches a
// rename or a chosen emoji: a label that isn't the old automatic one, or an
// emoji on a type someone has categorized, is theirs. Idempotent, since the
// new name never equals the old one it replaces.
{
  const oldAutoLabel = k => k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const upd = db.prepare('UPDATE activity_types SET label = ?, emoji = ? WHERE type_key = ?');
  let renamed = 0;
  for (const r of db.prepare('SELECT type_key, label, emoji, categorized FROM activity_types').all()) {
    const label = r.label === oldAutoLabel(r.type_key) ? defaultActivityTypeLabel(r.type_key) : r.label;
    const emoji = r.emoji === '🏅' && !r.categorized ? defaultActivityTypeEmoji(r.type_key) : r.emoji;
    if (label !== r.label || emoji !== r.emoji) { upd.run(label, emoji, r.type_key); renamed++; }
  }
  if (renamed) console.log(`Gave ${renamed} activity type(s) their tidied starting name or emoji.`);
}

// ── Default user (seeded once, idempotent) ─────────────────────────────────────
// A fresh install gets ONE user, id 1: the id every backfilled row belongs to
// and the one getUserId falls back to, so it must always exist. Its name is a
// starting label, renamable in the People card, where anyone else is added.
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  console.log('Seeding the default user...');
  db.prepare('INSERT INTO users (id, name, emoji) VALUES (?, ?, ?)').run(1, 'Me', '🔵');
}

// ── Default exercise → muscle attribution + movement patterns ─────────────────
// Seeded once, only into an empty table, so an in-app retune is never
// overwritten. Fractions: 1.0 primary, 0.5 secondary, 0.3 minor; rows do NOT
// sum to 1.0 (see the table comment).
//
// Names must match SUGGESTED_EXERCISES (index.html) and DEFAULT_ROUTINES
// CHARACTER FOR CHARACTER, or the mapping never resolves. 'Supinated curl' and
// 'Supinated curls' are both here because those two lists disagree. Anything
// else logged shows in Settings -> Unmapped Exercises, never guessed.
const DEFAULT_EXERCISE_MUSCLES = {
  // Upper push
  'DB bench press':          { chest: 1.0, triceps: 0.5, front_delts: 0.5 },
  'Incline dumbbell press':  { chest: 1.0, front_delts: 0.5, triceps: 0.5 },
  'DB floor press':          { chest: 1.0, triceps: 0.5, front_delts: 0.3 },
  'Close-grip floor press':  { triceps: 1.0, chest: 0.5, front_delts: 0.3 },
  'Overhead dumbbell press': { front_delts: 1.0, triceps: 0.5, side_delts: 0.3, core: 0.3 },
  'Overhead shoulder press': { front_delts: 1.0, triceps: 0.5, side_delts: 0.3, core: 0.3 },
  'Arnold press':            { front_delts: 1.0, side_delts: 0.5, triceps: 0.3 },
  'Incline DB fly':          { chest: 1.0, front_delts: 0.3 },
  'DB pullover':             { lats: 0.5, chest: 0.5, triceps: 0.3 },
  'Lateral raise':           { side_delts: 1.0, front_delts: 0.3 },
  'Front raise':             { front_delts: 1.0, side_delts: 0.3 },
  'Skull crushers':          { triceps: 1.0 },
  'OHD tricep extension':    { triceps: 1.0 },
  'Push ups':                { chest: 1.0, triceps: 0.5, front_delts: 0.5, core: 0.3 },
  'Decline push ups':        { chest: 1.0, front_delts: 0.5, triceps: 0.5, core: 0.3 },
  'Diamond push ups':        { triceps: 1.0, chest: 0.5, front_delts: 0.3 },
  'Pike push ups':           { front_delts: 1.0, triceps: 0.5, side_delts: 0.3 },
  'Dips':                    { triceps: 1.0, chest: 0.5, front_delts: 0.3 },

  // Upper pull
  'Bent-over row':      { lats: 1.0, upper_back: 1.0, biceps: 0.5, rear_delts: 0.3, lower_back: 0.3 },
  'Single-arm row':     { lats: 1.0, upper_back: 0.5, biceps: 0.5, rear_delts: 0.3 },
  'DB high pull':       { upper_back: 1.0, side_delts: 0.5, rear_delts: 0.5, biceps: 0.3 },
  'Shrugs':             { upper_back: 1.0, forearms: 0.3 },
  'Reverse fly':        { rear_delts: 1.0, upper_back: 0.5 },
  'Face pull':          { rear_delts: 1.0, upper_back: 0.5 },
  'Curls':              { biceps: 1.0, forearms: 0.3 },
  'Hammer curl':        { biceps: 1.0, forearms: 0.5 },
  'Supinated curls':    { biceps: 1.0, forearms: 0.3 },
  'Supinated curl':     { biceps: 1.0, forearms: 0.3 },
  'Reverse curl':       { forearms: 1.0, biceps: 0.5 },
  'Incline DB curl':    { biceps: 1.0, forearms: 0.3 },
  'Concentration curl': { biceps: 1.0 },
  'Zottman curl':       { biceps: 1.0, forearms: 1.0 },
  'Pull ups':           { lats: 1.0, biceps: 0.5, upper_back: 0.5, core: 0.3 },
  'Chin ups':           { lats: 1.0, biceps: 1.0, upper_back: 0.3, core: 0.3 },
  'Inverted row':       { upper_back: 1.0, lats: 0.5, biceps: 0.5, rear_delts: 0.3 },

  // Legs push (knee-dominant)
  'Goblet squat':          { quads: 1.0, glutes: 0.5, core: 0.3 },
  'DB front squat':        { quads: 1.0, glutes: 0.5, core: 0.5 },
  'Bulgarian split squat': { quads: 1.0, glutes: 1.0 },
  'Split squat':           { quads: 1.0, glutes: 0.5 },
  'Walking lunges':        { quads: 1.0, glutes: 1.0, hamstrings: 0.3 },
  'Reverse lunge':         { quads: 1.0, glutes: 1.0 },
  'Lateral lunge':         { quads: 1.0, glutes: 0.5, adductors: 0.5 },
  'Curtsy lunge':          { glutes: 1.0, quads: 0.5, adductors: 0.3 },
  'Step-ups':              { quads: 1.0, glutes: 1.0 },
  'Calf raise':            { calves: 1.0 },
  'Bodyweight squat':      { quads: 1.0, glutes: 0.5 },
  'Pistol squat':          { quads: 1.0, glutes: 0.5, core: 0.5 },
  'Sissy squat':           { quads: 1.0 },
  'Wall sit':              { quads: 1.0 },
  'Box jump':              { quads: 1.0, glutes: 0.5, calves: 0.5 },

  // Legs pull (hip-hinge dominant)
  'Romanian deadlift':     { hamstrings: 1.0, glutes: 1.0, lower_back: 0.5 },
  'DB deadlift':           { hamstrings: 1.0, glutes: 1.0, lower_back: 0.5, quads: 0.3, upper_back: 0.3 },
  'Single-leg RDL':        { hamstrings: 1.0, glutes: 1.0, lower_back: 0.3, core: 0.3 },
  'Kickstand RDL':         { hamstrings: 1.0, glutes: 1.0, lower_back: 0.3 },
  'Good morning':          { hamstrings: 1.0, lower_back: 1.0, glutes: 0.5 },
  'Hip thrust':            { glutes: 1.0, hamstrings: 0.5 },
  'Single-leg hip thrust': { glutes: 1.0, hamstrings: 0.5 },
  'Frog pump':             { glutes: 1.0 },
  'Glute bridge':          { glutes: 1.0, hamstrings: 0.3 },
  'Nordic curl':           { hamstrings: 1.0, calves: 0.3 },
  'Hamstring walkout':     { hamstrings: 1.0, core: 0.5 },
  'Reverse hyper':         { glutes: 1.0, hamstrings: 0.5, lower_back: 0.5 },
};

// Only names that carry a tag; every other name starts unreviewed (NULL).
const DEFAULT_EXERCISE_PATTERNS = {
  'Single-arm row':        { unilateral: true },
  'Concentration curl':    { unilateral: true },
  'Goblet squat':          { hinge_knee: 'knee' },
  'DB front squat':        { hinge_knee: 'knee' },
  'Bulgarian split squat': { hinge_knee: 'knee', unilateral: true },
  'Split squat':           { hinge_knee: 'knee', unilateral: true },
  'Walking lunges':        { hinge_knee: 'knee', unilateral: true },
  'Reverse lunge':         { hinge_knee: 'knee', unilateral: true },
  'Lateral lunge':         { hinge_knee: 'knee', unilateral: true },
  'Curtsy lunge':          { hinge_knee: 'knee', unilateral: true },
  'Step-ups':              { hinge_knee: 'knee', unilateral: true },
  'Bodyweight squat':      { hinge_knee: 'knee' },
  'Pistol squat':          { hinge_knee: 'knee', unilateral: true },
  'Sissy squat':           { hinge_knee: 'knee' },
  'Wall sit':              { hinge_knee: 'knee' },
  'Box jump':              { hinge_knee: 'knee' },
  'Romanian deadlift':     { hinge_knee: 'hinge' },
  'DB deadlift':           { hinge_knee: 'hinge' },
  'Single-leg RDL':        { hinge_knee: 'hinge', unilateral: true },
  'Kickstand RDL':         { hinge_knee: 'hinge', unilateral: true },
  'Good morning':          { hinge_knee: 'hinge' },
  'Hip thrust':            { hinge_knee: 'hinge' },
  'Single-leg hip thrust': { hinge_knee: 'hinge', unilateral: true },
  'Reverse hyper':         { hinge_knee: 'hinge' },
};

const muscleRowCount = db.prepare('SELECT COUNT(*) as n FROM exercise_muscles').get().n;
if (muscleRowCount === 0) {
  console.log('Seeding default exercise → muscle attribution...');
  for (const [name, muscles] of Object.entries(DEFAULT_EXERCISE_MUSCLES)) setExerciseMuscles(name, muscles);
}

// The guard must read what setExercisePattern WRITES (exercise_meta), not only
// the frozen exercise_patterns table: on a fresh install that table is empty
// forever, and a guard reading it alone re-seeds on every boot, reverting hand
// edits. verify_migrations.js covers it.
const patternRowCount =
  db.prepare('SELECT COUNT(*) as n FROM exercise_patterns').get().n +
  db.prepare(`SELECT COUNT(*) as n FROM exercise_meta
              WHERE hinge_knee IS NOT NULL OR laterality IS NOT NULL OR unilateral = 1`).get().n;
if (patternRowCount === 0) {
  console.log('Seeding default exercise movement patterns...');
  for (const [name, pattern] of Object.entries(DEFAULT_EXERCISE_PATTERNS)) setExercisePattern(name, pattern);
}

// ── Transactions ───────────────────────────────────────────────────────────────
// Lets a CALLER make several exported writes all-or-nothing. Every
// multi-statement write inside db.js wraps itself; this is for server.js's
// sequences of separate calls, POST /api/import (clears, then refills) and the
// Garmin dedup (deletes the manual entry, then inserts the synced one).
// Story: DECISIONS.md#import-atomicity.
//
// `fn` must be SYNCHRONOUS: better-sqlite3 commits when fn returns, so an async
// fn commits an empty transaction and runs its work outside it. Nesting is
// fine; an inner db.transaction becomes a SAVEPOINT.
function transaction(fn) {
  return db.transaction(fn)();
}

// ── Lifts ──────────────────────────────────────────────────────────────────────
// Keyed by routine id as a string. Only the user's ACTIVE routines: archived
// ones are not editable or loggable, and history holds its own snapshot.
// Scoped through routines.user_id, since exercises carries no user_id.
// Each row's six default fields come from exercise_defaults, the truth (see
// its CREATE TABLE), so a value saved from ANY routine, or for an exercise in
// none, shows in every routine carrying the name. The row's own copy is only
// the fallback for a name with no defaults row.
function getLifts(userId) {
  const routines = db.prepare('SELECT id FROM routines WHERE archived = 0 AND user_id = ?').all(userId);
  const result = {};
  for (const r of routines) result[String(r.id)] = [];
  const defaults = getExerciseDefaults(userId);
  const rows = db.prepare('SELECT * FROM exercises WHERE routine_id IS NOT NULL ORDER BY routine_id, position').all();
  for (const row of rows) {
    const key = String(row.routine_id);
    if (!(key in result)) continue; // belongs to an archived/missing routine
    const d = defaults[(row.name || '').trim().toLowerCase()];
    result[key].push({
      name:     row.name,
      weight:   d ? d.weight : row.weight,
      reps:     d ? d.reps : row.reps,
      sets:     d ? d.sets : row.sets,
      video:    d ? d.video : row.video,
      emoji:    (d ? d.emoji : row.emoji) || '',
      category: row.category || null,
      rest_sec: d ? d.rest_sec : (row.rest_sec ?? null)
    });
  }
  return result;
}

// A rest length is kept only as whole seconds within [REST_SEC_MIN,
// REST_SEC_MAX]; anything else is stored as NULL, the app default. Coerced, not
// rejected: a PUT replaces the whole routine, and one bad field must not refuse
// every other exercise's save.
const REST_SEC_MIN = 5;
const REST_SEC_MAX = 900;
function normalizeRestSec(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= REST_SEC_MIN && n <= REST_SEC_MAX ? n : null;
}

// One exercise's six default fields, coerced the way both writers store them.
function normalizeExerciseDefaults(ex) {
  return {
    weight:   ex?.weight == null ? '' : String(ex.weight),
    reps:     ex?.reps == null ? '' : String(ex.reps),
    sets:     parseInt(ex?.sets, 10) || 3,
    rest_sec: normalizeRestSec(ex?.rest_sec),
    emoji:    ex?.emoji || '',
    video:    ex?.video || '',
  };
}

// A function declaration, not a const: setLifts runs during the first-boot
// routine seed, above this point in the file, where a const is still in its
// temporal dead zone.
function upsertExerciseDefaultsStmt() {
  return db.prepare(`
    INSERT INTO exercise_defaults (user_id, name, weight, reps, sets, rest_sec, emoji, video)
    VALUES (@user_id, @name, @weight, @reps, @sets, @rest_sec, @emoji, @video)
    ON CONFLICT(user_id, name) DO UPDATE SET
      weight = excluded.weight, reps = excluded.reps, sets = excluded.sets,
      rest_sec = excluded.rest_sec, emoji = excluded.emoji, video = excluded.video
  `);
}

// The six fields a routine row shares with its exercise_defaults row.
const EXERCISE_DEFAULT_FIELDS = ['weight', 'reps', 'sets', 'rest_sec', 'emoji', 'video'];

// Writes the named fields of an already-normalized `d` through to the
// exercise's defaults. Inserts the whole row when the exercise has none yet,
// so a field list never leaves the others missing.
function writeExerciseDefaultFields(userId, name, d, fields) {
  const exists = db.prepare('SELECT 1 FROM exercise_defaults WHERE user_id = ? AND name = ?').get(userId, name);
  if (!exists) {
    upsertExerciseDefaultsStmt().run({ user_id: userId, name, ...d });
    return;
  }
  const params = { user_id: userId, name };
  for (const f of fields) params[f] = d[f];
  db.prepare(`UPDATE exercise_defaults SET ${fields.map(f => `${f} = @${f}`).join(', ')} WHERE user_id = @user_id AND name = @name`).run(params);
}

// Writes rows through to their owner's exercise_defaults, so a routine PUT
// (an edit, an add, a finished session's weight write-back) moves the
// exercise's one set of defaults.
//
// ONLY WHAT THE SAVE CHANGED. A routine PUT sends every row, and a tab or
// device loaded before someone else's edit sends that edit's OLD values back
// with a mere reorder; written through whole, they would revert the edit in
// every routine. So a row may carry `changedDefaults`, the fields its client
// changed against the defaults it last knew (putRoutine in index.html), and
// only those are written. A row without it (an older client, an exercise the
// client had no defaults for) writes all six. Story:
// DECISIONS.md#exercise-defaults.
//
// `writeDefaults: false` is for a routine that is about to be archived (an
// import replaying an archived one): its stale rows must not overwrite a live
// routine's values, and the seed fills any name only it carries.
function setLifts(routineId, exercises, { writeDefaults = true } = {}) {
  const del = db.prepare('DELETE FROM exercises WHERE routine_id = ?');
  // `lift` is dead but NOT NULL with no default, so every row gets ''.
  const ins = db.prepare(
    'INSERT INTO exercises (lift, routine_id, position, name, weight, reps, sets, video, category, emoji, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const userId = db.prepare('SELECT user_id FROM routines WHERE id = ?').get(routineId)?.user_id;
  const upsert = upsertExerciseDefaultsStmt();
  db.transaction(() => {
    del.run(routineId);
    exercises.forEach((ex, i) => {
      const d = normalizeExerciseDefaults(ex);
      ins.run('', routineId, i, ex.name || '', d.weight, d.reps, d.sets, d.video, ex.category || null, d.emoji, d.rest_sec);
      const name = (ex.name || '').trim().toLowerCase();
      if (!writeDefaults || !name || userId == null) return;
      if (!Array.isArray(ex.changedDefaults)) { upsert.run({ user_id: userId, name, ...d }); return; }
      const changed = EXERCISE_DEFAULT_FIELDS.filter(f => ex.changedDefaults.includes(f));
      if (changed.length) writeExerciseDefaultFields(userId, name, d, changed);
    });
  })();
}

// { [lowercased name]: { weight, reps, sets, rest_sec, emoji, video } } for
// one user — every exercise they have defaults for, in a routine or not.
function getExerciseDefaults(userId) {
  const result = {};
  for (const row of db.prepare('SELECT * FROM exercise_defaults WHERE user_id = ?').all(userId)) {
    result[row.name] = { weight: row.weight, reps: row.reps, sets: row.sets, rest_sec: row.rest_sec, emoji: row.emoji, video: row.video };
  }
  return result;
}

// Replaces one exercise's whole defaults row, and mirrors it onto every row of
// that name in the user's routines (archived ones too, so un-archiving shows
// the same values). Returns the stored defaults.
function setExerciseDefaults(userId, name, fields) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  const d = normalizeExerciseDefaults(fields);
  db.transaction(() => {
    upsertExerciseDefaultsStmt().run({ user_id: userId, name: key, ...d });
    db.prepare(`
      UPDATE exercises SET weight = ?, reps = ?, sets = ?, rest_sec = ?, emoji = ?, video = ?
      WHERE lower(trim(name)) = ? AND routine_id IN (SELECT id FROM routines WHERE user_id = ?)
    `).run(d.weight, d.reps, d.sets, d.rest_sec, d.emoji, d.video, key, userId);
  })();
  return d;
}

// Every exercise name in ANY user's routines, deliberately unscoped: names and
// their tags are a shared library. Powers the Add Exercise autocomplete.
function getAllExerciseNames() {
  return db.prepare(
    'SELECT DISTINCT name FROM exercises WHERE routine_id IS NOT NULL ORDER BY name COLLATE NOCASE'
  ).all().map(r => r.name);
}

// ── Users ──────────────────────────────────────────────────────────────────────
// Ordered by id, so user 1 sorts first. RETURNS ARCHIVED USERS TOO, with the
// flag, like getRoutines(): the People card needs them to offer Un-archive, and
// the picker and bootWithUserGate filter them out in index.html. No ?all=1
// variant: GET /api/users is exempt from the /api gate, so its surface stays
// minimal.
function getUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}

// The /api gate's check, run on every request, hence a bare SELECT 1.
//
// DELIBERATELY IGNORES archived: it answers "was this id ever created", not
// "should it be offered". Honouring the flag would 400 every request from an
// archived user's open tab; that tab re-checks at its next load instead
// (bootWithUserGate). Story: DECISIONS.md#unknown-user-ids.
function userExists(id) {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
}

// POST /api/users. id comes from AUTOINCREMENT, so an archived user's id is
// never reused and nobody inherits their rows. Created active.
function createUser({ name, emoji }) {
  const result = db.prepare('INSERT INTO users (name, emoji) VALUES (?, ?)')
    .run((name || '').trim(), (emoji || '').trim() || '👤');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

// PATCH /api/users/:id: merges only the keys present, returns null for an
// unknown id so the route can 404. Validation, including refusing to archive
// user 1, is the route's job.
function updateUser(id, { name, emoji, archived }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare('UPDATE users SET name = ?, emoji = ?, archived = ? WHERE id = ?').run(
    name     !== undefined ? name  : existing.name,
    emoji    !== undefined ? emoji : existing.emoji,
    archived !== undefined ? (archived ? 1 : 0) : existing.archived,
    id
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Upsert by id: users is a global list, like activity_types. archived RIDES
// ALONG, or restoring would quietly un-archive someone; a backup with no
// archived key restores the user as active.
function restoreUser({ id, name, emoji, archived }) {
  if (id == null || !name) return;
  db.prepare(`
    INSERT INTO users (id, name, emoji, archived) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, emoji = excluded.emoji, archived = excluded.archived
  `).run(id, name, emoji || '👤', archived ? 1 : 0);
}

// ── Routines ───────────────────────────────────────────────────────────────────
// ALL of the user's routines, archived included, so past entries still
// resolve a name and emoji. Callers that need only loggable ones filter on
// archived.
function getRoutines(userId) {
  return db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY position').all(userId);
}

// position counts within this user's routines only.
function createRoutine({ name, emoji, target_per_week = null }, userId) {
  const maxPos = db.prepare('SELECT MAX(position) as p FROM routines WHERE user_id = ?').get(userId).p;
  const position = (maxPos ?? -1) + 1;
  const result = db.prepare('INSERT INTO routines (name, emoji, position, archived, user_id, target_per_week) VALUES (?, ?, ?, 0, ?, ?)')
    .run((name || '').trim() || 'New Routine', emoji || '🏋️', position, userId, target_per_week ?? null);
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(result.lastInsertRowid);
}

// target_per_week: undefined leaves it alone, null clears it.
function updateRoutine(id, { name, emoji, position, target_per_week }) {
  const existing = db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare('UPDATE routines SET name = ?, emoji = ?, position = ?, target_per_week = ? WHERE id = ?').run(
    name  !== undefined ? name  : existing.name,
    emoji !== undefined ? emoji : existing.emoji,
    position !== undefined ? position : existing.position,
    target_per_week !== undefined ? target_per_week : existing.target_per_week,
    id
  );
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id);
}

// Soft delete; the row is kept forever so past entries resolve its name. Also
// drops the routine from every plan dated today or later, re-packing each day
// through setPlanDay, and returns the dates whose plan changed.
//
// TODAY keeps one item per session of this routine already logged today (the
// same matching as planDoneFlags in index.html), so a finished session keeps
// its check. POST /api/import passes keepLoggedToday: false, since it recreates
// every routine under a new id; it relies on this clearing, then restores plans
// with remapped ids.
//
// day_schedule is never touched: it is a frozen record (see its comment).
function archiveRoutine(id, { keepLoggedToday = true } = {}) {
  const workout = `lift-${id}`;
  const today = isoDateStr();
  return db.transaction(() => {
    db.prepare('UPDATE routines SET archived = 1 WHERE id = ?').run(id);
    const days = db.prepare(
      'SELECT DISTINCT user_id, date FROM planned_workouts WHERE workout = ? AND date >= ?'
    ).all(workout, today);
    const changed = [];
    for (const { user_id, date } of days) {
      const list = db.prepare('SELECT workout FROM planned_workouts WHERE user_id = ? AND date = ? ORDER BY position')
        .all(user_id, date).map(r => r.workout);
      let keep = keepLoggedToday && date === today
        ? db.prepare("SELECT COUNT(*) AS n FROM history WHERE user_id = ? AND date = ? AND type = 'lift' AND lift = ?")
            .get(user_id, date, String(id)).n
        : 0;
      const kept = list.filter(w => w !== workout || keep-- > 0);
      if (kept.length === list.length) continue;
      setPlanDay(date, kept, user_id);
      changed.push(date);
    }
    return changed;
  })();
}

// ── Exercise Meta (category / notes / weightless / patterns / timed / unranked) ─
// Six of the seven name-keyed attributes share one exercise_meta row per name
// (see that table's comment). Each getter and setter keeps its per-attribute
// name and shape, so nothing outside db.js sees the shared storage.
//
// A row can exist for a DIFFERENT attribute, so each getter filters on its
// OWN column being set, never on the row existing. Each setter upserts only
// its own columns (ON CONFLICT DO UPDATE never touches an unnamed column),
// then calls pruneExerciseMetaIfEmpty, which deletes the row only once EVERY
// column is back to unset.

function upsertExerciseMetaColumns(key, columns) {
  const cols = Object.keys(columns);
  db.prepare(`
    INSERT INTO exercise_meta (name, ${cols.join(', ')})
    VALUES (?, ${cols.map(() => '?').join(', ')})
    ON CONFLICT(name) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(', ')}
  `).run(key, ...cols.map(c => columns[c]));
}

function pruneExerciseMetaIfEmpty(key) {
  db.prepare(`
    DELETE FROM exercise_meta
    WHERE name = ?
      AND category IS NULL AND how_to = '' AND mistakes = ''
      AND weightless = 0 AND hinge_knee IS NULL AND unilateral = 0 AND timed = 0
      AND laterality IS NULL AND unranked = 0
  `).run(key);
}

// Names are keyed trimmed and lowercased throughout this section. A category
// is never cleared through here, so no prune is needed.
function getExerciseCategoryOverrides() {
  const result = {};
  for (const row of db.prepare('SELECT name, category FROM exercise_meta WHERE category IS NOT NULL').all()) {
    result[row.name] = row.category;
  }
  return result;
}

function setExerciseCategoryOverride(name, category) {
  const key = (name || '').trim().toLowerCase();
  if (!key || !category) return;
  upsertExerciseMetaColumns(key, { category });
}

// Saving both fields blank IS how a note is cleared, so the getter filters on
// content.
function getExerciseFormNotes() {
  const result = {};
  for (const row of db.prepare(`SELECT name, how_to, mistakes FROM exercise_meta WHERE how_to != '' OR mistakes != ''`).all()) {
    result[row.name] = { how_to: row.how_to, mistakes: row.mistakes };
  }
  return result;
}

function setExerciseFormNote(name, how_to, mistakes) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  upsertExerciseMetaColumns(key, { how_to: how_to || '', mistakes: mistakes || '' });
  pruneExerciseMetaIfEmpty(key);
}

// The three boolean flags below (weightless, timed, unranked) return only the
// flagged names, so "off" and "never set" are one state.
function getExerciseWeightless() {
  const result = {};
  for (const row of db.prepare('SELECT name FROM exercise_meta WHERE weightless = 1').all()) {
    result[row.name] = true;
  }
  return result;
}

function setExerciseWeightless(name, weightless) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  upsertExerciseMetaColumns(key, { weightless: weightless ? 1 : 0 });
  pruneExerciseMetaIfEmpty(key);
}

function getExerciseTimed() {
  const result = {};
  for (const row of db.prepare('SELECT name FROM exercise_meta WHERE timed = 1').all()) {
    result[row.name] = true;
  }
  return result;
}

function setExerciseTimed(name, timed) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  upsertExerciseMetaColumns(key, { timed: timed ? 1 : 0 });
  pruneExerciseMetaIfEmpty(key);
}

function getExerciseUnranked() {
  const result = {};
  for (const row of db.prepare('SELECT name FROM exercise_meta WHERE unranked = 1').all()) {
    result[row.name] = true;
  }
  return result;
}

function setExerciseUnranked(name, unranked) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  upsertExerciseMetaColumns(key, { unranked: unranked ? 1 : 0 });
  pruneExerciseMetaIfEmpty(key);
}

// ── Exercise → muscle attribution ────────────────────────────────────────────────
// Keyed trimmed and lowercased; returned nested, { name: { muscle: fraction } }.
function getExerciseMuscles() {
  const result = {};
  for (const row of db.prepare('SELECT * FROM exercise_muscles').all()) {
    if (!result[row.name]) result[row.name] = {};
    result[row.name][row.muscle] = row.fraction;
  }
  return result;
}

// One exercise's { muscle: fraction } ({} when untagged). Takes an
// already-normalized key.
function getExerciseMusclesFor(nameKey) {
  const result = {};
  for (const row of db.prepare('SELECT muscle, fraction FROM exercise_muscles WHERE name = ?').all(nameKey)) {
    result[row.muscle] = row.fraction;
  }
  return result;
}

// Replaces one exercise's WHOLE map; drop a muscle by omitting it. A fraction
// <= 0 is skipped, so "not worked" and "never set" are one state.
function setExerciseMuscles(name, muscles) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  const del = db.prepare('DELETE FROM exercise_muscles WHERE name = ?');
  const ins = db.prepare('INSERT INTO exercise_muscles (name, muscle, fraction) VALUES (?, ?, ?)');
  db.transaction(() => {
    del.run(key);
    for (const [muscle, fraction] of Object.entries(muscles || {})) {
      const f = parseFloat(fraction);
      const m = (muscle || '').trim().toLowerCase();
      if (!m || !(f > 0)) continue;
      ins.run(key, m, f);
    }
  })();
}

// ── Exercise movement patterns ───────────────────────────────────────────────────
// Backed by exercise_meta, with the shared upsert/prune shape above.
function getExercisePatterns() {
  const result = {};
  const rows = db.prepare(`
    SELECT name, hinge_knee, laterality, unilateral FROM exercise_meta
    WHERE hinge_knee IS NOT NULL OR laterality IS NOT NULL OR unilateral = 1
  `).all();
  for (const row of rows) {
    result[row.name] = {
      hinge_knee: row.hinge_knee,
      laterality: row.laterality,
      // DERIVED from laterality, never read from the column, so there is one
      // source of truth. Still sent for readers of the old boolean.
      unilateral: row.laterality ? row.laterality === 'unilateral' : !!row.unilateral,
    };
  }
  return result;
}

// Both axes are independent and FOUR-state: NULL is "not reviewed", while
// 'neither' and 'bilateral' are real answers. Never collapse the two.
//
// laterality is the input. `unilateral` is read only when laterality is ABSENT
// (an old backup): true becomes 'unilateral', false stays NULL, never
// 'bilateral'. An explicit null clears. The boolean column is written in sync.
//
// The valid values are inlined, not module consts: the seed block above calls
// this at import time, before a const down here is initialized.
function setExercisePattern(name, { hinge_knee, laterality, unilateral }) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  const hk = (hinge_knee === 'hinge' || hinge_knee === 'knee' || hinge_knee === 'neither')
    ? hinge_knee : null;
  const lat = (laterality === 'bilateral' || laterality === 'independent' || laterality === 'unilateral')
    ? laterality
    : (laterality === undefined && unilateral ? 'unilateral' : null);
  upsertExerciseMetaColumns(key, {
    hinge_knee: hk,
    laterality: lat,
    unilateral: lat === 'unilateral' ? 1 : 0,
  });
  pruneExerciseMetaIfEmpty(key);
}

// ── Activity Types ───────────────────────────────────────────────────────────────
// Keys that are no longer activity types. Hidden on READ, not deleted: an old
// backup would restore a deleted row, while hiding here removes it from every
// picker, PUT /api/plans validation and the next export at once.
// Story: DECISIONS.md#drills-retired.
const RETIRED_ACTIVITY_TYPES = new Set(['drills']);

function getActivityTypes() {
  const result = {};
  for (const row of db.prepare('SELECT * FROM activity_types').all()) {
    if (RETIRED_ACTIVITY_TYPES.has(row.type_key)) continue;
    result[row.type_key] = { label: row.label, emoji: row.emoji, categorized: !!row.categorized };
  }
  return result;
}

// Insert-if-missing with a starting label and emoji, categorized=0. Called
// for every synced activity, so every synced type has a row.
function ensureActivityType(typeKey) {
  if (!typeKey) return;
  const existing = db.prepare('SELECT type_key FROM activity_types WHERE type_key = ?').get(typeKey);
  if (existing) return;
  db.prepare('INSERT INTO activity_types (type_key, label, emoji, categorized) VALUES (?, ?, ?, 0)')
    .run(typeKey, defaultActivityTypeLabel(typeKey), defaultActivityTypeEmoji(typeKey));
}

// Creates a type by hand, for a sport no watch recorded. Unlike
// ensureActivityType it lands categorized=1, and a collision returns null so
// the route can 409.
function createActivityType(typeKey, { label, emoji }) {
  if (!typeKey) return null;
  const existing = db.prepare('SELECT type_key FROM activity_types WHERE type_key = ?').get(typeKey);
  if (existing) return null;
  db.prepare('INSERT INTO activity_types (type_key, label, emoji, categorized) VALUES (?, ?, ?, 1)')
    .run(typeKey, label || typeKey, emoji || '🏅');
  return db.prepare('SELECT * FROM activity_types WHERE type_key = ?').get(typeKey);
}

function updateActivityType(typeKey, { label, emoji }) {
  const existing = db.prepare('SELECT * FROM activity_types WHERE type_key = ?').get(typeKey);
  if (!existing) return null;
  db.prepare('UPDATE activity_types SET label = ?, emoji = ?, categorized = 1 WHERE type_key = ?').run(
    label !== undefined ? label : existing.label,
    emoji !== undefined ? emoji : existing.emoji,
    typeKey
  );
  return db.prepare('SELECT * FROM activity_types WHERE type_key = ?').get(typeKey);
}

// POST /api/import only: a full upsert writing every field as given,
// categorized included.
function restoreActivityType({ type_key, label, emoji, categorized }) {
  if (!type_key) return;
  db.prepare(`
    INSERT INTO activity_types (type_key, label, emoji, categorized) VALUES (?, ?, ?, ?)
    ON CONFLICT(type_key) DO UPDATE SET label = excluded.label, emoji = excluded.emoji, categorized = excluded.categorized
  `).run(type_key, label || type_key, emoji || '🏅', categorized ? 1 : 0);
}

// ── Exercise Merge ───────────────────────────────────────────────────────────────
// Folds one exercise name into another everywhere: live routines, history,
// the name-keyed tags and goals. Every exercise identity in the frontend is
// derived live from the exact name, so a stray spelling splits PRs and trends
// until merged.
//
// It must carry ALL SEVEN name-keyed attributes (NAME_KEYED_EXERCISE_TABLES,
// which verify_backend.js checks this function against), PLUS
// goals.exercise_name (step 9), which is not in that list.
//
// CASE-ONLY DUPLICATES ("Pull Ups" vs "Pull ups") are mergeable, and four
// things make that work. Break any one and it stops working:
//   - getAllKnownExerciseNames() dedupes on the EXACT TRIMMED name, not a
//     lowercased one, or the two spellings collapse before you can pick them.
//   - findPossibleDuplicates() treats a Levenshtein distance of 0 as case-only
//     and unshifts it to the front of the hints.
//   - server.js and db.js compare names EXACTLY, never lowercased, before
//     rejecting a merge as a no-op — otherwise a case-only merge looks like
//     merging a name into itself and is refused.
//   - the caseOnly flag below skips every tag carry-then-clear (steps 4-8c),
//     which would otherwise clear the canonical's OWN tags (same row).
// verify_backend.js asserts the whole path.
//
// Merging does NOT reconcile logging conventions: if the two spellings were
// logged differently, the merged history keeps both. Do not "fix" the chart.
//
// When a routine ends up with two rows of the same name, the dedupe keeps one
// and carries the deleted row's `video` and `rest_sec` onto it if the keeper
// has none: both are hand-set with no copy in history. weight, reps, sets and
// emoji are defaults, not carried.
//
// userId scopes the per-user steps (1-3, 9 and 10) to the ACTING user. The shared
// tag steps (4-8c) always carry a value onto canonical, only filling a gap,
// but clear the alias's own tags only if isExerciseNameLiveElsewhere says no
// OTHER user still has that spelling in an active routine or in their history.
// Story: DECISIONS.md#case-only-merge, DECISIONS.md#exercise-form-notes,
// DECISIONS.md#cross-user-tag-wipe-on-merge.
function isExerciseNameLiveElsewhere(nameKey, excludingUserId) {
  const inRoutine = db.prepare(`
    SELECT 1 FROM exercises e
    JOIN routines r ON r.id = e.routine_id
    WHERE r.archived = 0 AND r.user_id != ? AND lower(trim(e.name)) = ?
    LIMIT 1
  `).get(excludingUserId, nameKey);
  if (inRoutine) return true;

  const otherHistory = db.prepare(`SELECT data FROM history WHERE type = 'lift' AND user_id != ?`).all(excludingUserId);
  for (const row of otherHistory) {
    if (!row.data) continue;
    let parsed;
    try { parsed = JSON.parse(row.data); } catch (e) { continue; }
    if (!Array.isArray(parsed.exercises)) continue;
    if (parsed.exercises.some(ex => (ex.name || '').trim().toLowerCase() === nameKey)) return true;
  }
  return false;
}

function mergeExerciseNames(canonical, alias, userId) {
  canonical = (canonical || '').trim();
  const aliasTrimmed = (alias || '').trim();
  const aliasKey     = aliasTrimmed.toLowerCase();
  const canonicalKey = canonical.toLowerCase();

  // Only an EXACT match is a no-op; a case-only difference is a real merge.
  if (!canonical || !aliasTrimmed || aliasTrimmed === canonical) {
    return { liveRenamed: [], historyCount: 0, dedupedCount: 0, categoryCarried: false, formNoteCarried: false, videoCarried: false, weightlessCarried: false, musclesCarried: false, patternCarried: false, timedCarried: false, unrankedCarried: false, defaultsCarried: false, goalsRenamed: 0 };
  }
  // Case-only: aliasKey === canonicalKey, so every lowercased lookup below
  // matches BOTH spellings, which is the rewrite wanted. The tag steps must
  // not then clear canonical's own tags, so they skip on caseOnly.
  const caseOnly = aliasKey === canonicalKey;

  const liveRenamed = [];
  let historyCount     = 0;
  let dedupedCount      = 0;
  let categoryCarried  = false;
  let formNoteCarried  = false;
  let videoCarried     = false;
  let weightlessCarried = false;
  let musclesCarried   = false;
  let patternCarried   = false;
  let timedCarried     = false;
  let unrankedCarried  = false;
  let defaultsCarried  = false;
  let goalsRenamed     = 0;

  db.transaction(() => {
    // 1. Live exercises in the user's ACTIVE routines: the dedupe and
    // liveRenamed only concern a routine you can still open.
    const aliasRows = db.prepare(`
      SELECT e.id, e.routine_id FROM exercises e
      JOIN routines r ON r.id = e.routine_id
      WHERE r.archived = 0 AND r.user_id = ? AND lower(trim(e.name)) = ?
    `).all(userId, aliasKey);

    // 1b. ARCHIVED routines are renamed too, with a plain UPDATE outside
    // step 2: getAllExerciseNames() reads them, so a skipped alias would come
    // back in the Add Exercise datalist and recreate the duplicate.
    db.prepare(`
      UPDATE exercises SET name = ?
      WHERE lower(trim(name)) = ? AND routine_id IN (
        SELECT id FROM routines WHERE archived = 1 AND user_id = ?
      )
    `).run(canonical, aliasKey, userId);

    const affectedRoutineIds = new Set();
    for (const row of aliasRows) {
      db.prepare('UPDATE exercises SET name = ? WHERE id = ?').run(canonical, row.id);
      affectedRoutineIds.add(row.routine_id);
    }

    // 2. Dedupe: a routine that already had canonical now has two rows. Keep
    // one (preferring one with a category), carry video and rest_sec onto it
    // if missing, delete the rest. Position gaps are fine.
    for (const routineId of affectedRoutineIds) {
      liveRenamed.push({ routineId });
      const dupes = db.prepare('SELECT * FROM exercises WHERE routine_id = ? AND lower(trim(name)) = ?')
        .all(routineId, canonicalKey);
      if (dupes.length > 1) {
        const keeper = dupes.find(r => r.category) || dupes[0];
        if (!keeper.video) {
          const withVideo = dupes.find(r => r.id !== keeper.id && r.video);
          if (withVideo) {
            db.prepare('UPDATE exercises SET video = ? WHERE id = ?').run(withVideo.video, keeper.id);
            videoCarried = true;
          }
        }
        if (keeper.rest_sec == null) {
          const withRest = dupes.find(r => r.id !== keeper.id && r.rest_sec != null);
          if (withRest) db.prepare('UPDATE exercises SET rest_sec = ? WHERE id = ?').run(withRest.rest_sec, keeper.id);
        }
        for (const r of dupes) {
          if (r.id !== keeper.id) {
            db.prepare('DELETE FROM exercises WHERE id = ?').run(r.id);
            dedupedCount++;
          }
        }
      }
    }

    // 3. History: rename embedded exercises[].name, writing back only rows
    // that changed.
    const historyRows = db.prepare(`SELECT id, data FROM history WHERE type = 'lift' AND user_id = ?`).all(userId);
    const updHistory   = db.prepare('UPDATE history SET data = ? WHERE id = ?');
    for (const row of historyRows) {
      if (!row.data) continue;
      let parsed;
      try { parsed = JSON.parse(row.data); } catch (e) { continue; }
      if (!Array.isArray(parsed.exercises)) continue;
      let changed = false;
      for (const ex of parsed.exercises) {
        if ((ex.name || '').trim().toLowerCase() === aliasKey) {
          ex.name = canonical;
          changed = true;
        }
      }
      if (changed) {
        updHistory.run(JSON.stringify(parsed), row.id);
        historyCount++;
      }
    }

    // Steps 4-8c carry one attribute each: copy the alias's value onto
    // canonical only if canonical has none, then clear ONLY that attribute's
    // columns on the alias (never a row DELETE, which would erase a sibling)
    // and prune. The clear is skipped when aliasLiveElsewhere.
    const aliasLiveElsewhere = isExerciseNameLiveElsewhere(aliasKey, userId);

    // 4. Category: canonical "has one" if it has an override OR a live
    // exercise under that name carries a category.
    const aliasOverride = caseOnly
      ? null
      : db.prepare('SELECT category FROM exercise_meta WHERE name = ? AND category IS NOT NULL').get(aliasKey);
    if (aliasOverride) {
      const canonicalOverride = db.prepare('SELECT category FROM exercise_meta WHERE name = ? AND category IS NOT NULL').get(canonicalKey);
      const canonicalLiveCategory = db.prepare(`
        SELECT e.category FROM exercises e
        JOIN routines r ON r.id = e.routine_id
        WHERE r.archived = 0 AND lower(trim(e.name)) = ? AND e.category IS NOT NULL
        LIMIT 1
      `).get(canonicalKey);
      if (!canonicalOverride && !canonicalLiveCategory) {
        setExerciseCategoryOverride(canonical, aliasOverride.category);
        categoryCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('UPDATE exercise_meta SET category = NULL WHERE name = ?').run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 5. Form notes.
    const aliasFormNote = caseOnly
      ? null
      : db.prepare(`SELECT how_to, mistakes FROM exercise_meta WHERE name = ? AND (how_to != '' OR mistakes != '')`).get(aliasKey);
    if (aliasFormNote) {
      const canonicalFormNote = db.prepare('SELECT how_to, mistakes FROM exercise_meta WHERE name = ?').get(canonicalKey);
      const canonicalHasNote = canonicalFormNote && ((canonicalFormNote.how_to || '').trim() || (canonicalFormNote.mistakes || '').trim());
      const aliasHasNote = (aliasFormNote.how_to || '').trim() || (aliasFormNote.mistakes || '').trim();
      if (!canonicalHasNote && aliasHasNote) {
        setExerciseFormNote(canonical, aliasFormNote.how_to, aliasFormNote.mistakes);
        formNoteCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare(`UPDATE exercise_meta SET how_to = '', mistakes = '' WHERE name = ?`).run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 6. Weightless.
    const aliasWeightless = caseOnly
      ? null
      : db.prepare('SELECT weightless FROM exercise_meta WHERE name = ? AND weightless = 1').get(aliasKey);
    if (aliasWeightless) {
      const canonicalWeightless = db.prepare('SELECT weightless FROM exercise_meta WHERE name = ? AND weightless = 1').get(canonicalKey);
      if (!canonicalWeightless) {
        setExerciseWeightless(canonical, true);
        weightlessCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('UPDATE exercise_meta SET weightless = 0 WHERE name = ?').run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 7. Muscles, carried as a WHOLE map: blending two maps would invent one
    // neither exercise was tagged with.
    const aliasMuscles = caseOnly ? null : getExerciseMusclesFor(aliasKey);
    if (aliasMuscles && Object.keys(aliasMuscles).length) {
      const canonicalMuscles = getExerciseMusclesFor(canonicalKey);
      if (!Object.keys(canonicalMuscles).length) {
        setExerciseMuscles(canonical, aliasMuscles);
        musclesCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('DELETE FROM exercise_muscles WHERE name = ?').run(aliasKey);
      }
    }

    // 8. Patterns: both axes move together, like step 7. The presence test
    // covers all THREE columns, since laterality alone is a real tag.
    const PATTERN_SET = '(hinge_knee IS NOT NULL OR laterality IS NOT NULL OR unilateral = 1)';
    const aliasPattern = caseOnly
      ? null
      : db.prepare(`SELECT hinge_knee, laterality, unilateral FROM exercise_meta WHERE name = ? AND ${PATTERN_SET}`).get(aliasKey);
    if (aliasPattern) {
      const canonicalPattern = db.prepare(`SELECT hinge_knee FROM exercise_meta WHERE name = ? AND ${PATTERN_SET}`).get(canonicalKey);
      if (!canonicalPattern) {
        setExercisePattern(canonical, {
          hinge_knee: aliasPattern.hinge_knee,
          laterality: aliasPattern.laterality,
          unilateral: aliasPattern.unilateral,
        });
        patternCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('UPDATE exercise_meta SET hinge_knee = NULL, laterality = NULL, unilateral = 0 WHERE name = ?').run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 8b. Timed. Dropping it would read the alias's seconds as reps.
    const aliasTimed = caseOnly
      ? null
      : db.prepare('SELECT timed FROM exercise_meta WHERE name = ? AND timed = 1').get(aliasKey);
    if (aliasTimed) {
      const canonicalTimed = db.prepare('SELECT timed FROM exercise_meta WHERE name = ? AND timed = 1').get(canonicalKey);
      if (!canonicalTimed) {
        setExerciseTimed(canonical, true);
        timedCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('UPDATE exercise_meta SET timed = 0 WHERE name = ?').run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 8c. Unranked.
    const aliasUnranked = caseOnly
      ? null
      : db.prepare('SELECT unranked FROM exercise_meta WHERE name = ? AND unranked = 1').get(aliasKey);
    if (aliasUnranked) {
      const canonicalUnranked = db.prepare('SELECT unranked FROM exercise_meta WHERE name = ? AND unranked = 1').get(canonicalKey);
      if (!canonicalUnranked) {
        setExerciseUnranked(canonical, true);
        unrankedCarried = true;
      }
      if (!aliasLiveElsewhere) {
        db.prepare('UPDATE exercise_meta SET unranked = 0 WHERE name = ?').run(aliasKey);
        pruneExerciseMetaIfEmpty(aliasKey);
      }
    }

    // 9. Goals: a goal left on the old spelling is orphaned, showing no
    // progress and never met. A plain rewrite, so no caseOnly skip is needed.
    goalsRenamed = db.prepare(
      'UPDATE goals SET exercise_name = ? WHERE lower(trim(exercise_name)) = ? AND user_id = ?'
    ).run(canonical, aliasKey, userId).changes;

    // 10. The acting user's exercise_defaults (per user, so no
    // aliasLiveElsewhere check). Canonical keeps its own row; the alias's only
    // fills a gap — the whole row when canonical has none, else a missing rest
    // or video, the two hand-set fields step 2 carries for the same reason.
    // The alias row then goes, or the next merge back would find it.
    const aliasDefaults = caseOnly
      ? null
      : db.prepare('SELECT * FROM exercise_defaults WHERE user_id = ? AND name = ?').get(userId, aliasKey);
    if (aliasDefaults) {
      const canonicalDefaults = db.prepare('SELECT * FROM exercise_defaults WHERE user_id = ? AND name = ?').get(userId, canonicalKey);
      if (!canonicalDefaults) {
        db.prepare('UPDATE exercise_defaults SET name = ? WHERE user_id = ? AND name = ?').run(canonicalKey, userId, aliasKey);
        defaultsCarried = true;
      } else {
        if (canonicalDefaults.rest_sec == null && aliasDefaults.rest_sec != null) {
          db.prepare('UPDATE exercise_defaults SET rest_sec = ? WHERE user_id = ? AND name = ?').run(aliasDefaults.rest_sec, userId, canonicalKey);
          defaultsCarried = true;
        }
        if (!canonicalDefaults.video && aliasDefaults.video) {
          db.prepare('UPDATE exercise_defaults SET video = ? WHERE user_id = ? AND name = ?').run(aliasDefaults.video, userId, canonicalKey);
          defaultsCarried = true;
        }
        db.prepare('DELETE FROM exercise_defaults WHERE user_id = ? AND name = ?').run(userId, aliasKey);
      }
    }
  })();

  return { liveRenamed, historyCount, dedupedCount, categoryCarried, formNoteCarried, videoCarried, weightlessCarried, musclesCarried, patternCarried, timedCarried, unrankedCarried, defaultsCarried, goalsRenamed };
}

// ── Day Schedule ───────────────────────────────────────────────────────────────
function getSchedule(userId) {
  const rows = db.prepare('SELECT * FROM day_schedule WHERE user_id = ?').all(userId);
  const result = {};
  for (const row of rows) {
    result[row.day_key] = { type: row.type, name: row.name, liftDay: row.lift_day };
  }
  return result;
}

// Retired table: only POST /api/import calls this. Upserts on the composite
// (day_key, user_id) key.
function setScheduleDay(dayKey, data, userId) {
  db.prepare(`
    INSERT INTO day_schedule (day_key, user_id, type, name, lift_day) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day_key, user_id) DO UPDATE SET
      type     = excluded.type,
      name     = excluded.name,
      lift_day = excluded.lift_day
  `).run(dayKey, userId, data.type, data.name, data.liftDay || null);
}

// ── Planned workouts ───────────────────────────────────────────────────────────
// Every planned day, as { [date]: [workout, ...] } in position order; small
// enough to ship whole.
function getPlans(userId) {
  const rows = db.prepare(
    'SELECT date, workout FROM planned_workouts WHERE user_id = ? ORDER BY date, position'
  ).all(userId);
  const result = {};
  for (const row of rows) (result[row.date] ||= []).push(row.workout);
  return result;
}

// REPLACES the day's whole list, so positions stay 0..n-1 and an empty list
// clears the day. Validation belongs to PUT /api/plans/:date; POST /api/import
// calls this directly, since a restore replays what was rather than making a
// new write (the same split as upsertCheckin).
function setPlanDay(date, workouts, userId) {
  const day = normalizeDateStr(date);
  db.transaction(() => {
    db.prepare('DELETE FROM planned_workouts WHERE user_id = ? AND date = ?').run(userId, day);
    const insert = db.prepare('INSERT INTO planned_workouts (user_id, date, position, workout) VALUES (?, ?, ?, ?)');
    workouts.forEach((workout, position) => insert.run(userId, day, position, workout));
  })();
}

// ── History ────────────────────────────────────────────────────────────────────
function getHistory(userId) {
  // Every history read maps through _rowToHistoryEntry, so all carry the same
  // columns.
  const rows = db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY timestamp DESC').all(userId);
  return rows.map(_rowToHistoryEntry);
}

// preserveSyncedAt is for RESTORING A BACKUP only (POST /api/import).
//
// userId is ALWAYS the caller-supplied owner. A record's own user_id (an
// exported row carries one) is IGNORED, or a hand-edited backup could claim
// rows for another user; it is destructured out so it never lands in `data`.
function addHistory(record, { preserveSyncedAt = false } = {}, userId) {
  const { date, timestamp, type, name, lift, rpe, note, id: _id, external_id, synced_at: suppliedSyncedAt, user_id: _user_id, ...rest } = record;
  // synced_at is derived here: now if the row has an external_id, else NULL.
  // A client-supplied value is never trusted, except on restore, which takes
  // the backup's value VERBATIM, null included. Never default it to now there:
  // many synced rows legitimately have a NULL synced_at, and stamping them
  // would make the whole backlog look freshly synced.
  const synced_at = external_id
    ? (preserveSyncedAt ? (suppliedSyncedAt ?? null) : Date.now())
    : null;
  const stmt = db.prepare(
    'INSERT INTO history (timestamp, date, type, name, lift, rpe, note, data, external_id, synced_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    timestamp   || Date.now(),
    normalizeDateStr(date) || isoDateStr(),
    type        || null,
    name        || null,
    lift        || null,
    rpe         || null,
    note        || null,
    JSON.stringify(rest),
    external_id || null,
    synced_at,
    userId
  );
  return result.lastInsertRowid;
}

// Whether THIS USER already has this external ID. Per user, like the unique
// index ("Deduping synced activities"); keep the two in step.
function hasExternalId(externalId, userId) {
  return !!db.prepare('SELECT id FROM history WHERE external_id = ? AND user_id = ?').get(externalId, userId);
}

// Ownership check for PATCH/DELETE /api/history/:id, as one indexed SELECT.
function historyBelongsToUser(id, userId) {
  return !!db.prepare('SELECT 1 FROM history WHERE id = ? AND user_id = ?').get(id, userId);
}

function _rowToHistoryEntry(row) {
  const extra = row.data ? JSON.parse(row.data) : {};
  // Real columns spread LAST, so a stale duplicate key inside the JSON blob
  // never shadows a column.
  return {
    ...extra,
    id: row.id, timestamp: row.timestamp, date: row.date, type: row.type,
    name: row.name, lift: row.lift, rpe: row.rpe, note: row.note,
    external_id: row.external_id, synced_at: row.synced_at, user_id: row.user_id,
  };
}

// The user's manual entries on this date and type: dedup candidates for a
// synced activity.
function findManualCandidates(date, type, userId) {
  return db.prepare('SELECT * FROM history WHERE date = ? AND type = ? AND external_id IS NULL AND user_id = ?')
    .all(date, type, userId).map(_rowToHistoryEntry);
}

// Every synced entry for the user, for scanning existing history for
// duplicate pairs.
function getGarminHistory(userId) {
  return db.prepare('SELECT * FROM history WHERE external_id IS NOT NULL AND user_id = ?').all(userId).map(_rowToHistoryEntry);
}

// Picks the manual candidate that is almost certainly the same activity as a
// synced one, or null. Conservative on purpose:
//   - a single same-day, same-type candidate is treated as a match unless
//     both sides have a distance and it disagrees by more than 15%
//   - with multiple candidates, only a distance-proximity match resolves the
//     ambiguity; otherwise no merge happens (both entries are left in place)
//   - before either, a candidate must be TIME-compatible (see below)
const DISTANCE_TOLERANCE = 0.15;

// A manual row's timestamp is when it was SAVED; a synced one's is when the
// session STARTED. A manual row is the same session only if saved between a
// little before the start and a few hours after the end; otherwise it is a
// separate session, and merging would delete it. Story: DECISIONS.md#drills-retired.
//
// Every doubtful case keeps both rows: a duplicate can be deleted, a merged-
// away session cannot be recovered. A missing timestamp skips the check.
const SAVED_BEFORE_START_MS = 2 * 3600 * 1000;
const SAVED_AFTER_END_MS    = 4 * 3600 * 1000;

// Seconds from a stored duration: 'H:MM:SS' / 'M:SS' (what the syncs send),
// or a manual entry's bare minutes, as a number or a numeric string. 0 when
// unreadable, which here only narrows the window by the session's own length.
// The one parser for the field: server.js's weather window reads it too.
function durationSec(d) {
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? d * 60 : 0;
  if (typeof d !== 'string') return 0;
  const t = d.trim();
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60;
  return 0;
}

function timeCompatible(candidate, activity) {
  const saved = Number(candidate.timestamp), start = Number(activity.timestamp);
  if (!(saved > 0) || !(start > 0)) return true;
  const end = start + durationSec(activity.duration) * 1000;
  return saved >= start - SAVED_BEFORE_START_MS && saved <= end + SAVED_AFTER_END_MS;
}

function findLikelyDuplicate(allCandidates, activity) {
  const candidates = allCandidates.filter(c => timeCompatible(c, activity));
  if (!candidates.length) return null;
  const distanceMatches = c =>
    activity.distance == null || c.distance == null ||
    Math.abs(c.distance - activity.distance) / activity.distance <= DISTANCE_TOLERANCE;

  if (candidates.length === 1) {
    return distanceMatches(candidates[0]) ? candidates[0] : null;
  }
  const withDistance = candidates.filter(c => c.distance != null);
  if (activity.distance != null && withDistance.length) {
    return withDistance.find(distanceMatches) || null;
  }
  return null; // ambiguous — don't guess which of several candidates it is
}

// Backs a PATCH, so it MERGES against the stored row: an omitted key means
// "leave it alone", and clearing a field means sending it as null. `rest` is
// merged over the stored extras for the same reason.
//
// external_id, synced_at and user_id are dropped: an edit never changes sync
// linkage or owner, and they must not be baked into the JSON blob.
function updateHistory(id, record) {
  const existing = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
  if (!existing) return;
  const { date, timestamp, type, name, lift, rpe, note, id: _id, external_id: _external_id, synced_at: _synced_at, user_id: _user_id, ...rest } = record;
  const existingExtras = existing.data ? JSON.parse(existing.data) : {};
  const pick = (supplied, stored) => (supplied !== undefined ? supplied : stored);
  db.prepare(`
    UPDATE history SET date=?, timestamp=?, type=?, name=?, lift=?, rpe=?, note=?, data=?
    WHERE id=?
  `).run(
    date      || existing.date,
    timestamp || existing.timestamp,
    pick(type, existing.type)   || null,
    pick(name, existing.name)   || null,
    pick(lift, existing.lift)   || null,
    pick(rpe,  existing.rpe)    ?? null,
    pick(note, existing.note)   || null,
    JSON.stringify({ ...existingExtras, ...rest }),
    id
  );
}

// Writes a synced activity's DEVICE-ONLY fields (bestEfforts, training load,
// training effect) onto an existing row. Only the keys in `fields` change; the
// typed note, RPE and title are never touched. Writes only on a real change,
// and returns whether it wrote.
function _writeDeviceFields(row, fields) {
  const keys = Object.keys(fields || {});
  if (!row || !keys.length) return false;
  const extras = row.data ? JSON.parse(row.data) : {};
  if (keys.every(k => JSON.stringify(extras[k] ?? null) === JSON.stringify(fields[k]))) return false;
  db.prepare('UPDATE history SET data = ? WHERE id = ?').run(JSON.stringify({ ...extras, ...fields }), row.id);
  return true;
}

// The sync's already-logged arm: the row that carries this external id.
function refreshDeviceFields(externalId, userId, fields) {
  return _writeDeviceFields(
    db.prepare('SELECT id, data FROM history WHERE external_id = ? AND user_id = ?').get(externalId, userId), fields);
}

// The sync's manual-wins arm: the kept MANUAL row (no external_id), matched
// again on every sync that still fetches its watch twin. It is deliberately
// not tagged with the twin's external_id, which would turn a manual lift or
// climb into a synced row (the "to fill in" queue, the duplicate scan).
function addDeviceFieldsToManual(id, userId, fields) {
  return _writeDeviceFields(
    db.prepare('SELECT id, data FROM history WHERE id = ? AND user_id = ? AND external_id IS NULL').get(id, userId), fields);
}

function deleteHistory(id) {
  db.prepare('DELETE FROM history WHERE id = ?').run(id);
}

// A restore's "replace history" wipes only the restoring user's history.
function clearHistory(userId) {
  db.prepare('DELETE FROM history WHERE user_id = ?').run(userId);
}

// ── Body Weight ────────────────────────────────────────────────────────────────
function getBodyWeight(userId) {
  return db.prepare('SELECT * FROM body_weight WHERE user_id = ? ORDER BY timestamp DESC').all(userId);
}

// Upserts on the composite (date, user_id) unique constraint.
function addBodyWeight(timestamp, date, weightKg, userId) {
  date = normalizeDateStr(date);
  db.prepare(`
    INSERT INTO body_weight (timestamp, date, weight_kg, user_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(date, user_id) DO UPDATE SET weight_kg = excluded.weight_kg, timestamp = excluded.timestamp
  `).run(timestamp, date, weightKg, userId);
}

// Keyed by (date, userId), the only handle the UI has. Returns { changes } so
// the route can 404 on an empty day.
function deleteBodyWeight(date, userId) {
  const info = db.prepare('DELETE FROM body_weight WHERE date = ? AND user_id = ?').run(date, userId);
  return { changes: info.changes };
}

// ── Check-ins (morning / evening) ───────────────────────────────────────────────
// The four JSON columns are handed to callers parsed. A malformed value, or
// one of the wrong shape, degrades to that column's empty shape rather than
// throwing, so one bad row cannot break the list.
//
// The shapes differ: morning_fasts is an ARRAY (display order), the other
// three are OBJECTS, so the empty default and the shape check are per column.
// parseCheckinFlags covers the fast columns too, despite its name.
const CHECKIN_JSON_COLUMNS = {
  morning_flags: 'object', evening_flags: 'object',
  morning_fasts: 'array',  evening_fasts: 'object',
};
function parseCheckinFlags(row) {
  if (!row) return row;
  const parsed = { ...row };
  for (const [col, shape] of Object.entries(CHECKIN_JSON_COLUMNS)) {
    const empty = () => (shape === 'array' ? [] : {});
    let val = empty();
    if (row[col]) {
      try {
        const p = JSON.parse(row[col]);
        const rightShape = shape === 'array'
          ? Array.isArray(p)
          : (!!p && typeof p === 'object' && !Array.isArray(p));
        val = rightShape ? p : empty();
      } catch (e) { val = empty(); }
    }
    parsed[col] = val;
  }
  return parsed;
}

function getCheckins(userId) {
  return db.prepare('SELECT * FROM checkins WHERE user_id = ? ORDER BY date DESC').all(userId).map(parseCheckinFlags);
}

function getCheckin(date, userId) {
  const row = db.prepare('SELECT * FROM checkins WHERE date = ? AND user_id = ?').get(date, userId);
  return row ? parseCheckinFlags(row) : null;
}

// Partial upsert: only the keys in `fields` change, so a morning save never
// wipes the evening (or vice versa). Upserts on (date, user_id).
function upsertCheckin(date, fields, userId) {
  date = normalizeDateStr(date);
  const existing = getCheckin(date, userId) || {};
  const merged = { ...existing, ...fields, date };
  db.prepare(`
    INSERT INTO checkins (date, user_id, morning_sleep, morning_feeling, morning_planned_type, morning_timestamp, morning_sick,
                           morning_flags,
                           evening_energy, evening_feeling, evening_eating, evening_journal, evening_timestamp, evening_sick,
                           evening_flags, garmin_sleep_score, garmin_sleep_qualifier, day_journal,
                           morning_fasts, evening_fasts, morning_prayer)
    VALUES (@date, @user_id, @morning_sleep, @morning_feeling, @morning_planned_type, @morning_timestamp, @morning_sick,
            @morning_flags,
            @evening_energy, @evening_feeling, @evening_eating, @evening_journal, @evening_timestamp, @evening_sick,
            @evening_flags, @garmin_sleep_score, @garmin_sleep_qualifier, @day_journal,
            @morning_fasts, @evening_fasts, @morning_prayer)
    ON CONFLICT(date, user_id) DO UPDATE SET
      morning_sleep          = excluded.morning_sleep,
      morning_feeling        = excluded.morning_feeling,
      morning_planned_type   = excluded.morning_planned_type,
      morning_timestamp      = excluded.morning_timestamp,
      morning_sick           = excluded.morning_sick,
      morning_flags          = excluded.morning_flags,
      evening_energy         = excluded.evening_energy,
      evening_feeling        = excluded.evening_feeling,
      evening_eating         = excluded.evening_eating,
      evening_journal        = excluded.evening_journal,
      evening_timestamp      = excluded.evening_timestamp,
      evening_sick           = excluded.evening_sick,
      evening_flags          = excluded.evening_flags,
      garmin_sleep_score     = excluded.garmin_sleep_score,
      garmin_sleep_qualifier = excluded.garmin_sleep_qualifier,
      day_journal             = excluded.day_journal,
      morning_fasts           = excluded.morning_fasts,
      evening_fasts           = excluded.evening_fasts,
      morning_prayer          = excluded.morning_prayer
  `).run({
    date,
    user_id: userId,
    morning_sleep:          merged.morning_sleep          ?? null,
    morning_feeling:        merged.morning_feeling        ?? null,
    morning_planned_type:   merged.morning_planned_type   ?? null,
    morning_timestamp:      merged.morning_timestamp      ?? null,
    morning_sick:           merged.morning_sick           ?? null,
    morning_flags:          serializeFlags(merged.morning_flags),
    evening_energy:         merged.evening_energy         ?? null,
    evening_feeling:        merged.evening_feeling        ?? null,
    evening_eating:      merged.evening_eating      ?? null,
    evening_journal:     merged.evening_journal     ?? null,
    evening_timestamp:   merged.evening_timestamp   ?? null,
    evening_sick:           merged.evening_sick           ?? null,
    // The JSON columns accept an object (API) or an already-serialized string
    // (a restore replaying a raw exported row).
    evening_flags:          serializeFlags(merged.evening_flags),
    garmin_sleep_score:     merged.garmin_sleep_score     ?? null,
    garmin_sleep_qualifier: merged.garmin_sleep_qualifier ?? null,
    day_journal:            merged.day_journal            ?? null,
    morning_fasts:          serializeJsonColumn(merged.morning_fasts),
    evening_fasts:          serializeJsonColumn(merged.evening_fasts),
    morning_prayer:         merged.morning_prayer         ?? null,
  });
  return getCheckin(date, userId);
}

// Keyed by (date, userId), with the date normalized like every write. Returns
// { changes } so the route can 404.
//
// DOES NOT CASCADE injury_checkins: those are follow-ups about an injury, not
// children of a check-in.
function deleteCheckin(date, userId) {
  date = normalizeDateStr(date);
  const info = db.prepare('DELETE FROM checkins WHERE date = ? AND user_id = ?').run(date, userId);
  return { changes: info.changes };
}

// ── garmin_daily: what the watch measured, never what the user said ─────────
// No delete: a measurement is never written "by mistake"; a re-sync would
// write it again.

const GARMIN_DAILY_COLUMNS = ['resting_hr', 'hrv_overnight', 'hrv_status', 'steps',
  'body_battery_high', 'body_battery_low', 'readiness_score', 'readiness_level',
  'stress_avg', 'vo2max', 'load_acute', 'load_chronic', 'load_optimal_min',
  'load_optimal_max', 'training_status', 'focus_low_aerobic', 'focus_high_aerobic',
  'focus_anaerobic', 'focus_low_aerobic_min', 'focus_low_aerobic_max',
  'focus_high_aerobic_min', 'focus_high_aerobic_max', 'focus_anaerobic_min',
  'focus_anaerobic_max', 'focus_feedback', 'resp_rate', 'sleep_minutes', 'skin_temp_dev',
  'calories_total', 'calories_active'];

function getGarminDaily(userId) {
  return db.prepare('SELECT * FROM garmin_daily WHERE user_id = ? ORDER BY date DESC').all(userId);
}

function getGarminDailyDay(date, userId) {
  return db.prepare('SELECT * FROM garmin_daily WHERE date = ? AND user_id = ?')
    .get(normalizeDateStr(date), userId) || null;
}

// Partial upsert, like upsertCheckin: a key absent from `fields` keeps its
// stored value, since Garmin may answer with some metrics missing. That is the
// whole of "a null never erases a stored value", so the caller must NOT
// pre-fill missing metrics with null (POST /api/garmin/sync builds its fields
// conditionally for this).
function upsertGarminDaily(date, fields, userId) {
  date = normalizeDateStr(date);
  const existing = getGarminDailyDay(date, userId) || {};
  const merged = { ...existing, ...fields, date };
  const params = { date, user_id: userId };
  for (const col of GARMIN_DAILY_COLUMNS) params[col] = merged[col] ?? null;
  db.prepare(`
    INSERT INTO garmin_daily (date, user_id, ${GARMIN_DAILY_COLUMNS.join(', ')})
    VALUES (@date, @user_id, ${GARMIN_DAILY_COLUMNS.map(c => '@' + c).join(', ')})
    ON CONFLICT(date, user_id) DO UPDATE SET
      ${GARMIN_DAILY_COLUMNS.map(c => `${c} = excluded.${c}`).join(',\n      ')}
  `).run(params);
  return getGarminDailyDay(date, userId);
}

// A restore is the upsert: (user_id, date) is a natural key, so it converges.
function restoreGarminDaily(row, userId) {
  if (!row || !row.date) return null;
  const fields = {};
  for (const col of GARMIN_DAILY_COLUMNS) {
    if (row[col] !== undefined) fields[col] = row[col];
  }
  return upsertGarminDaily(row.date, fields, userId);
}

// ── activity_routes: where a synced activity happened ──────────────────────
// No delete, for the same reason as garmin_daily.

// Types that never carry a route, as a DENY-list like the frontend's
// NON_DISTANCE_TYPES: the loggable set is open, so an allow-list would exclude
// every new sport. Story: DECISIONS.md#any-activity-is-first-class.
const NON_ROUTE_TYPES = ['lift', 'climb', 'rest'];

// Joined to history, which scopes by user and supplies the date and type the
// map filters on. `profile` adds elev and hr, which only the JSON backup and
// the single-route read need: the Map tab never draws them, and they would
// grow its payload by about half.
function getActivityRoutes(userId, { profile = false } = {}) {
  return db.prepare(`
    SELECT r.external_id, r.polyline, r.point_count, r.bounds, r.breaks, r.times,
           ${profile ? 'r.elev, r.hr,' : ''}
           h.id AS history_id, h.date, h.type
    FROM activity_routes r
    JOIN history h ON h.external_id = r.external_id AND h.user_id = r.user_id
    WHERE r.user_id = ?
    ORDER BY h.timestamp DESC
  `).all(userId).map(r => parseRouteRow(r, profile));
}

function parseRouteRow(r, profile) {
  const out = { ...r, bounds: JSON.parse(r.bounds), breaks: parseRouteBreaks(r.breaks),
                times: parseRouteBreaks(r.times) };
  if (profile) {
    out.elev = parseRouteSeries(r.elev);
    out.hr = parseRouteSeries(r.hr);
  }
  return out;
}

// One outing, for its summary: every column, joined to history like the bulk
// read so another user's external_id is simply not found.
function getActivityRouteWithProfile(externalId, userId) {
  const r = db.prepare(`
    SELECT r.external_id, r.polyline, r.point_count, r.bounds, r.breaks, r.times, r.elev, r.hr,
           h.id AS history_id, h.date, h.type
    FROM activity_routes r
    JOIN history h ON h.external_id = r.external_id AND h.user_id = r.user_id
    WHERE r.user_id = ? AND r.external_id = ?
    LIMIT 1
  `).get(userId, String(externalId));
  return r ? parseRouteRow(r, true) : null;
}

// elev and hr: like parseRouteBreaks, but an entry may be null (no reading
// there) and need not be an integer.
function parseRouteSeries(v) {
  if (v == null) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.every(x => x === null || Number.isFinite(x)) ? a : null;
  } catch (e) {
    return null;
  }
}

// NULL stays null ("not checked"), and so does anything unreadable: a bad
// value costs that route its breaks, never the whole response. Also reads
// times, which have the same shape: a JSON array of integers.
function parseRouteBreaks(v) {
  if (v == null) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.every(Number.isInteger) ? a : null;
  } catch (e) {
    return null;
  }
}

// The route work queue, so garmin_sync.py tracks nothing itself.
//
// The LIMIT IS REQUIRED: an uncapped backlog would burst Garmin with requests
// and get rate limited. Capped, it drains over a few nights; the backfill
// script is there for anyone who does not want to wait.
//
// Missing routes come FIRST, then routes not yet checked for pauses (breaks IS
// NULL) or fetched before per-point times, elevation or heart rate were kept
// (times / elev / hr IS NULL), each newest-first. An activity recorded in activity_route_misses is never
// offered again: Garmin already said it has no track.
//
// GARMIN IDS ONLY (all digits): Apple rows carry an external_id too, and
// history has no source column, so without the filter every Apple workout
// would be sent to Garmin's API.
function getRoutelessActivityIds(userId, limit) {
  const placeholders = NON_ROUTE_TYPES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT h.external_id, h.type, h.date
    FROM history h
    LEFT JOIN activity_routes r
      ON r.user_id = h.user_id AND r.external_id = h.external_id
    WHERE h.user_id = ?
      AND h.external_id IS NOT NULL
      AND h.external_id <> ''
      AND h.external_id NOT GLOB '*[^0-9]*'
      AND h.type NOT IN (${placeholders})
      AND (r.external_id IS NULL OR r.breaks IS NULL OR r.times IS NULL
           OR r.elev IS NULL OR r.hr IS NULL)
      AND NOT EXISTS (SELECT 1 FROM activity_route_misses m
                      WHERE m.user_id = h.user_id AND m.external_id = h.external_id)
    ORDER BY (r.external_id IS NOT NULL), h.timestamp DESC
    LIMIT ?
  `).all(userId, ...NON_ROUTE_TYPES, limit);
}

// Records activities Garmin answered with no track. INSERT OR IGNORE keeps the
// first checked_at, and a repeat is a no-op. Returns how many ids were given,
// not how many were new: the caller only reports it.
function markRoutesMissing(externalIds, userId, now = Date.now()) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO activity_route_misses (user_id, external_id, checked_at)
                           VALUES (?, ?, ?)`);
  db.transaction(ids => { for (const id of ids) stmt.run(userId, String(id), now); })(externalIds);
  return externalIds.length;
}

function getActivityRoute(externalId, userId) {
  return db.prepare('SELECT * FROM activity_routes WHERE user_id = ? AND external_id = ?')
    .get(userId, String(externalId)) || null;
}

// A whole-row replace, not a merge: one fetch produces every column. A row
// given no breaks, times, elev or hr stores NULL even over checked ones, since
// the old values describe a different polyline.
function upsertActivityRoute(row, userId) {
  const externalId = String(row.external_id);
  const asJson = v => (Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'string' ? v : null));
  const breaks = asJson(row.breaks), times = asJson(row.times);
  const elev = asJson(row.elev), hr = asJson(row.hr);
  db.prepare(`
    INSERT INTO activity_routes (user_id, external_id, polyline, point_count, bounds, fetched_at, breaks, times, elev, hr)
    VALUES (@user_id, @external_id, @polyline, @point_count, @bounds, @fetched_at, @breaks, @times, @elev, @hr)
    ON CONFLICT(user_id, external_id) DO UPDATE SET
      polyline    = excluded.polyline,
      point_count = excluded.point_count,
      bounds      = excluded.bounds,
      fetched_at  = excluded.fetched_at,
      breaks      = excluded.breaks,
      times       = excluded.times,
      elev        = excluded.elev,
      hr          = excluded.hr
  `).run({
    breaks,
    times,
    elev,
    hr,
    user_id: userId,
    external_id: externalId,
    polyline: row.polyline,
    point_count: row.point_count,
    bounds: typeof row.bounds === 'string' ? row.bounds : JSON.stringify(row.bounds),
    fetched_at: Number.isFinite(row.fetched_at) ? row.fetched_at : Date.now(),
  });
  return getActivityRoute(externalId, userId);
}

// A restore is the upsert (natural key), forced to the restoring user.
// A row missing a NOT NULL column is SKIPPED: the insert would throw inside the
// import transaction and roll back the whole restore. A shape check only, not
// today's validation rules.
function restoreActivityRoute(row, userId) {
  if (!row || !row.external_id || !row.polyline) return null;
  if (!Array.isArray(row.bounds) && typeof row.bounds !== 'string') return null;
  if (!Number.isFinite(row.point_count)) return null;
  return upsertActivityRoute(row, userId);
}

// ── activity_weather: Open-Meteo's answer per routed activity ──────────────
// server.js is the only writer (fillActivityWeather); nothing here fetches.
const ACTIVITY_WEATHER_COLUMNS = ['temp_c', 'feels_like_c', 'humidity_pct', 'dew_point_c', 'wind_kmh',
  'gust_kmh', 'precip_mm', 'precip_max_mmh', 'snow_cm', 'weather_code'];

// Keyed by external_id, the one handle the client joins history on. Not
// joined to history here: a row for a deleted activity is inert, since no
// entry is left to look it up.
function getActivityWeather(userId) {
  const out = {};
  for (const r of db.prepare(`SELECT external_id, ${ACTIVITY_WEATHER_COLUMNS.join(', ')}
                              FROM activity_weather WHERE user_id = ?`).all(userId)) {
    const { external_id, ...rest } = r;
    out[external_id] = rest;
  }
  return out;
}

// The fill queue, across EVERY user: the fill is a server job, not a request
// on anyone's behalf. Newest first, so a fresh sync's activity is tagged
// before the backlog. One row per (user, activity) even if a restore
// duplicated the history row. duration comes out of history's data blob;
// times is the route's own clock, which the caller prefers when it has one.
//
// Two kinds of entry: an activity with no weather row, and a PROVISIONAL row
// (see the table comment) whose activity is now more than WEATHER_SETTLE_MS
// old. `refetch` tells the caller which, so a refetch that comes back empty
// never overwrites real numbers with nulls.
const WEATHER_SETTLE_MS = 24 * 60 * 60 * 1000;
function getWeatherlessActivities(limit, now = Date.now()) {
  return db.prepare(`
    SELECT h.user_id, h.external_id, MAX(h.timestamp) AS timestamp, h.data, r.polyline, r.times,
           w.external_id IS NOT NULL AS refetch
    FROM history h
    JOIN activity_routes r ON r.user_id = h.user_id AND r.external_id = h.external_id
    LEFT JOIN activity_weather w ON w.user_id = h.user_id AND w.external_id = h.external_id
    WHERE w.external_id IS NULL
       OR (w.fetched_at < h.timestamp + @settle AND h.timestamp + @settle <= @now)
    GROUP BY h.user_id, h.external_id
    ORDER BY timestamp DESC
    LIMIT @limit
  `).all({ limit, now, settle: WEATHER_SETTLE_MS }).map(r => {
    let duration = null;
    try { duration = (JSON.parse(r.data || '{}') || {}).duration ?? null; } catch (e) { /* no duration */ }
    return { user_id: r.user_id, external_id: r.external_id, timestamp: r.timestamp,
             duration, polyline: r.polyline, times: parseRouteBreaks(r.times), refetch: !!r.refetch };
  });
}

// A provisional row's recheck that Open-Meteo answered with nothing: keep the
// numbers it had and mark it final, so it isn't asked again on every pass.
function settleActivityWeather(userId, externalId, now = Date.now()) {
  db.prepare('UPDATE activity_weather SET fetched_at = ? WHERE user_id = ? AND external_id = ?')
    .run(now, userId, String(externalId));
}

// A whole-row replace: one fetch produces every column.
function upsertActivityWeather(row, userId) {
  const num = v => (Number.isFinite(v) ? v : null);
  const vals = Object.fromEntries(ACTIVITY_WEATHER_COLUMNS.map(c => [c, num(row[c])]));
  if (vals.weather_code != null) vals.weather_code = Math.round(vals.weather_code);
  db.prepare(`
    INSERT INTO activity_weather (user_id, external_id, lat, lon, ${ACTIVITY_WEATHER_COLUMNS.join(', ')}, fetched_at)
    VALUES (@user_id, @external_id, @lat, @lon, ${ACTIVITY_WEATHER_COLUMNS.map(c => '@' + c).join(', ')}, @fetched_at)
    ON CONFLICT(user_id, external_id) DO UPDATE SET
      lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at,
      ${ACTIVITY_WEATHER_COLUMNS.map(c => `${c} = excluded.${c}`).join(', ')}
  `).run({ ...vals, user_id: userId, external_id: String(row.external_id), lat: row.lat, lon: row.lon,
           fetched_at: Number.isFinite(row.fetched_at) ? row.fetched_at : Date.now() });
}

// ── route_segments: stretches timed on every outing that covers them ───────
// Per-user list; ownership is checked in server.js, validation there too.
function getRouteSegments(userId) {
  return db.prepare('SELECT * FROM route_segments WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC')
    .all(userId);
}

function getRouteSegment(id) {
  return db.prepare('SELECT * FROM route_segments WHERE id = ?').get(id) || null;
}

// The clash check the API answers 409 with, before the UNIQUE constraint
// would throw. exceptId lets a rename keep its own name in a new case.
function routeSegmentNameTaken(userId, name, exceptId = null) {
  return !!db.prepare('SELECT 1 FROM route_segments WHERE user_id = ? AND name = ? AND id IS NOT ?')
    .get(userId, name, exceptId);
}

function createRouteSegment({ name, type, polyline, length_m }, userId) {
  const result = db.prepare(`
    INSERT INTO route_segments (user_id, name, type, polyline, length_m, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, name, type, polyline, length_m, Date.now());
  return getRouteSegment(result.lastInsertRowid);
}

// A rename, a moved stretch, or both; undefined leaves a column alone. The
// caller validates, and computes length_m from the polyline it passes.
function updateRouteSegment(id, { name, polyline, length_m }) {
  const cur = getRouteSegment(id);
  if (!cur) return null;
  db.prepare('UPDATE route_segments SET name = ?, polyline = ?, length_m = ? WHERE id = ?').run(
    name !== undefined ? name : cur.name,
    polyline !== undefined ? polyline : cur.polyline,
    polyline !== undefined ? length_m : cur.length_m, id);
  return getRouteSegment(id);
}

function deleteRouteSegment(id) {
  db.prepare('DELETE FROM route_segments WHERE id = ?').run(id);
}

// POST /api/import only: an upsert on the natural key (user_id, name), so a
// replay converges. A row missing a NOT NULL column is SKIPPED rather than
// thrown, which would roll back the whole import. A shape check, not the
// API's validation, as for restoreActivityRoute.
function restoreRouteSegment(row, userId) {
  if (!row || typeof row.name !== 'string' || !row.name.trim()) return false;
  if (typeof row.type !== 'string' || !row.type || typeof row.polyline !== 'string' || !row.polyline) return false;
  if (!Number.isFinite(row.length_m)) return false;
  db.prepare(`
    INSERT INTO route_segments (user_id, name, type, polyline, length_m, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      type = excluded.type, polyline = excluded.polyline, length_m = excluded.length_m
  `).run(userId, row.name.trim(), row.type, row.polyline, row.length_m,
    Number.isFinite(row.created_at) ? row.created_at : Date.now());
  return true;
}

// For morning_flags and evening_flags.
function serializeFlags(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val || null;
  if (typeof val === 'object') {
    // Only set flags are stored, so "off" and "never existed" are one state.
    const on = Object.fromEntries(Object.entries(val).filter(([, v]) => !!v));
    return Object.keys(on).length ? JSON.stringify(on) : null;
  }
  return null;
}

// The fast columns' serializer. Like serializeFlags an empty value stores
// NULL, but nothing is pruned: a fast's values are ids and outcome records, not
// booleans.
function serializeJsonColumn(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val || null;   // a restore replaying a raw row
  if (Array.isArray(val)) return val.length ? JSON.stringify(val) : null;
  if (typeof val === 'object') return Object.keys(val).length ? JSON.stringify(val) : null;
  return null;
}

// ── Span of dated data ───────────────────────────────────────────────────────
// The first and last year with a history or checkins row, for GET
// /api/liturgical. Only those two tables, since only they produce a day card
// that shows the badge. Not user-scoped: the calendar is the same for everyone.
function getDataYearSpan() {
  const row = db.prepare(`
    SELECT MIN(date) AS min, MAX(date) AS max
      FROM (SELECT date FROM history UNION ALL SELECT date FROM checkins)
  `).get();
  const year = v => (typeof v === 'string' && /^\d{4}/.test(v) ? Number(v.slice(0, 4)) : null);
  return { min: year(row && row.min), max: year(row && row.max) };
}

// ── Garmin sync status ──────────────────────────────────────────────────────────
// Per user, same shape as the Apple and backup status pairs below.
function getGarminSyncStatus(userId) {
  return db.prepare('SELECT * FROM garmin_sync_status WHERE user_id = ?').get(userId) || null;
}

// last_attempt_at always moves; last_success_at only on a success, so it keeps
// pointing at the last time data actually landed.
function setGarminSyncStatus(userId, { ok, mfa_required, rate_limited, message }) {
  const now = Date.now();
  const prev = getGarminSyncStatus(userId);
  db.prepare(`
    INSERT INTO garmin_sync_status (user_id, last_attempt_at, ok, mfa_required, rate_limited, message, last_success_at)
    VALUES (@user_id, @last_attempt_at, @ok, @mfa_required, @rate_limited, @message, @last_success_at)
    ON CONFLICT(user_id) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      ok              = excluded.ok,
      mfa_required    = excluded.mfa_required,
      rate_limited    = excluded.rate_limited,
      message         = excluded.message,
      last_success_at = excluded.last_success_at
  `).run({
    user_id: userId,
    last_attempt_at: now,
    ok: ok ? 1 : 0,
    mfa_required: mfa_required ? 1 : 0,
    rate_limited: rate_limited ? 1 : 0,
    message: message ? String(message).slice(0, 500) : null,
    last_success_at: ok ? now : (prev?.last_success_at ?? null),
  });
  return getGarminSyncStatus(userId);
}

// On disconnect or a change of account: the row describes one account's last
// sync and must not outlive its credentials, like wipeTokenStore() in server.js.
function clearGarminSyncStatus(userId) {
  db.prepare('DELETE FROM garmin_sync_status WHERE user_id = ?').run(userId);
}

// ── Apple sync status ────────────────────────────────────────────────────────
function getAppleSyncStatus(userId) {
  return db.prepare('SELECT * FROM apple_sync_status WHERE user_id = ?').get(userId) || null;
}

function setAppleSyncStatus(userId, { ok, message }) {
  const now = Date.now();
  const prev = getAppleSyncStatus(userId);
  db.prepare(`
    INSERT INTO apple_sync_status (user_id, last_attempt_at, ok, message, last_success_at)
    VALUES (@user_id, @last_attempt_at, @ok, @message, @last_success_at)
    ON CONFLICT(user_id) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      ok              = excluded.ok,
      message         = excluded.message,
      last_success_at = excluded.last_success_at
  `).run({
    user_id: userId,
    last_attempt_at: now,
    ok: ok ? 1 : 0,
    message: message ? String(message).slice(0, 500) : null,
    last_success_at: ok ? now : (prev?.last_success_at ?? null),
  });
  return getAppleSyncStatus(userId);
}

// ── Backup status ────────────────────────────────────────────────────────────
// Keyed by job. getBackupStatus returns ALL jobs as { [job]: row }, since the
// badge judges both at once.
function getBackupStatus() {
  const out = {};
  for (const row of db.prepare('SELECT * FROM backup_status').all()) out[row.job] = row;
  return out;
}

// last_attempt_at always moves; last_success_at only on a success.
function setBackupStatus(job, { ok, message }) {
  const now = Date.now();
  const prev = db.prepare('SELECT * FROM backup_status WHERE job = ?').get(job);
  db.prepare(`
    INSERT INTO backup_status (job, last_attempt_at, ok, message, last_success_at)
    VALUES (@job, @last_attempt_at, @ok, @message, @last_success_at)
    ON CONFLICT(job) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      ok              = excluded.ok,
      message         = excluded.message,
      last_success_at = excluded.last_success_at
  `).run({
    job,
    last_attempt_at: now,
    ok: ok ? 1 : 0,
    message: message ? String(message).slice(0, 500) : null,
    last_success_at: ok ? now : (prev?.last_success_at ?? null),
  });
  return db.prepare('SELECT * FROM backup_status WHERE job = ?').get(job);
}

// On Apple disconnect. A token regenerate does NOT clear it: same account,
// so the last outcome still holds.
function clearAppleSyncStatus(userId) {
  db.prepare('DELETE FROM apple_sync_status WHERE user_id = ?').run(userId);
}

// ── Restoring a backup ───────────────────────────────────────────────────────
// For restoring tables with NO natural key (goals, injuries, pregnancy
// milestones): a fresh INSERT with a new id. The import clears the user's rows
// of that kind first (clearGoals and its siblings), so a replay replaces them
// rather than adding a second copy.
//
// The column list comes from the table, so a new column restores as surely
// as the whole-row export carries it; a hand-written list would silently drop
// it. verify_backend.js asserts the round trip. Story: DECISIONS.md#backup-gap.
//
// `id` is excluded, an absent key takes the column DEFAULT, and only real
// column names reach the SQL.
function insertRestoredRow(table, row) {
  const cols = db.pragma(`table_info(${table})`)
    .map(c => c.name)
    .filter(c => c !== 'id' && row[c] !== undefined);
  // Any column named date or ending _date is normalized to ISO.
  const toValue = c => {
    const v = row[c] ?? null;
    return (c === 'date' || c.endsWith('_date')) ? normalizeDateStr(v) : v;
  };
  const result = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map(toValue));
  return result.lastInsertRowid;
}

// ── Goals ────────────────────────────────────────────────────────────────────
function getGoals(userId) {
  return db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

// PATCH /api/goals/:id validates the MERGED row, so it needs the stored one.
// By id only; the route checks ownership.
function getGoal(id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null;
}

// Takes achieved_at too: re-creating an achieved goal must keep its date,
// since goalSinceKey() bounds the achievement scan at the NEW created_at.
// Write-once only holds if every write path writes it.
function createGoal({ type, exercise_name, activity_type, target_value, added_lbs, target_distance_km, climb_scale, direction, target_date, achieved_at }, userId) {
  const result = db.prepare(`
    INSERT INTO goals (type, exercise_name, activity_type, target_value, added_lbs, target_distance_km, climb_scale, direction, target_date, achieved_at, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, exercise_name || null, activity_type || null, target_value, added_lbs ?? null, target_distance_km ?? null, climb_scale || null, direction || 'at_least', normalizeDateStr(target_date) || null, achieved_at ?? null, Date.now(), userId);
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(result.lastInsertRowid);
}

function updateGoal(id, fields) {
  const existing = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE goals SET type = ?, exercise_name = ?, activity_type = ?, target_value = ?, added_lbs = ?, target_distance_km = ?, climb_scale = ?, direction = ?, target_date = ?, achieved_at = ?, target_history = ?
    WHERE id = ?
  `).run(
    fields.type          !== undefined ? fields.type          : existing.type,
    fields.exercise_name !== undefined ? fields.exercise_name : existing.exercise_name,
    fields.activity_type !== undefined ? fields.activity_type : existing.activity_type,
    fields.target_value  !== undefined ? fields.target_value  : existing.target_value,
    fields.added_lbs     !== undefined ? fields.added_lbs     : existing.added_lbs,
    fields.target_distance_km !== undefined ? fields.target_distance_km : existing.target_distance_km,
    fields.climb_scale   !== undefined ? fields.climb_scale   : existing.climb_scale,
    fields.direction     !== undefined ? fields.direction     : existing.direction,
    // `|| null` like createGoal, so '' is stored as NULL.
    fields.target_date   !== undefined ? (normalizeDateStr(fields.target_date) || null) : existing.target_date,
    fields.achieved_at   !== undefined ? fields.achieved_at   : existing.achieved_at,
    // Only normalizeGoal's goalTargetEdit sets it (see server.js).
    fields.target_history !== undefined ? fields.target_history : existing.target_history,
    id
  );
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

function deleteGoal(id) {
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
}

// POST /api/import only. Replays fields as given, BYPASSING normalizeGoal: a
// backup records what was. created_at is defaulted here because it is NOT NULL
// with no DEFAULT and an old backup may lack it.
function restoreGoal(row) {
  if (!row) return;
  insertRestoredRow('goals', { ...row, created_at: row.created_at || Date.now() });
}

// POST /api/import only, and only when the payload carries a goals list: a
// restore REPLACES the user's goals rather than adding the backup's beside
// them, the way history is replaced. With no natural key, adding would double
// every goal the backup shares with the database, which is all of them for a
// recent backup. Story: DECISIONS.md#import-atomicity.
function clearGoals(userId) {
  db.prepare('DELETE FROM goals WHERE user_id = ?').run(userId);
}

// ── Injuries ─────────────────────────────────────────────────────────────────
function getInjuries(userId) {
  return db.prepare('SELECT * FROM injuries WHERE user_id = ? ORDER BY started_date DESC').all(userId);
}

function createInjury({ body_part, severity, started_date, notes, pt_plan, kind, history_id }, userId) {
  const result = db.prepare(`
    INSERT INTO injuries (body_part, severity, started_date, notes, pt_plan, kind, history_id, tracked_since, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body_part, severity ?? null, normalizeDateStr(started_date) || isoDateStr(), notes || null, pt_plan || null,
         kind || 'injury', history_id ?? null, Date.now(), userId);
  return db.prepare('SELECT * FROM injuries WHERE id = ?').get(result.lastInsertRowid);
}

function updateInjury(id, fields) {
  const existing = db.prepare('SELECT * FROM injuries WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE injuries SET body_part = ?, severity = ?, started_date = ?, resolved_date = ?, notes = ?, pt_plan = ?, resolution_summary = ?, kind = ?, tracked_since = ?
    WHERE id = ?
  `).run(
    fields.body_part          !== undefined ? fields.body_part          : existing.body_part,
    fields.severity           !== undefined ? fields.severity           : existing.severity,
    fields.started_date       !== undefined ? normalizeDateStr(fields.started_date)  : existing.started_date,
    fields.resolved_date      !== undefined ? normalizeDateStr(fields.resolved_date) : existing.resolved_date,
    fields.notes              !== undefined ? fields.notes              : existing.notes,
    fields.pt_plan            !== undefined ? fields.pt_plan            : existing.pt_plan,
    fields.resolution_summary !== undefined ? fields.resolution_summary : existing.resolution_summary,
    fields.kind               !== undefined ? fields.kind               : existing.kind,
    // A reopen restarts tracked_since. Never client-writable.
    fields.resolved_date === null && existing.resolved_date != null ? Date.now() : existing.tracked_since,
    id
  );
  return db.prepare('SELECT * FROM injuries WHERE id = ?').get(id);
}

// Deletes the injury AND its daily follow-ups, which would otherwise be
// orphaned. With no FOREIGN KEY this function is the integrity guarantee, so
// it is one TRANSACTION: half-run, it would wipe the recovery curve and leave
// the injury showing.
const deleteInjury = db.transaction((id) => {
  db.prepare('DELETE FROM injury_checkins WHERE injury_id = ?').run(id);
  db.prepare('DELETE FROM injuries WHERE id = ?').run(id);
});

// injuries.history_id can change under it (see the injuries comment). The
// sync-wins merge repoints it inside its transaction; deleting a workout
// unlinks it and keeps the injury.
function relinkInjuries(oldHistoryId, newHistoryId) {
  db.prepare('UPDATE injuries SET history_id = ? WHERE history_id = ?').run(newHistoryId, oldHistoryId);
}
function unlinkInjuriesFromHistory(historyId) {
  db.prepare('UPDATE injuries SET history_id = NULL WHERE history_id = ?').run(historyId);
}

// POST /api/import only: a fresh INSERT. Returns the NEW id, which the import
// remaps injury_checkins onto.
function restoreInjury(row) {
  if (!row) return null;
  return insertRestoredRow('injuries', row);
}

// POST /api/import only, when the payload carries an injuries list: replaced,
// like goals (see clearGoals). The daily follow-ups go with them, as in
// deleteInjury: the restored injuries get fresh ids, so an old follow-up left
// behind would be orphaned, or graft onto whichever injury reuses its id.
// Runs inside the import's transaction.
function clearInjuries(userId) {
  db.prepare('DELETE FROM injury_checkins WHERE injury_id IN (SELECT id FROM injuries WHERE user_id = ?)').run(userId);
  db.prepare('DELETE FROM injuries WHERE user_id = ?').run(userId);
}

// ── Injury check-ins ─────────────────────────────────────────────────────────
// Scoped by a join to injuries, since injury_checkins carries no user_id.
function getInjuryCheckins(userId) {
  return db.prepare(`
    SELECT ic.* FROM injury_checkins ic
    JOIN injuries i ON i.id = ic.injury_id
    WHERE i.user_id = ?
    ORDER BY ic.date DESC
  `).all(userId);
}

// By (injuryId, date) only; the route checks the injury's owner.
function getInjuryCheckin(injuryId, date) {
  return db.prepare('SELECT * FROM injury_checkins WHERE injury_id = ? AND date = ?').get(injuryId, date) || null;
}

// Partial upsert like upsertCheckin: an absent key keeps its stored value, so
// saving one period never wipes the other.
function upsertInjuryCheckin(injuryId, date, fields) {
  date = normalizeDateStr(date);
  const existing = getInjuryCheckin(injuryId, date) || {};
  const merged = { ...existing, ...fields };
  db.prepare(`
    INSERT INTO injury_checkins (injury_id, date, morning_pain, morning_affected_sleep,
                                 evening_pain, evening_affected_workout, evening_pt_done,
                                 workout_pain, evening_trend, evening_note)
    VALUES (@injury_id, @date, @morning_pain, @morning_affected_sleep,
            @evening_pain, @evening_affected_workout, @evening_pt_done,
            @workout_pain, @evening_trend, @evening_note)
    ON CONFLICT(injury_id, date) DO UPDATE SET
      morning_pain             = excluded.morning_pain,
      morning_affected_sleep   = excluded.morning_affected_sleep,
      evening_pain             = excluded.evening_pain,
      evening_affected_workout = excluded.evening_affected_workout,
      evening_pt_done          = excluded.evening_pt_done,
      workout_pain             = excluded.workout_pain,
      evening_trend            = excluded.evening_trend,
      evening_note             = excluded.evening_note
  `).run({
    injury_id:                injuryId,
    date,
    morning_pain:             merged.morning_pain             ?? null,
    morning_affected_sleep:   merged.morning_affected_sleep   ?? null,
    evening_pain:             merged.evening_pain             ?? null,
    evening_affected_workout: merged.evening_affected_workout ?? null,
    evening_pt_done:          merged.evening_pt_done          ?? null,
    workout_pain:             merged.workout_pain              ?? null,
    evening_trend:            merged.evening_trend             ?? null,
    evening_note:             merged.evening_note              ?? null,
  });
  return getInjuryCheckin(injuryId, date);
}

// POST /api/import only. An upsert: (injury_id, date) is a natural key.
function restoreInjuryCheckin(row, injuryId) {
  if (!row) return;
  const id = injuryId != null ? injuryId : row.injury_id;
  if (id == null || !row.date) return;
  upsertInjuryCheckin(id, row.date, row);
}

// ── Pregnancy tracking ───────────────────────────────────────────────────────
// One row per user.
function getPregnancyInfo(userId) {
  return db.prepare('SELECT * FROM pregnancy_info WHERE user_id = ?').get(userId) || null;
}

function setPregnancyInfo(userId, { conception_date, due_date, notes }) {
  db.prepare(`
    INSERT INTO pregnancy_info (user_id, conception_date, due_date, notes)
    VALUES (@user_id, @conception_date, @due_date, @notes)
    ON CONFLICT(user_id) DO UPDATE SET
      conception_date = excluded.conception_date,
      due_date        = excluded.due_date,
      notes           = excluded.notes
  `).run({
    user_id: userId,
    conception_date: normalizeDateStr(conception_date) || null,
    due_date: normalizeDateStr(due_date) || null,
    notes: notes || null,
  });
  return getPregnancyInfo(userId);
}

// POST /api/import only. Upserts, since user_id is the primary key and a blind
// INSERT would collide.
function restorePregnancyInfo(row, userId) {
  if (!row) return;
  setPregnancyInfo(userId, row);
}

function getPregnancyMilestones(userId) {
  return db.prepare('SELECT * FROM pregnancy_milestones WHERE user_id = ? ORDER BY date ASC').all(userId);
}

function createPregnancyMilestone({ date, label, notes }, userId) {
  const result = db.prepare(`
    INSERT INTO pregnancy_milestones (user_id, date, label, notes) VALUES (?, ?, ?, ?)
  `).run(userId, normalizeDateStr(date) || isoDateStr(), label, notes || null);
  return db.prepare('SELECT * FROM pregnancy_milestones WHERE id = ?').get(result.lastInsertRowid);
}

function updatePregnancyMilestone(id, fields) {
  const existing = db.prepare('SELECT * FROM pregnancy_milestones WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE pregnancy_milestones SET date = ?, label = ?, notes = ? WHERE id = ?
  `).run(
    fields.date  !== undefined ? normalizeDateStr(fields.date) : existing.date,
    fields.label !== undefined ? fields.label : existing.label,
    fields.notes !== undefined ? fields.notes : existing.notes,
    id
  );
  return db.prepare('SELECT * FROM pregnancy_milestones WHERE id = ?').get(id);
}

function deletePregnancyMilestone(id) {
  db.prepare('DELETE FROM pregnancy_milestones WHERE id = ?').run(id);
}

// POST /api/import only: a fresh INSERT. No natural key, so the import clears
// the user's milestones first (clearPregnancyMilestones) when the payload
// carries a list; that is what keeps a second restore from doubling them.
function restorePregnancyMilestone(row, userId) {
  if (!row) return;
  insertRestoredRow('pregnancy_milestones', { ...row, user_id: userId });
}

// POST /api/import only, when the payload carries a pregnancyMilestones list:
// replaced, like goals (see clearGoals).
function clearPregnancyMilestones(userId) {
  db.prepare('DELETE FROM pregnancy_milestones WHERE user_id = ?').run(userId);
}

// ── Life phases ──────────────────────────────────────────────────────────────
// Per-user list; ownership is checked in server.js. What a phase means is in
// the table comment. Story: DECISIONS.md#life-phases.
function getLifePhases(userId) {
  return db.prepare('SELECT * FROM life_phases WHERE user_id = ? ORDER BY start_date ASC, id ASC').all(userId);
}

function getLifePhase(id) {
  return db.prepare('SELECT * FROM life_phases WHERE id = ?').get(id) || null;
}

function createLifePhase({ label, emoji, start_date, end_date, notes }, userId) {
  const result = db.prepare(`
    INSERT INTO life_phases (user_id, label, emoji, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, label, emoji || null, normalizeDateStr(start_date),
    normalizeDateStr(end_date) || null, notes || null);
  return getLifePhase(result.lastInsertRowid);
}

function updateLifePhase(id, fields) {
  const existing = getLifePhase(id);
  if (!existing) return null;
  const pick = (k, norm) => fields[k] !== undefined ? (norm ? norm(fields[k]) : fields[k]) : existing[k];
  db.prepare(`
    UPDATE life_phases SET label = ?, emoji = ?, start_date = ?, end_date = ?, notes = ? WHERE id = ?
  `).run(
    pick('label'),
    pick('emoji', v => v || null),
    pick('start_date', normalizeDateStr),
    pick('end_date', v => normalizeDateStr(v) || null),
    pick('notes', v => v || null),
    id
  );
  return getLifePhase(id);
}

function deleteLifePhase(id) {
  db.prepare('DELETE FROM life_phases WHERE id = ?').run(id);
}

// POST /api/import only. Skips a row matching the natural key (user_id,
// label, start_date); returns true when it inserted.
function restoreLifePhase(row, userId) {
  if (!row || !row.label || !row.start_date) return false;
  const start = normalizeDateStr(row.start_date);
  const dup = db.prepare(
    'SELECT 1 FROM life_phases WHERE user_id = ? AND label = ? AND start_date = ?'
  ).get(userId, row.label, start);
  if (dup) return false;
  insertRestoredRow('life_phases', { ...row, user_id: userId });
  return true;
}

// ── Check-in chips ───────────────────────────────────────────────────────────
// One user's custom chips and built-in show/hide choices; the two row kinds
// are in the table comment. server.js validates every write.
// Story: DECISIONS.md#custom-check-in-chips.
const CUSTOM_FLAG_PREFIX = 'c_';
const CHECKIN_PERIODS = ['morning', 'evening'];
const isCustomFlagKey = key => typeof key === 'string' && key.startsWith(CUSTOM_FLAG_PREFIX);

function getCheckinFlagPrefs(userId) {
  return db.prepare(`
    SELECT period, key, label, emoji, position, hidden, created_at FROM checkin_flag_prefs
    WHERE user_id = ? ORDER BY period, position, created_at, key
  `).all(userId);
}

function getCheckinFlagPref(userId, period, key) {
  return db.prepare('SELECT * FROM checkin_flag_prefs WHERE user_id = ? AND period = ? AND key = ?')
    .get(userId, period, key) || null;
}

function getCustomCheckinFlags(userId, period) {
  return getCheckinFlagPrefs(userId).filter(r => r.period === period && isCustomFlagKey(r.key));
}

// c_ plus the label folded to ASCII snake case, numbered on a clash. Minted
// once: a rename keeps the key, since the key is what every check-in stores.
function mintCustomFlagKey(userId, period, label) {
  const slug = String(label).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/, '') || 'chip';
  const base = CUSTOM_FLAG_PREFIX + slug;
  let key = base;
  for (let n = 2; getCheckinFlagPref(userId, period, key); n++) key = `${base}_${n}`;
  return key;
}

function createCustomCheckinFlag({ period, label, emoji }, userId) {
  const key = mintCustomFlagKey(userId, period, label);
  const last = db.prepare(`
    SELECT MAX(position) AS p FROM checkin_flag_prefs WHERE user_id = ? AND period = ? AND substr(key, 1, 2) = 'c_'
  `).get(userId, period);
  db.prepare(`
    INSERT INTO checkin_flag_prefs (user_id, period, key, label, emoji, position, hidden, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(userId, period, key, label, emoji || null, (last?.p ?? -1) + 1, Date.now());
  return getCheckinFlagPref(userId, period, key);
}

// A custom chip's label, emoji or archived state; undefined leaves a column alone.
function updateCustomCheckinFlag(userId, period, key, { label, emoji, hidden }) {
  const cur = getCheckinFlagPref(userId, period, key);
  if (!cur) return null;
  db.prepare('UPDATE checkin_flag_prefs SET label = ?, emoji = ?, hidden = ? WHERE user_id = ? AND period = ? AND key = ?').run(
    label !== undefined ? label : cur.label,
    emoji !== undefined ? (emoji || null) : cur.emoji,
    hidden !== undefined ? hidden : cur.hidden,
    userId, period, key);
  return getCheckinFlagPref(userId, period, key);
}

// Swaps a custom chip with its neighbour in Mine (dir -1 = earlier, 1 =
// later), renumbering the period's custom chips 0..n-1 as it goes, so
// positions never collide or drift. A no-op at either end.
function moveCustomCheckinFlag(userId, period, key, dir) {
  const rows = getCustomCheckinFlags(userId, period);
  const i = rows.findIndex(r => r.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const set = db.prepare('UPDATE checkin_flag_prefs SET position = ? WHERE user_id = ? AND period = ? AND key = ?');
  db.transaction(() => rows.forEach((r, n) => set.run(n, userId, period, r.key)))();
}

// A built-in chip's override: true/false hides or shows it, null drops the
// row so the chip follows the code's default again.
function setBuiltinCheckinFlagHidden(userId, period, key, hidden) {
  if (hidden === null) {
    db.prepare('DELETE FROM checkin_flag_prefs WHERE user_id = ? AND period = ? AND key = ?').run(userId, period, key);
    return null;
  }
  db.prepare(`
    INSERT INTO checkin_flag_prefs (user_id, period, key, hidden, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, period, key) DO UPDATE SET hidden = excluded.hidden
  `).run(userId, period, key, hidden ? 1 : 0, Date.now());
  return getCheckinFlagPref(userId, period, key);
}

function deleteCheckinFlagPref(userId, period, key) {
  db.prepare('DELETE FROM checkin_flag_prefs WHERE user_id = ? AND period = ? AND key = ?').run(userId, period, key);
}

// How many of this user's check-ins have the chip ticked: what DELETE checks
// before letting a custom chip go. The LIKE only narrows the scan; the parsed
// blob decides, so a key that is a prefix of another never counts for it.
function checkinFlagUseCount(userId, period, key) {
  if (!CHECKIN_PERIODS.includes(period)) return 0;
  const col = `${period}_flags`;
  return db.prepare(`SELECT * FROM checkins WHERE user_id = ? AND ${col} LIKE ?`)
    .all(userId, `%"${key}"%`)
    .map(parseCheckinFlags)
    .filter(c => c[col] && c[col][key])
    .length;
}

// POST /api/import only: an upsert on (user_id, period, key), so a replay
// converges. A row of the wrong shape is SKIPPED rather than thrown, which
// would roll back the whole import -- a shape check, not the API's rules, as
// for restoreRouteSegment.
function restoreCheckinFlagPref(row, userId) {
  if (!row || !CHECKIN_PERIODS.includes(row.period)) return false;
  if (typeof row.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(row.key)) return false;
  const custom = isCustomFlagKey(row.key);
  if (custom && (typeof row.label !== 'string' || !row.label.trim())) return false;
  const hidden = row.hidden === null || row.hidden === undefined ? null : (row.hidden ? 1 : 0);
  if (!custom && (hidden === null || row.key === 'sick')) return false;
  db.prepare(`
    INSERT INTO checkin_flag_prefs (user_id, period, key, label, emoji, position, hidden, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, period, key) DO UPDATE SET
      label = excluded.label, emoji = excluded.emoji, position = excluded.position, hidden = excluded.hidden
  `).run(userId, row.period, row.key,
    custom ? row.label.trim() : null,
    custom && typeof row.emoji === 'string' && row.emoji.trim() ? row.emoji.trim() : null,
    custom && Number.isInteger(row.position) ? row.position : null,
    custom ? (hidden ?? 0) : hidden,
    Number.isFinite(row.created_at) ? row.created_at : Date.now());
  return true;
}

// ── Full database backup ────────────────────────────────────────────────────────
// A complete snapshot of every table through better-sqlite3's online backup,
// safe against the live WAL connection (a plain file copy can miss rows still
// in the -wal). Needs no upkeep as tables are added, unlike the JSON export.
// Returns the temp path; server.js streams it and deletes it.
//
// The unlink on failure is REQUIRED: better-sqlite3 leaves a partial copy
// behind, and server.js cannot see its path when the await throws. os.tmpdir()
// is the container's overlay on the SD card, so each failure would consume the
// space whose shortage caused it.
//
// The random suffix prevents two same-millisecond requests sharing a path.
async function backupDatabase() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const dest = path.join(os.tmpdir(), `workout_backup_${Date.now()}_${process.pid}_${suffix}.db`);
  try {
    await db.backup(dest);
  } catch (e) {
    fs.unlink(dest, () => {});
    throw e;
  }
  return dest;
}

// ── Shutdown ────────────────────────────────────────────────────────────────────
// Checkpoints the WAL into workout.db and closes the handle. Called only from
// server.js's SIGTERM/SIGINT handlers. Without it a FILE-level copy of
// workout.db (a snapshot, an rsync, a cp) can miss everything since the last
// automatic checkpoint; GET /api/backup/db is WAL-aware and unaffected.
// TRUNCATE, so the -wal is emptied, not just merged.
// Story: DECISIONS.md#wal-durability.
let closed = false;
function closeDatabase() {
  if (closed) return;   // a second signal must not double-close
  closed = true;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.error('WAL checkpoint on shutdown failed:', e.message);
  }
  db.close();
}

module.exports = { transaction, closeDatabase, durationSec, NAME_KEYED_EXERCISE_TABLES, isoDateStr, normalizeDateStr, getDataYearSpan, getUsers, userExists, createUser, updateUser, restoreUser, getLifts, setLifts, getExerciseDefaults, setExerciseDefaults, seedExerciseDefaultsFromRoutines, getAllExerciseNames, getSchedule, setScheduleDay, getPlans, setPlanDay, getHistory, addHistory, updateHistory, refreshDeviceFields, addDeviceFieldsToManual, deleteHistory, clearHistory, historyBelongsToUser, getBodyWeight, addBodyWeight, deleteBodyWeight, hasExternalId, getCheckins, getCheckin, upsertCheckin, deleteCheckin, GARMIN_DAILY_COLUMNS, getGarminDaily, getGarminDailyDay, upsertGarminDaily, restoreGarminDaily, NON_ROUTE_TYPES, getActivityRoutes, getActivityRouteWithProfile, getRoutelessActivityIds, markRoutesMissing, getActivityRoute, upsertActivityRoute, restoreActivityRoute, ACTIVITY_WEATHER_COLUMNS, getActivityWeather, getWeatherlessActivities, upsertActivityWeather, settleActivityWeather, getRouteSegments, getRouteSegment, routeSegmentNameTaken, createRouteSegment, updateRouteSegment, deleteRouteSegment, restoreRouteSegment, getRoutines, createRoutine, updateRoutine, archiveRoutine, getExerciseCategoryOverrides, setExerciseCategoryOverride, getExerciseFormNotes, setExerciseFormNote, getExerciseWeightless, setExerciseWeightless, getExerciseMuscles, setExerciseMuscles, getExercisePatterns, setExercisePattern, getExerciseTimed, setExerciseTimed, getExerciseUnranked, setExerciseUnranked, mergeExerciseNames, getActivityTypes, ensureActivityType, createActivityType, updateActivityType, restoreActivityType, findManualCandidates, getGarminHistory, findLikelyDuplicate, backupDatabase, getGarminSyncStatus, setGarminSyncStatus, clearGarminSyncStatus, getAppleSyncStatus, setAppleSyncStatus, clearAppleSyncStatus, getBackupStatus, setBackupStatus, getGoals, getGoal, createGoal, updateGoal, deleteGoal, restoreGoal, clearGoals, getInjuries, createInjury, updateInjury, deleteInjury, restoreInjury, clearInjuries, relinkInjuries, unlinkInjuriesFromHistory, getInjuryCheckins, getInjuryCheckin, upsertInjuryCheckin, restoreInjuryCheckin, getPregnancyInfo, setPregnancyInfo, restorePregnancyInfo, getPregnancyMilestones, createPregnancyMilestone, updatePregnancyMilestone, deletePregnancyMilestone, restorePregnancyMilestone, clearPregnancyMilestones, getLifePhases, getLifePhase, createLifePhase, updateLifePhase, deleteLifePhase, restoreLifePhase, CUSTOM_FLAG_PREFIX, getCheckinFlagPrefs, getCheckinFlagPref, getCustomCheckinFlags, createCustomCheckinFlag, updateCustomCheckinFlag, moveCustomCheckinFlag, setBuiltinCheckinFlagHidden, deleteCheckinFlagPref, checkinFlagUseCount, restoreCheckinFlagPref };
