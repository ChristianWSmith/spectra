// THE read API a mounted component receives
// — the whole surface between a component and the app, typed here in one
// module. ComponentFrame.svelte builds one per mounted component and
// passes it as the reserved `spectra` prop beside the component's own
// props; builtin and user components receive the same object.
//
//   metric(name, binds)  stored values with the five states
//   query(sql, binds)    a live read-only SQL read (no freshness)
//   context              the read-only context the surface mounted this
//                        component with (04 §3, ruling 34), passed as a prop
//                        by ComponentFrame; binds default from it
//   navigate(route)      the route hash every view navigates with
//   guard(fn)            the event and async wrapper (see below)
//   isHuman / listedPlayers   the frontend bot filter (lib/players.js)
//
// Error routing (04 §4's known gap): <svelte:boundary> does not see errors
// thrown from event handlers or from async work the component started.
// Every failure of metric()/query() is reported into the component's
// frame AND rejects (so code after a failed read does not run on bad
// data); guard(fn) reports whatever fn throws or rejects with and
// swallows it. A failure is reported at most once even when it passes
// through several of these layers.

import { buildHash } from '../router.js';
import { isHuman, listedPlayers } from '../players.js';
import { metricPresentation } from '../metricstate.js';
import * as S from '../strings/index.js';

/**
 * @typedef {'processing'|'failed'|'fresh'|'no-data'|'behind'} MetricState
 *
 * The reserved binds of 03-QUERIES §5: `match_id` (match grain),
 * `steam_id` (one player; career grain without `match_id`), `round` with
 * `match_id` (round grain).
 * @typedef {{match_id?: number, steam_id?: string, round?: number}} MetricBinds
 *
 * @typedef {{subject: string, dim: string, value: number, n: number, valueKey: string}} MetricRow
 *
 * One metric read. `state` is the slot's word (lib/metricstate.js
 * precedence). With `steam_id` bound, `value`/`n`/`valueKey` are that
 * player's (null when the state is not 'fresh'); otherwise `rows` carries
 * every fresh row of the bound unit. `rows` is empty unless 'fresh'.
 * @typedef {{name: string, doc: string, state: MetricState, error: string,
 *   value: number|null, n: number|null, valueKey: string, rows: MetricRow[]}} MetricRead
 *
 * @typedef {{columns: string[], rows: any[][]}} QueryRead
 *
 * The services a read API draws on (componentruntime/reads.js wires the
 * real ones; tests pass their own).
 * @typedef {{
 *   listMetrics: () => Promise<any[]>,
 *   getMetricValuesForMatch: (matchId: number, ids: number[]) => Promise<any[]>,
 *   getMetricValuesForPlayer: (steamId: string, ids: number[]) => Promise<any[]>,
 *   getMetricComputeState: () => Promise<any[]>,
 *   getMetricStates: (scope: 'match'|'player', id: number|string) => Promise<any[]>,
 *   componentQuery: (sql: string) => Promise<{columns?: string[], rows?: any[][], err?: string}>,
 * }} ReadServices
 *
 * @typedef {{
 *   metric: (name: string, binds?: MetricBinds) => Promise<MetricRead>,
 *   query: (sql: string, binds?: MetricBinds) => Promise<QueryRead>,
 *   navigate: (route: string | {path: string, query?: object}) => void,
 *   guard: <F extends (...args: any[]) => any>(fn: F) => F,
 *   isHuman: typeof isHuman,
 *   listedPlayers: typeof listedPlayers,
 * }} ReadApi
 */

const PRESENTATION_STATE = { value: 'fresh', nodata: 'no-data' };

// The context names (04 §3) and the reserved bind names they stand for
// (03-QUERIES §5). A bind object may use either spelling of one bind.
const CONTEXT_TO_BIND = { matchId: 'match_id', steamId: 'steam_id', round: 'round' };
const RESERVED_BINDS = ['match_id', 'steam_id', 'round'];

// contextBinds is the bind set a context implies: each set field becomes
// its reserved bind, and unset fields are left out.
export function contextBinds(ctx) {
  const out = {};
  if (!ctx) return out;
  if (ctx.matchId != null) out.match_id = Number(ctx.matchId);
  if (ctx.steamId != null && ctx.steamId !== '') out.steam_id = String(ctx.steamId);
  if (ctx.round != null) out.round = Number(ctx.round);
  return out;
}

// resolveBinds picks the binds of one read. An explicit bind object
// REPLACES the context's set as a whole (so a career read given a steamId
// does not pick up the context's match); no object, or an empty one, uses
// the context. Keys come back in the reserved spelling; giving one bind
// twice (matchId and match_id) is refused.
export function resolveBinds(binds, ctx) {
  if (binds == null || Object.keys(binds).length === 0) return contextBinds(ctx);
  const out = {};
  for (const [key, value] of Object.entries(binds)) {
    const reserved = CONTEXT_TO_BIND[key] || key;
    if (value == null) continue;
    if (reserved in out) throw new Error(S.fill(S.components.bindConflict, { name: reserved }));
    out[reserved] = value;
  }
  return out;
}

const QUERY_BIND = /:(match_id|steam_id|round)\b/g;

