<script>
  import {
    getRoundDetail,
    getRounds,
    getMatch,
    getRoundClasses,
    getTeamNames,
    setPendingSeek,
    errText,
  } from '../services.js';
  import { fmtDuration, fmtTickSeconds, fmtInt } from '../fmt.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import EventFlags from '../components/EventFlags.svelte';
  import EventPlay from '../components/EventPlay.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';

  let { id = 0, round = 0, nav = () => {} } = $props();

  let detail = $state(null);
  let rounds = $state([]);
  let tickRate = $state(64);
  let sideSwitches = $state(0);
  let error = $state('');
  let cls = $state(null); // models.RoundClassification for this round (may be null)

  // Team display names for the round strip's above/below labels — the
  // same resolution the Match header uses (demo clan names → derived
  // `team_<player>` → bare side), resolved by Go's GetTeamNames (the
  // synth twin of lib/teams.js — see the cross-reference there).
  let teams = $state({ ct: 'CT', t: 'T' });

  $effect(() => {
    let live = true;
    Promise.all([getRoundDetail(id, round), getRounds(id), getMatch(id)])
      .then(([d, r, m]) => {
        if (!live) return;
        detail = d;
        rounds = r || [];
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        if (m) sideSwitches = m.sideSwitches || 0;
        error = d ? '' : 'Round not found.';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Match-level identity (runs once per id, not per round navigation).
  // GetTeamNames is the one-match getter ({ct, t}, synthesized
  // team_<player> fallbacks included Go-side) — never the whole library
  // list for one header lookup.
  $effect(() => {
    id;
    let live = true;
    getTeamNames(id)
      .then((t) => {
        if (live && t) teams = t;
      })
      .catch(() => {
        /* keep the CT/T defaults */
      });
    return () => (live = false);
  });

  // Classification chip (analytics pass) — best-effort, absence is fine.
  $effect(() => {
    let live = true;
    getRoundClasses(id)
      .then((rows) => {
        if (!live) return;
        cls = (rows || []).find((r) => r.round === round) || null;
      })
      .catch(() => {
        if (live) cls = null;
      });
    return () => (live = false);
  });

  const kills = $derived(
    (detail?.events || []).filter((e) => e.kind === 'kill'),
  );
  const economy = $derived(detail?.economy || []);
  const chat = $derived(detail?.chat || []);

  // Prev/next by INDEX into the numbered list, not number arithmetic: the
  // first real round is 1 with negative knife/warmup rounds before it, so
  // "round 0" never exists and ±1 arithmetic would skip over (or invent)
  // rounds across that gap.
  const roundIdx = $derived(rounds.findIndex((r) => r.number === round));
  const prevRound = $derived(roundIdx > 0 ? rounds[roundIdx - 1] : null);
  const nextRound = $derived(
    roundIdx >= 0 && roundIdx < rounds.length - 1 ? rounds[roundIdx + 1] : null,
  );

  // Jump to the replay at a tick (per-kill ▶ uses the kill's own tick; the
  // header button uses the round start).
  function watchTick(tick) {
    setPendingSeek({ tick });
    nav(`/replay/${id}`);
  }
</script>

<div class="view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(`/match/${id}`)}><span class="codicon codicon-arrow-left"></span> Match</button>
    {#if detail}
      <button
        class="btn primary"
        title="Watch this round from its start in the replay"
        onclick={() => watchTick(detail.round.startTick || 0)}
      >
        <span class="codicon codicon-play"></span> Watch round
      </button>
      <h1>
        Round {detail.round.number}
        <span class="chip side {detail.round.winner || 'none'}">
          {detail.round.winner ? detail.round.winner.toUpperCase() : '—'}
        </span>
        {#if detail.round.warmup}<span class="chip">warmup</span>{/if}
        {#if detail.round.pregame}
          <span class="chip" title="pre-match knife round — not counted play">knife</span>
        {/if}
        {#if cls}
          <span
            class="chip cmp-class"
            title="{cls.explanation || 'classified'} (rule v{cls.ruleVersion}, confidence {Math.round((cls.confidence || 0) * 100)}%)"
            >{cls.label}</span
          >
        {/if}
      </h1>
      <p class="muted">
        {detail.round.reason || '—'}
        · {fmtDuration(detail.round.durationS)}
        · site {detail.round.bombSite || '—'}
        · equip <span class="ct">{detail.round.equipCT}</span>/<span
          class="t">{detail.round.equipT}</span
        >
        · {detail.round.kills} kills
        · MVP {detail.round.mvpName || '—'}
        {#if detail.round.mvpReason}({detail.round.mvpReason}){/if}
        · {fmtTickSeconds(detail.round.startTick, tickRate)}–{fmtTickSeconds(
          detail.round.endTick,
          tickRate,
        )}
      </p>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if detail}
    <div class="round-grid">
      <section class="panel">
        <h2>Kill feed</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Replay</span></th>
              <th scope="col" class="num">Tick</th>
              <th scope="col">Attacker</th>
              <th scope="col">Weapon</th>
              <th scope="col">Victim</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {#each kills as e (e.id)}
              <tr>
                <td>
                  <EventPlay
                    tick={e.tick}
                    title="Jump to this kill in the replay"
                    label="Jump to kill at tick {e.tick} in the replay"
                    onclick={() => watchTick(e.tick)}
                  />
                </td>
                <td class="num mono">{e.tick}</td>
                <td class="ct">
                  <ProfileLink
                    steam={e.attacker}
                    name={e.attackerName || '—'}
                    {nav}
                    title="Open {e.attackerName} profile"
                  />
                </td>
                <td class="mono">{e.weapon || '—'}</td>
                <td class="t">
                  <ProfileLink
                    steam={e.victim}
                    name={e.victimName || '—'}
                    {nav}
                    title="Open {e.victimName} profile"
                  />
                </td>
                <td><EventFlags event={e} /></td>
              </tr>
            {:else}
              <tr><td colspan="6" class="muted">No kills recorded in this round.</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <div class="round-side">
        <section class="panel">
          <h2>Economy</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Side</th>
                <th scope="col" class="num">Equip</th>
                <th scope="col" class="num">Money</th>
              </tr>
            </thead>
            <tbody>
              {#each economy as e (e.side)}
                <tr>
                  <td><span class="chip side {e.side}">{e.side.toUpperCase()}</span></td>
                  <td class="num">{e.equipValue}</td>
                  <td class="num">
                    {e.moneySamples > 0
                      ? fmtInt(Math.round(e.moneySampledSum / e.moneySamples))
                      : '—'}
                  </td>
                </tr>
              {:else}
                <tr><td colspan="3" class="muted">No economy samples.</td></tr>
              {/each}
            </tbody>
          </table>
        </section>

        <section class="panel">
          <h2>Round chat</h2>
          {#if chat.length === 0}
            <p class="muted" role="status">No chat this round.</p>
          {:else}
            <ul class="chat-list">
              {#each chat as c (c.id)}
                <li>
                  <span class="mono muted">{c.tick}</span>
                  <strong>{c.name || '—'}</strong>
                  <span>{c.text}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    </div>

    <div class="round-nav">
      {#if prevRound}
        <button class="btn" onclick={() => nav(`/match/${id}/round/${prevRound.number}`)}>
          <span class="codicon codicon-arrow-left"></span> Round {prevRound.number}
        </button>
      {/if}
      <RoundStrip
        {rounds}
        current={round}
        matchId={id}
        teamAbove={teams.ct}
        teamBelow={teams.t}
        {sideSwitches}
        {nav}
      />
      {#if nextRound}
        <button class="btn" onclick={() => nav(`/match/${id}/round/${nextRound.number}`)}>
          Round {nextRound.number} →
        </button>
      {/if}
    </div>
  {/if}
</div>
