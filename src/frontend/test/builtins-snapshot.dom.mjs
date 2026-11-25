// builtins-snapshot.dom.mjs — the rendered-DOM baseline for every built-in registry
// component (builtins/panels.js BUILTIN_PANELS, 27 ids).
//
// Each id mounts through the real ComponentFrame over the snapshot fixture
// (test/fixtures/snapshot-fixture.mjs): a match-scoped id gets matchId 7, a profile
// id gets steam ALPHA. After the reads settle, the frame's markup is normalised
// (inter-tag whitespace only) and compared with test/snapshots/builtins/<id>.html.
//
// Checks, per id:
//   - the markup equals the stored snapshot (a changed snapshot is a regression
//     unless the change is intended, in which case rerun with --update and review
//     the diff);
//   - a second mount of the same id produces identical markup (determinism);
//   - nothing escapes the mount as an uncaught error.
//
// Run (from frontend/):  node test/builtins-snapshot.dom.mjs
//                        node test/builtins-snapshot.dom.mjs --update
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';
import { snapshotReads, MATCH_ID, ALPHA } from './fixtures/snapshot-fixture.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UPDATE = process.argv.includes('--update');
const SNAP_DIR = join('test', 'snapshots', 'builtins');
mkdirSync(SNAP_DIR, { recursive: true });

const h = await boot('builtins-snapshot');
const reads = snapshotReads();
const ids = Object.keys(h.panels);

// The profile surface (the Profile view and its panels) is steam-scoped; every other
// registry id is match-scoped.
const contextFor = (id) =>
  id.startsWith('profile') ? { matchId: null, steamId: ALPHA, round: null } : { matchId: MATCH_ID, steamId: null, round: null };

// normalise: the frame's markup without the noise that is not rendered behaviour:
//   - Svelte's empty anchor comments (<!---->), which mark template positions and
//     move when a template is restructured but change nothing on screen;
//   - inter-tag whitespace, and the spacing inside class attributes.
// Text, attributes, element order and every real node stay in the snapshot.
const normalise = (el) =>
  el.innerHTML
    .replace(/<!---->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/class="([^"]*)"/g, (_, c) => `class="${c.split(/\s+/).filter(Boolean).join(' ')}"`)
    .trim() + '\n';

async function render(id) {
  const { target, cleanup } = await h.mountComponent(h.panels[id], contextFor(id), {}, reads);
  await h.settle(300);
  const html = normalise(target);
  cleanup();
  return html;
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log(`Built-in snapshots: ${ids.length} registry ids${UPDATE ? ' (updating)' : ''}`);
for (const id of ids) {
  const first = await render(id);
  const second = await render(id);
  check(`${id}: a second mount renders identically`, first === second, 'the markup depends on mount order or timing');
  const file = join(SNAP_DIR, `${id}.html`);
  if (UPDATE) {
    writeFileSync(file, first);
    console.log(`  wrote ${file}`);
  } else if (!existsSync(file)) {
    check(`${id}: a snapshot exists`, false, `run with --update to create ${file}`);
  } else {
    check(`${id}: markup matches its snapshot`, readFileSync(file, 'utf8') === first, `diff ${file} against a fresh render`);
  }
}

check('no uncaught error escaped a mount', h.escaped.length === 0, h.escaped.map((e) => e && e.message).join('; '));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(0);
