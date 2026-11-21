// THE read API a mounted component receives (dogfood/04-COMPONENTS.md §3)
// — the whole surface between a component and the app, typed here in one
// module. ComponentFrame.svelte builds one per mounted component and
// passes it as the reserved `spectra` prop beside the component's own
// props; builtin and user components receive the same object.
//
//   metric(name, binds)  stored values with the five states
//   query(sql)           a live read-only SQL read (no freshness)
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
 * @typedef {{name: string, state: MetricState, error: string,
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
 *   componentQuery: (sql: string) => Promise<{columns?: string[], rows?: any[][], err?: string}>,
 * }} ReadServices
 *
 * @typedef {{
 *   metric: (name: string, binds?: MetricBinds) => Promise<MetricRead>,
 *   query: (sql: string) => Promise<QueryRead>,
 *   navigate: (route: string | {path: string, query?: object}) => void,
 *   guard: <F extends (...args: any[]) => any>(fn: F) => F,
 *   isHuman: typeof isHuman,
 *   listedPlayers: typeof listedPlayers,
 * }} ReadApi
 */

const PRESENTATION_STATE = { value: 'fresh', nodata: 'no-data' };

// stateWord maps a metricPresentation result onto the five-state word.
function stateWord(p) {
  return p.kind === 'chip' ? p.state : PRESENTATION_STATE[p.kind];
}

function toError(e) {
  if (e instanceof Error) return e;
  return new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
}

// storedRead is the ONE mapping from reserved binds to today's stored-value
// reads: match_id → the match read; steam_id alone → the career bucket
// (the whole bucket, so sibling coverage is honest), narrowed by steam_id
// below. Round grain and unbound (library-wide) reads have no stored read
// yet and are refused — never served another scope's values (builtin
// convention 3: no fabricated values).
function storedRead(reads, def, binds) {
  if (binds.round != null) throw new Error(S.components.metricRoundUnavailable);
  if (binds.match_id != null) return reads.getMetricValuesForMatch(Number(binds.match_id), [def.id]);
  if (binds.steam_id != null && binds.steam_id !== '') return reads.getMetricValuesForPlayer('', [def.id]);
  throw new Error(S.components.metricLibraryUnavailable);
}

/**
 * @param {{reads: ReadServices, report: (err: Error) => void, nav?: (hash: string) => void}} deps
 * @returns {ReadApi}
 */
export function createReadApi({ reads, report, nav }) {
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
  async function metric(name, binds = {}) {
    try {
      const defs = (await reads.listMetrics()) || [];
      const def = defs.find((d) => d && d.name === name);
      if (!def) throw new Error(S.fill(S.components.metricUnknown, { name }));
      const [values, states] = await Promise.all([storedRead(reads, def, binds), reads.getMetricComputeState()]);
      const unit = (values || []).filter((v) => v.metricId === def.id);
      const entry = (states || []).find((s) => s.metricId === def.id) || null;
      const computeState = (entry && entry.state) || '';
      const steam = binds.steam_id != null && binds.steam_id !== '' ? String(binds.steam_id) : null;
      const row = steam ? unit.find((v) => v.subjectKey === steam) || null : unit[0] || null;
      const state = stateWord(metricPresentation(computeState, row, unit.length > 0));
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
  async function query(sql) {
    try {
      const res = await reads.componentQuery(String(sql));
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
