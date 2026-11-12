// jsdom driver for PlayerCard + TeamColumn: the icon → text-fallback
// contract (icon present renders <img>, a miss renders the readable
// canonical label — except on the WEAPON row, which is icon-only by
// design: no name text, the name rides the chip's title tooltip), helmet
// vs armor labels, money/ammo formatting, the
// mute buttons' aria-pressed + callbacks, the side color classes, the
// PLAYER-COLOR ring as the card's ONE outline (asserted from the
// component's own injected CSS: no second/outline ring may reappear)
// and the voice live dot beside the name (speaking only), the row order
// (armor at the right of the HP row, the weapon on its own line), the
// fixed-height row geometry (nothing may resize the card — including
// the econ row's exact two-line util reserve, pinned below the old
// 3em slack) and the weapon icon's aspect-ratio rule (intrinsic ratio,
// capped at the line's height — the same rule pinned for the held
// indicator, while the shared .pc-ico square stays 15px for the
// badges),
// the live stats row, the carried C4, the tri-state defuse-kit badge
// (kit=true renders it, false/null render nothing), and the honest "—"
// placeholders when
// slotStateAt state is null (never a zero presented as a fact) — plus the
// held-item weapon-row modes: a knife/util/C4 ACTIVE in hand rides INSIDE
// the MAIN weapon's chip, right after the gun icon (the old .pc-hsep
// separator is gone for good — markup and CSS), with the MAIN weapon's
// ammo (v3 mainMag/mainReserve) still right-pinned at the row's edge; a
// knife-round inventory renders the bare held icon (no name), and a
// firearm active renders no held indicator at all — and the RELOAD ring:
// hidden when reloadProgress is null, a grey track + a dasharray-swept
// arc in the gun chip while reloading, mounted in BOTH weapon-row modes
// that show a gun, sitting between the gun icon and the held indicator,
// with the row's fixed-height pins untouched. Section H6 also pins the
// LONG-LOADOUT yield order (the reported ammo-clipping bug): the ammo
// cell is the never-yielding one (flex:none + nowrap), the icon cells
// carry the shrink — structural pins only, jsdom does no layout.
// Section J pins the card CLICK → onFollow wiring (the root fires, an
// inner control like the mute button is guarded out, a DEAD card stays
// clickable) plus its KEYBOARD parity (role=button + tabindex, Enter/Space
// fire, other keys and inner-control keys never) and its CSS: the
// pointer/hover affordance and the .pc-follow border tint — never an
// outline (the one-ring pin above scans every .pc-card rule).
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
// (fmt → rounds; replay/playercard → replay/landmarks → rounds + fmt +
// teams — landmarks' chat export helpers (teams → sideparity); and the
// playercard → loadout → bullets → state chain the held-item prefix
// pulls in — loadout.js also imports bullets.js). The
// components are compiled with css:'injected' so their <style> blocks
// land in the document — the outline-geometry checks below read the real
// rules the browser would apply.
for (const rel of ['rounds.js', 'fmt.js', 'players.js', 'sideparity.js', 'teams.js']) {
  writeFileSync(join(dir, rel), readFileSync(join('src/lib', rel), 'utf8'));
}
for (const rel of ['landmarks.js', 'playercard.js', 'loadout.js', 'bullets.js', 'state.js']) {
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
check(
  'NO weapon name text — the icon-only row keeps the name in the chip tooltip',
  !q(root, '.pc-wname') && q(root, '.pc-weapon')?.getAttribute('title') === 'AK-47 — 23 / 71',
  q(root, '.pc-weapon')?.getAttribute('title'),
);
check(
  'weapon chip cells are the icon + ammo only',
  JSON.stringify([...q(root, '.pc-weapon').children].map(pcClass)) ===
    JSON.stringify(['pc-ico', 'pc-num pc-ammo']),
  JSON.stringify([...q(root, '.pc-weapon').children].map(pcClass)),
);
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
check(
  'firearm active → the ordinary block only: NO held indicator, NO separator',
  !q(root, '.pc-held') && !q(root, '.pc-hsep'),
);

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

console.log('A3. defuse-kit badge: a TRI-STATE prop — only `true` draws it');
// The badge is inert plumbing today (nothing passes `kit` until the
// Replay wiring lands); the component contract is what is pinned here.
const kitCard = {
  ...fullCard,
  iconURLs: { ...fullCard.iconURLs, 'Defuse Kit': '/api/icons/defuser.svg' },
};
const rootKit = await show({ card: { ...kitCard, kit: true, onToggleMute: () => {} } });
const kitCell = q(rootKit, '.pc-kit');
check('kit={true} → the badge mounts inside the econ row', !!kitCell && !!q(rootKit, '.pc-econ .pc-kit'));
check('kit badge titled "Defuse kit"', kitCell?.getAttribute('title') === 'Defuse kit', kitCell?.getAttribute('title'));
check(
  'kit renders its icon when one resolves (alt "Kit")',
  !!q(kitCell, 'img') &&
    q(kitCell, 'img').getAttribute('src') === '/api/icons/defuser.svg' &&
    q(kitCell, 'img').getAttribute('alt') === 'Kit',
  q(kitCell, 'img')?.getAttribute('alt'),
);
check(
  'the kit cell uses the shared 15px .pc-ico square (the C4 badge geometry)',
  !!q(kitCell, '.pc-ico'),
);
check(
  'kit={false} → no badge (KNOWN not to hold one)',
  !(await show({ card: { ...kitCard, kit: false, onToggleMute: () => {} } })).querySelector('.pc-kit'),
);
const rootKitNull = await show({ card: { ...kitCard, onToggleMute: () => {} } });
check(
  'kit omitted (null) → no badge (unknown is never drawn as a fact)',
  !q(rootKitNull, '.pc-kit'),
);
const rootKitNoIcon = await show({
  card: { ...kitCard, kit: true, iconURLs: null, icons: null, onToggleMute: () => {} },
});
check(
  'kit falls back to its "Kit" text label when no icon exists',
  q(rootKitNoIcon, '.pc-kit')?.textContent.trim() === 'Kit',
  q(rootKitNoIcon, '.pc-kit')?.textContent,
);
check('no <img> anywhere on the no-icon card', qa(rootKitNoIcon, 'img').length === 0);
// C4 + kit together: two independent badges, C4 first, both cells fixed.
const rootBoth = await show({
  card: {
    ...kitCard,
    kit: true,
    state: { ...fullCard.state, inventory: ['AK-47', 'C4', 'Smoke Grenade'] },
    onToggleMute: () => {},
  },
});
const bothKids = [...q(rootBoth, '.pc-econ').children].map(pcClass);
check(
  'C4 and kit badges coexist, C4 first (money → util → C4 → kit)',
  JSON.stringify(bothKids) === JSON.stringify(['pc-num pc-money', 'pc-util', 'pc-c4', 'pc-kit']),
  JSON.stringify(bothKids),
);

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

// The FIREARM icons' own rule: they keep their intrinsic aspect ratio
// (width:auto — no forced square) and are capped at the weapon line's
// height, which the row's overflow:hidden enforces — a wide rifle fills
// the line instead of letterboxing inside the shared 15px square, and
// the line's height never changes.
const wIcoRule =
  sheetText()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.pc-weapon[^{}]*\.pc-ico[^{}]*\{[^}]*\}/)?.[0] || '';
