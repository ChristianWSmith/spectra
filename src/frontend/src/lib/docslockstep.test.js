// docslockstep.test.js — THE manual-lockstep pin (queue-manual-lockstep,
// adopted 2026-11-14): the user guide stays in lockstep with the app's
// user-visible surfaces. PRODUCT.md **The manual stays in lockstep** is
// THE statement; this test is its mechanical half.
//
// Shape: a SURFACE CENSUS checked against the registered guide. Every
// census is derived from the REAL source at run time — the nav registry
// (`lib/nav.js` NAV_ACTIONS), App.svelte's sidebar chrome, the tab table
// (`lib/router.js` MATCH_TABS), Settings.svelte's <h2> panels and the
// view files on disk — never a hand-copied surface list. The hand-written
// part is the surface→section MAPPING TABLES below: THAT IS THE
// CONTRACT. Three failure modes, all instructive:
//   1. a surface with no mapping entry  → "update the mapping"
//   2. an entry whose section is missing from the guide → "add the
//      section (or an explicit placeholder) before merge"
//   3. an entry whose surface no longer exists → "stale entry"
// Sections a mapping may name must exist in the registered user-guide;
// a placeholder counts as a section here (the guide's own no-placeholder
// reality is docs.dom.mjs section E's separate, deliberately re-pin-able
// contract).
//
// PLACEMENT: unit tests live FLAT in `src/lib/` — the fast suite
// `node --test src/lib/*.test.js` (from `frontend/`) expands to
// top-level files only (every existing unit test is flat; a probe run
// confirmed a test under `src/lib/docs/` never runs), which is why this
// is `src/lib/docslockstep.test.js` and not under `src/lib/docs/`.
//
// Coverage decisions (dated 2026-11-14, lockstep adoption — the mapping
// tables are the record of these):
//   - Match's four analysis tabs (Economy/Utility/Combat/Heatmaps) are
//     deliberately covered by the ONE `match-analysis` section; the match
//     shell tabs (Overview/Scoreboard/Rounds/Details) by
//     `understanding-a-match`; the Reports tab by `reports`. (That table
//     now lives in lib/router.js as MATCH_TAB_SECTIONS — Match's header
//     `?` consumes it, so there is one spelling; see the note there.)
//   - Explorer renders as the Details tab's diagnostics block:
//     `understanding-a-match`'s Details paragraph documents all three of
//     its panels (Import details / Advanced diagnostics / Network
//     messages); its standalone route is not a nav destination.
//   - The sidebar's Help button opens the guide itself — `introduction`
//     documents it.
//   - Settings panels are covered INSIDE `settings`: the census
//     set-compares Settings.svelte's <h2> panels against that section's
//     `- **Panel** — …` bullets, so a new panel without a bullet fails
//     and a removed panel's stale bullet fails too.
// No surface is exempt today; a future one either gets a section (or
// placeholder) or an explicit mapping entry with a comment justifying
// the broader section that covers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { NAV_ACTIONS } from './nav.js';
import { MATCH_TABS, MATCH_TAB_SECTIONS } from './router.js';
import { getDoc } from './docs/registry.js';
import './docs/manuals/index.js'; // registers the shipped user guide

const appSrc = readFileSync(new URL('../App.svelte', import.meta.url), 'utf8');
const settingsSrc = readFileSync(new URL('./views/Settings.svelte', import.meta.url), 'utf8');
const viewFiles = readdirSync(new URL('./views/', import.meta.url))
  .filter((f) => f.endsWith('.svelte'))
  .sort();

const guide = getDoc('user-guide');
assert.ok(guide, 'manuals/index.js must have registered the user guide');
const sectionIds = new Set(guide.sections.map((s) => s.id));

// ---------------------------------------------------------------------------
// The mapping tables — THE contract (dated 2026-11-14). Surface → the guide
// section that documents it. Add an entry when a surface appears; delete it
// (with the surface) when one goes; point it at a new section when coverage
// needs its own section.
// ---------------------------------------------------------------------------

// Nav destinations — lib/nav.js NAV_ACTIONS (App's sidebar and the command
// palette render this one list).
const NAV_SECTIONS = {
  Library: 'library',
  Match: 'understanding-a-match', // the match view's own section (L4: Match became its own sidebar tab)
  Profiles: 'profiles',
  Builder: 'metric-builder',
  'Reports builder': 'reports-builder',
  'Component builder': 'component-builder',
  'SQL console': 'sql-console',
  Settings: 'settings',
};

// Match view tabs — lib/router.js MATCH_TABS. The table itself moved to
// router.js as MATCH_TAB_SECTIONS (help-buttons, 2026-11-15): Match's
// header `?` targets the ACTIVE tab's section, so the view consumes it
// and there may be only ONE spelling (AGENTS "One canonical way"). The
// contract is unchanged and still asserted below: the keys are exactly
// MATCH_TABS and every value is a registered guide section.
const TAB_SECTIONS = MATCH_TAB_SECTIONS;

