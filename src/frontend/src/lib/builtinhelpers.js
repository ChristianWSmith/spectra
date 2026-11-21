// The helper blocks the Economy and Utility builtins (dogfood/PLAN.md C5c,
// dogfood/04-COMPONENTS.md §3) carry. A builtin is self-contained source: a
// component cannot import app modules (componentruntime/compile.js refuses
// every import outside the Svelte registry), so the functions it needs are
// copied here as text, the way matchpanels.js copies lib/fmt.js.
//
// Each block is plain JavaScript that a builtin's <script> splices in. The
// copies are pinned to the app's own modules by builtinhelpers.test.js: the
// same inputs give the same outputs, so a copy cannot drift silently.
//
// Rules the copies keep (AGENTS.md "Builtin conventions"): a missing value is
// a dash, never a zero (ruling 23); a stored value is never recomputed here
// except where the Go read it replaces does the same arithmetic on rows the
// view has already fetched (AGENTS.md "View computation"). The loss-bonus
// reconstruction and the side-flip detection are that second kind: they are
// the Go functions applyLossBonuses and sideFlips (internal/store/analytics.go)
// over the round rows the economy query returns, copied line for line.

// FMT: number and clock formatting (lib/fmt.js, lib/econ.js). DASH is the one
// dash every missing cell shows.
export const FMT_HELPERS = `
  const DASH = '\\u2014';
  function round1(x) {
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 10) / 10;
  }
  function fmtInt(x) {
    if (!Number.isFinite(x)) return DASH;
    return Math.round(x).toLocaleString();
  }
  function fmt1(x) {
    if (!Number.isFinite(x)) return DASH;
    return round1(x).toFixed(1);
  }
  function fmt2(x) {
    if (!Number.isFinite(x)) return DASH;
    return (Math.round(x * 100) / 100).toFixed(2);
  }
  function fmtPercentOf(x) {
    if (!Number.isFinite(x)) return DASH;
    return round1(x * 100) + '%';
  }
  function fmtMoney(v) {
    const n = Math.round(Number(v) || 0);
    return (n < 0 ? '\\u2212$' : '$') + Math.abs(n).toLocaleString();
  }
  // One stored value as its text, by its format tag (lib/fmt.js fmtMetric).
  function fmtStoredValue(v, format) {
    if (v == null || !Number.isFinite(v)) return DASH;
    if (format === 'int') return fmtInt(v);
    if (format === 'float1') return fmt1(v);
    if (format === 'float2') return fmt2(v);
    if (format === 'percent') return fmtPercentOf(v);
    if (format === 'currency') return fmtMoney(v);
    return Number.isInteger(v) ? fmtInt(v) : fmt2(v);
  }
  function fmtMs(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }
  function fmtClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return DASH;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }
  // The utility tables' zero rule: a count of nothing is a dash.
  function fmtZeroDash(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return DASH;
    return unit ? n + ' ' + unit : String(n);
  }
`;

