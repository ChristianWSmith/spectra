// The Economy view as builtin components (dogfood/PLAN.md C5c, C5a's nested
// mount, dogfood/04-COMPONENTS.md §3, §3.5, §7). The Economy builtin is a
// composer: it loads the match's rounds and economy rows once, then mounts
// three panels with `spectra.Child`, each receiving the same read-only
// `context` ({ matchId }) from the Match view:
//
//   builtin-economy-curve   the team equip / net-worth curve and its winner strip
//   builtin-economy-cards   the six default economy statistics (metrics)
//   builtin-economy-rounds  the per-round table (buy classes, deaths, loss pips)
//
// Retired preferences (ruling 33) are not read: the card set is the shipped
// default, and the economy placement is not stored. The
// per-round deaths are the stored round-grain metric raw_round_side_deaths,
// read through metric() with the round bind; they replace the per-round
// player_round_stats.deaths read that F3 removes.
//
// Copy and formulas: the English text of the view's chrome is written here (as
// matchpanels.js does), and the helpers come from builtinhelpers.js. A missing
// value shows a dash, never a zero (ruling 23).

import { FMT_HELPERS, TICK_HELPERS, TEAM_HELPERS, ECON_HELPERS, NAV_HELPERS } from './builtinhelpers.js';
import * as S from './strings/index.js';

export const ECON_PANEL_IDS = Object.freeze({
  economy: 'builtin-economy',
  curve: 'builtin-economy-curve',
  cards: 'builtin-economy-cards',
  rounds: 'builtin-economy-rounds',
});

// The read-only SQL the economy builtins run (bound from the context, see
// componentruntime/readapi.js bindQuery). Each mirrors one read of the Go
// economy view it replaces (store.GetEconomy, GetRounds, GetRoundPlayerSides,
// GetTeamNames, the match row). They sit here as plain literals so the audit
// exempts them by text: SQL the panel runs is not user copy.
const SQL_MATCH = 'SELECT score_ct, score_t, side_switches FROM matches WHERE id = :match_id';
const SQL_ROUNDS = 'SELECT number, winner, start_tick, end_tick FROM rounds WHERE match_id = :match_id ORDER BY number';
const SQL_ECON =
  'SELECT r.number, r.winner, r.equip_ct, r.equip_t, ' +
  'COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0), ' +
  'COALESCE(ct.spent, 0), COALESCE(t.spent, 0), ' +
  'COALESCE(ct.free_pistol_value, 0), COALESCE(t.free_pistol_value, 0), ' +
  "COALESCE(rc.label, ''), COALESCE(rc.explanation, ''), COALESCE(rc.rule_version, 0), " +
  "COALESCE(rsct.class, ''), COALESCE(rsct.why, ''), COALESCE(rst.class, ''), COALESCE(rst.why, '') " +
  'FROM rounds r ' +
  "LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct' " +
  "LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't' " +
  'LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number ' +
  "LEFT JOIN round_side_classes rsct ON rsct.match_id = r.match_id AND rsct.round = r.number AND rsct.side = 'ct' " +
  "LEFT JOIN round_side_classes rst ON rst.match_id = r.match_id AND rst.round = r.number AND rst.side = 't' " +
  'WHERE r.match_id = :match_id ORDER BY r.number ASC';
const SQL_SIDES =
  'SELECT round, steam_id, side FROM round_player_sides WHERE match_id = :match_id ORDER BY round ASC, steam_id ASC';
const SQL_TEAMS = 'SELECT side, name FROM teams WHERE match_id = :match_id';
const SQL_ROSTER =
  'SELECT ps.steam_id, p.name, p.side, ps.score FROM player_stats ps ' +
  'JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id ' +
  'WHERE ps.match_id = :match_id AND p.is_bot = 0 ' +
  'ORDER BY (SELECT COUNT(*) FROM events e WHERE e.match_id = ps.match_id AND e.kind = \'kill\' ' +
  'AND e.attacker = ps.steam_id AND e.attacker <> e.victim AND NOT EXISTS (SELECT 1 FROM round_player_sides a ' +
  'JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim ' +
  'WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)) DESC, p.name ASC';

