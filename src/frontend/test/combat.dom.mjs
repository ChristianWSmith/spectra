import './compile-worker-node.mjs';
// jsdom driver for Combat: the Kill tags card's column order (round →
// time into round → killer vs victim → distance in metres — no raw-tick
// and no "won by" column), ONE-ROW-PER-KILL merging (a kill's trade +
// traded/untraded facts share one row with its chips — section D — plus
// the opening+untraded pair, the OR multi-select filter behaviour with
// the KIND DROPDOWN chrome (a "Kind" field over a trigger, one checkbox
// per kind in the anchored panel, closed state stating the effective
// filter) and the none-checked = no-filter default pins, and the
// grouping-key precision in E/F), the `traded` kind chip + checkbox (I),
// the Clutches card's won/lost TOGGLE (default won ON / lost OFF — G) and
// its long-event replay loop (H: solo's kill span at the loop length,
// padded-span fallback, unstatable → no ?loop=), the bare round numbers
// under the RD heading (A/B/D) and the Kill tags ROUND scope — the
// round <select> dropdown mirroring Utility's (visible "Round" field
// label, "All rounds" + canonical RD | score options, DEFAULT ROUND 1,
// Kill tags only; N). The clutches title carries no chip (B). The
// retired Combat stats panel and its
// KAST drill-down dialog are GONE (J — no section heading and no KAST
// trigger anywhere), the cold-start gate and the failed-load alert hold
// over the two surviving panels (K, L), and the view never calls the
// retired combat-stats / metric-slot reads (M).
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/combat.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/combat.dom.mjs` — it pins the
// browser condition itself so `svelte` resolves to the client build)
import { registerHooks } from 'node:module';

// svelte's package exports pick the SERVER build without the `browser`
// condition (mount() then throws "lifecycle_function_unavailable"), so the
// driver adds it for every svelte specifier before anything imports one.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'svelte' || specifier.startsWith('svelte/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', ...(context.conditions || [])],
      });
    }
    return nextResolve(specifier, context);
  },
});

const { JSDOM } = await import('jsdom');
const { compile } = await import('svelte/compiler');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver',
  'DOMParser',
]) {
  if (!(k in dom.window)) continue;
  try {
    globalThis[k] = dom.window[k];
  } catch {
    Object.defineProperty(globalThis, k, {
      value: dom.window[k],
      configurable: true,
      writable: true,
    });
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const errors = [];
process.on('uncaughtException', (e) => {
  errors.push(e);
  console.error('UNCAUGHT: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  errors.push(e);
  console.error('REJECTION: ' + (e && e.stack ? e.stack : e));
});

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'combat');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds, nav → router + replay/landmarks → rounds, teams →
// sideparity) — the same copy the landmark-row / stat-card drivers do.
// viewstate.svelte.js is Combat's view-state registry (match-scoped
// seed/remember — see its header; plain JS, copied raw).
for (const rel of ['rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js', 'definitions.js', 'fmt.js', 'players.js', 'viewstate.svelte.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// The view's data source is scripted, never a live Wails backend: the
// driver sets globalThis.__combatData before each mount.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__combatData || {};
// __combatDelay (section K) holds every read back so the cold-start
// loading gate is observable; unset/0 keeps the plain resolve.
// __combatError (section L) makes every read REJECT — the load-failure
// path the dismissible alert is pinned against; unset/0 keeps it plain.
const wait = (v) =>
  globalThis.__combatError
    ? Promise.reject(new Error(globalThis.__combatError))
    : globalThis.__combatDelay
      ? new Promise((res) => setTimeout(() => res(v), globalThis.__combatDelay))
      : Promise.resolve(v);
// The RETIRED reads (the Combat stats panel, its metric slots and the
// KAST drill-down are gone): still exported so a re-import would link,
// but section M arms __combatCalls and pins every one of these at ZERO
// calls. Unarmed (null) the counter stays quiet everywhere else.
const hit = (name) => {
  const c = globalThis.__combatCalls;
  if (c) c[name] += 1;
};
export const getCombatStats = () => { hit('getCombatStats'); return wait(d().stats || []); };
export const getClutches = () => wait(d().clutches || []);
export const getKillTags = () => wait(d().killTags || []);
export const getPlayerRounds = () => { hit('getPlayerRounds'); return wait(d().playerRounds || []); };
export const getRounds = () => wait(d().rounds || []);
export const getScoreboard = () => wait(d().scoreboard || []);
export const getMatch = () => wait(d().match || null);
export const listMetrics = () => { hit('listMetrics'); return wait(d().listMetrics || []); };
export const getMetricValuesForMatch = () => { hit('getMetricValuesForMatch'); return wait(d().metricValues || []); };
export const getMetricComputeState = () => { hit('getMetricComputeState'); return wait(d().metricStates || []); };
export const subscribeMetricProgress = () => { hit('subscribeMetricProgress'); return () => {}; };
export const onMetricDone = () => { hit('onMetricDone'); return () => {}; };
// The one pref read at mount (the loop length) — unset, so the view
// seeds LOOP_SECS_DEFAULT; a link-level getPref is a link error without.
export const getPref = () => Promise.resolve(undefined);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
export const warmProfile = () => {};
`,
);

for (const name of ['EventPlay', 'ProfileLink', 'StatusChip', 'Popover']) {
  svelteCompile(
    // plumbing (Strings Stage 3): these components import the strings
    // catalog — resolve it from the real tree (no-op for the import-less
    // leaves).
    readFileSync(`src/lib/components/${name}.svelte`, 'utf8').replace(
      "from '../strings/index.js'",
      `from '${pathToFileURL('src/lib/strings/index.js').href}'`,
    ),
    `${name}.svelte`,
    join(dir, 'components', `${name}.js`),
  );
}

// TokenSelect is no longer mounted here (the Kill tags round scope is
// a plain <select> — section N, so nothing compiles the chip input
// anymore); Popover IS — the kind filter's multi-select dropdown anchors
// on it (section A), so this driver compiles it beside the view's other
// component imports.

