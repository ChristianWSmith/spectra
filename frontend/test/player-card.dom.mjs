// jsdom driver for PlayerCard + TeamColumn: the icon → text-fallback
// contract (icon present renders <img>, a miss renders the readable
// canonical label), helmet vs armor labels, money/ammo formatting, the
// mute buttons' aria-pressed + callbacks, the side color classes, the
// PLAYER-COLOR ring as the card's ONE outline (asserted from the
// component's own injected CSS: no second/outline ring may reappear)
// and the voice live dot beside the name (speaking only), the row order
// (armor at the right of the HP row, the weapon on its own line), the
// fixed-height row geometry (nothing may resize the card — including
// the econ row's exact two-line util reserve, pinned below the old
// 3em slack),
// the live stats row, the carried C4, and the honest "—" placeholders when
// slotStateAt state is null (never a zero presented as a fact).
//
// jsdom is intentionally not a project dependency; from frontend/ run:
//   npm i --no-save jsdom
//   node --test test/player-card.dom.mjs
// (must be run with frontend/ as the working directory; the same file also
// runs under `node --conditions browser test/player-card.dom.mjs` — it pins the
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

const dir = join('node_modules', '.cache', 'spectra-dom-tests', 'player-card');
mkdirSync(join(dir, 'replay'), { recursive: true });
mkdirSync(join(dir, 'components'), { recursive: true });

const svelteCompile = (src, filename, out, opts = {}) =>
  writeFileSync(out, compile(src, { filename, generate: 'client', ...opts }).js.code);