check(
  'the firearm icon keeps its aspect ratio (width:auto + object-fit:contain)',
  /width:\s*auto/.test(wIcoRule) && /object-fit:\s*contain/.test(wIcoRule),
  wIcoRule,
);
const iconH = ((wIcoRule.match(/height:\s*([^;]+);/) || [])[1] || '').trim();
const rowH = ((ruleFor('pc-weapon-row').match(/height:\s*([^;]+);/) || [])[1] || '').trim();
check(
  'the firearm icon is capped at EXACTLY the weapon line height (never exceeds it)',
  iconH !== '' && iconH === rowH,
  `icon ${iconH || '(none)'} vs row ${rowH}`,
);
// The held indicator takes the SAME aspect treatment (it is the line's
// subject too): one rule covers mode 2's indicator (inside the gun chip)
// and mode 3's bare held chip.
const hIcoRule =
  sheetText()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.pc-held[^{}]*\.pc-ico[^{}]*\{[^}]*\}/)?.[0] || '';
check(
  'the held indicator keeps its aspect ratio (width:auto + object-fit:contain)',
  /width:\s*auto/.test(hIcoRule) && /object-fit:\s*contain/.test(hIcoRule),
  hIcoRule,
);
const heldIconH = ((hIcoRule.match(/height:\s*([^;]+);/) || [])[1] || '').trim();
check(
  'the held indicator is capped at EXACTLY the weapon line height (same as the gun)',
  heldIconH !== '' && heldIconH === rowH,
  `held ${heldIconH || '(none)'} vs row ${rowH}`,
);
check(
  'the shared .pc-ico square stays a 15px cell for armor/util/C4 badges',
  /width:\s*15px/.test(ruleFor('pc-ico(?![\\w-])')) &&
    /height:\s*15px/.test(ruleFor('pc-ico(?![\\w-])')),
  ruleFor('pc-ico(?![\\w-])'),
);
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
const dashes = ['.pc-hp', '.pc-armor-val', '.pc-ammo', '.pc-money'].map((s) => q(rootD, s)?.textContent);
check('every value renders —', JSON.stringify(dashes) === JSON.stringify(['—', '—', '—', '—']), JSON.stringify(dashes));
check(
  'the nameless weapon row degrades to the honest ammo placeholder + tooltip',
  !q(rootD, '.pc-wname') &&
    q(rootD, '.pc-weapon')?.textContent.trim() === '—' &&
    q(rootD, '.pc-weapon')?.getAttribute('title') === 'Weapon unknown',
  `${q(rootD, '.pc-weapon')?.textContent} / ${q(rootD, '.pc-weapon')?.getAttribute('title')}`,
);
check('utility renders —', q(rootD, '.pc-util').textContent.trim() === '—', q(rootD, '.pc-util').textContent);
check('utility title says unknown', q(rootD, '.pc-util').getAttribute('title') === 'Utility unknown');
check('no $0 anywhere on the card', !cardD.textContent.includes('$0'), cardD.textContent);
check('no icons (nothing to show)', qa(rootD, 'img').length === 0);
check('armor falls back to the plain label', q(rootD, '.pc-armor')?.textContent.includes('Armor'));