// Combat.svelte → its ../ imports land in dir/ (services.js above, fmt,
// nav, teams, definitions, replay/landmarks are copied there); only the
// svelte component imports need rewriting to their compiled .js.
// The Combat tab is two builtin panels (src/lib/builtins/match):
// they land under dir/builtins/match/, so their ../../
// imports resolve to the copies above. Only the .svelte component imports
// and the strings catalog are rewritten; combatdata.js is plain ESM.
mkdirSync(join(dir, 'builtins', 'match'), { recursive: true });
for (const rel of ['combatdata.js', 'combatmodel.js']) {
  writeFileSync(join(dir, 'builtins', 'match', rel), readFileSync(join('src/lib/builtins/match', rel), 'utf8'));
}
const panelSrc = (name) =>
  readFileSync(`src/lib/builtins/match/${name}.svelte`, 'utf8')
    .replace(/from '\.\.\/\.\.\/components\/(\w+)\.svelte'/g, "from '../../components/$1.js'")
    // plumbing (Strings Stage 3): the panels import the strings catalog —
    // resolve it from the real tree, like every other ../ module here.
    .replace("from '../../strings/index.js'", `from '${pathToFileURL('src/lib/strings/index.js').href}'`);
for (const name of ['CombatKillTags', 'CombatClutches']) {
  svelteCompile(panelSrc(name), `${name}.svelte`, join(dir, 'builtins', 'match', `${name}.js`));
}

