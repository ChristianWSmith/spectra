<script>
  import {
    getRoundDetail,
    getRounds,
    getMatch,
    getScoreboard,
    getRoundClasses,
    listMatches,
    setPendingSeek,
  } from '../services.js';
  import { fmtDuration, fmtTickSeconds, fmtInt } from '../fmt.js';
  import { teamNames } from '../teams.js';
  import RoundStrip from '../components/RoundStrip.svelte';

  let { id = 0, round = 0, nav = () => {} } = $props();

  let detail = $state(null);
  let rounds = $state([]);
  let tickRate = $state(64);
  let sideSwitches = $state(0);
  let error = $state('');
  let cls = $state(null); // RoundClassRow for this round (may be null)

  // Team display names for the round strip's above/below labels — the
  // same resolution the Match header uses (demo clan names → derived
  // `team_<player>` → bare side), loaded once per match.
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
  $effect(() => {
    id;
    let live = true;
    Promise.all([
      listMatches('', 'extracted_at', false).catch(() => []),
      getScoreboard(id, 'kills', true).catch(() => []),
    ])
      .then(([list, sb]) => {
        if (!live) return;
        const s = (list || []).find((m) => m.id === id);
        teams = teamNames({
          ctName: (s && s.ctName) || '',
          tName: (s && s.tName) || '',
          players: sb || [],
        });
      })
      .catch(() => {});
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

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  function isSteam(s) {
    return /^\d{17}$/.test(s || '');
  }

  function openProfile(steam) {
    if (isSteam(steam)) nav(`/player/${steam}`);
  }

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
                  <button
                    class="btn small ghost"
                    title="Jump to this kill in the replay"
                    aria-label="Jump to kill at tick {e.tick} in the replay"
                    onclick={() => watchTick(e.tick)}
                  ><span class="codicon codicon-play"></span></button>
                </td>
                <td class="num mono">{e.tick}</td>
                <td class="ct">
                  {#if isSteam(e.attacker)}
                    <button
                      class="comb-name-btn"
                      title="Open {e.attackerName} profile"
                      onclick={() => openProfile(e.attacker)}
                    >{e.attackerName || '—'}</button>
                  {:else}
                    {e.attackerName || '—'}
                  {/if}
                </td>
                <td class="mono">{e.weapon || '—'}</td>
                <td class="t">
                  {#if isSteam(e.victim)}
                    <button
                      class="comb-name-btn"
                      title="Open {e.victimName} profile"
                      onclick={() => openProfile(e.victim)}
                    >{e.victimName || '—'}</button>
                  {:else}
                    {e.victimName || '—'}
                  {/if}
                </td>
                <td>
                  {#if e.headshot}<span class="chip flag" title="headshot">HS</span>{/if}
                  {#if e.wallbang}<span class="chip flag" title="wallbang">WB</span>{/if}
                  {#if e.noscope}<span class="chip flag" title="no scope">NS</span>{/if}
                  {#if e.throughSmoke}<span class="chip flag" title="through smoke">SMK</span>{/if}
                  {#if e.attackerBlind}<span class="chip flag" title="attacker blind">BLD</span>{/if}
                </td>
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
            <p class="muted">No chat this round.</p>
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