console.log('E. icons absent: text fallbacks, helmet tri-state');
const noIcons = { ...fullCard, iconURLs: null, icons: null };
const rootE = await show({ card: { ...noIcons, onToggleMute: () => {} } });
check('no <img> when no source resolves', qa(rootE, 'img').length === 0);
check(
  'no weapon name text when the icon is missing — the chip tooltip still names it',
  !q(rootE, '.pc-wname') &&
    q(rootE, '.pc-weapon')?.getAttribute('title') === 'AK-47 — 23 / 71',
  q(rootE, '.pc-weapon')?.getAttribute('title'),
);
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

console.log('H. held-item weapon row: knife/util/C4 in hand → the held icon rides AFTER the gun icon inside the main chip (or the bare icon)');
// The v3 state fields: the MAIN weapon's ammo rides alongside the
// active one's; with a held item in hand the row must show the MAIN
// weapon's icon and ITS ammo — never the held item's artifact (the
// knife reads "1 / 0") — and no name text at all (the chip tooltip
// names the gun).
const heldBase = {
  ...fullCard,
  playerColor: null,
  stats: null,
  state: {
    ...fullCard.state,
    weapon: 'Knife',
    magAmmo: 1, // the knife's artifact ammo — must never be displayed
    reserveAmmo: 0,
    inventory: ['AK-47', 'Knife', 'Smoke Grenade', 'Flashbang', 'Flashbang'],
    mainMag: 30,
    mainReserve: 90,
  },
  iconURLs: { ...fullCard.iconURLs, Knife: '/api/icons/knife.svg' },
};

// H1 — knife held with an AK carried: <AK icon><knife icon> … 30 / 90
const rootH1 = await show({ card: { ...heldBase, onToggleMute: () => {} } });
const heldImg = q(rootH1, '.pc-held img');
check(
  'H1 held knife icon, alt "" and NO text label of its own',
  !!heldImg &&
    heldImg.getAttribute('src') === '/api/icons/knife.svg' &&
    heldImg.getAttribute('alt') === '' &&
    !q(rootH1, '.pc-held .pc-wname'),
);
check(
  'H1 separator gone for good: zero .pc-hsep nodes anywhere + no CSS rule for it',
  document.querySelectorAll('.pc-hsep').length === 0 && ruleFor('pc-hsep(?![\\w-])') === '',
  `nodes ${document.querySelectorAll('.pc-hsep').length} / rule "${ruleFor('pc-hsep(?![\\w-])')}"`,
);
check(
  'H1 main block carries NO name text — the chip tooltip names the AK-47',
  !q(rootH1, '.pc-weapon-row .pc-wname') &&
    q(rootH1, '.pc-weapon')?.getAttribute('title') === 'AK-47 — 30 / 90',
  q(rootH1, '.pc-weapon')?.getAttribute('title'),
);
check(
  'H1 ammo shows the MAIN mag/reserve (30 / 90 — not the knife artifact 1 / 0)',
  q(rootH1, '.pc-ammo')?.textContent === '30 / 90',
  q(rootH1, '.pc-ammo')?.textContent,
);
check(
  'H1 main block reuses .pc-ico with the AK icon',
  q(rootH1, '.pc-weapon img')?.getAttribute('src') === '/api/icons/ak47.svg',
);
check(
  'H1 held chip title names both halves + the main ammo',
  q(rootH1, '.pc-held')?.getAttribute('title') === 'Knife + AK-47 — 30 / 90',
  q(rootH1, '.pc-held')?.getAttribute('title'),
);
const h1Kids = [...q(rootH1, '.pc-weapon-row').children].map(pcClass);
check(
  'H1 row children: ONE gun chip (the held indicator rides inside it now)',
  JSON.stringify(h1Kids) === JSON.stringify(['pc-chip pc-weapon']),
  JSON.stringify(h1Kids),
);
const h1GunKids = [...q(rootH1, '.pc-weapon-row .pc-weapon').children].map(pcClass);
check(
  'H1 gun chip order: gun icon → held indicator → ammo (the ammo stays right-pinned)',
  JSON.stringify(h1GunKids) === JSON.stringify(['pc-ico', 'pc-held', 'pc-num pc-ammo']),
  JSON.stringify(h1GunKids),
);
const h1CardKids = [...q(rootH1, '.pc-card').children].map(pcClass);
check(
  'H1 card row order unchanged (the prefix never moves the stack)',
  JSON.stringify(h1CardKids) === JSON.stringify(['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']),
  JSON.stringify(h1CardKids),
);