// The harness mounts both panels with the match as their context and a stub
// read API whose navigate records the routes (the Combat view's old nav).
const harnessSrc = `<script>
  import KillTags from './builtins/match/CombatKillTags.js';
  import Clutches from './builtins/match/CombatClutches.js';
  const spectra = { navigate: (h) => (globalThis.__nav = (globalThis.__nav || []).concat(h)), track: (p) => p, busy: false };
</script>
<KillTags {spectra} context={{ matchId: 3 }} />
<Clutches {spectra} context={{ matchId: 3 }} />`;
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(harnessOut).href);
// The view-state registry Combat links (the copied file → same
// instance): reset in every scenario's setup — the jsdom cross-talk rule
// in viewstate.svelte.js' header. Each render() is a FRESH mount that
// pins defaults (section B's won/lost, the chip states), so a prior
// section's kind-chip clicks must not restore into it.
const viewstate = await import(pathToFileURL(join(dir, 'viewstate.svelte.js')).href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// mount renders into a fresh target; scenario C remounts after replacing
// the scripted data, so each scenario gets its own root.
async function render(data) {
  globalThis.__combatData = data;
  viewstate.resetViewState();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(mod.default, { target });
  await sleep();
  return target;
}

const sections = (root, heading) =>
  [...root.querySelectorAll('section.panel')].filter((s) =>
    s.querySelector('h2')?.textContent.includes(heading),
  );
const headerTexts = (table) => [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
const rows = (table) => [...table.querySelectorAll('tbody tr')];

// The Kill tags kind filter's DROPDOWN (one per mounted section): the
// trigger button under its "Kind" field label, and the panel only while
// open — openKinds() clicks the trigger and hands back the panel (null
// when the control is not the dropdown yet), kindCheck() the box for one
// kind inside it.
const kindTriggerOf = (sec) => sec?.querySelector('.comb-kind-host button');
const openKinds = async (sec) => {
  const t = kindTriggerOf(sec);
  if (t) click(t);
  await sleep();
  return sec?.querySelector('#comb-kind-pop') || null;
};
const kindCheck = (sec, label) =>
  [...(sec?.querySelectorAll('#comb-kind-pop .filt-check') || [])]
    .find((l) => l.textContent.trim() === label)
    ?.querySelector('input');
const ALL_KINDS = ['opening', 'trade', 'traded', 'untraded'];

// Round 7 starts at tick 10000 at 64 tick — the kill tag at 10640 is
// 640/64 = 10 s INTO that round ("0:10"), never the match clock.
const base = {
  match: { tickRate: 64, sideSwitches: 0 },
  rounds: [
    { number: 6, startTick: 9040, endTick: 10000 },
    { number: 7, startTick: 10000, endTick: 10960 },
  ],
  scoreboard: [
    { steamId: 'A', name: 'alice', side: 'ct' },
    { steamId: 'B', name: 'bob', side: 't' },
  ],
  killTags: [
    { tick: 10640, round: 7, kind: 'opening', aSteam: 'A', aName: 'alice', bSteam: 'B', bName: 'bob', distance: 19.4, wonBy: 'ct' },
    { tick: 10704, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 0, wonBy: 't' },
  ],
  clutches: [
    { id: 1, round: 7, size: 2, steamId: 'D', name: 'dave', won: false, hpLeft: 1, bombState: 'none', replayAnchorTick: 10500, startTick: 10400, endTick: 10700, killTicks: '[10480]' },
    // The WON clutch mirrors the GOLDEN round-7 shape: its span (10200 →
    // 10960 — the making kill → the resolution) is far wider than the
    // SOLO's kills inside it (10700, 10900 — killTicks, ClutchRow's
    // "solo's kills after start"). The ▶ keeps the anchor SEEK
    // (replayAnchorTick) but loops the KILL span padded by the loop
    // length (default 5 s — 10700−320, 10900+320) — never the raw span.
    { id: 2, round: 7, size: 1, steamId: 'C', name: 'carol', won: true, hpLeft: 42, bombState: 'planted', replayAnchorTick: 10600, startTick: 10200, endTick: 10960, killTicks: '[10700,10900]' },
  ],
};

console.log('A. kill tag columns: round → time into round → killer vs victim → dist (m)');
const root = await render(base);
const eng = sections(root, 'Kill tags')[0];
const engTable = eng?.querySelector('table');
check('kill tags table rendered', !!engTable);
check(
  'header order',
  JSON.stringify(headerTexts(engTable)) ===
    JSON.stringify(['Replay', 'RD', 'Time', 'Kind', 'Killer', 'versus', 'Victim', 'Dist (m)']),
  JSON.stringify(headerTexts(engTable)),
);
const engRows = rows(engTable);
check('two kill tag rows', engRows.length === 2, String(engRows.length));
const first = engRows[0]?.querySelectorAll('td') || [];
// The Round cell is TEXT again (owner ruling: "no round play button
// there" — the round-watch ▶ was removed): the bare round number under
// the RD heading (W3a), and the row's ONLY play button is the
// event/follow ▶ in the Replay column (A5 resolved to ONE play button
// per row).
check('round cell renders the bare round number', first[1]?.textContent.trim() === '7', first[1]?.textContent);
check('round cell carries NO button (no round play)', !first[1]?.querySelector('button'), first[1]?.innerHTML);
const engPlayBtn = first[0]?.querySelector('button');
check(
  'A5: ONE play button per row — the event/follow ▶ (killer), no round play',
  first[0]?.querySelectorAll('button').length === 1 &&
    !first[1]?.querySelector('button') &&
    !!engPlayBtn &&
    engPlayBtn.getAttribute('title') === 'Watch this kill — follow alice (killer)',
  JSON.stringify([engPlayBtn?.getAttribute('title'), first[1]?.innerHTML]),
);
check('time cell is time INTO the round', first[2]?.textContent.trim() === '0:10', first[2]?.textContent);
check('raw tick kept in the cell title', first[2]?.getAttribute('title') === 'tick 10640', first[2]?.getAttribute('title'));
check('kind chip intact', first[3]?.textContent.includes('opening'), first[3]?.textContent);
check('killer column holds the killer', first[4]?.textContent.includes('alice'), first[4]?.textContent);
check('victim column holds the victim', first[6]?.textContent.includes('bob'), first[6]?.textContent);
check('distance rounded in metres', first[7]?.textContent.trim() === '19', first[7]?.textContent);
const second = engRows[1]?.querySelectorAll('td') || [];
check('missing distance renders an em dash', second[7]?.textContent.trim() === '—', second[7]?.textContent);
// The kind filter is ONE multi-select DROPDOWN (owner, 2026-11-18): the
// four toggle buttons are gone — a visible "Kind" field label over a
// trigger whose CLOSED state states the effective filter ("All kinds" at
// the none-checked default = the old all-off no-filter), and an anchored
// panel of one checkbox per kind (the victim-side `traded` included —
// there is still no exclusive "all" option). The round selector beside
// it is section N's pin.
const kindHostA = eng.querySelector('.comb-kind-host');
const kindTrigA = kindTriggerOf(eng);
check(
  'kind filter is a dropdown: "Kind" field label over a trigger, no toggle buttons left',
  !!kindHostA &&
    kindHostA.querySelector('.field-label')?.textContent.trim() === 'Kind' &&
    !!kindTrigA &&
    eng.querySelectorAll('.comb-kind').length === 0,
  kindHostA
    ? `toggles=${eng.querySelectorAll('.comb-kind').length} trigger=${kindTrigA?.textContent.trim()}`
    : 'no .comb-kind-host',
);
check(
  'closed state at the default reads "All kinds" and the panel is shut',
  /All kinds/.test(kindTrigA?.textContent || '') && !eng.querySelector('#comb-kind-pop'),
  kindTrigA?.textContent.trim() || 'no trigger',
);
const kindPopA = await openKinds(eng);
check(
  'opening offers one checkbox per kind, ALL unchecked (the all-off default)',
  !!kindPopA &&
    [...kindPopA.querySelectorAll('.filt-check')].map((l) => l.textContent.trim()).join(',') ===
      'opening,trade,traded,untraded' &&
    [...kindPopA.querySelectorAll('input')].every((i) => !i.checked),
  kindPopA
    ? JSON.stringify(
        [...kindPopA.querySelectorAll('.filt-check')].map((l) => [
          l.textContent.trim(),
          l.querySelector('input')?.checked,
        ]),
      )
    : 'no #comb-kind-pop',
);
// The all-off verdict made mechanical: a FRESH mount applies NO kind
// filter — every kill tag row renders (none-checked = all rows, never
// an empty default card).
check(
  'fresh mount: none checked → NO filter — every kill tag row shows',
  rows(engTable).length === 2,
  String(rows(engTable).length),
);
// Escape is the canonical Popover dismissal (the component's contract):
// the panel goes and focus returns to the trigger (the consumer's
// onClose half — outside pointerdown closes without stealing focus).
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep();
check(
  'Escape closes the panel and returns focus to the trigger',
  !eng.querySelector('#comb-kind-pop') && document.activeElement === kindTrigA,
  `pop=${!!eng.querySelector('#comb-kind-pop')} focus=${document.activeElement?.tagName}`,
);

// (B) the kill tag ▶ keeps its seek tick, stamps the loop-length entry
// loop (nav.entryLoopAround — the default 5 s × 64 tick = 320 either
// side) AND the
// KILLER as the camera follow (the owner's rule for kill rows).
check(
  'kill tag ▶ is icon-only play with a follow-aware title',
  !!engPlayBtn && engPlayBtn.textContent.trim() === '' && !!engPlayBtn.querySelector('.codicon-play') &&
    engPlayBtn.getAttribute('title') === 'Watch this kill — follow alice (killer)',
  engPlayBtn?.getAttribute('title'),
);
click(engPlayBtn);
await sleep();
const navEng = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'kill tag ▶ links tick + the loop-length loop + follow=the killer, no filter',
  !!navEng &&
    navEng.includes('tick=10640') &&
    navEng.includes('loop=10320,10960') &&
    navEng.includes('follow=A') &&
    !navEng.includes('cat='),
  navEng || 'no navigation',
);

console.log('B. clutches card: DEFAULT = won ON / lost OFF (today\'s list), kill-span loop');
const clutchSec = sections(root, 'Clutches')[0];
check(
  'the Clutches title bar carries no chip (the title-badge removal, 2026-11-18)',
  !!clutchSec &&
    !clutchSec.querySelector('h2 .chip') &&
    !clutchSec.querySelector('h2 .provenance') &&
    clutchSec.querySelector('h2')?.textContent.trim() === 'Clutches',
  clutchSec?.querySelector('h2')?.textContent,
);
const clutchRows = rows(clutchSec?.querySelector('table') || document.createElement('table'));
check('one clutch row (the won one)', clutchRows.length === 1, String(clutchRows.length));
check('won clutch shown', clutchSec?.textContent.includes('carol'), '');
check('lost clutch dropped by default', !clutchSec?.textContent.includes('dave'), '');
check('lost clutch HP-left (1) gone with it', !clutchRows.some((r) => r.textContent.includes('1v2')), '');
check('HP left column kept', clutchRows[0]?.textContent.includes('42'), clutchRows[0]?.textContent);
check(
  'default toggle state: won active, lost inactive',
  [...clutchSec.querySelectorAll('.comb-kinds .comb-kind')].map(
    (b) => `${b.textContent.trim()}:${b.classList.contains('active')}`,
  ).join(',') === 'won:true,lost:false',
  [...clutchSec.querySelectorAll('.comb-kinds .comb-kind')].map((b) => b.textContent.trim()).join(','),
);

// (B) the clutch ▶ keeps its anchor SEEK (replayAnchorTick) and follows
// the CLUTCH's solo — but the ?loop= is the LONG-EVENT rule: the solo's
// kill span (killTicks 10700 → 10900) padded by the loop length
// (default 5 s = 320 ticks at 64
// tick) → 10380,11220. The raw span (10200,10960 — the making kill →
// the resolution) must NOT appear: golden round 7's creating kill
// (~13:34) is the teammate's death, not the solo's first kill (~14:10).
const clutchPlay = clutchRows[0]?.querySelector('td button');
check(
  'clutch ▶ is icon-only play naming the solo it follows',
  !!clutchPlay && clutchPlay.textContent.trim() === '' && !!clutchPlay.querySelector('.codicon-play') &&
    clutchPlay.getAttribute('title') === 'Watch this clutch — follow carol',
  clutchPlay?.getAttribute('title'),
);
click(clutchPlay);
await sleep();
const navClutch = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'clutch ▶ links tick + the KILL-span loop (not the raw span) + follow=the solo',
  !!navClutch &&
    navClutch.includes('tick=10600') &&
    navClutch.includes('loop=10380,11220') &&
    !navClutch.includes('loop=10200,10960') &&
    navClutch.includes('follow=C') &&
    !navClutch.includes('cat='),
  navClutch || 'no navigation',
);
// …and the clutch Round cell is TEXT too: the bare round number with no
// round play — the clutch ▶ above is the row's only play button.
const clutchCells = clutchRows[0]?.querySelectorAll('td') || [];
check(
  'clutch round cell renders the bare round number, no button',
  clutchCells[1]?.textContent.trim() === '7' && !clutchCells[1]?.querySelector('button'),
  clutchCells[1]?.textContent,
);
check(
  'clutch row has exactly ONE play button (the event/follow ▶)',
  clutchRows[0].querySelectorAll('button').length === 1,
  String(clutchRows[0].querySelectorAll('button').length),
);

