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
  import { fmtDuration, fmtTickSeconds, fmtInt, fmtClock, tickSeconds, chatClock, chatTag } from '../fmt.js';
  import { roundIndexLabel, scoreThrough } from '../rounds.js';
  import { playerSideAt, playerSideClassAt } from '../teams.js';
  import { replayHash, entryLoopSpan, entryLoopAround } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { buildHash } from '../router.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import EventFlags from '../components/EventFlags.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';

  let { id = 0, round = 0, query = {}, nav = () => {} } = $props();

  // The origin path for the return trip (?back= on the route — the Match
  // tab or view that opened this round; absent = Overview).
  const backPath = $derived(query.back || '');

  let detail = $state(null);
  let rounds = $state([]);
  let tickRate = $state(64);
  let sideSwitches = $state(0);
  // Scoreboard rows: the final side per player — the input for the
  // per-round name colors (lib/teams.js playerSideClassAt looks the
  // player up by steam id first, exact display name as the fallback,
  // since kill/chat rows may carry only a name).
  let players = $state([]);
  let error = $state('');
  let cls = $state(null); // models.RoundClassification for this round (may be null)

  // Per-round SIDE color class for a name surface — every name on this
  // view belongs to exactly THIS round, so the color follows the side the
  // player had in it (lib/teams.js playerSideClassAt over the round list
  // this view already loads), not the team's start side. '' when the
  // player or the round can't be resolved (never a guessed color).
  function playerCls(steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, round, steamId, name);
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
        players = listedPlayers(sb) || [];
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

  // Scoreline at this round: cumulative counted-round wins through this
  // round — the ONE aggregate in lib/rounds.js scoreThrough (view-level
  // over the already-fetched rounds rows; isCounted drops the
  // knife/warmup winners, rounds are numbered in time order so
  // "number <= round" is "through this round").
  const scoreAt = $derived(scoreThrough(rounds, round));

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

  // Non-counted rounds display their KIND word ("Warmup"/"Knife") — the
  // ribbon's W/K letters spelled out (lib/rounds.js roundIndexLabel) —
  // so no surface shows a raw negative index; counted rounds keep the
  // plain "Round N" phrasing.
  const roundKind = (r) => {
    const l = roundIndexLabel(r);
    return l === 'K' ? 'Knife' : l === 'W' ? 'Warmup' : null;
  };

  // Round nav preserves the origin (the return trip from RoundDetail
  // goes back to where the user came from, not always Overview).
  function roundNav(n) {
    return buildHash(`/match/${id}/round/${n}`, { back: backPath });
  }

  // Contextual entries into THE event browser: this round, scoped (both
  // inclusive round bounds set to the same number) AND stamped with the
  // round's start tick — ?tick= is the only "where to jump" instruction
  // (the scope alone is feed filter and never seeks), so the button
  // still lands on this round like it always did.
  function openEvents() {
    nav(
      replayHash(
        id,
        { roundFrom: round, roundTo: round },
        { tick: detail.round.startTick, back: `match/${id}/round/${round}` },
      ),
    );
  }

  // Jump to the replay at a tick (the header button uses the round start;
  // per-event seeks live in the canonical feed now). `loop` is the
  // entry-only ?loop= range stamped BESIDE the seek (undefined = none,
  // which buildHash drops): the round's start→end span for the header's
  // "Watch round", ±10 s around the event tick for the kill-feed and
  // bomb-timeline ▶ buttons (nav.entryLoopSpan / nav.entryLoopAround).
  function watchTick(tick, loop) {
    nav(replayHash(id, {}, { tick, loop, back: `match/${id}/round/${round}` }));
  }
</script>

