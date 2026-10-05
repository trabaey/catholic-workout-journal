// exercise_library.js — the RepDB exercise library, translated into this app's
// own tags.
//
// The snapshot lives in data/repdb/ and is NEVER in the repo: the RepDB licence
// forbids redistributing it as a dataset, so each install downloads RepDB's own
// published copy at the SHA pinned below (installSnapshot, from Settings) and the
// bind mount keeps it across rebuilds. Without one the library is simply empty.
// It speaks RepDB's vocabulary: ~30 anatomical muscle slugs, a push/pull/
// static/dynamic force, a variation_group, an is_unilateral boolean. This file
// is the ONE place that vocabulary becomes ours — category, the 16-group muscle
// map, hinge_knee, laterality, the three flags and a form note. server.js serves
// the result as GET /api/exercise-library and scripts/adopt_repdb.js re-tags
// existing exercises from it; both require this file, so a new pick and an
// adopted exercise can never be translated two different ways.
//
// THE NAME IS THE LINK. An exercise is "in the library" when its name equals a
// RepDB name_en, compared case-insensitively — there is no id column anywhere.
// The adoption renamed every matched exercise to that exact name, so the name
// already carries the link, and a column would have been one more name-keyed
// attribute for mergeExerciseNames, POST /api/import and exportData() to learn.
// Renaming a linked exercise to a spelling RepDB doesn't have unlinks it (its
// images go away), which is visible and fixable by merging it back.
//
// DERIVED TAGS ARE A STARTING POINT, NEVER AUTHORITY. RepDB is coarser than
// this app on three axes and simply wrong on a handful of entries, so:
//   - muscles: RepDB has primary/secondary only, so a derived map is 1.0/0.5
//     and never carries the 0.3 "minor" tier.
//   - laterality: is_unilateral cannot tell 'bilateral' from 'independent'
//     (one implement or two), so a non-unilateral dumbbell/kettlebell move is
//     left null — not reviewed — rather than guessed.
//   - weightless: is_bodyweight means "needs no equipment", so Pull-Up (a bar)
//     and Chest Dips (a station) are false there. Load-free apparatus is added
//     back explicitly below.
//   - known errors: Step Ups is_unilateral false; Bird-Dog grouped as a back
//     extension. scripts/repdb_adoption.json overrides these for existing
//     exercises; for a new pick the form shows the value and it can be fixed.
// In the Add Exercise form a name's STORED tags always win over these — see
// loadExerciseTagsIntoForm in index.html. Story: DECISIONS.md#repdb-exercise-library.

const fs = require('fs');
const path = require('path');

const REPDB_DIR = path.join(__dirname, 'data', 'repdb');
// PINNED, not "latest": the app links an exercise to its library entry BY NAME,
// so a snapshot that renames or drops an entry silently unlinks it. Bumping it
// is deliberate: change it here (scripts/fetch_repdb.sh reads it from this
// line), reinstall, and run testing/verify_backend.js.
const REPDB_SHA = '9ed9357f09c7566ea0256c57ebd6374ebb8b575e';

