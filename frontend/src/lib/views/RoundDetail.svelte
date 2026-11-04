<script>
  import {
    getRoundDetail,
    getRounds,
    getMatch,
    getRoundClasses,
    getTeamNames,
    errText,
  } from '../services.js';
  import { fmtDuration, fmtTickSeconds, fmtInt, chatClock } from '../fmt.js';
  import { replayHash } from '../nav.js';
  import { buildHash } from '../router.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import RoundStrip from '../components/RoundStrip.svelte';

  let { id = 0, round = 0, query = {}, nav = () => {} } = $props();

  // The origin path for the return trip (?back= on the route — the Match
  // tab or view that opened this round; absent = Overview).
  const backPath = $derived(query.back || '');

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

  const economy = $derived(detail?.economy || []);
  const chat = $derived(detail?.chat || []);
  const rbn = $derived(roundsByNumber(rounds));

  // Prev/next by INDEX into the numbered list, not number arithmetic: the
  // first real round is 1 with negative knife/warmup rounds before it, so
  // "round 0" never exists and ±1 arithmetic would skip over (or invent)
  // rounds across that gap.
  const roundIdx = $derived(rounds.findIndex((r) => r.number === round));
  const prevRound = $derived(roundIdx > 0 ? rounds[roundIdx - 1] : null);
  const nextRound = $derived(
    roundIdx >= 0 && roundIdx < rounds.length - 1 ? rounds[roundIdx + 1] : null,
  );

  // Round nav preserves the origin (the return trip from RoundDetail
  // goes back to where the user came from, not always Overview).
  function roundNav(n) {
    return buildHash(`/match/${id}/round/${n}`, { back: backPath });
  }

  // Contextual entries into THE event browser: this round, scoped.
  function openEvents() {
    nav(replayHash(id, { round }, { back: `match/${id}/round/${round}` }));
  }

  // Jump to the replay at a tick (the header button uses the round start;
  // per-event seeks live in the canonical feed now).
  function watchTick(tick) {
    nav(replayHash(id, {}, { tick, back: `match/${id}/round/${round}` }));
  }
</script>

<div class="view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(backPath ? '/' + backPath : `/match/${id}`)}><span class="codicon codicon-arrow-left"></span> Back</button>
    {#if detail}
      <button
        class="btn primary"
        title="Watch this round from its start in the replay"
        onclick={() => watchTick(detail.round.startTick || 0)}
      >
        <span class="codicon codicon-play"></span> Watch round
      </button>
      <button
        class="btn"
        title="Open this round's events in the replay landmark feed"
        onclick={openEvents}
      >
        Events in Replay →
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
    <!-- Round analysis: economy + this round's chat (the kill feed
         retired into the canonical event browser — see openEvents). -->
    <div class="round-grid">
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
                <span class="mono muted" title="tick {c.tick}">{chatClock(c, rbn, tickRate)}</span>
                <strong>{c.name || '—'}</strong>
                <span>{c.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>

    <div class="round-nav">
      {#if prevRound}
        <button class="btn" onclick={() => nav(roundNav(prevRound.number))}>
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
        back={backPath}
        {nav}
      />
      {#if nextRound}
        <button class="btn" onclick={() => nav(roundNav(nextRound.number))}>
          Round {nextRound.number} →
        </button>
      {/if}
    </div>
  {/if}
</div>