// TICK: tick, round-clock and round-label arithmetic (lib/fmt.js, lib/rounds.js).
// A round is its stored row: { number, winner, startTick, endTick }.
export const TICK_HELPERS = `
  function normTickRate(tickRate) {
    return Number(tickRate) > 0 ? Number(tickRate) : 64;
  }
  function tickSeconds(ticks, tickRate) {
    return ticks / normTickRate(tickRate);
  }
  function intoRoundSeconds(tick, round, tickRate) {
    if (!round) return null;
    const into = tickSeconds(tick - round.startTick, tickRate);
    return into >= 0 ? into : null;
  }
  // The round-relative clock of a tick (fmtClock of the time into the round,
  // or of the match-relative time when the round is unknown).
  function roundClock(tick, round, tickRate) {
    const into = intoRoundSeconds(tick, round, tickRate);
    return fmtClock(into != null ? into : tickSeconds(tick, tickRate));
  }
  function isCounted(r) {
    return !!r && r.number >= 1;
  }
  // The round after which a separator falls (MR12 halftime, then the
  // regulation end and every three OT rounds: 12, 24, 27, 30, ...).
  function separatorAfter(countedRoundNumber) {
    const n = Number(countedRoundNumber);
    if (!Number.isFinite(n)) return false;
    if (n === 12) return true;
    return n >= 24 && (n - 24) % 3 === 0;
  }
  // The money-reset indexes (0-based) strictly inside a match of \`counted\` rounds.
  function moneyResetIndexes(counted) {
    const n = Number.isFinite(counted) ? Math.trunc(counted) : 0;
    const out = [];
    for (let i = 1; i < n; i++) {
      if (separatorAfter(i)) out.push(i);
    }
    return out;
  }
  // separatorFlags: one flag per row, true where a separator follows that row.
  // Only counted rows carry one, and the last counted row never does.
  function separatorFlags(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const countedTotal = list.filter(isCounted).length;
    let seen = 0;
    return list.map((r) => (isCounted(r) ? ++seen < countedTotal && separatorAfter(seen) : false));
  }
  // The round's display label: its number, or K / W for a legacy negative row.
  function roundIndexLabel(r) {
    if (r && typeof r === 'object') return roundIndexLabel(r.number);
    if (r == null || r === '') return '';
    const n = Number(r);
    if (!Number.isFinite(n)) return '';
    if (n >= 1) return String(n);
    return n === -2 ? 'K' : 'W';
  }
  function scoreThrough(rounds, roundNumber) {
    const n = Number(roundNumber);
    let ct = 0;
    let t = 0;
    for (const r of rounds || []) {
      if (!isCounted(r) || !Number.isFinite(n) || r.number > n) continue;
      if (r.winner === 'ct') ct++;
      else if (r.winner === 't') t++;
    }
    return { ct: ct, t: t };
  }
  // The round option label every round picker shows: RD<n> | <ct>-<t>.
  function roundScoreLabel(rounds, number) {
    const n = number && typeof number === 'object' ? number.number : number;
    const s = scoreThrough(rounds, n);
    return 'RD' + roundIndexLabel(n) + ' | ' + s.ct + '-' + s.t;
  }
  function roundStartTick(rounds, number) {
    const n = Number(number);
    const r = (rounds || []).find((x) => x && x.number === n);
    return r && Number.isFinite(r.startTick) ? r.startTick : null;
  }
  function roundEndTick(rounds, number) {
    const n = Number(number);
    const r = (rounds || []).find((x) => x && x.number === n);
    return r && Number.isFinite(r.endTick) ? r.endTick : null;
  }
  function roundsByNumber(rounds) {
    return new Map((rounds || []).map((r) => [r.number, r]));
  }
`;

