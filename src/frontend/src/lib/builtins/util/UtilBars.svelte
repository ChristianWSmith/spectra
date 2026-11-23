<script>
  // Utility per-round bars, one card per measure: `measure` is 'damage' (utility
  // damage) or 'blind' (blind time). One bar per team per round, its colour the
  // side that team held that round, one team striped. The card hides when the
  // filtered throws have nothing to draw.
  import * as S from '../../strings/index.js';
  import { fmtMs, roundIndexLabel, roundsByNumber, teamStartClass, sideAtRound } from '../../builtinhelpers.js';

  let {
    spectra,
    context,
    measure = 'damage',
    rows = [],
    rounds = [],
    players = [],
    names = { ct: S.match.sideCt, t: S.match.sideT },
    sideSwitches = 0,
  } = $props();

  const MEASURE = $derived(measure);
  const COPY = $derived(
    MEASURE === 'damage'
      ? {
          heading: S.utility.panelDamage,
          aria: S.utility.damageTeamTitle,
          stripeId: 'util-stripe',
          panelClass: 'util-card-damage',
          unit: ' damage',
          maxSuffix: S.utility.damageSub,
          maxTitle: S.utility.damageTotalTitle,
        }
      : {
          heading: S.utility.panelBlind,
          aria: S.utility.blindTeamTitle,
          stripeId: 'util-stripe-blind',
          panelClass: 'util-card-blind',
          unit: S.utility.blindSuffix,
          maxSuffix: S.utility.blindSub,
          maxTitle: S.utility.blindTotalTitle,
        });
  const STRIPED_KEY = 't';
  const barW = 1000;
  const barH = 90;

  const rbn = $derived(roundsByNumber(rounds));
  const teamBySteam = $derived(new Map(players.map((p) => [p.steamId, p.side || ''])));
  const clsCT = $derived(teamStartClass('ct', sideSwitches));
  const clsT = $derived(teamStartClass('t', sideSwitches));

  function amount(r) {
    return MEASURE === 'damage' ? r.damage || 0 : r.flashMsTotal || 0;
  }

  function valueText(v) {
    return MEASURE === 'damage' ? v + COPY.unit : fmtMs(v) + COPY.unit;
  }

  function barSide(roundNumber, finalSide) {
    const side = sideAtRound(rounds, sideSwitches, roundNumber, finalSide);
    return side === 'ct' ? 'side-ct' : side === 't' ? 'side-t' : '';
  }

  const groups = $derived.by(() => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.round)) m.set(r.round, []);
      m.get(r.round).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  });

  const bars = $derived.by(() => {
    const per = groups.map(([round, list]) => {
      let ct = 0;
      let t = 0;
      for (const r of list) {
        const team = teamBySteam.get(r.thrower) || '';
        if (team === 'ct') ct += amount(r);
        else if (team === 't') t += amount(r);
      }
      return { round, ct, t };
    });
    let max = 0;
    for (const p of per) max = Math.max(max, p.ct, p.t);
    return { per, max: max || 1, any: max > 0 };
  });

  const maxText = $derived(MEASURE === 'damage' ? String(bars.max) : fmtMs(bars.max));
</script>

{#if bars.any}
  <div class="{COPY.panelClass}">
    <h2>{COPY.heading}</h2>
    <svg class="util-bars" viewBox="0 0 {barW} {barH}" preserveAspectRatio="none" aria-label={COPY.aria}>
      <defs>
        <pattern id={COPY.stripeId} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
          <rect x="0" y="0" width="3" height="7" class="util-stripe-line" />
        </pattern>
      </defs>
      {#each bars.per as p, i (p.round)}
        {@const slot = barW / bars.per.length}
        {@const x = i * slot}
        {@const bw = Math.max(2, slot * 0.32)}
        {@const hCt = (p.ct / bars.max) * (barH - 4)}
        {@const hT = (p.t / bars.max) * (barH - 4)}
        {@const ctX = x + slot * 0.08}
        {@const tX = x + slot * 0.08 + bw + 2}
        <rect class="util-bar {barSide(p.round, 'ct')}" x={ctX} y={barH - hCt} width={bw} height={hCt}>
          <title>{S.utility.roundPrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.ct}{' '}{valueText(p.ct)}</title>
        </rect>
        {#if STRIPED_KEY === 'ct'}
          <rect class="util-bar-stripe" x={ctX} y={barH - hCt} width={bw} height={hCt} fill={'url(#' + COPY.stripeId + ')'} pointer-events="none" />
        {/if}
        <rect class="util-bar {barSide(p.round, 't')}" x={tX} y={barH - hT} width={bw} height={hT}>
          <title>{S.utility.roundPrefix}{roundIndexLabel(rbn.get(p.round) ?? p.round)} — {names.t}{' '}{valueText(p.t)}</title>
        </rect>
        {#if STRIPED_KEY === 't'}
          <rect class="util-bar-stripe" x={tX} y={barH - hT} width={bw} height={hT} fill={'url(#' + COPY.stripeId + ')'} pointer-events="none" />
        {/if}
      {/each}
    </svg>
    <div class="util-legend">
      <span><span class="util-dot {clsCT}" class:striped={STRIPED_KEY === 'ct'}></span>{names.ct}{#if MEASURE === 'damage'} <span class="chip badge-computed">{S.utility.badgeComputed}</span>{:else} <span class="chip badge-inferred" title="{S.utility.titleComputedBlind}">{S.utility.badgeInferred}</span>{/if}</span>
      <span><span class="util-dot {clsT}" class:striped={STRIPED_KEY === 't'}></span>{names.t}</span>
      <span class="muted" title={COPY.maxTitle}>{S.utility.axisMax}{maxText}{COPY.maxSuffix}</span>
    </div>
  </div>
{/if}