// The composer: loads the shared rows, then mounts the three panels.
export const ECONOMY_SOURCE = `<script>
  // Economy view: the rounds, the economy rows and the team names, loaded once
  // for the three panels below. Each panel mounts with this frame's context
  // (the match) and the Match view's back path.
  let { spectra, context, back = '' } = $props();
  ${TICK_HELPERS}
  ${TEAM_HELPERS}
  ${ECON_HELPERS}
  const MATCH_SQL = ${JSON.stringify(SQL_MATCH)};
  const ROUNDS_SQL = ${JSON.stringify(SQL_ROUNDS)};
  const ECON_SQL = ${JSON.stringify(SQL_ECON)};
  const SIDES_SQL = ${JSON.stringify(SQL_SIDES)};
  const TEAMS_SQL = ${JSON.stringify(SQL_TEAMS)};
  const ROSTER_SQL = ${JSON.stringify(SQL_ROSTER)};

  let state = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const [m, roundRows, ecoRows, sideRows, teamRows, roster] = await Promise.all([
      spectra.query(MATCH_SQL),
      spectra.query(ROUNDS_SQL),
      spectra.query(ECON_SQL),
      spectra.query(SIDES_SQL),
      spectra.query(TEAMS_SQL),
      spectra.query(ROSTER_SQL),
    ]);
    const head = m.rows[0] || [0, 0, 0];
    const scoreCT = Number(head[0]) || 0;
    const scoreT = Number(head[1]) || 0;
    const sideSwitches = Number(head[2]) || 0;
    const rounds = roundRows.rows.map((r) => ({ number: Number(r[0]), winner: r[1] || '', startTick: Number(r[2]), endTick: Number(r[3]) }));
    const rows = buildEconRows(ecoRows.rows, sideRows.rows);
    const clan = new Map(teamRows.rows.map((t) => [t[0], t[1]]));
    const players = roster.rows.map((r) => ({ steamId: r[0], name: r[1], side: r[2] }));
    const names = teamNames(clan.get('ct') || '', clan.get('t') || '', players);
    const matchWinner = scoreCT === scoreT ? '' : scoreCT > scoreT ? 'ct' : 't';
    return { rows, rounds, names, sideSwitches, matchWinner };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    state = null;
    load(matchId).then(
      (d) => {
        if (live) state = d;
      },
      () => {
        // A failed read is reported into this frame by the read API; the view
        // stays up on an empty set, as before (the banner names the failure).
        if (live) state = { rows: [], rounds: [], names: { ct: '${S.match.sideCt}', t: '${S.match.sideT}' }, sideSwitches: 0, matchWinner: '' };
      },
    );
    return () => {
      live = false;
    };
  });
</script>

{#if state}
  <div class="view econ-view">
    <div class="econ-head">
      <span class="muted">{state.rows.length}{state.rows.length === 1 ? ' round' : ' rounds'}</span>
      <span class="spacer"></span>
      <span class="muted econ-head-note">${S.economy.headNote}</span>
    </div>

    <spectra.Child name="${ECON_PANEL_IDS.curve}" props={{ rows: state.rows, names: state.names, sideSwitches: state.sideSwitches, matchWinner: state.matchWinner, back }} />
    <spectra.Child name="${ECON_PANEL_IDS.cards}" props={{ rows: state.rows, rounds: state.rounds, names: state.names, back }} />
    <spectra.Child name="${ECON_PANEL_IDS.rounds}" props={{ rows: state.rows, rounds: state.rounds, names: state.names, sideSwitches: state.sideSwitches, back }} />
  </div>
{:else}
  <p class="muted" role="status">${S.economy.loading}</p>
{/if}
`;