// TEAM: side, team and identity arithmetic (lib/sideparity.js, lib/teams.js).
// A player is { steamId, name, side } (the roster's final side); a side is
// 'ct' or 't'. The team of a row is keyed by its FINAL side.
export const TEAM_HELPERS = `
  function flipIndexes(counted, switches) {
    const n = Number.isFinite(counted) ? Math.trunc(counted) : 0;
    const s = Number.isFinite(switches) ? Math.trunc(switches) : 0;
    if (n <= 0 || s <= 0) return [];
    const flips = [];
    for (let k = 1; k <= s; k++) {
      const idx = k === 1 ? 12 : 27 + 3 * (k - 2);
      if (idx > 0 && idx < n) flips.push(idx);
    }
    return flips;
  }
  function eraOf(index, flips) {
    let era = 0;
    for (const flip of flips) {
      if (flip <= index) era++;
    }
    return era;
  }
  function sideInEra(finalSide, sideSwitches, era) {
    if (finalSide !== 'ct' && finalSide !== 't') return null;
    const s = Number.isFinite(sideSwitches) ? Math.trunc(sideSwitches) : 0;
    const e = Number.isFinite(era) ? Math.trunc(era) : 0;
    const eras = Math.max(1, s + 1);
    const flips = Math.abs(eras - 1 - e) % 2;
    if (flips === 0) return finalSide;
    return finalSide === 'ct' ? 't' : 'ct';
  }
  function startSideFor(finalSide, sideSwitches) {
    return sideInEra(finalSide, sideSwitches, 0);
  }
  // Which team (final side) played the CT side in counted round index \`index\`.
  function teamKeyAt(side, index, counted, switches) {
    if (side !== 'ct' && side !== 't') return null;
    const era = eraOf(index, flipIndexes(counted, switches));
    return sideInEra('ct', switches, era) === side ? 'ct' : 't';
  }
  // The side a team (final side) held in a round, by the round's number.
  function sideAtRound(rounds, sideSwitches, roundNumber, finalSide) {
    if (finalSide !== 'ct' && finalSide !== 't') return null;
    const list = Array.isArray(rounds) ? rounds : [];
    if (!list.some((r) => r && r.number === roundNumber)) return null;
    const s = Number.isFinite(sideSwitches) ? Math.trunc(sideSwitches) : 0;
    const counted = list.filter(isCounted);
    const idx = counted.findIndex((r) => r && r.number === roundNumber);
    const flips = flipIndexes(counted.length, s);
    const eras = Math.max(1, s + 1);
    const era = idx < 0 ? 0 : Math.min(eras - 1, eraOf(idx, flips));
    return sideInEra(finalSide, s, era);
  }
  // The team (final side) that won a round, from the round's winning side.
  function winnerTeamKey(rounds, sideSwitches, roundNumber, winnerSide) {
    if (winnerSide !== 'ct' && winnerSide !== 't') return null;
    const ctSide = sideAtRound(rounds, sideSwitches, roundNumber, 'ct');
    if (ctSide === null) return null;
    return ctSide === winnerSide ? 'ct' : 't';
  }
  function teamStartClass(finalSide, sideSwitches) {
    const start = startSideFor(finalSide, sideSwitches);
    return start === 'ct' ? 'team-start-ct' : start === 't' ? 'team-start-t' : '';
  }
  function pickPlayer(players, side) {
    let best = null;
    for (const p of players || []) {
      if (!p || p.side !== side || !p.name) continue;
      if (!best) {
        best = p;
        continue;
      }
      const id = p.steamId || '';
      const bestId = best.steamId || '';
      if (id < bestId || (id === bestId && p.name < best.name)) best = p;
    }
    return best;
  }
  function synthTeamName(players, side) {
    const p = pickPlayer(players, side);
    return p ? 'team_' + p.name : '';
  }
  // The team display names: the demo's clan name, else team_<player>, else CT / T.
  function teamNames(ctName, tName, players) {
    return {
      ct: ctName || synthTeamName(players, 'ct') || 'CT',
      t: tName || synthTeamName(players, 't') || 'T',
    };
  }
  function resolveSide(players, steamId, name) {
    let side = '';
    if (steamId) {
      const byId = (players || []).find((p) => p && p.steamId === steamId);
      if (byId) side = byId.side || '';
    }
    if (!side && name) {
      const byName = (players || []).find((p) => p && p.name === name);
      if (byName) side = byName.side || '';
    }
    return side;
  }
  function sideClassOf(side) {
    return side === 'ct' ? 'side-ct' : side === 't' ? 'side-t' : '';
  }
  // The colour class of a player's name in one round: the side held then, or
  // the match-start colour when the round cannot place them.
  function playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name) {
    const finalSide = resolveSide(players, steamId, name);
    const at = finalSide ? sideAtRound(rounds, sideSwitches, roundNumber, finalSide) || '' : '';
    return sideClassOf(at) || teamStartClass(finalSide, sideSwitches);
  }
`;