console.log('C. only lost clutches + default toggles → explicit empty state');
document.body.removeChild(root);
const root2 = await render({ ...base, clutches: [base.clutches[0]] });
const clutchSec2 = sections(root2, 'Clutches')[0];
check(
  'no-won-clutches message (default won-only selection)',
  clutchSec2?.textContent.includes('No won clutches in this match.'),
  clutchSec2?.textContent.slice(0, 120),
);

// The kind filter's checkboxes live in the Kill tags section's
// dropdown panel (each scenario mounts its own root, so the helper is
// scoped per section); openKinds() above opens the panel first — a
// scenario keeps it open while it works the boxes.

console.log('D. one kill, one row: the same-tick trade+untraded pair merges (the reported bug)');
document.body.removeChild(root2);
// The real seq 30/31 shape: same round, tick, killer, victim AND
// distance in BOTH fetched rows — only Kind differs (two true statements
// about ONE kill — killer-side fact + victim-side fact — not a
// duplicate emission; Go keeps emitting both per-kind rows).
const pairKill = {
  tick: 10640,
  round: 7,
  aSteam: 'A',
  aName: 'alice',
  bSteam: 'B',
  bName: 'bob',
  distance: 7.888,
  wonBy: 'ct',
};
const rootD = await render({
  ...base,
  killTags: [
    { ...pairKill, kind: 'trade' },
    { ...pairKill, kind: 'untraded' },
  ],
});
const engD = sections(rootD, 'Kill tags')[0];
const tableD = engD?.querySelector('table');
check('kill tags table rendered', !!tableD);
const dRows = rows(tableD);
check('TWO fetched rows render as ONE', dRows.length === 1, String(dRows.length));
const dCells = dRows[0]?.querySelectorAll('td') || [];
check(
  'one distance cell — the shared 7.888 rounds to 8 m exactly once',
  dCells.length === 8 && dCells[7]?.textContent.trim() === '8',
  `${dCells.length} cells / dist="${dCells[7]?.textContent}"`,
);
const dChips = [...(dRows[0]?.querySelectorAll('.comb-kind-chip') || [])];
check(
  'the single row carries BOTH kind chips, side by side',
  JSON.stringify(dChips.map((c) => c.textContent.trim())) === '["trade","untraded"]',
  JSON.stringify(dChips.map((c) => c.textContent.trim())),
);
check(
  'each chip keeps its own perspective-explicit title (killer side / victim side)',
  /killer side/.test(dChips[0]?.getAttribute('title') || '') &&
    /victim side/.test(dChips[1]?.getAttribute('title') || ''),
  JSON.stringify(dChips.map((c) => c.getAttribute('title'))),
);
check(
  'the Kind cell carries an accessible combined label (one kill, both facts)',
  /One kill/.test(dCells[3]?.textContent || '') && /killer side/.test(dCells[3]?.textContent || ''),
  dCells[3]?.textContent,
);
// The A5 ruling holds on the MERGED row too: ONE play button (the
// event/follow ▶) and the Round cell as plain text.
const dPlay = dCells[0]?.querySelector('button');
check(
  'A5 on the merged row: ONE play button (no round play beside it)',
  dRows[0].querySelectorAll('button').length === 1 && !!dPlay && !dCells[1]?.querySelector('button'),
  JSON.stringify([dPlay?.getAttribute('title'), String(dRows[0].querySelectorAll('button').length)]),
);
check(
  'the merged row ▶ still follows the killer',
  dPlay?.getAttribute('title') === 'Watch this kill — follow alice (killer)',
  dPlay?.getAttribute('title'),
);
check(
  'the merged round cell keeps its bare round number (no round play)',
  dCells[1]?.textContent.trim() === '7' && !dCells[1]?.querySelector('button'),
  dCells[1]?.textContent,
);

