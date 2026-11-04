<script>
  import {
    getRoundDetail,
    getRounds,
    getMatch,
    getScoreboard,
    getRoundClasses,
    getTeamNames,
    errText,
  } from '../services.js';
  import { fmtDuration, fmtTickSeconds, fmtInt, fmtClock, tickSeconds, chatClock } from '../fmt.js';
  import { isCounted } from '../rounds.js';
  import { playerStartClass } from '../teams.js';
  import { replayHash } from '../nav.js';
  import { buildHash } from '../router.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import EventFlags from '../components/EventFlags.svelte';

  let { id = 0, round = 0, query = {}, nav = () => {} } = $props();

  // The origin path for the return trip (?back= on the route — the Match
  // tab or view that opened this round; absent = Overview).
  const backPath = $derived(query.back || '');

  let detail = $state(null);
  let rounds = $state([]);
  let tickRate = $state(64);
  let sideSwitches = $state(0);
  // Scoreboard rows: the final side per player, for the team-identity
  // colors on names (changes.txt #20) — steam-id lookup first, exact
  // name as the fallback (kill/chat rows may carry only a name).
  let players = $state([]);
  let error = $state('');
  let cls = $state(null); // models.RoundClassification for this round (may be null)

  // Team-identity color class for a name surface — '' when the player or
  // their side can't be resolved (never a guessed color).
  function playerCls(steamId, name) {
    return playerStartClass(players, sideSwitches, steamId, name);
  }

  // Team display names for the round strip's above/below labels — the
  // same resolution the Match header uses (demo clan names → derived
  // `team_<player>` → bare side), resolved by Go's GetTeamNames (the
  // synth twin of lib/teams.js — see the cross-reference there).
  let teams = $state({ ct: 'CT', t: 'T' });

  $effect(() => {
    let live = true;
    Promise.all([
      getRoundDetail(id, round),
      getRounds(id),
      getMatch(id),
      getScoreboard(id, 'kills', true).catch(() => []),
    ])
      .then(([d, r, m, sb]) => {
        if (!live) return;
        detail = d;
        rounds = r || [];
        players = sb || [];
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

  // Round events from the ONE round-detail read (models.RoundDetail
  // .events — typed EventRows for exactly this round, already ordered by
  // seq): the kill feed and the bomb timeline live here again (the
  // canonical event browser still holds every other round event).
  const events = $derived(detail?.events || []);
  const kills = $derived(events.filter((e) => e.kind === 'kill'));
  const bombEvents = $derived(
    events.filter(
      (e) => e.kind === 'bomb_plant' || e.kind === 'bomb_defuse' || e.kind === 'bomb_explode',
    ),
  );

  // Scoreline at this round: cumulative counted-round wins by side — a
  // pure view aggregate over the already-fetched rounds rows
  // (lib/rounds.js isCounted drops the knife/warmup winners; rounds are
  // numbered in time order, so number <= round is "through this round").
  const scoreAt = $derived.by(() => {
    let ct = 0;
    let t = 0;
    for (const r of rounds) {
      if (!isCounted(r) || r.number > round) continue;
      if (r.winner === 'ct') ct++;
      else if (r.winner === 't') t++;
    }
    return { ct, t };
  });

  // Into-round clock for an event row ("0:47" = that far past the round
  // start) — fmt.js fmtClock over tickSeconds; the raw tick rides the
  // title tooltip.
  function roundClock(tick) {
    const start = detail?.round?.startTick;
    const into = Number.isFinite(start) ? tick - start : tick;
    return fmtClock(tickSeconds(into, tickRate));
  }

  // Bomb event label for the timeline's Event column.
  function bombLabel(kind) {
    if (kind === 'bomb_plant') return 'Planted';
    if (kind === 'bomb_defuse') return 'Defused';
    if (kind === 'bomb_explode') return 'Exploded';
    return kind;
  }

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
        · MVP
        {#if detail.round.mvpName}
          <span class={playerCls(detail.round.mvp, detail.round.mvpName)}
            >{detail.round.mvpName}</span
          >
        {:else}
          —
        {/if}
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
    <!-- Round analysis: the round's result, kill feed and bomb timeline
         (the round-detail read's typed events), with economy and this
         round's chat alongside. Every event row drills into the replay
         at its tick (watchTick); openEvents keeps the canonical
         landmark-feed entry. -->
    <div class="round-grid">
      <div class="round-side">
        <section class="panel">
          <h2>Round result</h2>
          <dl class="facts">
            <div>
              <dt>Winner</dt>
              <dd>
                {#if detail.round.winner}
                  <span class="chip side {detail.round.winner}"
                    >{teams[detail.round.winner] || detail.round.winner.toUpperCase()}</span
                  >
                {:else}
                  <span class="muted">—</span>
                {/if}
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{detail.round.reason || '—'}</dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd
                title="Counted-round wins through this round (knife/warmup excluded)"
              >
                {#if round >= 1 && rounds.length}
                  <span class="ct">{scoreAt.ct}</span>–<span class="t">{scoreAt.t}</span>
                {:else}
                  <span class="muted">—</span>
                {/if}
              </dd>
            </div>
            <div>
              <dt>First kill</dt>
              <dd>
                {#if detail.round.firstKillName}
                  <span class={playerCls(detail.round.firstKillSteam, detail.round.firstKillName)}
                    >{detail.round.firstKillName}</span
                  >
                {:else}
                  —
                {/if}
                {#if detail.round.firstDeathName}
                  {' → '}
                  <span class={playerCls(detail.round.firstDeathSteam, detail.round.firstDeathName)}
                    >{detail.round.firstDeathName}</span
                  >
                {/if}
              </dd>
            </div>
          </dl>
        </section>

        <section class="panel">
          <h2>Kills <span class="muted">({kills.length})</span></h2>
          {#if kills.length === 0}
            <p class="muted" role="status">No kills this round.</p>
          {:else}
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Killer</th>
                    <th scope="col">Victim</th>
                    <th scope="col">Weapon</th>
                    <th scope="col">Flags</th>
                    <th scope="col"><span class="sr-only">Watch</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each kills as k (k.id)}
                    <tr>
                      <td class="mono" title="tick {k.tick}">{roundClock(k.tick)}</td>
                      <td class={playerCls(k.attacker, k.attackerName)}
                        >{k.attackerName || k.attacker || '—'}</td
                      >
                      <td class={playerCls(k.victim, k.victimName)}
                        >{k.victimName || k.victim || '—'}</td
                      >
                      <td class="mono">{k.weapon || '—'}</td>
                      <td><EventFlags event={k} none /></td>
                      <td>
                        <button
                          class="btn small ghost"
                          title="Watch from this kill in the replay"
                          aria-label="Watch from tick {k.tick} in the replay"
                          onclick={() => watchTick(k.tick)}
                          ><span class="codicon codicon-play"></span></button
                        >
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

        <section class="panel">
          <h2>Bomb</h2>
          {#if bombEvents.length === 0}
            <p class="muted" role="status">No bomb events this round.</p>
          {:else}
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Event</th>
                    <th scope="col">Player</th>
                    <th scope="col">Site</th>
                    <th scope="col"><span class="sr-only">Watch</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each bombEvents as e (e.id)}
                    <tr>
                      <td class="mono" title="tick {e.tick}">{roundClock(e.tick)}</td>
                      <td>{bombLabel(e.kind)}</td>
                      <td class={playerCls(e.attacker, e.attackerName)}
                        >{e.attackerName || e.attacker || '—'}</td
                      >
                      <td>{e.site || '—'}</td>
                      <td>
                        <button
                          class="btn small ghost"
                          title="Watch from this event in the replay"
                          aria-label="Watch from tick {e.tick} in the replay"
                          onclick={() => watchTick(e.tick)}
                          ><span class="codicon codicon-play"></span></button
                        >
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

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
      </div>

      <div class="round-side">
        <section class="panel">
          <h2>Round chat</h2>
          {#if chat.length === 0}
            <p class="muted" role="status">No chat this round.</p>
          {:else}
            <ul class="chat-list">
              {#each chat as c (c.id)}
                <li>
                  <span class="mono muted" title="tick {c.tick}">{chatClock(c, rbn, tickRate)}</span>
                  <strong class={playerCls(c.steamId, c.name)}>{c.name || '—'}</strong>
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
