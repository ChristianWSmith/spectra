// jsdom driver for CompareRounds: the event-sequence ▶ is an icon-only
// play that seeks WITH the ±10 s loop and follows the ROW'S ACTOR when
// it has one (a kill's killer — `attacker`), actor-less rows (round
// starts) keep the default seek copy and stamp no follow, and the
// round-level "Replay start" control is icon-only play with NO follow.
// Every link stays filter-free (buttons seek, never filter).
//
// jsdom is a declared devDependency; from frontend/ run:
//   node --test test/compare-rounds.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/compare-rounds.dom.mjs` — it
// pins the browser condition itself so `svelte` resolves to the client
// build)
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'compare-rounds');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });
mkdirSync(join(dir, 'views'), { recursive: true });

const svelteCompile = (src, filename, out) => {
  writeFileSync(out, compile(src, { filename, generate: 'client' }).js.code);
};

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds, nav → router + replay/landmarks → rounds/teams, teams →
// sideparity) — the same copy the round-detail driver uses.
for (const rel of ['rounds.js', 'sideparity.js', 'router.js', 'nav.js', 'teams.js', 'definitions.js', 'fmt.js', 'players.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
writeFileSync(
  join(dir, 'replay', 'landmarks.js'),
  readFileSync('src/lib/replay/landmarks.js', 'utf8'),
);

// The view's data source is scripted, never a live Wails backend: the
// driver sets globalThis.__cmpData before each mount.
writeFileSync(
  join(dir, 'services.js'),
  `const d = () => globalThis.__cmpData || {};
export const getMatch = () => Promise.resolve(d().match || null);
export const getRounds = () => Promise.resolve(d().rounds || []);
export const getScoreboard = () => Promise.resolve(d().scoreboard || []);
export const getEconomy = () => Promise.resolve(d().economy || []);
export const getUtility = () => Promise.resolve(d().utility || []);
export const getRoundClasses = () => Promise.resolve(d().classes || []);
export const getRoundDetail = (id, round) => Promise.resolve((d().details || {})[round] || null);
export const errText = (e) => (e == null ? 'unknown error' : String((e && e.message) || e));
export const warmProfile = () => {};
`,
);

for (const name of ['LandmarkRow', 'ProfileLink']) {
  const src = readFileSync(`src/lib/components/${name}.svelte`, 'utf8')
    // LandmarkRow imports its sibling ProfileLink as .svelte — at dir/
    // the compiled copy is a .js (the view's own imports are rewritten
    // below).
    .replace(/from '\.\/ProfileLink\.svelte'/g, "from './ProfileLink.js'");
  svelteCompile(src, `${name}.svelte`, join(dir, 'components', `${name}.js`));
}

// CompareRounds.svelte → its ../ imports land in dir/; only the .svelte
// component imports need rewriting to their compiled .js.
const cmpSrc = readFileSync('src/lib/views/CompareRounds.svelte', 'utf8').replace(
  /from '\.\.\/components\/(\w+)\.svelte'/g,
  "from '../components/$1.js'",
);
svelteCompile(cmpSrc, 'CompareRounds.svelte', join(dir, 'views', 'CompareRounds.js'));

const harnessSrc = `<script>
  import CompareRounds from './views/CompareRounds.js';
</script>
<CompareRounds
  id={3}
  query={{ rounds: '5,6' }}
  nav={(h) => (globalThis.__nav = (globalThis.__nav || []).concat(h))}
/>`;
const harnessOut = join(dir, 'harness.js');
svelteCompile(harnessSrc, 'harness.svelte', harnessOut);

const { mount } = await import('svelte');
const mod = await import(pathToFileURL(harnessOut).href);

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

// --- Fixture ----------------------------------------------------------------
// Two compared rounds; round 5's sequence carries a KILL (actor: donk) and
// a ROUND_START (no actor at all — the actor-less control case). Rounds
// 5/6 sit in era 0 (sideSwitches 1, 13 counted rounds).
const mkDetail = (n) => ({
  round: {
    number: n,
    winner: 'ct',
    reason: 'CTWin',
    durationS: 105,
    warmup: false,
    pregame: false,
    bombSite: 'A',
    mvp: '76561198012345678',
    mvpName: 'donk',
    mvpReason: 'killed 3',
    equipCT: 4200,
    equipT: 3800,
    kills: 2,
    firstKillSteam: '76561198012345678',
    firstKillName: 'donk',
    firstDeathSteam: '76561198012345679',
    firstDeathName: 'zweih',
    startTick: (n - 5) * 10000 + 1000,
    endTick: (n - 5) * 10000 + 9999,
  },
  economy: [],
  chat: [],
  events:
    n === 5
      ? [
          { id: 1, seq: 1, tick: 1100, round: 5, kind: 'round_start', attacker: '', attackerName: '' },
          { id: 2, seq: 2, tick: 1500, round: 5, kind: 'kill', attacker: '76561198012345678', attackerName: 'donk', victim: '76561198012345679', victimName: 'zweih', weapon: 'ak47', headshot: true },
        ]
      : [{ id: 3, seq: 1, tick: 11000, round: 6, kind: 'round_start', attacker: '', attackerName: '' }],
});
const base = {
  match: { tickRate: 64, sideSwitches: 1 },
  rounds: [5, 6].map((n) => ({
    number: n,
    winner: 'ct',
    reason: 'CTWin',
    warmup: false,
    pregame: false,
    startTick: (n - 5) * 10000 + 1000,
    endTick: (n - 5) * 10000 + 9999,
  })),
  scoreboard: [
    { steamId: '76561198012345678', name: 'donk', side: 'ct' },
    { steamId: '76561198012345679', name: 'zweih', side: 't' },
  ],
  economy: [
    {
      round: 5,
      equipCT: 4200,
      equipT: 3800,
      moneyCT: 1500,
      moneyT: 2000,
      spentCT: 4000,
      spentT: 3600,
      classCT: 'full',
      classT: 'eco',
    },
    {
      round: 6,
      equipCT: 3000,
      equipT: 4500,
      moneyCT: 900,
      moneyT: 2500,
      spentCT: 2800,
      spentT: 4300,
      classCT: 'force',
      classT: 'full',
    },
  ],
  utility: [],
  classes: [
    { round: 5, label: 'full', confidence: 1, ruleVersion: 1, explanation: 'both teams full buy' },
    { round: 6, label: 'force', confidence: 1, ruleVersion: 1, explanation: 'equip over threshold' },
  ],
  details: { 5: mkDetail(5), 6: mkDetail(6) },
};

globalThis.__cmpData = base;
globalThis.__nav = [];
const target = document.createElement('div');
document.body.appendChild(target);
mount(mod.default, { target });
await sleep();

console.log('A. round-level "Replay start" is icon-only play and follows nobody');
// Two compared columns render — everything below scopes to the FIRST.
const col = target.querySelector('.cmp-col');
const actions = [...(col?.querySelectorAll('.cmp-actions button') || [])];
check('two toolbar controls render in the column (replay + round detail)', actions.length === 2, String(actions.length));
const replayStart = actions[0];
check(
  'Replay start is icon-only (its label text is gone) with the play glyph',
  !!replayStart && replayStart.textContent.trim() === '' && !!replayStart.querySelector('.codicon-play'),
  replayStart?.textContent,
);
check(
  'its title still states the round-start seek',
  (replayStart?.getAttribute('title') || '').startsWith('Replay from the round start'),
  replayStart?.getAttribute('title'),
);
check(
  'it carries an aria-label',
  replayStart?.getAttribute('aria-label') === 'Replay from the round start',
  replayStart?.getAttribute('aria-label'),
);
check('the other control stays labeled navigation (no tick)', /Round detail/.test(actions[1]?.textContent || ''), actions[1]?.textContent);
click(replayStart);
await sleep();
const navStart = (globalThis.__nav || []).at(-1);
check(
  'Replay start stamps the round tick + span, NO follow, no filter',
  !!navStart &&
    navStart.includes('tick=1000') &&
    navStart.includes('loop=1000,9999') &&
    !navStart.includes('follow=') &&
    !navStart.includes('cat='),
  navStart || 'no navigation',
);
// Round-span EQUALITY pin (watch-audit): the stamped loop is exactly
// nav.entryLoopSpan(round.startTick, round.endTick) — the SAME canonical
// stamper RoundDetail's "Watch round" uses (its driver pins the same
// helper with its own fixture), so the two round-level buttons cannot
// drift apart. The round IS the sequence (owner's watch rule): the loop
// is the round's own start→end span, never an event-style ±10 s anchor.
const { entryLoopSpan } = await import('../src/lib/nav.js');
const r5 = base.rounds.find((r) => r.number === 5);
check(
  'Replay start loop = nav.entryLoopSpan(startTick, endTick) — the ONE round-level stamper',
  !!navStart && navStart.includes('loop=' + entryLoopSpan(r5.startTick, r5.endTick)),
  navStart || 'no navigation',
);
check(
  'the round span is NOT padded (no ±10 s bleed into the previous round / next freeze)',
  !!navStart && navStart.includes('loop=1000,9999') && !navStart.includes('loop=360,'),
  navStart || 'no navigation',
);
// Cross-view source pin: RoundDetail's round-level button stamps the
// SAME helper over the SAME bounds (the equality half lives in the
// round-detail driver for the other direction).
const rdSrc = readFileSync('src/lib/views/RoundDetail.svelte', 'utf8');
check(
  'RoundDetail "Watch round" uses the same entryLoopSpan(startTick, endTick) (round-span equality)',
  rdSrc.includes('entryLoopSpan(detail.round.startTick, detail.round.endTick)'),
  'Watch round no longer stamps entryLoopSpan(startTick, endTick)',
);

console.log('B. the sequence ▶ follows the row ACTOR when it has one');
const rows = [...(col?.querySelectorAll('.lm-row') || [])];
check('two event rows render in the column (round start + kill)', rows.length === 2, String(rows.length));
const startPlay = rows[0]?.querySelector('.lm-play');
const killPlay = rows[1]?.querySelector('.lm-play');
check(
  'actor-less row keeps the DEFAULT seek copy (no follow claim)',
  (startPlay?.getAttribute('title') || '').startsWith('Seek replay to tick'),
  startPlay?.getAttribute('title'),
);
check(
  'kill row names the KILLER it follows',
  killPlay?.getAttribute('title') === 'Watch this event — follow donk',
  killPlay?.getAttribute('title'),
);
check(
  'both ▶ are icon-only plays',
  !!startPlay && !!killPlay && startPlay.textContent.trim() === '' && killPlay.textContent.trim() === '' &&
    !!startPlay.querySelector('.codicon-play') && !!killPlay.querySelector('.codicon-play'),
  JSON.stringify([startPlay?.textContent, killPlay?.textContent]),
);
click(killPlay);
await sleep();
const navKill = (globalThis.__nav || []).at(-1);
check(
  'kill ▶ stamps tick + ±10 s loop + sel + follow=the killer, NO filter',
  !!navKill &&
    navKill.includes('tick=1500') &&
    navKill.includes('loop=860,2140') &&
    navKill.includes('sel=e%3A2') &&
    navKill.includes('follow=76561198012345678') &&
    !navKill.includes('cat=') &&
    !navKill.includes('roundFrom'),
  navKill || 'no navigation',
);
click(startPlay);
await sleep();
const navStartRow = (globalThis.__nav || []).at(-1);
check(
  'actor-less ▶ stamps NO follow (never a guess)',
  !!navStartRow && navStartRow.includes('tick=1100') && !navStartRow.includes('follow='),
  navStartRow || 'no navigation',
);

console.log('C. buy-class chips wear the shared palette (raw key as class, tooltip intact)');
// Both chip shapes carry the RAW value as a class — the palette key that
// style-m3a.css's `.cmp-class.<key>` paints: the column h3 chip is the
// round classification (RoundClassification.label) and the per-side note
// chips are EconomyRow.classCT/classT (empty → `unknown`, the dashed key).
const clsChip = col?.querySelector('h3 .chip.cmp-class');
check(
  'column h3 chip carries the RAW classification key as a class',
  !!clsChip && clsChip.classList.contains('full') && clsChip.textContent.trim() === 'full',
  clsChip ? clsChip.className : 'missing',
);
check(
  'column h3 chip keeps its explanation + rules-version tooltip',
  clsChip?.getAttribute('title') === 'both teams full buy (rules v1)',
  clsChip?.getAttribute('title'),
);
const noteChips = [...(col?.querySelectorAll('.cmp-note .chip.cmp-class') || [])];
check(
  'per-side note chips carry the RAW EconomyRow class values as classes',
  noteChips.length === 2 &&
    noteChips[0].classList.contains('full') &&
    noteChips[0].textContent.trim() === 'full' &&
    noteChips[1].classList.contains('eco') &&
    noteChips[1].textContent.trim() === 'eco',
  JSON.stringify(noteChips.map((c) => c.className)),
);
// The sequence's legacy round cell (LandmarkRow without a roundByNumber
// lookup) is the other compact round label this driver renders.
const seqChips = [...(col?.querySelectorAll('.lm-row .chip.round-chip') || [])];
check(
  'sequence round chips spell the canonical RD prefix (RD5)',
  seqChips.length === 2 && seqChips.every((c) => c.textContent.trim() === 'RD5'),
  JSON.stringify(seqChips.map((c) => c.textContent.trim())),
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