// The curve: one team line per team per round (equip value or net worth), a
// winner strip, a hover readout and a click to open the round. Lines follow
// the teams across the halftime side switch; each money era is its own path.
export const ECON_CURVE_SOURCE = `<script>
  // Economy curve: hand-drawn SVG, one line per team, the winner strip under it.
  let { spectra, context, rows = [], names = { ct: '${S.match.sideCt}', t: '${S.match.sideT}' }, sideSwitches = 0, matchWinner = '', back = '' } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${TEAM_HELPERS}
  ${ECON_HELPERS}
  ${NAV_HELPERS}

  const W = 1000;
  const H = 220;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 10;
  const EQUIP_DEF = '${S.economy.equipDef}';
  const NETWORTH_DEF = '${S.economy.netWorthDef}';

  let metric = $state('equip');
  let hover = $state(-1);

  const n = $derived(rows.length);

  const series = $derived.by(() => {
    const ct = [];
    const tr = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ctKey = teamKeyAt('ct', i, n, sideSwitches);
      const ctVal = econValue(r, 'ct', metric);
      const tVal = econValue(r, 't', metric);
      const a = ctKey === 'ct' ? ctVal : tVal;
      const b = ctKey === 'ct' ? tVal : ctVal;
      ct.push(a);
      tr.push(b);
      if (a > max) max = a;
      if (b > max) max = b;
    }
    if (max <= 0) max = 1;
    return { ct, tr, max };
  });

  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));
  const nameCT = $derived(names.ct || '${S.match.sideCt}');
  const nameT = $derived(names.t || '${S.match.sideT}');
  const winnerKnown = $derived(matchWinner === 'ct' || matchWinner === 't');
  const loserCT = $derived(winnerKnown && matchWinner === 't');
  const loserT = $derived(winnerKnown && matchWinner === 'ct');

  const hoverRow = $derived(hover >= 0 ? rows[hover] || null : null);
  const hoverPct = $derived(n > 0 && hover >= 0 ? ((hover + 0.5) / n) * 100 : 50);

  function xAt(i) {
    return n > 0 ? ((i + 0.5) / n) * W : 0;
  }

  function yAt(v) {
    return PAD_TOP + (1 - v / series.max) * (H - PAD_TOP - PAD_BOTTOM);
  }

  function vertex(vals, i) {
    return xAt(i).toFixed(1) + ',' + yAt(vals[i]).toFixed(1);
  }

  function pathOf(points) {
    const pts = points.length === 1 ? [points[0], points[0]] : points;
    return pts.map((p, i) => (i === 0 ? 'M' : 'L') + p).join(' ');
  }

  // One path per team per money era: never drawn across a money reset.
  const segments = $derived.by(() => {
    const flips = flipIndexes(n, sideSwitches);
    const bounds = [0, ...moneyResetIndexes(n), n];
    const out = [];
    for (const key of ['ct', 't']) {
      const vals = key === 'ct' ? series.ct : series.tr;
      const loser = key === 'ct' ? loserCT : loserT;
      for (let j = 0; j + 1 < bounds.length; j++) {
        const from = bounds[j];
        const to = bounds[j + 1] - 1;
        if (from > to) continue;
        const side = sideInEra(key, sideSwitches, eraOf(from, flips));
        const pts = [];
        for (let i = from; i <= to; i++) pts.push(vertex(vals, i));
        out.push({ d: pathOf(pts), cls: 'econ-line ' + (side === 'ct' ? 'side-ct' : 'side-t'), loser });
      }
    }
    return out;
  });

  const gridLines = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => yAt(series.max * f)));

  // The buy-class verdict: the favourite held, the upset, an even buy or no verdict.
  const CLASS_RANK = { full: 2, force: 1 };

  function classRank(c) {
    if (!c || c === 'unknown') return null;
    return CLASS_RANK[c] ?? 0;
  }

  function ranks(r) {
    if (!r.winner) return null;
    return [
      classRank(r.winner === 'ct' ? r.classCT : r.classT),
      classRank(r.winner === 'ct' ? r.classT : r.classCT),
    ];
  }

  function mark(r) {
    const rr = ranks(r);
    if (!rr || rr[0] === null || rr[1] === null) return '·';
    if (rr[0] > rr[1]) return '✓';
    if (rr[0] < rr[1]) return '✗';
    return '=';
  }

  function verdict(r) {
    if (!r.winner) return '${S.economy.verdictNoWinner}';
    const rr = ranks(r);
    if (rr[0] === null || rr[1] === null) return '${S.economy.verdictUnknown}';
    if (rr[0] > rr[1]) return '${S.economy.verdictFavorite}';
    if (rr[0] < rr[1]) return '${S.economy.verdictUpset}';
    return '${S.economy.verdictEven}';
  }

  function cellTitle(r) {
    const w = r.winner ? r.winner.toUpperCase() : '—';
    return '${S.economy.cellRound}' + r.round + ' — ' + w + '${S.economy.cellWinsBuy}' + (r.classCT || 'unknown') + '${S.economy.cellBuySep}' + (r.classT || 'unknown') + ' · ' + verdict(r) + (r.pistolRound ? '${S.economy.cellPistol}' : '');
  }

  function openRound(round) {
    spectra.navigate(hashOf('/match/' + context.matchId + '/round/' + round, { back: back || 'match/' + context.matchId + '/economy' }));
  }

  function columns(r, key) {
    return econColumns(r, key);
  }

  function onMove(e) {
    if (n <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    hover = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
  }
</script>

<section class="panel econ-curve-panel">
  <div class="row-between econ-curve-head">
    <h2>{metric === 'equip' ? '${S.economy.curveHeadEquip}' : '${S.economy.curveHeadNetWorth}'}</h2>
    <div class="econ-curve-meta">
      {#if n > 0}
        <span class="econ-axis-note mono">0 – {fmtMoney(series.max)}</span>
      {/if}
      <div class="econ-toggle" role="group" aria-label="${S.economy.curveMetricGroup}">
        <button class="econ-toggle-btn" class:active={metric === 'equip'} aria-pressed={metric === 'equip'} title={EQUIP_DEF} onclick={() => (metric = 'equip')}>${S.economy.curveToggleEquip}</button>
        <button class="econ-toggle-btn" class:active={metric === 'networth'} aria-pressed={metric === 'networth'} title={NETWORTH_DEF} onclick={() => (metric = 'networth')}>${S.economy.curveToggleNetWorth}</button>
      </div>
    </div>
  </div>

  {#if n === 0}
    <p class="muted" role="status">${S.economy.noRows}</p>
  {:else}
    <div class="econ-legend" aria-label="${S.economy.curveLegendLabel}">
      <span class="econ-legend-item {clsCT}">
        <span class="econ-legend-line" class:loser={loserCT} aria-hidden="true"></span>
        {nameCT}
      </span>
      <span class="econ-legend-item {clsT}">
        <span class="econ-legend-line" class:loser={loserT} aria-hidden="true"></span>
        {nameT}
      </span>
    </div>

    <div class="econ-chart" onmousemove={onMove} onmouseleave={() => (hover = -1)} role="img"
      aria-label={(metric === 'equip' ? '${S.economy.curveAriaEquip}' : '${S.economy.curveAriaNetWorth}') + '${S.economy.curveAriaSuffix}'}
    >
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
        {#each rows as r, i (r.round)}
          {#if r.pistolRound}
            <rect class="econ-pistol-band" x={i * (W / n)} y="0" width={W / n} height={H} />
          {/if}
        {/each}
        {#each gridLines as y, i (i)}
          <line class="econ-grid-line" x1="0" x2={W} y1={y} y2={y} />
        {/each}
        {#each segments as s, i (i)}
          <path class={s.cls} class:loser={s.loser} d={s.d} />
        {/each}
        {#if hover >= 0}
          <line class="econ-guide" x1={xAt(hover)} x2={xAt(hover)} y1="0" y2={H} />
        {/if}
        {#each rows as r, i (r.round)}
          <rect class="econ-hit" x={i * (W / n)} y="0" width={W / n} height={H} role="button" tabindex="0"
            aria-label={'${S.economy.openRoundAria}' + r.round}
            onclick={() => openRound(r.round)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openRound(r.round)}
          >
            <title>${S.economy.cellRound}{r.round}</title>
          </rect>
        {/each}
      </svg>

      {#if hoverRow}
        {@const ctCols = columns(hoverRow, 'ct')}
        {@const tCols = columns(hoverRow, 't')}
        <div class="econ-tooltip" style="left:{hoverPct}%">
          <div class="econ-tip-head">
            <strong>${S.economy.cellRound}{hoverRow.round}</strong>
            <span class="chip side {hoverRow.winner || 'none'}">{hoverRow.winner ? hoverRow.winner.toUpperCase() : '—'}</span>
            {#if hoverRow.pistolRound}
              <span class="chip econ-cls pistol">${S.economy.chipPistol}</span>
            {/if}
          </div>
          <div class="econ-tip-cols" aria-hidden="true">
            <span class:active={metric === 'equip'}>${S.economy.tipEquip}</span>
            <span class:active={metric === 'networth'}>${S.economy.curveAriaNetWorth}</span>
          </div>
          <div class="econ-tip-row">
            <span class={clsCT}>{nameCT}</span>
            <span class="mono">{fmtMoney(ctCols.equip)}</span>
            <span class="mono">{fmtMoney(ctCols.net)}</span>
          </div>
          <div class="econ-tip-row">
            <span class={clsT}>{nameT}</span>
            <span class="mono">{fmtMoney(tCols.equip)}</span>
            <span class="mono">{fmtMoney(tCols.net)}</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="econ-strip" aria-label="${S.economy.stripLabel}">
      {#each rows as r (r.round)}
        <button class="econ-strip-cell" class:ct={r.winner === 'ct'} class:t={r.winner === 't'} class:pistol={r.pistolRound}
          title={cellTitle(r)} aria-label={'${S.economy.openRoundAria}' + r.round} onclick={() => openRound(r.round)}
        >
          <span class="econ-strip-num">{r.round}</span>
          <span class="econ-strip-mark" class:hold={mark(r) === '✓'} class:upset={mark(r) === '✗'}
            >{#if mark(r) === '✓'}<span class="codicon codicon-check"></span>{:else if mark(r) === '✗'}<span class="codicon codicon-error"></span>{:else if mark(r) === '='}<span class="codicon codicon-grabber"></span>{:else}<span class="codicon codicon-circle-small"></span>{/if}</span
          >
        </button>
      {/each}
    </div>
    <p class="econ-strip-note muted">
      <span class="econ-strip-swatch pistol" aria-hidden="true"></span> ${S.economy.stripPistol} <span class="codicon codicon-check"></span> ${S.economy.stripFavorite} <span class="codicon codicon-error"></span> ${S.economy.stripUpset} <span class="codicon codicon-grabber"></span> ${S.economy.stripEven} <span class="codicon codicon-circle-small"></span> ${S.economy.stripNoVerdict}
    </p>
  {/if}
</section>
`;

