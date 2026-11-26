// builtins-snapshot.dom.mjs — mount smoke for every built-in registry component
// (builtins/panels.js BUILTIN_PANELS, 27 ids).
//
// WHY THIS IS STILL HERE: the rendered-DOM snapshots (test/snapshots/builtins/<id>.html)
// were removed at the end of the built-in component campaign. Built-in panels are expected
// to change extensively, so a stored markup baseline recorded churn rather than
// regressions. What remains is the infrastructure a future baseline or smoke test needs:
// the mount of each registry id through the real ComponentFrame over the snapshot fixture
// (test/fixtures/snapshot-fixture.mjs), and the fixture itself. Re-add a comparison here
// if a future change needs one.
//
// Checks, per id:
//   - a second mount of the same id produces identical markup (determinism);
//   - nothing escapes the mount as an uncaught error.
//
// Run (from frontend/):  node test/builtins-snapshot.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';
import { snapshotReads, MATCH_ID, ALPHA } from './fixtures/snapshot-fixture.mjs';

const h = await boot('builtins-snapshot');
const reads = snapshotReads();
const ids = Object.keys(h.panels);

// The profile surface (the Profile view and its panels) is steam-scoped; every other
// registry id is match-scoped.
const contextFor = (id) =>
  id.startsWith('profile') ? { matchId: null, steamId: ALPHA, round: null } : { matchId: MATCH_ID, steamId: null, round: null };

// The frame's markup without Svelte's anchor comments and inter-tag whitespace.
const normalise = (el) => el.innerHTML.replace(/<!---->/g, '').replace(/>\s+</g, '><').trim() + '\n';

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

console.log(`Built-in mount smoke: ${ids.length} registry ids`);
for (const id of ids) {
  const first = await render(id);
  const second = await render(id);
  check(`${id}: a second mount renders identically`, first === second, 'the markup depends on mount order or timing');
}

check('no uncaught error escaped a mount', h.escaped.length === 0, h.escaped.map((e) => e && e.message).join('; '));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(0);