// H2 — the spec's exact example: a flash held with an AK carried.
const rootH2 = await show({
  card: {
    ...heldBase,
    state: { ...heldBase.state, weapon: 'Flashbang', inventory: ['AK-47', 'Flashbang', 'Knife'] },
    onToggleMute: () => {},
  },
});
check(
  'H2 flash indicator inside the gun chip + the main ammo (no name text, no separator)',
  q(rootH2, '.pc-held img')?.getAttribute('src') === '/api/icons/flashbang.svg' &&
    !q(rootH2, '.pc-hsep') &&
    !q(rootH2, '.pc-wname') &&
    q(rootH2, '.pc-weapon img')?.getAttribute('src') === '/api/icons/ak47.svg' &&
    q(rootH2, '.pc-ammo')?.textContent === '30 / 90',
  `${q(rootH2, '.pc-held img')?.getAttribute('src')} | ${q(rootH2, '.pc-weapon img')?.getAttribute('src')} | ${q(rootH2, '.pc-ammo')?.textContent}`,
);
const h2Imgs = qa(rootH2, '.pc-weapon img');
check(
  'H2 order inside the gun chip: AK icon first, flash indicator right after it',
  h2Imgs.length === 2 &&
    h2Imgs[0].getAttribute('src') === '/api/icons/ak47.svg' &&
    h2Imgs[1].getAttribute('src') === '/api/icons/flashbang.svg',
  h2Imgs.map((i) => i.getAttribute('src')).join(' → '),
);
check(
  'H2 held chip title = Flashbang + AK-47 pair',
  q(rootH2, '.pc-held')?.getAttribute('title') === 'Flashbang + AK-47 — 30 / 90',
  q(rootH2, '.pc-held')?.getAttribute('title'),
);

// H3 — knife round (inventory is knife-only): the BARE held icon.
const rootH3 = await show({
  card: {
    ...heldBase,
    state: { ...heldBase.state, inventory: ['Knife'], mainMag: 0, mainReserve: 0 },
    onToggleMute: () => {},
  },
});
check(
  'H3 bare held icon renders',
  !!q(rootH3, '.pc-held img') && q(rootH3, '.pc-held img').getAttribute('src') === '/api/icons/knife.svg',
);
check(
  'H3 NO separator and NO name/ammo in the weapon row',
  !q(rootH3, '.pc-hsep') && !q(rootH3, '.pc-weapon-row .pc-wname') && !q(rootH3, '.pc-weapon-row .pc-ammo'),
);
const h3Kids = [...q(rootH3, '.pc-weapon-row').children].map(pcClass);
check(
  'H3 row holds ONLY the bare held chip (mode 3 keeps working)',
  JSON.stringify(h3Kids) === JSON.stringify(['pc-chip pc-held']),
  JSON.stringify(h3Kids),
);
check(
  'H3 title is honest about the missing firearm',
  q(rootH3, '.pc-held')?.getAttribute('title') === 'Knife in hand — no firearm carried',
  q(rootH3, '.pc-held')?.getAttribute('title'),
);
check(
  'H3 the row keeps its fixed height (nothing collapses)',
  !!q(rootH3, '.pc-weapon-row') &&
    /height:\s*[^;]+;/.test(ruleFor('pc-weapon-row')) &&
    /overflow:\s*hidden/.test(ruleFor('pc-weapon-row')),
  ruleFor('pc-weapon-row'),
);
const h3CardKids = [...q(rootH3, '.pc-card').children].map(pcClass);
check(
  'H3 card row order unchanged',
  JSON.stringify(h3CardKids) === JSON.stringify(['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']),
  JSON.stringify(h3CardKids),
);

// H4 — C4 in hand counts as a third held item.
const rootH4 = await show({
  card: {
    ...heldBase,
    state: { ...heldBase.state, weapon: 'C4', inventory: ['AK-47', 'C4'] },
    iconURLs: { ...heldBase.iconURLs, C4: '/api/icons/c4.svg' },
    onToggleMute: () => {},
  },
});
check(
  'H4 C4 indicator inside the gun chip + the main ammo (no name text, no separator)',
  q(rootH4, '.pc-held img')?.getAttribute('src') === '/api/icons/c4.svg' &&
    !q(rootH4, '.pc-hsep') &&
    !q(rootH4, '.pc-wname') &&
    q(rootH4, '.pc-weapon img')?.getAttribute('src') === '/api/icons/ak47.svg' &&
    q(rootH4, '.pc-ammo')?.textContent === '30 / 90',
  `${q(rootH4, '.pc-held img')?.getAttribute('src')} | ${q(rootH4, '.pc-weapon img')?.getAttribute('src')}`,
);
const h4Imgs = qa(rootH4, '.pc-weapon img');
check(
  'H4 order inside the gun chip: AK icon first, C4 indicator right after it',
  h4Imgs.length === 2 &&
    h4Imgs[0].getAttribute('src') === '/api/icons/ak47.svg' &&
    h4Imgs[1].getAttribute('src') === '/api/icons/c4.svg',
  h4Imgs.map((i) => i.getAttribute('src')).join(' → '),
);