// RepDB muscle slug -> this app's muscle group (MUSCLE_OPTIONS in index.html).
// Every slug the snapshot uses must be here or in IGNORED_MUSCLES:
// verify_backend.js walks the whole vendored file and fails on one that is in
// neither, so a snapshot bump can't silently drop a muscle from the metric.
const MUSCLE_GROUP = {
  pectoralis_major: 'chest',
  anterior_deltoid: 'front_delts',
  lateral_deltoid: 'side_delts',
  supraspinatus: 'side_delts',       // initiates abduction; RepDB tags it once
  posterior_deltoid: 'rear_delts',
  triceps_brachii: 'triceps',
  biceps_brachii: 'biceps',
  brachialis: 'biceps',              // our "biceps" group means the elbow flexors
  brachioradialis: 'forearms',
  forearm_flexors: 'forearms',
  forearm_extensors: 'forearms',
  forearms: 'forearms',
  latissimus_dorsi: 'lats',
  trapezius: 'upper_back',
  rhomboids: 'upper_back',
  erector_spinae: 'lower_back',
  quadratus_lumborum: 'lower_back',
  quadriceps: 'quads',
  hamstrings: 'hamstrings',
  gluteus_maximus: 'glutes',
  gluteus_medius: 'glutes',
  abductors: 'glutes',               // gluteus medius/minimus do the abducting
  adductors: 'adductors',
  gastrocnemius: 'calves',
  soleus: 'calves',
  rectus_abdominis: 'core',
  transverse_abdominis: 'core',
  obliques: 'core',
  hip_flexors: 'core',
};
// No group of ours fits: the serratus is a scapular protractor, and counting it
// as chest or core would inflate a group that didn't do the work.
const IGNORED_MUSCLES = new Set(['serratus_anterior']);

const KNEE_GROUPS  = new Set(['squat', 'lunge', 'leg-press', 'leg-extension']);
const HINGE_GROUPS = new Set(['deadlift', 'hip-thrust', 'back-extension', 'kettlebell-swing']);
// Leg work that is neither a hinge nor knee-dominant in this app's sense: a leg
// curl or Nordic flexes the knee without loading it like a squat does, and a
// calf raise or abduction is neither. Stored as the explicit 'neither'.
const NEITHER_LEG_GROUPS = new Set(['leg-curl', 'calf-raise', 'hip-abduction', 'hip-adduction']);
const LEG_PARTS    = new Set(['upper_legs', 'lower_legs']);
const UPPER_PARTS  = new Set(['chest', 'back', 'shoulders', 'upper_arms', 'lower_arms']);
// Apparatus you hang from, press on or jump onto adds no load of its own, so a
// set on it is bodyweight in this app's sense even though RepDB lists equipment.
const LOADLESS_EQUIPMENT = new Set(['pull_up_bar', 'dip_station', 'rings', 'suspension_trainer', 'plyo_box', 'glute_ham_developer']);
// One implement or two is unknowable from RepDB, so these never get a guessed
// 'bilateral' — see the header.
const PAIRABLE_EQUIPMENT = new Set(['dumbbell', 'kettlebell']);

const PRIMARY = 1.0;
const SECONDARY = 0.5;

function muscleMapFor(entry) {
  const map = {};
  const add = (slugs, value) => {
    for (const slug of slugs || []) {
      const group = MUSCLE_GROUP[slug];
      if (!group) continue; // ignored or unknown; verify_backend.js polices unknown
      map[group] = Math.max(map[group] || 0, value);
    }
  };
  add(entry.primary_muscles, PRIMARY);
  add(entry.secondary_muscles, SECONDARY);
  return map;
}

// 'hinge' | 'knee' | 'neither' | null. Bird-Dog and its hold are grouped under
// back-extension by RepDB but are anti-extension core drills, hence the core
// exclusion on the hinge arm.
function hingeKneeFor(entry) {
  const group = entry.variation_group;
  if (KNEE_GROUPS.has(group)) return 'knee';
  if (HINGE_GROUPS.has(group) && entry.body_part !== 'core') return 'hinge';
  if (NEITHER_LEG_GROUPS.has(group)) return 'neither';
  if (UPPER_PARTS.has(entry.body_part) || entry.body_part === 'core' || entry.body_part === 'lower_legs') return 'neither';
  return null;
}

function lateralityFor(entry) {
  if (entry.is_unilateral) return 'unilateral';
  if (PAIRABLE_EQUIPMENT.has(entry.equipment)) return null;
  return 'bilateral';
}