// The kind CHECKBOXES filter merged rows by CONTAINED kind, OR'd: the
// row shows under trade AND under untraded (both checked → once, not
// twice), unchecking every box removes the filter (all rows — the
// none-checked default), checking every box is the SAME every-row
// filter (closed state reads "All kinds" either way), and checking only
// a kind the pair does not carry empties the table.
const dMatched = () => !tableD.textContent.includes('No kill tags match this filter.');
const popD = await openKinds(engD);
click(kindCheck(engD, 'trade'));
await sleep();
check(
  'checking trade → the merged row shows, its box is checked (opening stays clear)',
  rows(tableD).length === 1 && dMatched() &&
    kindCheck(engD, 'trade')?.checked === true &&
    kindCheck(engD, 'opening')?.checked === false,
  String(rows(tableD).length),
);
click(kindCheck(engD, 'untraded'));
await sleep();
check(
  'OR union: trade+untraded both checked → the SAME row shows once (both chips still on it)',
  rows(tableD).length === 1 && dMatched() &&
    [...tableD.querySelectorAll('.comb-kind-chip')].length === 2 &&
    kindCheck(engD, 'trade')?.checked === true &&
    kindCheck(engD, 'untraded')?.checked === true,
  String(rows(tableD).length),
);
click(kindCheck(engD, 'trade'));
click(kindCheck(engD, 'untraded'));
await sleep();
check(
  'uncheck-all → no filter → every row shows (none-checked default, never an empty card) and the closed state reads "All kinds"',
  rows(tableD).length === 1 && dMatched() &&
    [...popD.querySelectorAll('input')].every((i) => !i.checked) &&
    /All kinds/.test(kindTriggerOf(engD)?.textContent || ''),
  String(rows(tableD).length),
);
for (const k of ALL_KINDS) click(kindCheck(engD, k));
await sleep();
check(
  'ALL FOUR checked → the same every-row filter as none checked, closed state still "All kinds"',
  rows(tableD).length === 1 && dMatched() &&
    [...popD.querySelectorAll('input')].every((i) => i.checked) &&
    /All kinds/.test(kindTriggerOf(engD)?.textContent || ''),
  String(rows(tableD).length),
);
for (const k of ALL_KINDS) click(kindCheck(engD, k));
await sleep();
click(kindCheck(engD, 'opening'));
await sleep();
check(
  'opening alone → no match (the pair carries no opening fact)',
  !dMatched() && tableD.textContent.includes('No kill tags match this filter.'),
  tableD.textContent.slice(-90),
);

console.log('E. the real seq 27/28 shape: an opening+untraded pair merges too');
document.body.removeChild(rootD);
const pairKill2 = {
  tick: 10640,
  round: 7,
  aSteam: 'A',
  aName: 'alice',
  bSteam: 'B',
  bName: 'bob',
  distance: 12.5,
  wonBy: 'ct',
};
const rootE = await render({
  ...base,
  killTags: [
    { ...pairKill2, kind: 'opening' },
    { ...pairKill2, kind: 'untraded' },
  ],
});
const engE = sections(rootE, 'Kill tags')[0];
const tableE = engE?.querySelector('table');
const eRows = rows(tableE);
check('opening+untraded renders ONE row', eRows.length === 1, String(eRows.length));
const eChips = [...(eRows[0]?.querySelectorAll('.comb-kind-chip') || [])];
check(
  'both chips present, in the fetch (kind) order',
  JSON.stringify(eChips.map((c) => c.textContent.trim())) === '["opening","untraded"]',
  JSON.stringify(eChips.map((c) => c.textContent.trim())),
);
// Explicit OR pin: the opening+untraded pair shows under EITHER checked
// box alone and — both checked — exactly once (union, never a duplicate).
await openKinds(engE);
click(kindCheck(engE, 'opening'));
await sleep();
check(
  'checking opening → the merged row shows',
  rows(tableE).length === 1 && !tableE.textContent.includes('No kill tags match this filter.'),
  String(rows(tableE).length),
);
click(kindCheck(engE, 'untraded'));
await sleep();
check(
  'OR union: opening+untraded both checked → the SAME row shows once, both boxes checked',
  rows(tableE).length === 1 &&
    !tableE.textContent.includes('No kill tags match this filter.') &&
    [...tableE.querySelectorAll('.comb-kind-chip')].length === 2 &&
    kindCheck(engE, 'opening')?.checked === true &&
    kindCheck(engE, 'untraded')?.checked === true,
  JSON.stringify([
    rows(tableE).length,
    [...tableE.querySelectorAll('.comb-kind-chip')].length,
  ]),
);

