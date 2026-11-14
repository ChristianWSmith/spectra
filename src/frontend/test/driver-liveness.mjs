// The one liveness guard for the jsdom drivers (test/*.dom.mjs).
//
// Why this exists: a driver that throws at mount() before its first
// assertion can still exit 0 — the driver's own uncaughtException
// handler swallows the error (it only adds to `errors`, and the tail
// that folds `errors` into the exit code never runs), so node --test
// files it as a bare PASS with ZERO checks executed. Six drivers were
// caught dead this way at the 2026-11-12 audit (confirm-dialog,
// landmark-row, match-picker, payload-tree, round-strip, stat-card —
// all missing the svelte browser-condition resolve hook), and the same
// disease had already hidden replay.dom.mjs once. A vacuous run and a
// green run look identical in the suite output, so this meta-test
// re-runs every driver and pins how many checks each one must actually
// execute.
//
// Design notes:
// - EXPECTED is the opt-in table. A NEW test/*.dom.mjs file is not in
//   it, and the sync test below fails loudly until its real check count
//   is added — additions must opt in with their executed-check count.
//   Values are minimums: legitimately removing checks re-pins the
//   number here, deliberately, never silently.
// - "Checks" = the drivers' own `  ok` / `  FAIL` line protocol (the
//   check() helper every driver defines) plus ✔ node:test assertions
//   (voice-engine.dom.mjs is the one node:test-based driver).
// - Each probe runs with cwd = a private temp "farm" (symlinks to src,
//   test, public and node_modules-minus-.cache). Drivers compile their
//   harnesses into node_modules/.cache/spectra-dom-tests/<name>/, and
//   the suite runs that same driver against the SHARED cache at the
//   same time this guard re-runs it — two writers of one file would
//   race (truncate vs read) and make this guard itself flaky. The farm
//   gives every probe a private write root while reads follow symlinks
//   into the real tree; it is removed after the probes.
// - Probes add `--preserve-symlinks --preserve-symlinks-main` (via
//   NODE_OPTIONS): drivers resolve cwd-relative URLs (their stub
//   redirects, fileURL('src/lib/…') rewrites) while the loader
//   REALPATHS ordinary resolutions through the farm's symlinks — under
//   default flags one process then holds TWO instances of a stub (the
//   shortCircuit redirect URL and the realpath diverge) and the checks
//   fail for real. With the flags every resolution is keyed by the farm
//   URL, so the identity scheme is uniform. Verified equivalent: all 22
//   drivers execute the same checks as a plain run.
// - This file and esm-dir-hook.mjs are helpers, not drivers: discovery
//   is `*.dom.mjs`, which is why this guard is named without `.dom`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readdirSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const PROBE_TIMEOUT_MS = 180_000;
const PROBE_POOL = 4;

// Minimum executed checks per driver (see header). Counts as of the
// 2026-11-12 revival audit — the six revived drivers went 0 → their
// real number here; settings re-pinned 61 → 73 when the concurrent-
// imports control added its section H (2026-11-13), and 73 → 74 when
// that control was replaced by the machine-level "Parallel work" knob
// in its own card (one extra check: the old control's absence);
// econ-tables re-pinned 94 → 98 when section J added the scoreboard
// metric-header cap pins (2026-11-13), and 98 → 100 when the short_name
// display-criterion pin was added (2026-11-13); builder.dom.mjs entered
// with 38 (2026-11-13 — the Builder list filter toggles + built-in
// immutability wave: a NEW driver, the Builder view having had no
// harness of its own).
// W4 (stored-metrics read path, 2026-11-13): builder 38 → 56 (section I
// — state chips on list items + editor card, k/N progress, metric-done
// refetch, the draft-vs-saved preview criterion, no-version pin) and
// econ-tables 100 → 107 (section G — the Match value-slot state machine:
// five states + the honest dash + no-version pin); profiles 45 → 51
// (section I — PlayerProfile's Career metrics panel); reports.dom.mjs is
// NEW at 16 (the flat match-scope list, the stored read, the export
// copy, the behind chip + "value not computed" line, the live feed and
// the no-version pin).
// Dogfooding W1 (metric ordering, 2026-11-14): builder 56 → 72 (section
// J — the Order dialog: entry point, two stacked sections, read-only
// fixed block, write-through keyboard/button moves, Reset → Delete,
// read-only pin indicator, Close) and reports 16 → 18 (section G — the
// appendix list follows the match order pref: saved order re-sequences,
// key gone → default sequence).
// Dogfooding W3 (profile surface, 2026-11-14): profiles 51 → 67 (section
// J — the converted card set is 4 fixed cards, the Career metrics panel
// renders the nine DEFAULT pins in DEFAULT order over a reversed
// catalog, and the Profiles ADR column is metric-backed: stored value,
// honest gap, behind chip, metric-value sort with gaps last).
const EXPECTED = {
  'app-dock.dom.mjs': 59,
  'builder.dom.mjs': 72,
  // combat 75 → 86 (2026-11-14, dogfooding W2): +2 section J (the KAST
  // cell renders the metric value; the dialog header reads it — the
  // client-side fallback's 100% would disagree with the stored 50%),
  // +2 section L (a dead backend now surfaces the metric-slot alert too
  // — two dismissals), +7 the new section M (header positions, the
  // default KAST-metric order, value/dash cells, the behind chip).
  'combat.dom.mjs': 86,
  'compare-rounds.dom.mjs': 27,
  'confirm-dialog.dom.mjs': 20,
  // econ-tables 107 → 108 (2026-11-14, dogfooding W2): −3 the KAST%
  // error-dismissal sub-checks (combatError died with the KAST% metric
  // column), +4 the new section K (fixed block first, the four
  // converted metric columns after it, the m5-mth cap scope, the
  // fmtMetric cell values).
  'econ-tables.dom.mjs': 108,
  'heatmap-layer.dom.mjs': 49,
  'landmark-row.dom.mjs': 33,
  'library.dom.mjs': 167,
  'map-pack-prompt.dom.mjs': 48,
  'match-picker.dom.mjs': 43,
  'payload-tree.dom.mjs': 21,
  'player-card.dom.mjs': 174,
  'player-search-hint.dom.mjs': 21,
  // profiles 45 → 51 (section I — PlayerProfile's Career metrics panel),
  // then 51 → 67 for dogfooding W3 (section J — see the header note).
  'profiles.dom.mjs': 67,
  'progress-presentation.dom.mjs': 19,
  'replay.dom.mjs': 450,
  'reports.dom.mjs': 18,
  'round-detail.dom.mjs': 64,
  'round-strip.dom.mjs': 47,
  'settings.dom.mjs': 74,
  'stat-card.dom.mjs': 12,
  'utility.dom.mjs': 39,
  'voice-engine.dom.mjs': 7,
};