// The seven CATEGORIES keys in index.html, or null. Legs split the way this app
// already does it — push is knee/quad-led, pull is the posterior chain — not
// by RepDB's force_type, which calls a hip thrust a push.
// Core is RepDB's core body part, plus anything whose every primary is a core
// muscle (L Sit is filed under full_body). A stretch is still a stretch first,
// so a Cobra Stretch stays stretch_mobility. Story: DECISIONS.md#core-category.
function categoryFor(entry, muscles) {
  if (entry.category === 'stretching') return 'stretch_mobility';
  const primaries = (entry.primary_muscles || []).map(s => MUSCLE_GROUP[s]).filter(Boolean);
  if (primaries.length && primaries.every(g => g === 'forearms')) return 'finger_forearm';
  if (entry.body_part === 'core' || (primaries.length && primaries.every(g => g === 'core'))) return 'core';
  const group = entry.variation_group;
  if (HINGE_GROUPS.has(group) && entry.body_part !== 'core') return 'legs_pull';
  if (KNEE_GROUPS.has(group)) return 'legs_push';
  if (LEG_PARTS.has(entry.body_part)) {
    if (primaries.includes('quads')) return 'legs_push';
    if (primaries.includes('hamstrings') || primaries.includes('glutes')) return 'legs_pull';
    return 'legs_push';
  }
  if (UPPER_PARTS.has(entry.body_part)) {
    if (entry.force_type === 'push') return 'upper_push';
    if (entry.force_type === 'pull') return 'upper_pull';
  }
  return null; // full body or a static upper-body hold: left for the Uncategorized queue
}

function flagsFor(entry) {
  const unranked = entry.category === 'stretching';
  const timed = entry.force_type === 'static';
  // unranked OVERRIDES weightless (no weight field left to reinterpret), so a
  // stretch never carries both.
  const weightless = !unranked && (!!entry.is_bodyweight || LOADLESS_EQUIPMENT.has(entry.equipment));
  return { weightless, timed, unranked };
}

function formNoteFor(entry) {
  const steps = (entry.instructions_en || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const how_to = [entry.description_en, steps].filter(Boolean).join('\n\n');
  const mistakes = (entry.tips_en || []).join('\n');
  return { how_to, mistakes };
}

// Same emoji scheme the curated SUGGESTED_EXERCISES chips use.
function emojiFor(category, flags, entry) {
  if (category === 'stretch_mobility' || flags.unranked) return '🧘';
  if (category === 'legs_push' || category === 'legs_pull') return '🦵';
  if (category === 'core') return '🎯';
  if (flags.weightless) return '🤸';
  if (entry.mechanic === 'isolation') return '💪';
  return '🏋️';
}

function imagePathsFor(entry) {
  const flat = entry.images?.flat || {};
  return [flat.start, flat.peak, flat.main].filter(Boolean).map(p => `repdb/${p}`);
}

function translate(entry) {
  const muscles = muscleMapFor(entry);
  const category = categoryFor(entry, muscles);
  const flags = flagsFor(entry);
  return {
    id: entry.id,
    name: entry.name_en,
    equipment: entry.equipment || null,
    images: imagePathsFor(entry),
    category,
    emoji: emojiFor(category, flags, entry),
    reps: flags.timed ? '30' : '10',
    sets: flags.timed ? 2 : 3,
    ...flags,
    pattern: { hinge_knee: hingeKneeFor(entry), laterality: lateralityFor(entry) },
    muscles,
    formNote: formNoteFor(entry),
  };
}

function readSnapshot(dir = REPDB_DIR) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'exercises.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.exercises;
}

let cached = null;

// The whole library, translated, sorted by name. Computed once per process,
// and again only after installSnapshot replaces it. An install with no
// snapshot is an EMPTY library, not an error: that is every fresh install.
function buildLibrary(dir) {
  if (cached && !dir) return cached;
  if (!dir && !fs.existsSync(path.join(REPDB_DIR, 'exercises.json'))) return [];
  const built = readSnapshot(dir).map(translate).sort((a, b) => a.name.localeCompare(b.name));
  if (!dir) cached = built;
  return built;
}

