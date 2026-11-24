<script>
  import * as S from '../../strings/index.js';
  import { DASH, fmtMs, fmtZeroDash, roundClock, roundIndexLabel, roundScoreLabel, roundsByNumber, playerSideClassAt, hashOf, entryLoopAround, isSteam, openPlayer } from '../../builtinhelpers.js';

  // Utility throw log: the kind, thrower and round filters, the count, and one
  // row per throw. The filter state lives in the composer (filt / setFilt).
  let { spectra, context, rows = [], rounds = [], players = [], names = { ct: S.match.sideCt, t: S.match.sideT }, sideSwitches = 0, tickRate = 64, loopSecs = 5, back = '', filt, setFilt } = $props();

  const origin = () => back || 'match/' + context.matchId + '/utility';
  const rbn = $derived(roundsByNumber(rounds));
  const teamBySteam = $derived(new Map(players.map((p) => [p.steamId, p.side || ''])));
  const effTick = (r) => (r.throwTick > 0 ? r.throwTick : r.tick);

  const kindOptions = $derived([...new Set(rows.map((r) => r.kind).filter(Boolean))].sort());

  const filtered = $derived(rows.filter((r) => (filt.kindF === '' || r.kind === filt.kindF) && (filt.throwerF === '' || r.thrower === filt.throwerF)));

  const groups = $derived.by(() => {
    const m = new Map();
    for (const r of filtered) {
      if (!m.has(r.round)) m.set(r.round, []);
      m.get(r.round).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  });

  const roundOptions = $derived(groups.map(([round]) => round));

  // What the round select shows: the recorded choice while it still exists, else
  // the first round with throws, else "All rounds".
  const roundValue = $derived(
    filt.roundSel === 'all'
      ? 'all'
      : filt.roundSel !== '' && roundOptions.some((n) => String(n) === filt.roundSel)
        ? filt.roundSel
        : roundOptions.length
          ? String(roundOptions[0])
          : 'all',
  );

  const shownGroups = $derived(roundValue === 'all' ? groups : groups.filter(([round]) => String(round) === roundValue));

  function update(patch) {
    setFilt({ ...filt, ...patch });
  }

  function playerCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  function affectedCount(json) {
    if (!json) return 0;
    try {
      const a = JSON.parse(json);
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  }

  function coordCell(r) {
    const x = r.throwX;
    const y = r.throwY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return DASH;
    if (x === 0 && y === 0) return DASH;
    return '(' + Math.round(x) + ', ' + Math.round(y) + ')';
  }

  function openReplay(r) {
    const t = effTick(r);
    spectra.navigate(hashOf('/replay/' + context.matchId, { tick: t, loop: entryLoopAround(t, tickRate, loopSecs), follow: r.thrower || undefined, back: origin() }));
  }

  function openProfile(steam) {
    if (isSteam(steam)) openPlayer(spectra, steam);
  }
</script>

<div class="util-throwlog">
  <h2>{S.utility.throwLogHead}</h2>
  <div class="util-filters toolbar">
    <label class="util-field" for="util-kind">
      <span class="field-label">{S.utility.colKind}</span>
      <select class="input" id="util-kind" value={filt.kindF} onchange={(e) => update({ kindF: e.currentTarget.value })}>
        <option value="">{S.utility.allKinds}</option>
        {#each kindOptions as k (k)}
          <option value={k}>{k}</option>
        {/each}
      </select>
    </label>
    <label class="util-field" for="util-thrower">
      <span class="field-label">{S.utility.colThrower}</span>
      <select class="input" id="util-thrower" value={filt.throwerF} onchange={(e) => update({ throwerF: e.currentTarget.value })}>
        <option value="">{S.utility.allPlayers}</option>
        {#each players as p (p.steamId)}
          <option value={p.steamId}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label class="util-field" for="util-round">
      <span class="field-label">{S.utility.colRound}</span>
      <select class="input" id="util-round" value={roundValue} onchange={(e) => update({ roundSel: e.currentTarget.value })}>
        <option value="all">{S.utility.allRounds}</option>
        {#each roundOptions as n (n)}
          <option value={String(n)}>{roundScoreLabel(rounds, n)}</option>
        {/each}
      </select>
    </label>
    <span class="muted">{filtered.length}{S.utility.ofSeparator}{rows.length}{S.utility.grenadeWord}{rows.length === 1 ? '' : 's'}</span>
  </div>
  {#if groups.length === 0}
    <p class="muted" role="status">{S.utility.noMatch}</p>
  {:else}
    <div class="util-lists">
      <div class="util-cols">
        <span>{S.utility.colPlay}</span>
        <span>{S.utility.colKind}</span>
        <span>{S.utility.colThrower}</span>
        <span>{S.utility.colTime}</span>
        <span>{S.utility.colDamage}</span>
        <span>{S.utility.colBlind}</span>
        <span>{S.utility.colAffected}</span>
        <span>{S.utility.colPosition}</span>
      </div>
      {#each shownGroups as [round, list] (round)}
        <ul class="util-nades">
          {#each list as r, i (r.tick + ':' + i)}
            {@const name = r.throwerName || r.thrower}
            <li class="util-nade">
              <span class="util-actions">
                <button class="btn small ghost" title={r.thrower ? S.utility.watchThrowFollow + name : S.utility.watchThrowTitle} aria-label={r.thrower ? S.utility.watchThrowFollow + name : S.utility.watchThrowTitle} onclick={() => openReplay(r)}><span class="codicon codicon-play"></span></button>
              </span>
              <span class="chip util-kind {r.kind}">{r.kind}</span>
              {#if /^\d{17}$/.test(r.thrower)}
                <button class="comb-name-btn util-thrower {playerCls(r.round, r.thrower, r.throwerName)}" title={S.utility.openPrefix + name + S.utility.profileSuffix} onclick={() => openProfile(r.thrower)}>{name || DASH}</button>
              {:else}
                <span class="util-thrower {playerCls(r.round, r.thrower, r.throwerName)}">{name || DASH}</span>
              {/if}
              <span class="mono muted util-tick" title={S.utility.tickPrefix + effTick(r) + S.utility.timeIntoRound + roundIndexLabel(rbn.get(r.round) ?? r.round)}>{roundClock(effTick(r), rbn.get(r.round), tickRate)}</span>
              <span class="util-num" title="{S.utility.titleDamageDealt}">{fmtZeroDash(r.damage, S.utility.unitDamage)}</span>
              <span class="util-num muted" title="{S.utility.titleTotalBlind}">{r.flashMsTotal > 0 ? fmtMs(r.flashMsTotal) : DASH}</span>
              <span class="util-num muted" title="{S.utility.titleAffected}">{fmtZeroDash(affectedCount(r.affected), S.utility.unitAffected)}</span>
              <span class="util-coord muted mono" title="{S.utility.titleCoords}">{coordCell(r)}</span>
            </li>
          {/each}
        </ul>
      {/each}
    </div>
  {/if}
</div>