// bindQuery replaces the reserved binds a query names with SQL literals.
// The backend refuses bound parameters in a component query (session.go
// ComponentRead), so the values go in as literals, checked first: an
// integer for match_id and round, digits only (quoted) for steam_id.
// A bind that is named but unset, or not of its shape, is refused.
export function bindQuery(sql, binds) {
  return String(sql).replace(QUERY_BIND, (_, name) => {
    const v = binds[name];
    if (v == null || v === '') throw new Error(S.fill(S.components.bindUnset, { name }));
    if (name === 'steam_id') {
      if (!/^\d+$/.test(String(v))) throw new Error(S.fill(S.components.bindInvalid, { name }));
      return `'${v}'`;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error(S.fill(S.components.bindInvalid, { name }));
    return String(n);
  });
}

// stateWord maps a metricPresentation result onto the five-state word.
function stateWord(p) {
  return p.kind === 'chip' ? p.state : PRESENTATION_STATE[p.kind];
}

function toError(e) {
  if (e instanceof Error) return e;
  return new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
}

// storedRead is the ONE mapping from reserved binds to today's stored-value
// reads: match_id → the match read; match_id with round → the round read (the
// stored rows of that round only); steam_id alone → the career bucket (the
// whole bucket, so sibling coverage is honest), narrowed by steam_id below.
// A round without its match, and an unbound (library-wide) read, have no
// stored read and are refused — never served another scope's values (builtin
// convention 3: no fabricated values).
function storedRead(reads, def, binds) {
  if (binds.round != null) {
    if (binds.match_id == null) throw new Error(S.fill(S.components.bindUnset, { name: 'match_id' }));
    return reads.getMetricValuesForRound(Number(binds.match_id), Number(binds.round), [def.id]);
  }
  if (binds.match_id != null) return reads.getMetricValuesForMatch(Number(binds.match_id), [def.id]);
  if (binds.steam_id != null && binds.steam_id !== '') return reads.getMetricValuesForPlayer('', [def.id]);
  throw new Error(S.components.metricLibraryUnavailable);
}

/**
 * `context` is a getter for the mounting surface's context, read at each
 * call (the Builder preview's context changes while the frame lives).
 *
 * @param {{reads: ReadServices, report: (err: Error) => void, nav?: (hash: string) => void,
 *   context?: () => {matchId?: number|null, steamId?: string|null, round?: number|null}}} deps
 * @returns {ReadApi}
 */
export function createReadApi({ reads, report, nav, context = () => ({}) }) {
  const reported = new WeakSet();
  const fail = (e) => {
    const err = toError(e);
    if (!reported.has(err)) {
      reported.add(err);
      report(err);
    }
    return err;
  };
  const go = nav || ((hash) => (location.hash = hash));

  /** @type {ReadApi['metric']} */
  async function metric(name, binds) {
    try {
      const resolved = resolveBinds(binds, context());
      const defs = (await reads.listMetrics()) || [];
      const def = defs.find((d) => d && d.name === name);
      if (!def) throw new Error(S.fill(S.components.metricUnknown, { name }));
      // A bound unit takes its state from the scoped read: a match-grain read
      // from its match, a player read from its player, so another unit being
      // behind never marks this one. The library word (any match behind) is
      // the Builder list's alone.
      const steamBind = resolved.steam_id != null && resolved.steam_id !== '' ? String(resolved.steam_id) : null;
      const stateRead = resolved.match_id != null
        ? reads.getMetricStates('match', Number(resolved.match_id))
        : steamBind != null
          ? reads.getMetricStates('player', steamBind)
          : reads.getMetricComputeState();
      const [values, states] = await Promise.all([storedRead(reads, def, resolved), stateRead]);
      const unit = (values || []).filter((v) => v.metricId === def.id);
      const entry = (states || []).find((s) => s.metricId === def.id) || null;
      const computeState = (entry && entry.state) || '';
      const steam = resolved.steam_id != null && resolved.steam_id !== '' ? String(resolved.steam_id) : null;
      const row = steam ? unit.find((v) => v.subjectKey === steam) || null : unit[0] || null;
      // Sibling coverage (metricstate.js): a player-bound career read's unit is
      // that player, so another player's row is no coverage of it. A match or
      // round unit keeps the unit's own rows as its coverage.
      const playerUnit = resolved.match_id == null && steam != null;
      const unitHasRows = playerUnit ? row != null : unit.length > 0;
      const state = stateWord(metricPresentation(computeState, row, unitHasRows));
      const fresh = state === 'fresh';
      const rows = fresh
        ? (steam ? unit.filter((v) => v.subjectKey === steam) : unit).map((v) => ({
            subject: v.subjectKey,
            dim: v.dim || '',
            value: v.value,
            valueKey: v.valueKey || '',
          }))
        : [];
      return {
        name,
        doc: def.doc || '',
        state,
        error: state === 'failed' ? (entry && entry.error) || '' : '',
        value: fresh && steam ? row.value : null,
        valueKey: (fresh && steam && row.valueKey) || '',
        rows,
      };
    } catch (e) {
      throw fail(e);
    }
  }

  /** @type {ReadApi['query']} */
  async function query(sql, binds) {
    try {
      const text = bindQuery(sql, resolveBinds(binds, context()));
      const res = await reads.componentQuery(text);
      if (res && res.err) throw new Error(res.err);
      return { columns: (res && res.columns) || [], rows: (res && res.rows) || [] };
    } catch (e) {
      throw fail(e);
    }
  }

  /** @type {ReadApi['navigate']} */
  function navigate(route) {
    go(typeof route === 'string' ? route : buildHash(route.path, route.query));
  }

  /** @type {ReadApi['guard']} */
  function guard(fn) {
    return /** @type {any} */ (
      function guarded(...args) {
        let out;
        try {
          out = fn.apply(this, args);
        } catch (e) {
          fail(e);
          return undefined;
        }
        if (out && typeof out.then === 'function') {
          return out.then(undefined, (e) => {
            fail(e);
          });
        }
        return out;
      }
    );
  }

  return Object.freeze({ metric, query, navigate, guard, isHuman, listedPlayers });
}