// H5 — held icon missing from the manifest: degrade silently (the
// prefix has no text label by design) — no held chip, no separator, the
// MAIN block stays (icon + ammo, its tooltip naming the gun).
const rootH5 = await show({
  card: { ...heldBase, iconURLs: fullCard.iconURLs, onToggleMute: () => {} }, // no Knife icon
});
check(
  'H5 no held icon → no prefix, no separator, main block intact',
  !q(rootH5, '.pc-held') &&
    !q(rootH5, '.pc-hsep') &&
    !q(rootH5, '.pc-wname') &&
    q(rootH5, '.pc-weapon')?.getAttribute('title') === 'AK-47 — 30 / 90' &&
    q(rootH5, '.pc-ammo')?.textContent === '30 / 90',
  q(rootH5, '.pc-weapon')?.getAttribute('title'),
);

// H6 — LONG LOADOUT (the "M4A1-S pushes the ammo off the right edge"
// report): a wide weapon + knife pair can outgrow a narrow column and
// this row clips overflow — so the row pins a YIELD ORDER rather than
// amputating the trailing readout: the ammo cell NEVER yields
// (flex:none + nowrap) and the icon cells carry the shrink
// (flex:0 1 auto + min-width:0 — object-fit keeps the art's ratio, it
// only renders smaller). jsdom performs no layout, so these pins are
// honestly structural: the rendered cells + full ammo text for the
// long pair, and the injected CSS rules that are the contract. The row
// is icon-only BY DESIGN (the name rides the chip tooltip, pinned in A
// and H1 — there is no name span to ellipsize), so the "truncating
// cell" pin here is the icon cells' shrink rule, not a text ellipsis.
// The canonical EquipmentType spelling for the silenced M4 is 'M4A1'
// (the icon table maps it to m4a1_silencer — the 3:1 silhouette).
const rootH6 = await show({
  card: {
    ...heldBase,
    state: {
      ...heldBase.state,
      weapon: 'Knife',
      inventory: ['M4A1', 'Knife'], // M4A1-S + knife — the reported pair
      mainMag: 20,
      mainReserve: 60,
    },
    iconURLs: { ...heldBase.iconURLs, M4A1: '/api/icons/m4a1_silencer.svg' },
    onToggleMute: () => {},
  },
});
check(
  'H6 long M4A1-S + knife renders gun icon → knife icon → FULL ammo on the one row',
  q(rootH6, '.pc-weapon img')?.getAttribute('src') === '/api/icons/m4a1_silencer.svg' &&
    !!q(rootH6, '.pc-held img') &&
    q(rootH6, '.pc-ammo')?.textContent === '20 / 60',
  `${q(rootH6, '.pc-weapon img')?.getAttribute('src')} | ${
    q(rootH6, '.pc-held img')?.getAttribute('src')
  } | ${q(rootH6, '.pc-ammo')?.textContent}`,
);
const h6Kids = [...q(rootH6, '.pc-weapon-row .pc-weapon').children].map(pcClass);
check(
  'H6 chip cells unchanged: icon → held → ammo (no name span, no extra cell)',
  JSON.stringify(h6Kids) === JSON.stringify(['pc-ico', 'pc-held', 'pc-num pc-ammo']),
  JSON.stringify(h6Kids),
);
check(
  'H6 the full weapon name rides the tooltip (row stays icon-only)',
  !q(rootH6, '.pc-wname') &&
    q(rootH6, '.pc-weapon')?.getAttribute('title') === 'M4A1 — 20 / 60',
  q(rootH6, '.pc-weapon')?.getAttribute('title'),
);
// The CSS halves of the contract, read from the component's own
// injected sheet (comments stripped first — Svelte keeps them and the
// prose names selectors the regexes below would otherwise swallow).
const sheet6 = sheetText().replace(/\/\*[\s\S]*?\*\//g, '');
const h6AmmoRule = sheet6.match(/\.pc-ammo[^{}]*\{[^}]*\}/)?.[0] || '';
check(
  'H6 ammo = the non-yielder: flex:none + white-space:nowrap (9ch floor and auto pin kept)',
  /flex:\s*none/.test(h6AmmoRule) &&
    /white-space:\s*nowrap/.test(h6AmmoRule) &&
    /min-width:\s*9ch/.test(h6AmmoRule) &&
    /margin-left:\s*auto/.test(h6AmmoRule),
  h6AmmoRule,
);
const h6GunIcoRule = sheet6.match(/\.pc-weapon[^{}]*\.pc-ico[^{}]*\{[^}]*\}/)?.[0] || '';
const h6HeldIcoRule = sheet6.match(/\.pc-held[^{}]*\.pc-ico[^{}]*\{[^}]*\}/)?.[0] || '';
check(
  'H6 both icon cells carry the yield (flex 0 1 auto + min-width:0) beside the non-yielder',
  /flex:\s*0 1 auto/.test(h6GunIcoRule) &&
    /min-width:\s*0/.test(h6GunIcoRule) &&
    /flex:\s*0 1 auto/.test(h6HeldIcoRule) &&
    /min-width:\s*0/.test(h6HeldIcoRule),
  `${h6GunIcoRule} || ${h6HeldIcoRule}`,
);
const h6HeldSpanRule = sheet6.match(/\.pc-held\.[^{} ]*\s*\{[^}]*\}/)?.[0] || '';
check(
  'H6 the held wrapper is a shrinkable flex container (its img can shrink INSIDE it)',
  /display:\s*inline-flex/.test(h6HeldSpanRule) &&
    /flex:\s*0 1 auto/.test(h6HeldSpanRule) &&
    /min-width:\s*0/.test(h6HeldSpanRule),
  h6HeldSpanRule,
);
check(
  'H6 the row itself still clips + keeps its fixed height (the invariant the yield order protects)',
  /height:\s*[^;]+;/.test(ruleFor('pc-weapon-row')) && /overflow:\s*hidden/.test(ruleFor('pc-weapon-row')),
  ruleFor('pc-weapon-row'),
);
const h6CardKids = [...q(rootH6, '.pc-card').children].map(pcClass);
check(
  'H6 card row order unchanged (money → util → C4 → kit econ row untouched)',
  JSON.stringify(h6CardKids) ===
    JSON.stringify(['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']),
  JSON.stringify(h6CardKids),
);

