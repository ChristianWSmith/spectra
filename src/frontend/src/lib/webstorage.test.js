// Enforcement pin for the amended web-storage rule (AGENTS "Frontend
// helpers" + lib/keepalive.js): sessionStorage / localStorage are
// FORBIDDEN as view-state stores — the process-scoped registry
// (lib/viewstate.svelte.js) is the one sanctioned module-scoped
// view-state exception, and the URL is the only durable navigation
// record. The rule used to live in prose only (nothing scanned for it);
// this makes it fail the suite instead.
//
// The scan covers every source file under src/frontend/src/ (tests are
// excluded — they may name the stores to pin them). Comments are
// stripped first: the amended comments themselves NAME the forbidden
// stores, which is the point of the wording. sessionStorage must not
// survive as code ANYWHERE; localStorage is confined to the three
// pre-existing durable-PREF sites below — theme, the font-size
// pre-paint cache and pinned-metrics are preferences that legitimately
// survive a restart (they are not view state; moving them onto the
// kvstore is a separate decision, out of scope for the registry
// ruling). A NEW reference anywhere fails.
// Run: node --test src/lib/webstorage.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The sanctioned durable-pref sites (relative to src/frontend/src/).
// Every one of them stores a PREFERENCE, never view/navigation state.
const PREF_SITES = new Set([
  'lib/theme.js', // 'spectra:theme' — the only store the theme has
  'lib/fontsize.js', // 'spectra:font-size' — pre-paint cache; kvstore is truth
  'lib/views/Match.svelte', // 'spectra:pinned-metrics' (match-scope pins, read side)
  'lib/views/Builder.svelte', // BOTH pin keys — the one writer, scope-routed:
  //   'spectra:pinned-metrics' (match scope → the scoreboard) and
  //   'spectra:pinned-profile-metrics' (profile scope → PlayerProfile's
  //   Career metrics panel; stored-metrics design §3's scope-routed pin)
  'lib/views/PlayerProfile.svelte', // 'spectra:pinned-profile-metrics' (read side)
]);

const SRC_EXT = new Set(['.js', '.svelte', '.mjs']);

// stripComments — remove /* … */ blocks and // … line tails (quote-aware
// so a 'https://…' string never hides the code behind it).
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          quote = c;
          continue;
        }
        if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
  return out;
}

function scan() {
  const root = fileURLToPath(new URL('../', import.meta.url)); // src/frontend/src/
  const hits = [];
  let files = 0;
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`, r);
        continue;
      }
      if (entry.name.endsWith('.test.js')) continue; // tests may name the stores
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !SRC_EXT.has(entry.name.slice(dot))) continue;
      files++;
      const code = stripComments(readFileSync(`${dir}/${entry.name}`, 'utf8'));
      for (const token of ['sessionStorage', 'localStorage']) {
        if (new RegExp(`\\b${token}\\b`).test(code)) hits.push([r, token]);
      }
    }
  };
  walk(root, '');
  return { files, hits };
}

test('web storage fence: sessionStorage never appears in src/ code', () => {
  const { files, hits } = scan();
  // Sanity: the walk must actually see the tree (feed.test.js's fs-scan
  // precedent — a broken walk would pass vacuously).
  assert.ok(files > 30, `walked only ${files} files — the scan is broken`);
  const bad = hits.filter(([, token]) => token === 'sessionStorage');
  assert.deepEqual(bad, [], `sessionStorage references (view state must live in viewstate.svelte.js): ${JSON.stringify(bad)}`);
});

test('web storage fence: localStorage only at the durable-pref sites', () => {
  const { hits } = scan();
  const bad = hits.filter(([rel, token]) => token === 'localStorage' && !PREF_SITES.has(rel));
  assert.deepEqual(
    bad,
    [],
    `localStorage outside the sanctioned durable-pref sites (view state goes through seed/remember): ${JSON.stringify(bad)}`,
  );
  // The allowlist itself is the contract: a site that stopped using
  // localStorage must leave it here (or the fence forgets a real rule).
  const live = new Set(hits.filter(([, t]) => t === 'localStorage').map(([rel]) => rel));
  for (const site of PREF_SITES) {
    assert.ok(live.has(site), `${site} no longer uses localStorage — drop it from PREF_SITES`);
  }
});
