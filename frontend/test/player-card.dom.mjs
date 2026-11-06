// jsdom driver for PlayerCard + TeamColumn: the icon → text-fallback
// contract (icon present renders <img>, a miss renders the readable
// canonical label), helmet vs armor labels, money/ammo formatting, the
// mute buttons' aria-pressed + callbacks, the side color classes, the
// PLAYER-COLOR ring vs the separate speaking outline (asserted from the
// component's own injected CSS — the two rings' geometry must not
// overlap), the fixed-height row geometry (nothing may resize the card),
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
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

// The component's own injected CSS (css:'injected' above) — the ring
// geometry and the fixed row heights live there, so those checks read it.
const sheetText = () =>
  [...document.querySelectorAll('style')].map((s) => s.textContent || '').join('\n');
// Svelte scopes each selector with its component hash
// (.pc-card.pc-color.svelte-xxxx), so match up to the rule's brace.
const ruleFor = (sel) => {
  const m = sheetText().match(new RegExp(`\\.${sel}[^{}]*\\{[^}]*\\}`));
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

console.log('C. speaking: a SECOND outline outside the color ring, with a gap');
const rootC = await show({ card: { ...fullCard, speaking: true, onToggleMute: () => {} } });
const cardC = q(rootC, '.pc-card');
check(
  'speaking class set alongside the color class',
  cardC.classList.contains('pc-speaking') && cardC.classList.contains('pc-color'),
);
const colorRule = ruleFor('pc-card\\.pc-color');
const speakRule = ruleFor('pc-card\\.pc-speaking');
check('color ring rule exists and draws box-shadow', /box-shadow/.test(colorRule), colorRule);
check('speaking ring rule exists and draws an outline', /outline:\s*3px/.test(speakRule), speakRule);
check(
  'the two rings use different properties (no shared style)',
  /box-shadow/.test(colorRule) && !/outline:/.test(colorRule) && /outline:/.test(speakRule) && !/box-shadow/.test(speakRule),
  `color=[${colorRule}] speak=[${speakRule}]`,
);
const voiceSpread = Math.max(0, ...(colorRule.match(/0 0 0 ([\d.]+)px/g) || []).map((m) => px(m.slice(6))));
const speakOffset = px((speakRule.match(/outline-offset:\s*([\d.]+)px/) || [0, 0])[1]);
check(
  `speaking outline starts past the color ring (offset ${speakOffset}px > ${voiceSpread}px)`,
  voiceSpread > 0 && speakOffset > voiceSpread,
  `voiceSpread=${voiceSpread} speakOffset=${speakOffset}`,
);
check('speaking ring keeps a visible gap (≥1px)', speakOffset - voiceSpread >= 1, String(speakOffset - voiceSpread));
check('speaking ring mixes toward the theme text color', /color-mix/.test(speakRule) && /var\(--text\)/.test(speakRule), speakRule);
check('speaking outline falls back to the accent when the color is unknown', /var\(--pc-color,\s*var\(--accent\)\)/.test(speakRule), speakRule);

console.log('C2. fixed-height geometry: NOTHING may resize the card');
// The jitter contract: every row reserves its tallest possible height in
// the component's own CSS, so a mounting DEAD chip, a wrapping grenade
// row or a ticking stat can never change the stack's layout.
for (const sel of ['pc-head', 'pc-hp-row', 'pc-gear', 'pc-econ', 'pc-stats']) {
  const rule = ruleFor(sel);
  check(`${sel} declares a FIXED height`, /height:\s*[^;]+;/.test(rule), rule);
  check(`${sel} clips what does not fit (no spill into the stack)`, /overflow:\s*hidden/.test(rule), rule);
}
check(
  'the rings stay pure paint (box-shadow/outline only, never width/height)',
  !/width|height|padding|margin/.test(colorRule) && /box-shadow/.test(colorRule),
  colorRule,
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