const driverFiles = () =>
  readdirSync(join(FRONTEND, 'test'))
    .filter((f) => f.endsWith('.dom.mjs'))
    .sort();

// Checks = the drivers' `  ok` / `  FAIL` line protocol plus node:test
// ✔ assertions (voice-engine.dom.mjs). The runner's file-level wrapper
// line (`✔ test/<file>.dom.mjs (…ms)`) is NOT a check — excluding it is
// what makes a dead driver count 0 instead of 1.
const countChecks = (out) =>
  out
    .split('\n')
    .filter(
      (l) =>
        /^ {2}(?:ok|FAIL) /.test(l) ||
        (/^✔\s/.test(l) && !l.includes('.dom.mjs')),
    ).length;

// The driver's own failure lines first, else its last few lines — what
// someone needs to see when a probe comes back dead or short.
const diagnose = (out) => {
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  const errs = lines
    .filter((l) => /FAIL|UNCAUGHT|REJECTION|Error|FAILED/.test(l))
    .slice(0, 6);
  return (errs.length ? errs : lines.slice(-3)).join('\n      ');
};

// A probe: run the driver exactly as the suite does (node --test, one
// file, cwd = the private farm) and count what it executed.
const probe = (file, farm) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    // The suite's own test-runner context must not leak into the probe.
    delete env.NODE_TEST_CONTEXT;
    // Uniform farm-URL module identity — see the header's preserve-
    // symlinks note; without it the farm splits stub instances.
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--preserve-symlinks --preserve-symlinks-main`;
    const child = spawn(process.execPath, ['--test', join('test', file)], {
      cwd: farm,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, checks: countChecks(out), out });
    });
  });

test('every test/*.dom.mjs driver is pinned in EXPECTED (new drivers opt in with their real check count)', () => {
  const files = driverFiles();
  const unlisted = files.filter((f) => !(f in EXPECTED));
  const stale = Object.keys(EXPECTED).filter((f) => !files.includes(f));
  assert.deepEqual(
    unlisted,
    [],
    `unlisted driver file(s) — add them to EXPECTED with their real executed-check count: ${unlisted.join(', ')}`,
  );
  assert.deepEqual(
    stale,
    [],
    `stale EXPECTED entr(ies) — no such driver file: ${stale.join(', ')}`,
  );
});

test('every driver actually executes its pinned checks and exits 0 (re-run from a private cwd farm)', async () => {
  const farm = mkdtempSync(join(tmpdir(), 'spectra-driver-liveness-'));
  try {
    // The farm: drivers resolve every relative path (src/, test/,
    // public/, node_modules/<pkg> and their own cache writes) against
    // cwd. Reads are symlinked to the real tree; only node_modules/
    // itself is a real directory so the .cache write root is PRIVATE
    // (.cache is deliberately not symlinked).
    for (const entry of ['src', 'test', 'public']) {
      symlinkSync(join(FRONTEND, entry), join(farm, entry), 'dir');
    }
    mkdirSync(join(farm, 'node_modules'));
    for (const entry of readdirSync(join(FRONTEND, 'node_modules'))) {
      if (entry === '.cache') continue;
      symlinkSync(join(FRONTEND, 'node_modules', entry), join(farm, 'node_modules', entry));
    }

    const queue = driverFiles().filter((f) => f in EXPECTED);
    const results = new Map();
    const workers = Array.from(
      { length: Math.min(PROBE_POOL, queue.length) },
      async () => {
        while (queue.length) {
          const file = queue.shift();
          results.set(file, await probe(file, farm));
        }
      },
    );
    await Promise.all(workers);

    const dead = [];
    for (const [file, min] of Object.entries(EXPECTED)) {
      const r = results.get(file);
      if (!r) {
        dead.push(`${file}: never probed`);
      } else if (r.signal || r.code !== 0) {
        dead.push(
          `${file}: exited ${r.code === null ? 'via signal ' + r.signal : 'code ' + r.code} before reporting\n      ${diagnose(r.out)}`,
        );
      } else if (r.checks < min) {
        dead.push(
          `${file}: executed ${r.checks} check(s), pinned minimum ${min} — vacuous exit 0\n      ${diagnose(r.out)}`,
        );
      }
    }
    assert.deepEqual(
      dead,
      [],
      `dead driver(s) — executing zero/short of checks while reporting PASS:\n      ${dead.join('\n      ')}`,
    );
  } finally {
    rmSync(farm, { recursive: true, force: true });
  }
});