// What Settings shows: is a snapshot installed, which one, and is it the pin.
function snapshotStatus() {
  let snapshot = null;
  try { snapshot = fs.readFileSync(path.join(REPDB_DIR, 'SNAPSHOT'), 'utf8').trim(); } catch (e) { /* none */ }
  const count = snapshot ? buildLibrary().length : 0;
  return { installed: count > 0, snapshot, pinned: REPDB_SHA, count };
}

// Downloads RepDB's own published tarball at the pin and swaps it in as
// data/repdb. Copies ONLY what the app uses plus the licence record, never
// premium-samples/: the licence (term 6) makes those evaluation-only.
// Everything is built in a temp dir beside the target and moved in with one
// rename, so a failed or interrupted download leaves the old snapshot intact.
// Needs GNU tar (--wildcards), which the Dockerfile installs.
async function installSnapshot(sha = REPDB_SHA) {
  const { execFile } = require('child_process');
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  const dataDir = path.dirname(REPDB_DIR);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dataDir, '.repdb-'));
  try {
    const res = await fetch(`https://codeload.github.com/RepDB/exercise-dataset/tar.gz/${sha}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const tarball = path.join(tmp, 'repdb.tar.gz');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tarball));
    await new Promise((resolve, reject) => execFile('tar', ['-xzf', tarball, '-C', tmp, '--wildcards',
      '*/exercises.json', '*/images/flat/*', '*/LICENSE-DATA.md', '*/ATTRIBUTION.md'],
      { maxBuffer: 1 << 20 }, (err, _out, stderr) => err ? reject(new Error(`unpack failed: ${stderr || err.message}`)) : resolve()));
    const src = fs.readdirSync(tmp).find(n => n.startsWith('exercise-dataset-'));
    if (!src) throw new Error('unexpected archive layout: no exercise-dataset-* directory');

    const next = path.join(tmp, 'repdb');
    fs.mkdirSync(path.join(next, 'images'), { recursive: true });
    for (const f of ['exercises.json', 'LICENSE-DATA.md', 'ATTRIBUTION.md']) fs.renameSync(path.join(tmp, src, f), path.join(next, f));
    fs.renameSync(path.join(tmp, src, 'images', 'flat'), path.join(next, 'images', 'flat'));
    fs.writeFileSync(path.join(next, 'SNAPSHOT'), sha + '\n');

    // Every image the JSON names must exist, or the Form popup renders a
    // broken picture for that exercise with no error anywhere.
    const entries = readSnapshot(next);
    const missing = entries.flatMap(imagePathsFor).filter(p => !fs.existsSync(path.join(next, p.replace(/^repdb\//, ''))));
    if (!entries.length) throw new Error('the snapshot has no exercises');
    if (missing.length) throw new Error(`the snapshot names ${missing.length} missing image(s), e.g. ${missing[0]}`);

    if (fs.existsSync(REPDB_DIR)) fs.renameSync(REPDB_DIR, path.join(tmp, 'old'));
    fs.renameSync(next, REPDB_DIR);
    cached = null;
    return snapshotStatus();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function libraryEntryFor(name, dir) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  return buildLibrary(dir).find(e => e.name.toLowerCase() === key) || null;
}

// Every muscle slug in the snapshot that is neither mapped nor deliberately
// ignored. Empty on a healthy snapshot; verify_backend.js asserts that.
function unmappedMuscleSlugs(dir) {
  const out = new Set();
  for (const e of readSnapshot(dir)) {
    for (const s of [...(e.primary_muscles || []), ...(e.secondary_muscles || [])]) {
      if (!MUSCLE_GROUP[s] && !IGNORED_MUSCLES.has(s)) out.add(s);
    }
  }
  return [...out];
}

module.exports = {
  buildLibrary,
  libraryEntryFor,
  translate,
  unmappedMuscleSlugs,
  MUSCLE_GROUP,
  IGNORED_MUSCLES,
  REPDB_DIR,
  REPDB_SHA,
  snapshotStatus,
  installSnapshot,
};