// Plain-ESM deps copied verbatim with their relative layout intact
// (fmt → rounds; replay/playercard → replay/landmarks → rounds). The
// components are compiled with css:'injected' so their <style> blocks
// land in the document — the outline-geometry checks below read the real
// rules the browser would apply.
for (const rel of ['rounds.js', 'fmt.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
for (const rel of ['landmarks.js', 'playercard.js']) {
  writeFileSync(join(dir, 'replay', rel), readFileSync(join('src/lib', 'replay', rel), 'utf8'));
}

svelteCompile(
  readFileSync('src/lib/components/PlayerCard.svelte', 'utf8'),
  'PlayerCard.svelte',
  join(dir, 'components', 'PlayerCard.js'),
  { css: 'injected' },
);
// TeamColumn imports its sibling as ./PlayerCard.svelte — rewrite to the
// compiled output (same trick as the combat driver's component imports).
const tcSrc = readFileSync('src/lib/components/TeamColumn.svelte', 'utf8').replace(
  "from './PlayerCard.svelte'",
  "from './PlayerCard.js'",
);
svelteCompile(tcSrc, 'TeamColumn.svelte', join(dir, 'components', 'TeamColumn.js'), {
  css: 'injected',
});
svelteCompile(
  readFileSync('test/player-card.harness.svelte', 'utf8'),
  'harness.svelte',
  join(dir, 'harness.js'),
);

const { mount, unmount } = await import('svelte');
const mod = await import(pathToFileURL(join(dir, 'harness.js')).href);

const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let inst = null;
async function show({ card = null, team = null } = {}) {
  if (inst) unmount(inst);
  globalThis.__card = card;
  globalThis.__team = team;
  globalThis.__cardMutes = [];
  globalThis.__teamMutes = [];
  const target = document.createElement('div');
  document.body.appendChild(target);
  inst = mount(mod.default, { target });
  await sleep();
  return target;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

const q = (root, sel) => root.querySelector(sel);
const qa = (root, sel) => [...root.querySelectorAll(sel)];
// The pc- classes of an element (Svelte's scope hash excluded) — pins
// row/child ORDER in the card's fixed stack.
const pcClass = (el) => [...el.classList].filter((c) => c.startsWith('pc-')).join(' ');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// The component's own injected CSS (css:'injected' above) — the ring
// geometry and the fixed row heights live there, so those checks read it.
const sheetText = () =>
  [...document.querySelectorAll('style')].map((s) => s.textContent || '').join('\n');
// Svelte scopes each selector with its component hash
// (.pc-card.pc-color.svelte-xxxx), so match up to the rule's brace.
// CSS comments are stripped first — the fixed-height block's prose
// names .pc-econ, and a comment match would swallow the text up to the
// NEXT rule's brace (the same trick the outline scan below uses).
const ruleFor = (sel) => {
  const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, '');
  const m = sheet.match(new RegExp(`\\.${sel}[^{}]*\\{[^}]*\\}`));
  return m ? m[0] : '';
};
const px = (s) => parseFloat(s);

// A full, icon-equipped card: every cell present and formatted.
const fullCard = {
  player: { steamId: '76561198000000001', name: 'donk' },
  side: 'ct',
  playerColor: '#84C8ED',
  speaking: false,
  muted: false,
  dead: false,
  follow: true,
  stats: { k: 12, d: 5, a: 3, adr: 87.4375 },
  state: {
    hp: 87,
    armor: 65,
    helmet: true,
    weapon: 'AK-47',
    magAmmo: 23,
    reserveAmmo: 71,
    inventory: ['AK-47', 'Smoke Grenade', 'Flashbang', 'Flashbang'],
    money: 3250,
  },
  iconURLs: {
    'AK-47': '/api/icons/ak47.svg',
    'Kevlar + Helmet': '/api/icons/armor_helmet.svg',
    'Smoke Grenade': '/api/icons/smokegrenade.svg',
    'Flashbang': '/api/icons/flashbang.svg',
  },
};

console.log('A. full card: name, HP, armor+helmet, weapon+ammo, money, utility, stats');
const root = await show({
  card: { ...fullCard, onToggleMute: () => globalThis.__cardMutes.push('donk') },
});
check('root is one card', !!q(root, '.pc-card'));
check('side class from prop (ct)', q(root, '.pc-card').classList.contains('pc-ct'));
check(
  'color ring armed only by playerColor (inline custom prop + class)',
  q(root, '.pc-card').classList.contains('pc-color') &&
    q(root, '.pc-card').style.getPropertyValue('--pc-color') === '#84C8ED',
  q(root, '.pc-card').getAttribute('style'),
);
check('name + full-name title', q(root, '.pc-name').textContent === 'donk' && q(root, '.pc-name').getAttribute('title') === 'donk');
check('follow marker present', !!q(root, '.pc-mark.codicon-person-follow'));
check('HP number', q(root, '.pc-hp').textContent === '87', q(root, '.pc-hp').textContent);
check('HP bar fill width tracks HP', (q(root, '.pc-bar-fill')?.getAttribute('style') || '').includes('87%'), q(root, '.pc-bar-fill')?.getAttribute('style'));
const imgs = qa(root, 'img');
check('armor renders the helmet icon (not the vest)', imgs.some((i) => i.getAttribute('src') === '/api/icons/armor_helmet.svg' && i.getAttribute('alt') === 'Kevlar + Helmet'));
check('armor value', q(root, '.pc-armor-val').textContent === '65');
check('weapon icon present', imgs.some((i) => i.getAttribute('src') === '/api/icons/ak47.svg'));
check('weapon name shown beside the icon', q(root, '.pc-wname').textContent === 'AK-47');
check('ammo as mag / reserve', q(root, '.pc-ammo').textContent === '23 / 71', q(root, '.pc-ammo').textContent);
check('money through fmtMoney', q(root, '.pc-money').textContent === '$3,250', q(root, '.pc-money').textContent);
check('utility: grenade icons, no weapon icons', imgs.filter((i) => i.getAttribute('alt') === 'Smoke Grenade' || i.getAttribute('alt') === 'Flashbang').length === 2);
check('duplicated grenade shows its count', !!qa(root, '.pc-count').find((c) => c.textContent === '×2'), qa(root, '.pc-count').map((c) => c.textContent).join(','));
check('utility title says carried', q(root, '.pc-util').getAttribute('title') === 'Utility carried');
check('no DEAD / no-state markers', !q(root, '.pc-dead-mark') && !q(root, '.pc-nostate'));
check(
  'stats row renders the live fold (K/D/A + ADR, one decimal)',
  q(root, '.pc-stats')?.textContent === 'K/D/A 12/5/3 · ADR 87.4',
  q(root, '.pc-stats')?.textContent,
);
check(
  'stats row title documents the exact formula',
  /counted rounds started/.test(q(root, '.pc-stats')?.getAttribute('title') || '') &&
    /friendly fire/.test(q(root, '.pc-stats')?.getAttribute('title') || ''),
  q(root, '.pc-stats')?.getAttribute('title'),
);
check('no C4 cell when the inventory carries no bomb', !q(root, '.pc-c4'));

// Row structure — the fixed stack the C2 geometry checks pin: head →
// HP row (armor chip at its RIGHT edge) → weapon on its own line →
// money/util → stats.
const cardKids = [...q(root, '.pc-card').children].map(pcClass);
check(
  'row order: head → HP → weapon line → money/util → stats',
  JSON.stringify(cardKids) ===
    JSON.stringify(['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']),
  JSON.stringify(cardKids),
);
const hpKids = [...q(root, '.pc-hp-row').children].map(pcClass);
check(
  'armor/helmet chip rides the RIGHT end of the HP row (after the bar)',
  hpKids.some((c) => c === 'pc-bar') && hpKids[hpKids.length - 1].includes('pc-armor'),
  JSON.stringify(hpKids),
);
check(
  'armor pinned to the row edge by an auto margin',
  /margin-left:\s*auto/.test(ruleFor('pc-armor(?![\\w-])')),
  ruleFor('pc-armor(?![\\w-])'),
);
check(
  'weapon chip on its own row — out of the HP row, armor out of the weapon row',
  !!q(root, '.pc-weapon-row .pc-weapon') &&
    !q(root, '.pc-hp-row .pc-weapon') &&
    !q(root, '.pc-weapon-row .pc-armor'),
);

console.log('A2. carried C4: its own cell beside the util, icon or text fallback');
const c4Card = {
  ...fullCard,
  playerColor: null, // an unknown color draws NO ring
  stats: null,
  state: { ...fullCard.state, inventory: ['AK-47', 'C4', 'Smoke Grenade'] },
  iconURLs: { ...fullCard.iconURLs, C4: '/api/icons/c4.svg' },
};
const rootC4 = await show({ card: { ...c4Card, onToggleMute: () => {} } });
const c4Cell = q(rootC4, '.pc-c4');
check('C4 cell mounts next to the util', !!c4Cell && !!q(rootC4, '.pc-econ .pc-c4'));
check('C4 cell titled "C4 bomb"', c4Cell?.getAttribute('title') === 'C4 bomb', c4Cell?.getAttribute('title'));
check(
  'C4 renders its icon when one resolves',
  !!q(c4Cell, 'img') && q(c4Cell, 'img').getAttribute('src') === '/api/icons/c4.svg',
);
check(
  'utility still excludes the C4 (only the smoke icon is utility)',
  qa(rootC4, '.pc-util img').length === 1 &&
    q(rootC4, '.pc-util img')?.getAttribute('alt') === 'Smoke Grenade',
  qa(rootC4, '.pc-util img').map((i) => i.getAttribute('alt')).join(','),
);
check('unknown color → no ring', !q(rootC4, '.pc-card').classList.contains('pc-color'));
check(
  'stats row without a fold renders honest placeholders',
  q(rootC4, '.pc-stats')?.textContent === 'K/D/A — · ADR —',
  q(rootC4, '.pc-stats')?.textContent,
);
const rootC4b = await show({
  card: { ...c4Card, iconURLs: null, icons: null, onToggleMute: () => {} },
});
check(
  'C4 falls back to its text label when no icon exists',
  q(rootC4b, '.pc-c4')?.textContent.trim() === 'C4',
  q(rootC4b, '.pc-c4')?.textContent,
);
check('no <img> on the no-icon card', qa(rootC4b, 'img').length === 0);

console.log('B. mute button: aria + callback + pressed state');
// A2 re-mounted the harness above, so show the full card once more —
// the button this section drives must be the LIVE one, not a detached node.
const rootMute = await show({ card: { ...fullCard, onToggleMute: () => globalThis.__cardMutes.push('donk') } });
const mute = q(rootMute, '.pc-mute');
check('real button with the mute label', mute.tagName === 'BUTTON' && mute.getAttribute('aria-label') === 'Mute donk');
check('unmuted: aria-pressed false, no warn', mute.getAttribute('aria-pressed') === 'false' && !mute.classList.contains('warn'));
click(mute);
check('onToggleMute fired once', JSON.stringify(globalThis.__cardMutes) === '["donk"]', JSON.stringify(globalThis.__cardMutes));
const rootB = await show({ card: { ...fullCard, muted: true, onToggleMute: () => {} } });
const muteB = q(rootB, '.pc-mute');
check('muted: aria-pressed true + warn class', muteB.getAttribute('aria-pressed') === 'true' && muteB.classList.contains('warn'));
check('muted icon flips to codicon-mute', !!q(muteB, '.codicon-mute'));
check('muted title says Unmute', muteB.getAttribute('title') === "Unmute donk's voice", muteB.getAttribute('title'));

console.log('C. voice: a red live dot beside the name — the player-color ring is the ONLY ring');
const rootC = await show({ card: { ...fullCard, speaking: true, onToggleMute: () => {} } });
const cardC = q(rootC, '.pc-card');
check(
  'color ring still armed by playerColor while speaking (class + custom prop)',
  cardC.classList.contains('pc-color') &&
    cardC.style.getPropertyValue('--pc-color') === '#84C8ED',
  cardC.getAttribute('style'),
);
check('no pc-speaking ring class on the card', !cardC.classList.contains('pc-speaking'));
check('live dot renders in the head while speaking', !!q(cardC, '.pc-head .pc-live'));
check(
  'live dot is a decorative aria-hidden span',
  q(cardC, '.pc-live')?.tagName === 'SPAN' &&
    q(cardC, '.pc-live')?.getAttribute('aria-hidden') === 'true',
);
const headKids = [...q(cardC, '.pc-head').children].map(pcClass);
check(
  'head order: name → live dot → follow marker → mute',
  JSON.stringify(headKids) === JSON.stringify(['pc-name', 'pc-live', 'pc-mark', 'pc-mute']),
  JSON.stringify(headKids),
);

// The dot's own rule: a 7px filled circle in the app's recording red,
// flex:none so it can never squeeze the name or move the head's
// fixed-height row.
const liveRule = ruleFor('pc-live(?![\\w-])');
check(
  'live dot rule: 7px circle, danger red, flex:none',
  /width:\s*7px/.test(liveRule) &&
    /height:\s*7px/.test(liveRule) &&
    /border-radius:\s*50%/.test(liveRule) &&
    /background:\s*var\(--danger\)/.test(liveRule) &&
    /flex:\s*none/.test(liveRule),
  liveRule,
);
check(
  'dot pulse exists and goes static under prefers-reduced-motion',
  // svelte namespaces keyframes (svelte-<hash>-pc-live-pulse) — match
  // the name, not the @keyframes prefix.
  /@keyframes\s+[\w-]*pc-live-pulse/.test(sheetText()) &&
    /prefers-reduced-motion[^{]*\{[^}]*\.pc-live(?![\w-])[^{}]*\{[^}]*animation:\s*none/.test(
      sheetText(),
    ),
);

// The silent card must show NO dot — the `speaking` prop is the only
// trigger (re-mounts the harness, so the injected CSS stays in place).
const rootQuiet = await show({ card: { ...fullCard, speaking: false, onToggleMute: () => {} } });
check('no live dot while silent', !q(rootQuiet, '.pc-live'));

// --- The rings: ONE ring, the player's own color -----------------------
const colorRule = ruleFor('pc-card\\.pc-color');
check('color ring rule exists and draws a box-shadow', /box-shadow/.test(colorRule), colorRule);
const spreads = (colorRule.match(/0 0 0 ([\d.]+)px/g) || []).map((m) => px(m.slice(6)));
check(
  'the ring hugs the card (a 2px color spread behind a 3px dark casing)',
  spreads.length === 2 && spreads[0] === 2 && spreads[1] === 3,
  JSON.stringify(spreads),
);
// Every rule targeting .pc-card must be outline-free: the speaking
// outline (outline + outline-offset + pulse) is gone for good — the
// player-color box-shadow is the only thing that rings a card. CSS
// comments are stripped first so prose mentioning "outline" can never
// poison the scan.
const cardRules =
  sheetText()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.pc-card[^{}]*\{[^}]*\}/g) || [];
check(
  'NO outline ring: no .pc-speaking rule and no outline in any .pc-card rule',
  cardRules.length > 0 &&
    cardRules.every((r) => !/outline/.test(r)) &&
    !cardRules.some((r) => /\.pc-speaking/.test(r)),
  cardRules.join(' | '),
);

console.log('C2. fixed-height geometry: NOTHING may resize the card');
// The jitter contract: every row reserves its tallest possible height in
// the component's own CSS, so a mounting DEAD chip, a wrapping grenade
// row or a ticking stat can never change the stack's layout.
for (const sel of ['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']) {
  const rule = ruleFor(sel);
  check(`${sel} declares a FIXED height`, /height:\s*[^;]+;/.test(rule), rule);
  check(`${sel} clips what does not fit (no spill into the stack)`, /overflow:\s*hidden/.test(rule), rule);
}
check(
  'the color ring stays pure paint (box-shadow only, never width/height)',
  !/width|height|padding|margin/.test(colorRule) && /box-shadow/.test(colorRule),
  colorRule,
);

// The econ row's height PIN — the fix for "more margin above/below than
// any other line on the card". .pc-econ must reserve the util's TRUE
// two-line maximum (2 × 15px icons + the 2px row-gap = 32px), never the
// old loose `3em` (3 × 0.86 × root = 33.5 / 38.7 / 43.9px at the
// 13 / 15 / 17px root — up to ~12px of dead space that, with util on
// one line, the common case, read as fat margins above and below the
// row). The value is pinned EXACTLY: it may not drift back up (the
// fat margins return) nor shrink below the two-line max (a wrapped
// grenade row would then be silently clipped — the never-resize /
// never-clip invariant).
const econRule = ruleFor('pc-econ');
const econHeight = ((econRule.match(/height:\s*([^;]+);/) || [])[1] || '').trim();
const econPx = /^calc\(2 \* 15px \+ 2px\)$/.test(econHeight) ? 32 : NaN;
check(
  'pc-econ height is the exact two-line util max (2 × 15px icons + 2px row-gap)',
  econPx === 32,
  econHeight,
);
check(
  'pc-econ is strictly tighter than the old 3em reserve at EVERY root setting',
  Number.isFinite(econPx) && [13, 15, 17].every((root) => econPx < 3 * 0.86 * root),
  `${econPx}px vs old 3em ${[13, 15, 17]
    .map((root) => (3 * 0.86 * root).toFixed(1))
    .join('/')}px`,
);
check(
  'pc-econ content stays vertically centred (the slack is even, never biased)',
  /align-items:\s*center/.test(econRule),
  econRule,
);

console.log('D. state === null: honest placeholders, never zeros');
const rootD = await show({ card: { ...fullCard, state: null, iconURLs: null, onToggleMute: () => {} } });
const cardD = q(rootD, '.pc-card');
check('root titled "No player state for this match"', cardD.getAttribute('title') === 'No player state for this match', cardD.getAttribute('title'));
check('no-state marker in the head', !!q(rootD, '.pc-nostate'));
const dashes = ['.pc-hp', '.pc-armor-val', '.pc-wname', '.pc-ammo', '.pc-money'].map((s) => q(rootD, s)?.textContent);
check('every value renders —', JSON.stringify(dashes) === JSON.stringify(['—', '—', '—', '—', '—']), JSON.stringify(dashes));
check('utility renders —', q(rootD, '.pc-util').textContent.trim() === '—', q(rootD, '.pc-util').textContent);
check('utility title says unknown', q(rootD, '.pc-util').getAttribute('title') === 'Utility unknown');
check('no $0 anywhere on the card', !cardD.textContent.includes('$0'), cardD.textContent);
check('no icons (nothing to show)', qa(rootD, 'img').length === 0);
check('armor falls back to the plain label', q(rootD, '.pc-armor')?.textContent.includes('Armor'));

console.log('E. icons absent: text fallbacks, helmet tri-state');
const noIcons = { ...fullCard, iconURLs: null, icons: null };
const rootE = await show({ card: { ...noIcons, onToggleMute: () => {} } });
check('no <img> when no source resolves', qa(rootE, 'img').length === 0);
check('weapon name doubles as its text fallback', q(rootE, '.pc-wname').textContent === 'AK-47');
check('helmet on → "Kevlar + Helmet" label', q(rootE, '.pc-armor').textContent.includes('Kevlar + Helmet'), q(rootE, '.pc-armor').textContent);
check('grenade text fallbacks', !!qa(rootE, '.pc-fallback').find((f) => f.textContent === 'Smoke Grenade'), qa(rootE, '.pc-fallback').map((f) => f.textContent).join('|'));
const rootE2 = await show({ card: { ...noIcons, state: { ...noIcons.state, helmet: false }, onToggleMute: () => {} } });
check('helmet off → "Kevlar Vest" label', q(rootE2, '.pc-armor').textContent.includes('Kevlar Vest'), q(rootE2, '.pc-armor').textContent);
const rootE3 = await show({ card: { ...noIcons, state: { ...noIcons.state, helmet: null }, onToggleMute: () => {} } });
check('helmet unknown → "Armor" label (no guessed icon)', q(rootE3, '.pc-armor').textContent.includes('Armor') && qa(rootE3, 'img').length === 0, q(rootE3, '.pc-armor').textContent);

console.log('F. dead: reads as dead, last-known data stays');
const rootF = await show({ card: { ...fullCard, dead: true, onToggleMute: () => {} } });
check('dead class + DEAD marker', q(rootF, '.pc-card').classList.contains('pc-dead') && q(rootF, '.pc-dead-mark')?.textContent === 'DEAD');
check('last-known values still render', q(rootF, '.pc-hp').textContent === '87' && q(rootF, '.pc-money').textContent === '$3,250');
const rootF2 = await show({ card: { ...fullCard, alive: false, onToggleMute: () => {} } });
check('alive:false reads as dead too', q(rootF2, '.pc-card').classList.contains('pc-dead'));

console.log('G. TeamColumn: name color, team mute, five cards, side propagation');
const players = [1, 2, 3, 4, 5].map((n) => ({
  player: { steamId: `id${n}`, name: `p${n}` },
  state: { hp: 100 - n, armor: 100, helmet: false, weapon: 'AK-47', magAmmo: 30, reserveAmmo: 90, inventory: ['AK-47'], money: 800 * n },
  playerColor: n === 2 ? '#ECDF41' : null,
  stats: n === 2 ? { k: 1, d: 0, a: 0, adr: 50 } : null,
  muted: n === 3,
  onToggleMute: () => globalThis.__cardMutes.push(`p${n}`),
}));
const team = {
  teamName: 'Alpha',
  side: 'ct',
  players,
  teamMuted: false,
  onToggleTeamMute: () => globalThis.__teamMutes.push('Alpha'),
};
const rootG = await show({ team });
check('team name rendered', q(rootG, '.tc-name').textContent === 'Alpha');
check('team name colored by the column side', q(rootG, '.tc-name').classList.contains('side-ct'));
check('team mute button label + pressed', q(rootG, '.tc-mute').getAttribute('aria-label') === 'Mute Alpha voice' && q(rootG, '.tc-mute').getAttribute('aria-pressed') === 'false');
click(q(rootG, '.tc-mute'));
check('onToggleTeamMute fired', JSON.stringify(globalThis.__teamMutes) === '["Alpha"]', JSON.stringify(globalThis.__teamMutes));
const cards = qa(rootG, '.pc-card');
check('five cards render', cards.length === 5, String(cards.length));
check(
  'cards keep roster order',
  cards.map((c) => q(c, '.pc-name').textContent).join(',') === 'p1,p2,p3,p4,p5',
  cards.map((c) => q(c, '.pc-name').textContent).join(','),
);
check('column side propagates to every card', cards.every((c) => c.classList.contains('pc-ct')));
check(
  'per-player color rings pass through',
  cards[1].classList.contains('pc-color') &&
    cards[1].style.getPropertyValue('--pc-color') === '#ECDF41' &&
    !cards[0].classList.contains('pc-color'),
);
check(
  'per-player stats pass through (and the no-fold placeholder stays)',
  cards[1].querySelector('.pc-stats')?.textContent === 'K/D/A 1/0/0 · ADR 50.0' &&
    cards[0].querySelector('.pc-stats')?.textContent === 'K/D/A — · ADR —',
  cards.map((c) => c.querySelector('.pc-stats')?.textContent).join(' | '),
);
check('per-player muted state passes through', qa(rootG, '.pc-mute')[2].getAttribute('aria-pressed') === 'true');
click(qa(rootG, '.pc-mute')[4]);
check('card mute callbacks stay per-player', JSON.stringify(globalThis.__cardMutes) === '["p5"]', JSON.stringify(globalThis.__cardMutes));
const team2 = { ...team, teamMuted: true };
const rootG2 = await show({ team: team2 });
check('teamMuted sets the team button pressed', q(rootG2, '.tc-mute').getAttribute('aria-pressed') === 'true' && q(rootG2, '.tc-mute').classList.contains('warn'));
check('team column does not inject a side the caller did not give', (await show({ team: { ...team, side: '' } })) && qa(document.body, '.pc-ct').length === 0);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