console.log('F. grouping precision: same tick, DIFFERENT pair stays its own row; fetch order preserved');
document.body.removeChild(rootE);
const rootF = await render({
  ...base,
  killTags: [
    // an EARLIER single-kill row…
    { tick: 10500, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 0, wonBy: 't' },
    // …the merged pair (its two rows share round+tick+killer+victim)…
    { ...pairKill, kind: 'trade' },
    { ...pairKill, kind: 'untraded' },
    // …and a DIFFERENT kill at the SAME tick (the other pair): the
    // grouping key carries killer+victim, so it must NOT merge.
    { tick: 10640, round: 7, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 4, wonBy: 't' },
  ],
});
const tableF = sections(rootF, 'Kill tags')[0]?.querySelector('table');
const fRows = rows(tableF);
check('three rows: earlier single + merged pair + same-tick other pair', fRows.length === 3, String(fRows.length));
const fCells = (i) => fRows[i]?.querySelectorAll('td') || [];
check(
  'fetch order (round → tick → kind) preserved: merged row sits at its earliest member',
  fCells(0)[2]?.getAttribute('title') === 'tick 10500' &&
    fCells(1)[2]?.getAttribute('title') === 'tick 10640' &&
    fCells(2)[2]?.getAttribute('title') === 'tick 10640',
  [fCells(0)[2], fCells(1)[2], fCells(2)[2]].map((c) => c?.getAttribute('title')).join(' | '),
);
check(
  'the pair merges to one two-chip row…',
  [...fRows[1].querySelectorAll('.comb-kind-chip')].length === 2 &&
    fRows[1].textContent.includes('alice'),
  fRows[1]?.textContent,
);
check(
  '…while the same-tick DIFFERENT pair stays its own one-chip row',
  [...fRows[2].querySelectorAll('.comb-kind-chip')].length === 1 &&
    fRows[2].textContent.includes('bob'),
  fRows[2]?.textContent,
);

console.log('G. clutches won/lost TOGGLE: default won ON/lost OFF → both ON → won OFF → both OFF');
document.body.removeChild(rootF);
const rootG = await render(base);
const clutchSecG = sections(rootG, 'Clutches')[0];
const outBtn = (label) =>
  [...(clutchSecG?.querySelectorAll('.comb-kinds .comb-kind') || [])].find(
    (b) => b.textContent.trim() === label,
  );
const gTable = () => clutchSecG?.querySelector('table');
const gRows = () => rows(gTable() || document.createElement('table'));
const gChips = (tr) =>
  [...(tr?.querySelectorAll('td .chip.status') || [])].map((c) =>
    `${c.textContent.trim()}/${c.classList.contains('ok') ? 'ok' : c.classList.contains('bad') ? 'bad' : '?'}`,
  );
check('default: the won row only', gRows().length === 1 && gRows()[0]?.textContent.includes('carol'), String(gRows().length));

click(outBtn('lost'));
await sleep();
check(
  'lost ON → BOTH rows, the lost one wearing its lost/bad status chip',
  gRows().length === 2 &&
    gChips(gRows().find((r) => r.textContent.includes('dave'))).join(',') === 'lost/bad',
  JSON.stringify([gRows().length, gRows().map(gChips)]),
);

click(outBtn('won'));
await sleep();
check(
  'won OFF → lost-only list',
  gRows().length === 1 && gRows()[0]?.textContent.includes('dave') &&
    !clutchSecG?.textContent.includes('carol'),
  JSON.stringify(gRows().map((r) => r.textContent.slice(0, 40))),
);

click(outBtn('lost'));
await sleep();
check(
  'both OFF → filter-aware empty state (not a "no clutches" claim)',
  !gTable() &&
    clutchSecG?.textContent.includes('No clutch outcome selected — toggle won or lost above.'),
  clutchSecG?.textContent.slice(0, 200),
);
check(
  'the Clutches title stays chip-free here too (no badge anywhere on the heading)',
  !clutchSecG?.querySelector('h2 .chip'),
  clutchSecG?.querySelector('h2')?.textContent,
);
// …and the selection is LOCAL: no navigation happens for a toggle (a
// state-retention ruling is pending — these never reach the route query).
const navLenBeforeToggle = (globalThis.__nav || []).length;
click(outBtn('won'));
await sleep();
check(
  'toggle state stays local (no navigation, no route-query stamp)',
  (globalThis.__nav || []).length === navLenBeforeToggle &&
    !(globalThis.__nav || []).some((h) => h.includes('won=') || h.includes('lost=')),
  JSON.stringify((globalThis.__nav || []).slice(-1)),
);

console.log('H. clutch loop edges: no-kill span is PADDED by the loop length; unstatable bounds stamp no loop=');
document.body.removeChild(rootG);
const rootH = await render({
  ...base,
  clutches: [
    // Won clutch whose solo recorded NO kill in-span (bomb/time win):
    // the fallback is the raw span PADDED by the loop length (default
    // 5 s — 10480−320, 10960+320)
    // — never the bare span. killTicks is Go's NIL-slice wire form
    // ("null" — json.Marshal of a nil []int); "[]", "" and garbage all
    // take this same no-kills path (clutchKillTicks never guesses).
    { id: 3, round: 7, size: 1, steamId: 'C', name: 'carol', won: true, hpLeft: 42, bombState: 'planted', replayAnchorTick: 10600, startTick: 10480, endTick: 10960, killTicks: 'null' },
    // Unstatable bounds (never-a-promise): no ?loop= at all, the seek
    // still fires.
    { id: 4, round: 7, size: 2, steamId: 'D', name: 'dave', won: true, hpLeft: 1, bombState: 'none', replayAnchorTick: 10500, startTick: undefined, endTick: undefined, killTicks: '' },
  ],
});
const hRows = rows(sections(rootH, 'Clutches')[0]?.querySelector('table') || document.createElement('table'));
check('both fallback clutches listed (won ON by default)', hRows.length === 2, String(hRows.length));
click(hRows[0]?.querySelector('td button'));
await sleep();
const navH1 = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'solo without kills → PADDED span loop (entryLoopSpanAround), not the raw span',
  !!navH1 && navH1.includes('loop=10160,11280') && !navH1.includes('loop=10480,10960'),
  navH1 || 'no navigation',
);
click(hRows[1]?.querySelector('td button'));
await sleep();
const navH2 = (globalThis.__nav || [])[(globalThis.__nav || []).length - 1];
check(
  'unstatable bounds → NO ?loop= (seek still stamped)',
  !!navH2 && navH2.includes('tick=10500') && !navH2.includes('loop='),
  navH2 || 'no navigation',
);

