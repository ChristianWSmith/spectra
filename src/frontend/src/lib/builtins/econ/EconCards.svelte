<script>
  import * as S from '../../strings/index.js';
  import { DASH, fmtStoredValue, roundStartTick, roundEndTick, hashOf, entryLoopSpan } from '../../builtinhelpers.js';
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

  // Economy summary cards: six stored statistics of the match, each read with
  // metric() under the context's match. A card that is not fresh shows a dash.
  let { spectra, context, rows = [], rounds = [], names = { ct: S.match.sideCt, t: S.match.sideT }, back = '' } = $props();

  const CARDS = ECON_CARDS;
  const BADGE_INFERRED = 'inferred';
  const BADGE_COMPUTED = 'computed';

  let reads = $state({});

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
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

<div class="econ-summary stat-grid" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
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