// The six default statistics. Each is a stored metric read through metric() with
// the match bound from the context; the label, the formula tooltip and the format
// are the metric's own. `drill` names the round the card's click watches.
const ECON_CARDS = [
  {
    metric: 'pistol_hold',
    label: S.economy.cardPistolLabel,
    format: 'percent',
    subject: 'match',
    drill: 'firstPistol',
    sub: S.economy.cardPistolSub,
    inferred: false,
    doc: S.economy.cardPistolDoc,
  },
  {
    metric: 'team_force_wins',
    label: S.economy.cardForceWonLabel,
    format: 'int',
    subject: 'team',
    drill: 'firstForce',
    sub: '',
    inferred: false,
    doc: S.economy.cardForceWonDoc,
  },
  {
    metric: 'team_force_rounds',
    label: S.economy.cardForceLabel,
    format: 'int',
    subject: 'team',
    drill: 'firstForce',
    sub: '',
    inferred: false,
    doc: S.economy.cardForceDoc,
  },
  {
    metric: 'avg_equip_gap',
    label: S.economy.cardGapLabel,
    format: 'currency',
    subject: 'match',
    drill: 'gapRound',
    sub: S.economy.cardGapSub,
    inferred: false,
    doc: S.economy.cardGapDoc,
  },
  {
    metric: 'lost_equip',
    label: S.economy.cardLostLabel,
    format: 'currency',
    subject: 'match',
    drill: 'lostRound',
    sub: '',
    inferred: true,
    doc: S.economy.cardLostDoc,
  },
  {
    metric: 'team_lost_equip',
    label: S.economy.cardTeamLostLabel,
    format: 'currency',
    subject: 'team',
    drill: 'lostRound',
    sub: '',
    inferred: true,
    doc: S.economy.cardTeamLostDoc,
  },
];