console.log('I. the `traded` kind: chip + victim-side title + contained-kind filter');
document.body.removeChild(rootH);
const tradedKill = {
  tick: 10640,
  round: 7,
  aSteam: 'A',
  aName: 'alice',
  bSteam: 'B',
  bName: 'bob',
  distance: 7.888,
  wonBy: 'ct',
};
const rootI = await render({
  ...base,
  killTags: [
    // ONE kill answered on the killer side (trade) AND on the victim
    // side (traded) — the merged row wears both chips.
    { ...tradedKill, kind: 'trade' },
    { ...tradedKill, kind: 'traded' },
  ],
});
const engI = sections(rootI, 'Kill tags')[0];
const tableI = engI?.querySelector('table');
const iRows = rows(tableI);
check('trade+traded merge into ONE row', iRows.length === 1, String(iRows.length));
const iChips = [...(iRows[0]?.querySelectorAll('.comb-kind-chip') || [])];
check(
  'the merged row carries the traded chip beside trade',
  JSON.stringify(iChips.map((c) => c.textContent.trim())) === '["trade","traded"]',
  JSON.stringify(iChips.map((c) => c.textContent.trim())),
);
check(
  'traded chip title states the victim-side answered rule',
  /answered by a teammate within the trade window \(victim side\)/.test(
    iChips.find((c) => c.textContent.trim() === 'traded')?.getAttribute('title') || '',
  ),
  iChips.find((c) => c.textContent.trim() === 'traded')?.getAttribute('title'),
);
const popI = await openKinds(engI);
check(
  'the dropdown offers the traded checkbox (the victim-side kind)',
  !!popI &&
    [...popI.querySelectorAll('.filt-check')].some((l) => l.textContent.trim() === 'traded'),
  [...(popI?.querySelectorAll('.filt-check') || [])].map((l) => l.textContent.trim()).join(','),
);
click(kindCheck(engI, 'traded'));
await sleep();
check(
  'checking traded → the merged row CONTAINS-matches and shows',
  rows(tableI).length === 1 && !tableI.textContent.includes('No kill tags match this filter.'),
  String(rows(tableI).length),
);
click(kindCheck(engI, 'untraded'));
await sleep();
// Inverted by the OR selection: untraded is ADDED, not swapped in — the
// row still carries traded, so it keeps showing (the exclusive
// selection used to empty the table here).
check(
  'adding untraded (OR, never exclusive) → the row still shows — it contains traded',
  rows(tableI).length === 1 &&
    !tableI.textContent.includes('No kill tags match this filter.') &&
    [...tableI.querySelectorAll('.comb-kind-chip')].length === 2,
  tableI.textContent.slice(-90),
);

console.log('J. the retired Combat stats panel and its KAST drill-down are gone');
document.body.removeChild(rootI);
const rootJ = await render(base);
// The panel's only consumer was the Combat stats section; with the panel
// gone the KAST drill-down (its cell button) has no trigger left, so the
// whole surface must be ABSENT — not merely unopened.
check(
  'no Combat stats section renders and no KAST trigger exists anywhere',
  sections(rootJ, 'Combat stats').length === 0 &&
    rootJ.querySelectorAll('section.panel').length === 2 &&
    !rootJ.querySelector('.comb-kast-btn') &&
    !rootJ.querySelector('.comb-kast-grid') &&
    !rootJ.textContent.includes('Combat stats'),
  `panels=${rootJ.querySelectorAll('section.panel').length} kastBtn=${!!rootJ.querySelector('.comb-kast-btn')}`,
);

// ---------------------------------------------------------------------------
// Section K: the cold-start loading gate (loading ladder rung 3). Until the
// one Promise.all settles, the view shows the plain loading line — it never
// renders its panels as empty tables (a false "no data" state).
console.log('K. cold start: the tab is busy until its data lands (throbber, no percentage)');
{
  globalThis.__combatDelay = 250;
  const rootK = await render(base);
  // The loading state (builtin loading, spectra.busy): the panels keep their place,
  // their content fades under a centered throbber, and no percentage is shown.
  check(
    'mid-load: the tab carries its throbber, never a %',
    // The busy flag itself comes from the frame (spectra.busy); this driver passes a
    // fixed stub, so the throbber's presence is what is pinned here.
    !!rootK.querySelector('.builtin-throbber') &&
      !rootK.querySelector('.chip-ring') &&
      !rootK.querySelector('.chip-pct'),
    rootK.innerHTML.slice(0, 160),
  );
  await sleep(400); // past the 250 ms delay
  check(
    'after the fetch lands: the tab is no longer busy, both panels render',
    !rootK.querySelector('.builtin-busy') &&
      sections(rootK, 'Combat stats').length === 0 &&
      sections(rootK, 'Kill tags').length === 1 &&
      sections(rootK, 'Clutches').length === 1,
    rootK.textContent.replace(/\s+/g, ' ').slice(0, 140),
  );
  globalThis.__combatDelay = 0;
}

// ---------------------------------------------------------------------------
// Section L: the load failure is dismissible IN PLACE (PRODUCT.md "Every
// error indication is dismissible") and is never paired with a rendered
// Combat stats section — the ✕ lives inside p.error[role="alert"] and
// clears `error`, leaving the view (and its two panels) mounted.
console.log('L. failed load: the error is dismissible in place, the retired section never renders beside it');
{
  globalThis.__combatError = 'combat backend down';
  const rootL = await render(base);
  const errP = rootL.querySelector('p.error[role="alert"]');
  check(
    'failure renders the alert with its message',
    !!errP && errP.textContent.includes('combat backend down'),
    errP ? errP.textContent.trim() : 'no p.error',
  );
  check(
    'the ✕ rides INSIDE the alert (btn small + codicon-close)',
    !!errP?.querySelector('button.btn.small .codicon-close'),
    errP ? errP.innerHTML.slice(0, 160) : '',
  );
  // The retired section's honesty gate inverted in place: there is no
  // empty-state claim to gate any more — the section itself never
  // renders, error beside it or not.
  check(
    'the retired Combat stats section never renders beside the error',
    sections(rootL, 'Combat stats').length === 0 &&
      !rootL.textContent.includes('Combat stats'),
    rootL.textContent.replace(/\s+/g, ' ').slice(0, 160),
  );
  const panelsBefore = rootL.querySelectorAll('section.panel').length;
  check('the two panels render around the failure', panelsBefore === 2, String(panelsBefore));
  // A dead backend fails each panel's own load, so one alert surfaces per panel, each dismissible in place.
  const alerts = [...rootL.querySelectorAll('p.error[role="alert"]')];
  check(
    'the failure surfaces as one dismissible alert per panel',
    alerts.length === 2 && alerts.every((a) => a.textContent.includes('combat backend down')),
    alerts.map((p) => p.textContent.trim().slice(0, 60)).join(' | '),
  );
  click(errP.querySelector('button.btn.small'));
  await sleep();
  check(
    '✕ clears only its own panel\'s alert — the other stays, panels still mounted, nothing navigated',
    rootL.querySelectorAll('p.error[role="alert"]').length === 1 &&
      rootL.querySelectorAll('section.panel').length === panelsBefore,
    rootL.textContent.replace(/\s+/g, ' ').slice(0, 140),
  );
  globalThis.__combatError = 0;
}