// Sidebar chrome buttons that are NOT nav actions — literal title=""
// attributes inside App.svelte's <nav class="sidebar"> block (NAV_ACTIONS'
// own titles are expressions and never match the literal scan).
const SIDEBAR_SECTIONS = {
  Help: 'introduction',
};

// View files — src/lib/views/*.svelte (every route-rendered view; embedded
// rendering is covered by its host section, see the header).
const VIEW_SECTIONS = {
  'Builder.svelte': 'metric-builder',
  'CompareRounds.svelte': 'understanding-a-match',
  'Explorer.svelte': 'understanding-a-match', // the Details tab's diagnostics block
  'Library.svelte': 'library',
  'Match.svelte': 'understanding-a-match', // per-tab coverage is TAB_SECTIONS
  'PlayerProfile.svelte': 'profiles',
  'Profiles.svelte': 'profiles',
  'Replay.svelte': 'replay',
  'Reports.svelte': 'reports',
  'ReportsBuilder.svelte': 'reports-builder',
  'ComponentBuilder.svelte': 'component-builder',
  'RoundDetail.svelte': 'understanding-a-match',
  'Settings.svelte': 'settings',
  'SqlConsole.svelte': 'sql-console',
};

// assertCovered — one surface's half of the contract: it must be mapped,
// and its section must be in the registered guide.
function assertCovered(surface, sectionId) {
  assert.ok(
    sectionId,
    `${surface} has no mapping entry — a new user-visible surface needs a guide section ` +
      '(or an explicit placeholder) plus a mapping entry in docslockstep.test.js, in the same change',
  );
  assert.ok(
    sectionIds.has(sectionId),
    `${surface} maps to guide section "${sectionId}", which is not registered in the user guide — ` +
      'add the section before merge',
  );
}

// assertNoStale — the reverse direction: every mapped surface still exists.
function assertNoStale(kind, mapped, actual) {
  assert.deepEqual(
    mapped.sort(),
    [...actual].sort(),
    `${kind} changed — the surface→section mapping table is the contract; update it in the SAME change ` +
      '(new surface ⇒ new entry + guide section; removed surface ⇒ drop its entry)',
  );
}

// ---------------------------------------------------------------------------
// The censuses
// ---------------------------------------------------------------------------

test('lockstep: every nav destination (lib/nav.js NAV_ACTIONS) maps to a guide section', () => {
  assertNoStale('NAV_ACTIONS', Object.keys(NAV_SECTIONS), NAV_ACTIONS.map((a) => a.label));
  for (const a of NAV_ACTIONS) assertCovered(`nav destination "${a.label}"`, NAV_SECTIONS[a.label]);
});

test('lockstep: every sidebar chrome button (App.svelte) maps to a guide section', () => {
  const start = appSrc.indexOf('<nav class="sidebar"');
  assert.ok(start >= 0, 'App.svelte no longer has <nav class="sidebar"> — re-derive the sidebar census');
  const end = appSrc.indexOf('</nav>', start);
  assert.ok(end > start, 'the sidebar block does not close — re-derive the sidebar census');
  const titles = [...appSrc.slice(start, end).matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(titles.length > 0, 'no literal title= attribute found in the sidebar — the census is broken');
  assertNoStale('sidebar buttons', Object.keys(SIDEBAR_SECTIONS), titles);
  for (const t of titles) assertCovered(`sidebar button "${t}"`, SIDEBAR_SECTIONS[t]);
});

test('lockstep: every match view tab (lib/router.js MATCH_TABS) maps to a guide section', () => {
  assertNoStale('MATCH_TABS', Object.keys(TAB_SECTIONS), MATCH_TABS);
  for (const t of MATCH_TABS) assertCovered(`match tab "${t}"`, TAB_SECTIONS[t]);
});

test('lockstep: every Settings panel (Settings.svelte <h2>) is documented in the guide settings section', () => {
  // The census: Settings.svelte's panel headings.
  const panels = [...settingsSrc.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    m[1]
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim(),
  );
  assert.ok(panels.length >= 5, `only ${panels.length} Settings <h2> panels found — the census is broken`);
  // The guide side: the settings section's `- **Panel** — …` bullets.
  const sec = guide.sections.find((s) => s.id === 'settings');
  assert.ok(sec, 'the guide has no settings section');
  const bullets = [...sec.blocks.matchAll(/^- \*\*(.+?)\*\* — (.+)$/gm)].map((m) => ({
    name: m[1],
    desc: m[2].trim(),
  }));
  assert.ok(bullets.length > 0, 'the settings section carries no panel bullets — the census is broken');
  assertNoStale(
    'Settings panels vs the guide settings bullets',
    bullets.map((b) => b.name),
    panels,
  );
  for (const b of bullets) {
    assert.ok(
      b.desc.length >= 10,
      `the settings bullet for "${b.name}" has no real description — a panel's guide entry is prose, not a stub`,
    );
  }
});

test('lockstep: every view file (src/lib/views/*.svelte) maps to a guide section', () => {
  assertNoStale('src/lib/views', Object.keys(VIEW_SECTIONS), viewFiles);
  for (const f of viewFiles) assertCovered(`view ${f}`, VIEW_SECTIONS[f]);
});