console.log('I. reload ring: hidden when not reloading, a grey arc beside the gun icon while reloading');
// The fill's geometry comes from the component: r=5 in the 12×12
// viewBox → the circumference the dasharray/dashoffset sweep.
const CIRC = 2 * Math.PI * 5;

// I1 — no computed progress (the default: not reloading) → NO ring, and
// the firearm chip keeps exactly its icon + ammo cells (the A-section
// pin, re-checked so the ring can never become a permanent cell).
const rootI1 = await show({ card: { ...fullCard, onToggleMute: () => {} } });
check('no ring when not reloading (reloadProgress null)', !q(rootI1, '.pc-reload'));
check(
  'the firearm chip is still icon + ammo only without progress',
  JSON.stringify([...q(rootI1, '.pc-weapon').children].map(pcClass)) ===
    JSON.stringify(['pc-ico', 'pc-num pc-ammo']),
  JSON.stringify([...q(rootI1, '.pc-weapon').children].map(pcClass)),
);

// I2 — mid-run: the ring mounts INSIDE the firearm chip (between the
// icon and the ammo) with the arc swept to exactly the given progress.
const rootI2 = await show({ card: { ...fullCard, reloadProgress: 0.5, onToggleMute: () => {} } });
const ring2 = q(rootI2, '.pc-weapon-row .pc-weapon .pc-reload');
check('ring mounts in the firearm chip while reloading', !!ring2);
check(
  'ring is decorative (aria-hidden) and titled "Reloading"',
  !!ring2 &&
    ring2.getAttribute('aria-hidden') === 'true' &&
    ring2.getAttribute('title') === 'Reloading',
  ring2?.getAttribute('title'),
);
const chipKids2 = ring2 ? [...q(rootI2, '.pc-weapon').children].map(pcClass) : [];
check(
  'ring sits between the icon and the ammo',
  JSON.stringify(chipKids2) === JSON.stringify(['pc-ico', 'pc-reload', 'pc-num pc-ammo']),
  JSON.stringify(chipKids2),
);
const fill2 = ring2?.querySelector('.pc-reload-fill');
const track2 = ring2?.querySelector('.pc-reload-track');
check('track + fill circles render', !!track2 && !!fill2);
check(
  'fill sweeps exactly half the circle at progress 0.5',
  !!fill2 &&
    Math.abs(Number((fill2.getAttribute('stroke-dasharray') || '').split(' ')[0]) - CIRC) < 1e-9 &&
    Math.abs(Number(fill2.getAttribute('stroke-dashoffset')) - CIRC * 0.5) < 1e-9,
  `${fill2?.getAttribute('stroke-dasharray')} / ${fill2?.getAttribute('stroke-dashoffset')}`,
);
check(
  'the sweep starts at the top (both circles rotated -90° about the centre)',
  !!track2 &&
    track2.getAttribute('transform') === 'rotate(-90 6 6)' &&
    fill2.getAttribute('transform') === 'rotate(-90 6 6)',
  `${track2?.getAttribute('transform')} / ${fill2?.getAttribute('transform')}`,
);
check(
  'the card row stack is unchanged with the ring mounted',
  JSON.stringify([...q(rootI2, '.pc-card').children].map(pcClass)) ===
    JSON.stringify(['pc-head', 'pc-hp-row', 'pc-weapon-row', 'pc-econ', 'pc-stats']),
);

