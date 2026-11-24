import './compile-worker-node.mjs';
// jsdom driver for the Reports and Explorer panels as builtin components
// Each panel mounts in
// a real ComponentFrame with a FIXED context ({ matchId, steamId: null,
// round: null }) and the real read services over the scripted Wails stub.
//
//   A. Reports: the template grid, the active template, and no match picker
//      in the embedded tab (the Match view's context is the match);
//   B. Reports appendix: a picked metric's readout counts its stored rows for
//      the context's match; a match with no stored row shows its state chip,
//      never a number (ruling 23);
//   C. Reports context: the same view for another match reads that match's
//      rows (the context, not a stored id, picks the match);
//   D. Explorer: the import-details facts (a zero sample rate is the dash) and
//      the entity summary render from their own reads;
//   E. Explorer failure isolation: a failed provenance read shows its error in
//      the provenance panel while the diagnostics panel still renders;
//
// Run (from frontend/):  node test/reports-explorer-panels.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HUMAN_A = '76561198000000001';
const HUMAN_B = '76561198000000002';
const MATCH = 7;
const OTHER = 8;

const h = await boot('reports-explorer-panels');
const { bindings, services, panels, mountComponent, sleep } = h;
const viewstate = await import(pathToFileURL(h.bundle(resolve('src/lib/viewstate.svelte.js'))).href); // the panels' copy: one instance

// --- the scripted backend -----------------------------------------------------
const DEFS = [
  { id: 1, name: 'kills', title: 'Kills', scope: 'match', subject: 'player', format: 'int', expr: 'kills' },
  { id: 2, name: 'top_fragger', title: 'Top fragger', scope: 'match', subject: 'player', format: 'identity', expr: 'argmax' },
];
const STATES = [
  { metricId: 1, state: 'fresh', error: '' },
  { metricId: 2, state: 'fresh', error: '' },
];
// Stored values: match 7 has kills for both players; match 8 has none.
const VALUES = [
  { metricId: 1, subjectKey: HUMAN_A, dim: '', value: 12, valueKey: '', n: 12 },
  { metricId: 1, subjectKey: HUMAN_B, dim: '', value: 4, valueKey: '', n: 4 },
];
const ROSTER = [
  { steamId: HUMAN_A, name: 'Alpha', side: 'ct', score: 13, isBot: false },
  { steamId: HUMAN_B, name: 'Bravo', side: 't', score: 4, isBot: false },
];

bindings.PlatformService.ListReportTemplates = () =>
  Promise.resolve([
    { id: 'match-summary', title: 'Match summary', scope: 'match', format: 'md', origin: 'builtin' },
    { id: 'player-card', title: 'Player card', scope: 'player', format: 'md', origin: 'builtin' },
  ]);
bindings.PlatformService.RenderReport = () => Promise.resolve('# report body\n');
bindings.MetricsService.ListMetrics = () => Promise.resolve(DEFS);
bindings.MetricsService.GetMetricComputeState = () => Promise.resolve(STATES);
bindings.MetricsService.GetMetricValuesForMatch = (matchId, ids) =>
  Promise.resolve(matchId === MATCH ? VALUES.filter((v) => ids.includes(v.metricId)) : []);
bindings.MatchService.GetPlayerRefs = () => Promise.resolve(ROSTER.map((r) => ({ steamId: r.steamId, name: r.name })));
bindings.MatchService.GetScoreboard = () => Promise.resolve(ROSTER);
bindings.MatchService.GetRounds = () => Promise.resolve([{ number: 1 }, { number: 2 }]);
bindings.ProfileService.ListPlayers = () => Promise.resolve(ROSTER);
bindings.PlatformService.GetProvenance = (id) =>
  Promise.resolve({
    parserVersion: 'p-2026.11',
    extractedAt: '2026-03-03T10:00:00Z',
    parseMs: 1200,
    sampleRate: 0,
    voiceChunks: 5,
    warnings: 2,
    status: 'ready',
    notes: [],
    encMessages: 0,
    matchId: id,
  });