// ---------------------------------------------------------------------------
// Section M: the retired data paths stay UNREAD — the Combat stats panel,
// its metric slots and the KAST drill-down are gone (W24), so a fresh
// mount must never call the combat-stats fetch, the metric-slot reads or
// the per-round KAST fetch. The stub counts every call while this
// section's window is armed (the counter stays quiet everywhere else).
console.log('M. the view never reads the retired combat-stats / metric-slot data paths');
{
  globalThis.__combatCalls = {
    getCombatStats: 0,
    getPlayerRounds: 0,
    listMetrics: 0,
    getMetricValuesForMatch: 0,
    getMetricComputeState: 0,
    subscribeMetricProgress: 0,
    onMetricDone: 0,
  };
  const rootM = await render(base);
  const calls = globalThis.__combatCalls;
  check(
    'every retired read stays at zero calls and no Combat stats section renders',
    Object.values(calls).every((n) => n === 0) &&
      sections(rootM, 'Combat stats').length === 0,
    JSON.stringify(calls),
  );
  globalThis.__combatCalls = null;
}

// ---------------------------------------------------------------------------
// Section N: the Kill tags ROUND scope (owner, 2026-11-18): the chip
// input became a dropdown mirroring the Utility tab's round selector —
// a visible "Round" field label over ONE <select>, options "All rounds"
// + the canonical `RD<n> | <ct>-<t>` labels (roundScoreLabel), DEFAULT
// ROUND 1 (the pre-dropdown default was the empty multi-select set = no
// filter — the owner narrowed the default), and the Clutches card
// carries none.
console.log('N. kill tags round scope: round dropdown, default round 1, kill tags only');
{
  const rootN = await render({
    ...base,
    rounds: [
      { number: 1, startTick: 1040, endTick: 2000 },
      ...base.rounds, // rounds 6 and 7
    ],
    killTags: [
      // One kill in round 1 — the DEFAULT selection has its own row to
      // show, so "starts on round 1" is a value pin, not a fallback.
      { tick: 1500, round: 1, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 2, wonBy: 't' },
      ...base.killTags, // round 7's opening + untraded pair (two kills)
      // …plus ONE kill in round 6, so the scope has something to drop.
      { tick: 9500, round: 6, kind: 'untraded', aSteam: 'B', aName: 'bob', bSteam: 'A', bName: 'alice', distance: 3, wonBy: 't' },
    ],
  });
  const engN = sections(rootN, 'Kill tags')[0];
  const tableN = engN?.querySelector('table');
  const selN = engN?.querySelector('#comb-round-filter');
  const optsOf = () => [...(selN?.querySelectorAll('option') || [])].map((o) => o.textContent.trim());
  const roundCellOf = (tr) => tr?.querySelectorAll('td')[2]?.getAttribute('title') || '';
  const setRoundN = async (v) => {
    if (!selN) return false;
    selN.value = v;
    selN.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep();
    return true;
  };
  check(
    'the kill tag filter row carries the round DROPDOWN with its visible "Round" field label',
    !!selN &&
      selN.tagName === 'SELECT' &&
      engN?.querySelector('label[for="comb-round-filter"] .field-label')?.textContent.trim() === 'Round',
    selN ? `tag=${selN.tagName}` : engN ? 'no #comb-round-filter' : 'no kill tags section',
  );
  check(
    'its options are "All rounds" + one canonical RD | score label per round with a kill',
    JSON.stringify(optsOf()) ===
      JSON.stringify(['All rounds', 'RD1 | 0-0', 'RD6 | 0-0', 'RD7 | 0-0']),
    optsOf().join(','),
  );
  check(
    'the default selection is ROUND 1 — only round 1’s kill shows (never every row)',
    selN?.value === '1' &&
      rows(tableN).length === 1 &&
      roundCellOf(rows(tableN)[0]) === 'tick 1500',
    `${selN?.value} / ${rows(tableN).length} rows / ${roundCellOf(rows(tableN)[0])}`,
  );
  check(
    'All rounds → every row shows (the pre-dropdown view stays one pick away)',
    (await setRoundN('all')) && selN?.value === 'all' && rows(tableN).length === 4,
    `${selN?.value} / ${rows(tableN).length} rows`,
  );
  check(
    'round 6 picked → only round 6’s kill shows',
    (await setRoundN('6')) && rows(tableN).length === 1 && roundCellOf(rows(tableN)[0]) === 'tick 9500',
    `${selN?.value} / ${rows(tableN).length} rows`,
  );
  check(
    'round 1 picked again → the default round stays selectable',
    (await setRoundN('1')) && rows(tableN).length === 1 && roundCellOf(rows(tableN)[0]) === 'tick 1500',
    `${selN?.value} / ${rows(tableN).length} rows`,
  );
  const clutchN = sections(rootN, 'Clutches')[0];
  check(
    'the Clutches card carries NO round control',
    !!clutchN &&
      !clutchN.querySelector('#comb-round-filter') &&
      !clutchN.querySelector('select'),
    clutchN ? `selects=${clutchN.querySelectorAll('select').length}` : 'no Clutches section',
  );
}

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