// The ring's own CSS: grey tokens only, a 1.2px stroke and a fixed 12px
// box that is paint (flex:none) — the C2 row-height pins must still hold.
const ringRule = ruleFor('pc-reload(?![\\w-])');
const trackRule = ruleFor('pc-reload-track');
const fillRule = ruleFor('pc-reload-fill');
check(
  'ring box: fixed 12px, flex:none (paint, never layout)',
  /width:\s*12px/.test(ringRule) && /height:\s*12px/.test(ringRule) && /flex:\s*none/.test(ringRule),
  ringRule,
);
check(
  'grey only: --divider track under a --muted fill (no new colour token)',
  /stroke:\s*var\(--divider\)/.test(trackRule) && /stroke:\s*var\(--muted\)/.test(fillRule),
  `${trackRule} | ${fillRule}`,
);
check(
  '1.2px stroke with round caps',
  /stroke-width:\s*1\.2/.test(ruleFor('pc-reload[^{}]*circle')) &&
    /stroke-linecap:\s*round/.test(fillRule),
  ruleFor('pc-reload[^{}]*circle'),
);
const ringRowH = ((ruleFor('pc-weapon-row').match(/height:\s*([^;]+);/) || [])[1] || '').trim();
check('the weapon row keeps its exact fixed height with the ring', ringRowH === '1.5em', ringRowH);

// I3 — progress 0 (a run the stream never clears): the ring still says
// "reloading" via the track — no fill circle, because a zero-length
// round-capped dash would draw a dot.
const rootI3 = await show({ card: { ...fullCard, reloadProgress: 0, onToggleMute: () => {} } });
const ring3 = q(rootI3, '.pc-reload');
check(
  'progress 0 → ring with the track only (no fill arc)',
  !!ring3 && !!ring3.querySelector('.pc-reload-track') && !ring3.querySelector('.pc-reload-fill'),
);

// I4 — mode 2: the MAIN gun chip gets the same ring; the held prefix
// never carries one (a reload names the gun being reloaded).
const rootI4 = await show({ card: { ...heldBase, reloadProgress: 0.25, onToggleMute: () => {} } });
const mainRing = q(rootI4, '.pc-weapon-row .pc-weapon .pc-reload');
check('mode 2: the ring rides the MAIN gun chip', !!mainRing);
check('mode 2: no ring on the held chip', !q(rootI4, '.pc-held .pc-reload'));
const chipKids4 = [...q(rootI4, '.pc-weapon').children].map(pcClass);
check(
  'mode 2 order with the ring: gun icon → ring → held indicator → ammo',
  JSON.stringify(chipKids4) === JSON.stringify(['pc-ico', 'pc-reload', 'pc-held', 'pc-num pc-ammo']),
  JSON.stringify(chipKids4),
);
const fill4 = mainRing?.querySelector('.pc-reload-fill');
check(
  'mode 2: fill swept to the given progress (0.25 → offset 0.75×circumference)',
  !!fill4 && Math.abs(Number(fill4.getAttribute('stroke-dashoffset')) - CIRC * 0.75) < 1e-9,
  fill4?.getAttribute('stroke-dashoffset'),
);

console.log('J. card click → onFollow (the replay follow wiring): the root fires, inner controls never, a dead card still does');
// The card is ONE click target: a root click reports onFollow (the
// caller drives engine.setFollow / releaseFollow — pinned end to end in
// replay.dom.mjs section F3), while a click landing on an inner control
// must NOT follow (the Match.svelte row idiom guard on the root).
const followsJ = [];
const rootJ = await show({ card: { ...fullCard, onFollow: () => followsJ.push('follow') } });
click(q(rootJ, '.pc-card'));
check(
  'clicking the card root fires onFollow exactly once',
  JSON.stringify(followsJ) === '["follow"]',
  JSON.stringify(followsJ),
);
click(q(rootJ, '.pc-card'));
check(
  'a second click fires again (the component never swallows a click — the toggle lives with the caller)',
  followsJ.length === 2,
  JSON.stringify(followsJ),
);

// Keyboard parity (the LandmarkRow role=button idiom): the card root is
// focusable with a role, Enter/Space fire follow, other keys never do,
// and a key landing on the mute button stays with the button.
const key = (el, k) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const followsJk = [];
const rootJk = await show({ card: { ...fullCard, onFollow: () => followsJk.push('f') } });
const cardJk = q(rootJk, '.pc-card');
check(
  'the card root is a focusable role=button (tabindex=0)',
  cardJk.getAttribute('role') === 'button' && cardJk.getAttribute('tabindex') === '0',
  `${cardJk.getAttribute('role')} / ${cardJk.getAttribute('tabindex')}`,
);
key(cardJk, 'Enter');
check('Enter on the card root fires onFollow', followsJk.length === 1, JSON.stringify(followsJk));
// dispatchEvent returns false when preventDefault ran (Space would
// otherwise scroll the page under the card).
const spaceOk = key(cardJk, ' ');
check(
  'Space on the card root fires onFollow AND is preventDefault-ed',
  followsJk.length === 2 && spaceOk === false,
  `${JSON.stringify(followsJk)} / defaultPrevented=${!spaceOk}`,
);
key(cardJk, 'x');
check('any other key never fires follow', followsJk.length === 2, JSON.stringify(followsJk));
const followsJk2 = [];
const rootJk2 = await show({
  card: { ...fullCard, onFollow: () => followsJk2.push('f'), onToggleMute: () => {} },
});
key(q(rootJk2, '.pc-mute'), 'Enter');
check('Enter on the inner mute button never fires onFollow (the same target guard)', followsJk2.length === 0, JSON.stringify(followsJk2));