// The summary cards: each value is the stored metric row (dash when absent or not
// fresh), each card's click watches the round its statistic is about.
export const ECON_CARDS_SOURCE = `<script>
  // Economy summary cards: six stored statistics of the match, each read with
  // metric() under the context's match. A card that is not fresh shows a dash.
  let { spectra, context, rows = [], rounds = [], names = { ct: '${S.match.sideCt}', t: '${S.match.sideT}' }, back = '' } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${NAV_HELPERS}

  const CARDS = ${JSON.stringify(ECON_CARDS)};
  const BADGE_INFERRED = 'inferred';
  const BADGE_COMPUTED = 'computed';

  let reads = $state({});

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    reads = {};
    if (matchId == null) return;
    Promise.all(CARDS.map((c) => spectra.metric(c.metric).catch(() => null))).then((res) => {
      if (!live) return;
      const out = {};
      CARDS.forEach((c, i) => {
        out[c.metric] = res[i];
      });
      reads = out;
    });
    return () => {
      live = false;
    };
  });

  // The round each drill anchor names: the first decided pistol round, the first
  // force-buy round, the round with the largest winner gap, and the round with
  // the largest loser equipment.
  const anchors = $derived.by(() => {
    let firstPistol = 0;
    for (const r of rows) {
      if (r.pistolRound && (r.wonCT || r.wonT)) {
        firstPistol = r.round;
        break;
      }
    }
    let firstForce = 0;
    let gapRound = 0;
    let gapBest = -Infinity;
    let lostRound = 0;
    let lostBest = -Infinity;
    for (const r of rows) {
      if (!firstForce && (r.classCT === 'force' || r.classT === 'force')) firstForce = r.round;
      let win;
      let lose;
      let loserEquip;
      if (r.winner === 'ct') {
        win = r.equipCT;
        lose = r.equipT;
        loserEquip = r.equipT || 0;
      } else if (r.winner === 't') {
        win = r.equipT;
        lose = r.equipCT;
        loserEquip = r.equipCT || 0;
      } else {
        continue;
      }
      const gap = (win || 0) - (lose || 0);
      if (gap > gapBest) {
        gapBest = gap;
        gapRound = r.round;
      }
      if (loserEquip > lostBest) {
        lostBest = loserEquip;
        lostRound = r.round;
      }
    }
    return { firstPistol, firstForce, gapRound, lostRound };
  });

  // The stored row of a match-subject card, or the team pair (both teams or none).
  function matchValue(name) {
    const m = reads[name];
    if (!m || m.state !== 'fresh') return null;
    const row = m.rows.find((v) => v.subject === '');
    return row ? row.value : null;
  }

  function teamLine(name, format) {
    const m = reads[name];
    if (!m || m.state !== 'fresh') return DASH;
    const by = {};
    for (const v of m.rows) by[v.subject] = v.value;
    if (!('ct' in by) || !('t' in by)) return DASH;
    return names.ct + ' ' + fmtStoredValue(by.ct, format) + ' · ' + names.t + ' ' + fmtStoredValue(by.t, format);
  }

  const cards = $derived(
    CARDS.map((c) => {
      const drill = anchors[c.drill] || 0;
      return {
        key: c.metric,
        label: c.label,
        value: c.subject === 'team' ? teamLine(c.metric, c.format) : fmtStoredValue(matchValue(c.metric), c.format),
        sub: c.sub,
        title: c.doc,
        inferred: c.inferred,
        drill,
      };
    }),
  );

  // Watch the round: the replay opens at its start with the round's span as the loop.
  function drill(round) {
    if (!round) return;
    const start = roundStartTick(rounds, round);
    const end = roundEndTick(rounds, round);
    spectra.navigate(hashOf('/replay/' + context.matchId, { tick: start, loop: entryLoopSpan(start, end), back: back || 'match/' + context.matchId + '/economy' }));
  }
</script>

<div class="econ-summary stat-grid">
  {#each cards as c (c.key)}
    {#if c.drill}
      <button class="stat-cell" title={c.title} onclick={() => drill(c.drill)}>
        <span class="field-label">{c.label}<span class="chip {c.inferred ? 'badge-inferred' : 'badge-computed'}">{c.inferred ? BADGE_INFERRED : BADGE_COMPUTED}</span></span>
        <span class="stat-value">{c.value}</span>
        <span class="stat-sub">{c.sub}</span>
      </button>
    {:else}
      <div class="stat-cell no-drill" title={c.title}>
        <span class="field-label">{c.label}<span class="chip {c.inferred ? 'badge-inferred' : 'badge-computed'}">{c.inferred ? BADGE_INFERRED : BADGE_COMPUTED}</span></span>
        <span class="stat-value">{c.value}</span>
        <span class="stat-sub">{c.sub}</span>
      </div>
    {/if}
  {/each}
</div>
`;