bindings.PlatformService.GetEntitySummary = () =>
  Promise.resolve({ entityClasses: 42, endEntities: 900, genericTypes: 3, genericTotal: 77, notes: '' });
services.invalidate();

// --- checks -------------------------------------------------------------------
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const ctx = (matchId) => ({ matchId, steamId: null, round: null });

// The picked stats the appendix reads: the registry seeds the view's selection,
// as a restored session would (viewstate.svelte.js seed()).
function pickKills() {
  viewstate.resetViewState();
  viewstate.remember('reports', { tplId: 'match-summary', stats: [1], rawStats: [] });
}

console.log('A. Reports: the template grid and the embedded tab');
{
  viewstate.resetViewState();
  const m = await mountComponent(panels['match-reports'], ctx(MATCH), { embedded: true });
  await sleep(100);
  const tiles = [...m.target.querySelectorAll('.rep-tpl')];
  check('two templates from the catalog', tiles.length === 2, tiles.map(text).join(' | '));
  check('the first template is the selected one by default', tiles[0] && tiles[0].getAttribute('aria-pressed') === 'true');
  check('the embedded tab has no match picker (the context is the match)', !m.target.querySelector('#rep-match'));
  m.cleanup();
}

console.log('B. Reports appendix: a picked metric counts its stored rows for the context match');
{
  pickKills();
  const m = await mountComponent(panels['match-reports'], ctx(MATCH), { embedded: true });
  await sleep(150);
  const readouts = [...m.target.querySelectorAll('.rep-metric')];
  check('one readout for the picked metric', readouts.length === 1, String(readouts.length));
  check('the readout names the metric', readouts[0] && text(readouts[0]).startsWith('Kills'), readouts[0] && text(readouts[0]));
  check('the readout counts the two stored rows (2 rows)', readouts[0] && text(readouts[0]).includes('2 rows'), readouts[0] && text(readouts[0]));
  m.cleanup();
}
console.log('C. Reports context: another match reads its own rows (none: a state chip, not a number)');
{
  pickKills();
  const m = await mountComponent(panels['match-reports'], ctx(OTHER), { embedded: true });
  await sleep(150);
  const readout = m.target.querySelector('.rep-metric');
  check('the other match has no stored rows: no row count', readout && !text(readout).includes('rows'), readout && text(readout));
  check('the other match shows a state chip, never a number', readout && !/\d/.test(text(readout).replace('Kills', '')), readout && text(readout));
  m.cleanup();
}


console.log('D. Details: the import details and the entity summary, one panel');
{
  viewstate.resetViewState();
  const m = await mountComponent(panels['match-details'], ctx(MATCH), { embedded: true });
  await sleep(400);
  const facts = [...m.target.querySelectorAll('dl.facts > div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]);
  const rate = facts.find((f) => f[0] !== '' && f[1] === '—');
  check('the parser version renders', facts.some((f) => f[1] === 'p-2026.11'), JSON.stringify(facts));
  check('a zero sample rate is the dash, never 0 Hz', !!rate, JSON.stringify(facts));
  check('the entity summary renders its counts', text(m.target).includes('42') && text(m.target).includes('900'));
  m.cleanup();
}

console.log('E. Details failure isolation: a failed provenance read stays in its section');
{
  const original = bindings.PlatformService.GetProvenance;
  bindings.PlatformService.GetProvenance = () => Promise.reject(new Error('provenance down'));
  services.invalidate();
  const m = await mountComponent(panels['match-details'], ctx(MATCH), { embedded: true });
  await sleep(120);
  const alerts = [...m.target.querySelectorAll('[role="alert"]')].map(text);
  check('the provenance error is shown', alerts.some((t) => t.includes('provenance down')), JSON.stringify(alerts));
  check('the diagnostics section still renders', text(m.target).includes('42'));
  m.cleanup();
  bindings.PlatformService.GetProvenance = original;
  services.invalidate();
}

console.log(failures ? `FAILED: ${failures}` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
