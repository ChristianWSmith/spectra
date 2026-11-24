// frontend/src/lib/strings/ — THE catalog for free chrome copy (class 1 of
// the user-text criterion in AGENTS.md): text the markup
// renders directly — text nodes, title/aria-label/placeholder, button labels,
// empty states, dialog and error phrasing. Domain-keyed label tables stay
// with their tables; content prose stays in its content module.
//
// index.js is the ONLY import path: `import * as S from '../strings/index.js'`
// (or `'./strings/index.js'` from lib/), then `S.<area>.<slot>`; compose at
// the call site with `fill(S.errors.someTemplate, { err })`.
//
// Values are plain strings with `{arg}` placeholders — no functions, no
// concatenation: the audit test reads them as data, a human reads them as
// prose, a future export/i18n can consume them.
//
// Every Svelte file that renders free chrome copy imports this barrel
// (strings-audit.test.js's Check B — unconditional since 2026-11-15, when
// the migration's class-1 inline ledger drained to empty).
//
// Run: node --test src/lib/strings-audit.test.js   (from frontend/)

export { common } from './common.js';
export { errors } from './errors.js';
export { replay } from './replay.js';
export { match } from './match.js';
export { library } from './library.js';
export { settings } from './settings.js';
export { builder } from './builder.js';
export { profiles } from './profiles.js';
export { reports } from './reports.js';
export { reportbuilder } from './reportbuilder.js';
export { economy } from './economy.js';
export { combat } from './combat.js';
export { utility } from './utility.js';
export { heatmaps } from './heatmaps.js';
export { components } from './components.js';
export { componentbuilder } from './componentbuilder.js';
export { builtins } from './builtins.js';

// fill() — the ONE composition helper: substitutes `{arg}` placeholders at
// the call site so catalog values stay plain strings. Lives here beside the
// catalog (not fmt.js — these are templates, not formats).
export function fill(template, args = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : whole,
  );
}