// The per-round table: the buy class of each side (the chip opens its reason),
// the winner, the round's deaths by side (stored metric), and the loss-bonus pips.
export const ECON_ROUNDS_SOURCE = `<script>
  // Economy rounds: one row per counted round. Deaths are the stored round-grain
  // metric raw_player_round_deaths, read per round and summed per side; a round
  // with no stored value shows a dash.
  let { spectra, context, rows = [], rounds = [], names = { ct: '${S.match.sideCt}', t: '${S.match.sideT}' }, sideSwitches = 0, back = '' } = $props();
  ${FMT_HELPERS}
  ${TICK_HELPERS}
  ${TEAM_HELPERS}
  ${ECON_HELPERS}
  ${NAV_HELPERS}

  const PIP_SLOTS = [1, 2, 3, 4, 5];
  const origin = () => back || 'match/' + context.matchId + '/economy';

  let whyOpen = $state('');
  let deaths = $state(new Map());

  $effect(() => {
    const matchId = context.matchId;
    const list = rows.map((r) => r.round);
    let live = true;
    deaths = new Map();
    if (matchId == null || list.length === 0) return;
    Promise.all(
      list.map((round) =>
        spectra.metric('raw_player_round_deaths', { match_id: matchId, round }).then(
          (m) => [round, m],
          () => [round, null],
        ),
      ),
    ).then((pairs) => {
      if (!live) return;
      const out = new Map();
      for (const [round, m] of pairs) {
        // One stored row per player per round, its dim the side sampled: the
        // side's deaths are the sum over its players (ruling 41).
        const by = {};
        if (m && m.state === 'fresh') {
          for (const v of m.rows) {
            const side = v.dim;
            if (side !== 'ct' && side !== 't') continue;
            if (by[side] === undefined) by[side] = 0;
            by[side] = v.value == null || by[side] === null ? null : by[side] + v.value;
          }
        }
        out.set(round, by);
      }
      deaths = out;
    });
    return () => {
      live = false;
    };
  });

  function deathText(round, side) {
    const by = deaths.get(round);
    if (!by || by[side] == null || by[side] === null) return DASH;
    return fmtInt(by[side]);
  }

  const sepFlags = $derived(separatorFlags(rows.map((r) => ({ number: r.round }))));

  function winnerName(r) {
    const key = winnerTeamKey(rounds, sideSwitches, r.round, r.winner);
    return key ? names[key] : '';
  }

  function classChip(side, r) {
    const cls = side === 'ct' ? r.classCT : r.classT;
    const why = side === 'ct' ? r.classWhyCT : r.classWhyT;
    return { cls: cls || 'unknown', why: why || '${S.economy.noExplanation}', rule: r.ruleVersion };
  }

  function toggleWhy(r, side) {
    const key = r.round + ':' + side;
    whyOpen = whyOpen === key ? '' : key;
  }

  function openRound(round) {
    spectra.navigate(hashOf('/match/' + context.matchId + '/round/' + round, { back: origin() }));
  }

  function watchRound(round) {
    if (!round) return;
    const start = roundStartTick(rounds, round);
    const end = roundEndTick(rounds, round);
    spectra.navigate(hashOf('/replay/' + context.matchId, { tick: start, loop: entryLoopSpan(start, end), back: origin() }));
  }

  const whyText = $derived.by(() => {
    if (!whyOpen) return null;
    const [rs, side] = whyOpen.split(':');
    const r = rows.find((x) => String(x.round) === rs);
    if (!r) return null;
    return { side, why: side === 'ct' ? r.classWhyCT : r.classWhyT, rule: r.ruleVersion };
  });
</script>

<section class="panel">
  <h2>${S.economy.colRounds}</h2>
  {#if rows.length === 0}
    <p class="muted" role="status">${S.economy.noRounds}</p>
  {:else}
    <div class="table-scroll">
      <table class="data-table econ-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">${S.match.colWatch}</span></th>
            <th scope="col" class="num">${S.match.colRd}</th>
            <th scope="col">${S.match.colWinner}</th>
            <th scope="col">${S.economy.colCtBuy}</th>
            <th scope="col">${S.economy.colTBuy}</th>
            <th scope="col" class="num" title="${S.economy.titleDeaths}">${S.economy.colCtDeaths}</th>
            <th scope="col" class="num" title="${S.economy.titleDeaths}">${S.economy.colTDeaths}</th>
            <th scope="col" class="num">${S.economy.colCtLoss}</th>
            <th scope="col" class="num">${S.economy.colTLoss}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r, ri (r.round)}
            {@const ctc = classChip('ct', r)}
            {@const tc = classChip('t', r)}
            <tr class:split-before={ri > 0 && sepFlags[ri - 1]}>
              <td>
                <button class="btn small ghost" title={'${S.economy.watchRoundPrefix}' + r.round + '${S.economy.watchRoundSuffix}'} aria-label={'${S.economy.watchRoundPrefix}' + r.round} onclick={() => watchRound(r.round)}><span class="codicon codicon-play"></span></button>
              </td>
              <td class="num">
                <button class="btn small ghost econ-rd" title={'${S.economy.openRoundAria}' + r.round} onclick={() => openRound(r.round)}>{r.round}</button>
              </td>
              <td>
                <span class="chip side {r.winner || 'none'}">{winnerName(r) || (r.winner ? r.winner.toUpperCase() : '—')}</span>
              </td>
              <td>
                <button class="chip econ-cls {ctc.cls}" title={ctc.why + '${S.economy.ruleOpen}' + ctc.rule + '${S.economy.ruleClose}'} aria-expanded={whyOpen === r.round + ':ct'} onclick={() => toggleWhy(r, 'ct')}>{ctc.cls}</button>
              </td>
              <td>
                <button class="chip econ-cls {tc.cls}" title={tc.why + '${S.economy.ruleOpen}' + tc.rule + '${S.economy.ruleClose}'} aria-expanded={whyOpen === r.round + ':t'} onclick={() => toggleWhy(r, 't')}>{tc.cls}</button>
              </td>
              <td class="num">{deathText(r.round, 'ct')}</td>
              <td class="num">{deathText(r.round, 't')}</td>
              <td class="num econ-loss" title={fmtMoney(r.lossBonusCT)}>
                {#each PIP_SLOTS as pip (pip)}
                  <span class="econ-loss-pip" class:ct={pip <= lossPips(r.lossBonusCT)}></span>
                {/each}
              </td>
              <td class="num econ-loss" title={fmtMoney(r.lossBonusT)}>
                {#each PIP_SLOTS as pip (pip)}
                  <span class="econ-loss-pip" class:t={pip <= lossPips(r.lossBonusT)}></span>
                {/each}
              </td>
            </tr>
            {#if whyOpen.startsWith(r.round + ':')}
              <tr class="econ-why-row">
                <td colspan="9">
                  <div class="econ-why">
                    <span class="chip econ-cls {whyText?.side === 'ct' ? ctc.cls : tc.cls}">{whyText?.side === 'ct' ? ctc.cls : tc.cls}</span>
                    <span class="econ-why-text">{whyText?.why || '${S.economy.noExplanation}'}</span>
                    <span class="spacer"></span>
                    <span class="econ-why-rules mono">${S.economy.rulesPrefix}{whyText?.rule ?? r.ruleVersion}</span>
                    <button class="btn small ghost" aria-label="${S.economy.closeExplanation}" onclick={() => (whyOpen = '')}><span class="codicon codicon-close"></span></button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
`;

// The registry of the Economy builtins, in mount order.
export const ECON_PANELS = Object.freeze([
  Object.freeze({ id: ECON_PANEL_IDS.economy, label: S.economy.panelEconomy, source: ECONOMY_SOURCE }),
  Object.freeze({ id: ECON_PANEL_IDS.curve, label: S.economy.panelCurve, source: ECON_CURVE_SOURCE }),
  Object.freeze({ id: ECON_PANEL_IDS.cards, label: S.economy.panelCards, source: ECON_CARDS_SOURCE }),
  Object.freeze({ id: ECON_PANEL_IDS.rounds, label: S.economy.panelRounds, source: ECON_ROUNDS_SOURCE }),
]);