// The mute button sits INSIDE the root: the target guard must keep it
// from firing follow while the mute itself still fires (section B pins
// the mute half on a fixture with NO onFollow; this pins the guard half
// with a recording onFollow beside it).
const followsJ2 = [];
const mutesJ2 = [];
const rootJ2 = await show({
  card: { ...fullCard, onFollow: () => followsJ2.push('f'), onToggleMute: () => mutesJ2.push('m') },
});
click(q(rootJ2, '.pc-mute'));
check(
  'a mute click fires onToggleMute once and NEVER onFollow (the root guard)',
  JSON.stringify(mutesJ2) === '["m"]' && followsJ2.length === 0,
  `${JSON.stringify(mutesJ2)} / follows=${JSON.stringify(followsJ2)}`,
);

// NO dead-gating: a DEAD card stays clickable (follow-of-dead is
// well-defined — the renderer holds the last alive position until
// respawn, and neither the keyboard nor the popover checks alive).
const followsJ3 = [];
const rootJ3 = await show({ card: { ...fullCard, dead: true, onFollow: () => followsJ3.push('f') } });
click(q(rootJ3, '.pc-card'));
check(
  'a dead card still fires onFollow (and still renders .pc-dead while clickable)',
  followsJ3.length === 1 && q(rootJ3, '.pc-card').classList.contains('pc-dead'),
  `${JSON.stringify(followsJ3)} / ${q(rootJ3, '.pc-card').className}`,
);

// --- The dead card's PAINT (the owner's ruling, 2026-11-11) ---------------
// A STRONGER dim than the old 0.72 and the card's BORDER going gray —
// both CSS-only, read from the component's injected sheet (comments
// stripped, like the ring pins). Border-color, never outline: the
// player-color box-shadow stays the card's ONE ring.
const deadRule = ruleFor('pc-dead(?![\\w-])');
check(
  'dead card dims MORE: opacity 0.55 (was 0.72)',
  /opacity:\s*0\.55\b/.test(deadRule),
  deadRule,
);
check(
  'dead card: the BORDER goes gray (border-color tint, never an outline)',
  /border-color:\s*var\(--muted\)/.test(deadRule) && !/outline/.test(deadRule),
  deadRule,
);
check(
  'live cards stay untouched: the base .pc-card rule carries NO opacity (dim lives only on .pc-dead)',
  !!ruleFor('pc-card(?![\\w-])') && !/opacity/.test(ruleFor('pc-card(?![\\w-])')),
  ruleFor('pc-card(?![\\w-])'),
);

// The follow highlight + click affordance: CSS-ONLY (no head markup is
// added — the head-order pin in section C stays green), and NEVER an
// outline (the one-ring pin above scans every .pc-card rule).
const followRule = ruleFor('pc-card\\.pc-follow');
check(
  '.pc-follow highlight rule exists: a BORDER tint (UI state, not side/identity)',
  /border-color/.test(followRule) && !/outline/.test(followRule),
  followRule,
);
check(
  'the card wears a pointer affordance (cursor: pointer on the base rule)',
  /cursor:\s*pointer/.test(ruleFor('pc-card(?![\\w-])')),
  ruleFor('pc-card(?![\\w-])'),
);
// Svelte scopes the hash BETWEEN the class and the pseudo-class
// (.pc-card.svelte-hash:hover), so the hover rule is matched through
// the scope hash, and the order pin compares the two rule positions.
const hoverRule = ruleFor('pc-card[^{}]*:hover');
check(
  'a modest hover treatment exists (border lift on :hover)',
  /border-color/.test(hoverRule),
  hoverRule,
);
// The follow tint must OUTRANK the hover lift (equal specificity →
// source order decides): the .pc-follow rule comes after the :hover one,
// so a followed card never loses its amber under the cursor.
const sheetJ = sheetText().replace(/\/\*[\s\S]*?\*\//g, '');
const hoverIdx = sheetJ.search(/\.pc-card[^{}]*:hover/);
const followIdx = sheetJ.search(/\.pc-card\.pc-follow/);
check(
  'the follow rule is ordered AFTER the hover rule (a followed card keeps its tint on hover)',
  hoverIdx >= 0 && followIdx > hoverIdx,
  `${hoverIdx} vs ${followIdx}`,
);

check('no runtime errors', errors.length === 0, errors.map((e) => e.message).join(' | '));
if (inst) unmount(inst);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures || errors.length ? 1 : 0);