// ECON: the economy rows (lib/econ.js, lib/econ.test.js's oracle) and the
// loss-bonus reconstruction the economy query's Go twin performs.
export const ECON_HELPERS = `
  function econColumns(r, key) {
    const equip = Number(key === 'ct' ? r.equipCT : r.equipT) || 0;
    const cash = Number(key === 'ct' ? r.moneyCT : r.moneyT) || 0;
    return { equip: equip, net: equip + cash };
  }
  function econValue(r, key, metric) {
    const c = econColumns(r, key);
    return metric === 'equip' ? c.equip : c.net;
  }
  function lossPips(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    const p = Math.round((n - 1400) / 500) + 1;
    return Math.min(5, Math.max(0, p));
  }
  // sideFlips: per row index, whether the side-to-team mapping changed from the
  // row before (a player observed on the other side proves the switch).
  function sideFlips(rows, exact) {
    const n = rows.length;
    const flips = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      const prev = exact.get(rows[i - 1].round) || new Map();
      const cur = exact.get(rows[i].round) || new Map();
      if (prev.size === 0 || cur.size === 0) continue;
      for (const [sid, ps] of prev) {
        const cs = cur.get(sid);
        if (cs !== undefined && ps !== '' && cs !== '' && ps !== cs) {
          flips[i] = true;
          break;
        }
      }
    }
    return flips;
  }
  // applyLossBonuses: the bonus a side's team collects by losing each round.
  // The per-team loss count steps up after a loss and down after a win, from
  // a start of 1 at every half. Sides re-map to teams at each flip.
  function applyLossBonuses(rows, flips) {
    const bonus = (count) => 1400 + 500 * Math.min(count, 4);
    const stepDown = (c) => (c > 0 ? c - 1 : 0);
    const stepUp = (c) => (c < 4 ? c + 1 : 4);
    const counts = [1, 1];
    let flip = false;
    const teamOn = (side) => {
      const ctIsA = !flip;
      if (side === 'ct') return ctIsA ? 0 : 1;
      return ctIsA ? 1 : 0;
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i < flips.length && flips[i]) {
        flip = !flip;
        counts[0] = 1;
        counts[1] = 1;
      }
      const ct = teamOn('ct');
      const t = teamOn('t');
      r.lossBonusCT = bonus(counts[ct]);
      r.lossBonusT = bonus(counts[t]);
      if (r.winner === 'ct') {
        counts[ct] = stepDown(counts[ct]);
        counts[t] = stepUp(counts[t]);
      } else if (r.winner === 't') {
        counts[t] = stepDown(counts[t]);
        counts[ct] = stepUp(counts[ct]);
      }
    }
    return rows;
  }
  // buildEconRows shapes the economy query's rows (see ECON_SQL in the
  // economy panels) and the round-side samples into the view's economy rows.
  function buildEconRows(ecoRows, sideRows) {
    const rows = ecoRows.map((x) => ({
      round: Number(x[0]),
      winner: x[1] || '',
      equipCT: Number(x[2]) || 0,
      equipT: Number(x[3]) || 0,
      moneyCT: Number(x[4]) || 0,
      moneyT: Number(x[5]) || 0,
      spentCT: Number(x[6]) || 0,
      spentT: Number(x[7]) || 0,
      freePistolCT: Number(x[8]) || 0,
      freePistolT: Number(x[9]) || 0,
      label: x[10] || '',
      explanation: x[11] || '',
      ruleVersion: Number(x[12]) || 0,
      classCT: x[13] || '',
      classWhyCT: x[14] || '',
      classT: x[15] || '',
      classWhyT: x[16] || '',
      pistolRound: (x[10] || '') === 'pistol',
      wonCT: x[1] === 'ct',
      wonT: x[1] === 't',
    }));
    const exact = new Map();
    for (const s of sideRows) {
      const round = Number(s[0]);
      if (!exact.has(round)) exact.set(round, new Map());
      exact.get(round).set(s[1], s[2]);
    }
    applyLossBonuses(rows, sideFlips(rows, exact));
    return rows;
  }
`;

// NAV: the replay route a view's links build (lib/nav.js replayHash and the
// ?loop= span helpers, lib/router.js buildHash). Values are encoded like
// buildHash does: "/" and "," stay raw.
export const NAV_HELPERS = `
  function hashOf(path, query) {
    const parts = [];
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v == null || v === '') continue;
      const val = encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/%2C/g, ',');
      parts.push(k + '=' + val);
    }
    return parts.length ? path + '?' + parts.join('&') : path;
  }
  function asTick(v) {
    return v == null || v === '' ? NaN : Number(v);
  }
  // The ?loop= span from one tick to another (nav.entryLoopSpan).
  function entryLoopSpan(fromTick, toTick) {
    const from = asTick(fromTick);
    const to = asTick(toTick);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > to) return undefined;
    return from + ',' + to;
  }
  // The ?loop= span of an event: loopSecs either side at the tick rate
  // (nav.entryLoopAround).
  function entryLoopAround(tick, tickRate, loopSecs) {
    const t = asTick(tick);
    if (!Number.isFinite(t) || t < 0) return undefined;
    const secs = Math.min(Math.max(Math.round(Number(loopSecs) || 5), 1), 60);
    const half = Math.round(secs * normTickRate(tickRate));
    return entryLoopSpan(Math.max(0, Math.round(t - half)), Math.round(t + half));
  }
  function replayRoute(matchId, extras) {
    return hashOf('/replay/' + matchId, extras);
  }
`;