<div class="view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(backPath ? '/' + backPath : `/match/${id}`)}><span class="codicon codicon-arrow-left"></span> Back</button>
    {#if detail}
      <button
        class="btn primary"
        title="Watch this round from its start in the replay"
        onclick={() =>
          watchTick(detail.round.startTick || 0, entryLoopSpan(detail.round.startTick, detail.round.endTick))}
      >
        <span class="codicon codicon-play"></span> Watch round
      </button>
      <button
        class="btn"
        title="Open this round's events in the replay landmark feed"
        onclick={openEvents}
      >
        Events in Replay <span class="codicon codicon-chevron-right"></span>
      </button>
      <h1>
        {#if roundKind(detail.round)}
          <span
            title={detail.round.pregame
              ? 'pre-match knife round — not counted play'
              : 'warmup round — not counted play'}
            >{roundKind(detail.round)} round</span
          >
        {:else}
          Round {detail.round.number}
        {/if}
        <span class="chip side {detail.round.winner || 'none'}">
          {detail.round.winner ? detail.round.winner.toUpperCase() : '—'}
        </span>
        {#if cls}
          <span
            class="chip cmp-class"
            title="{cls.explanation || 'classified'} (rules v{cls.ruleVersion} — {Math.round((cls.confidence || 0) * 100)}% sure)"
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
          <ProfileLink
            steam={detail.round.mvp}
            name={detail.round.mvpName}
            {nav}
            cls={playerCls(detail.round.mvp, detail.round.mvpName)}
            title="Open {detail.round.mvpName} profile"
          />
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
         at its tick (watchTick — ▶ rows stamp a ±10 s ?loop= range, the
         header the round's own span); openEvents keeps the canonical
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
                  <ProfileLink
                    steam={detail.round.firstKillSteam}
                    name={detail.round.firstKillName}
                    {nav}
                    cls={playerCls(detail.round.firstKillSteam, detail.round.firstKillName)}
                    title="Open {detail.round.firstKillName} profile"
                  />
                {:else}
                  —
                {/if}
                {#if detail.round.firstDeathName}
                  {' → '}
                  <ProfileLink
                    steam={detail.round.firstDeathSteam}
                    name={detail.round.firstDeathName}
                    {nav}
                    cls={playerCls(detail.round.firstDeathSteam, detail.round.firstDeathName)}
                    title="Open {detail.round.firstDeathName} profile"
                  />
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
                      <td>
                        <ProfileLink
                          steam={k.attacker}
                          name={k.attackerName || k.attacker}
                          {nav}
                          cls={playerCls(k.attacker, k.attackerName)}
                          title="Open {k.attackerName || k.attacker} profile"
                        />
                      </td>
                      <td>
                        <ProfileLink
                          steam={k.victim}
                          name={k.victimName || k.victim}
                          {nav}
                          cls={playerCls(k.victim, k.victimName)}
                          title="Open {k.victimName || k.victim} profile"
                        />
                      </td>
                      <td class="mono">{k.weapon || '—'}</td>
                      <td><EventFlags event={k} none /></td>
                      <td>
                        <button
                          class="btn small ghost"
                          title="Watch from this kill in the replay"
                          aria-label="Watch from tick {k.tick} in the replay"
                          onclick={() => watchTick(k.tick, entryLoopAround(k.tick, tickRate))}
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
                      <td>
                        <ProfileLink
                          steam={e.attacker}
                          name={e.attackerName || e.attacker}
                          {nav}
                          cls={playerCls(e.attacker, e.attackerName)}
                          title="Open {e.attackerName || e.attacker} profile"
                        />
                      </td>
                      <td>{e.site || '—'}</td>
                      <td>
                        <button
                          class="btn small ghost"
                          title="Watch from this event in the replay"
                          aria-label="Watch from tick {e.tick} in the replay"
                          onclick={() => watchTick(e.tick, entryLoopAround(e.tick, tickRate))}
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
                {@const tag = chatTag(c.channel || '', playerSideAt(players, sideSwitches, rounds, round, c.steamId, c.name))}
                <li>
                  <span class="mono muted" title="tick {c.tick}">{chatClock(c, rbn, tickRate)}</span>
                  <strong>
                    <ProfileLink
                      steam={c.steamId}
                      name={c.name}
                      {nav}
                      cls={playerCls(c.steamId, c.name)}
                      title="Open {c.name} profile"
                    />{#if tag}{' '}{tag}{/if}
                  </strong>
                  <!-- THE chat display rule (fmt.chatLine's DOM twin):
                       linked name + tag + ': ' + text — team chat tags the
                       speaker's SIDE in this round, all chat reads [ALL],
                       system rows stay plain. -->
                  <span>: {c.text}</span>
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
          <span class="codicon codicon-arrow-left"></span>
          {roundKind(prevRound) ?? `Round ${prevRound.number}`}
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
          {roundKind(nextRound) ?? `Round ${nextRound.number}`}
          <span class="codicon codicon-arrow-right"></span>
        </button>
      {/if}
    </div>
  {/if}
</div>
