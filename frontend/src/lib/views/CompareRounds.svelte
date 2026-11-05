<script>
  // Side-by-side round comparison — a distinct analytical view (not an
  // event browser): its bounded event sequence renders through the shared
  // LandmarkRow and links into Replay's landmark feed at that tick. The
  // selected rounds ride the URL (?rounds=3,5,7), as does the origin path
  // (?back=).
  //
  // Ghost overlay (two trail sets over the M2 sidecar) is intentionally NOT
  // implemented here — it needs sidecar streaming + mapxform wiring and is
  // deferred.
  import {
    getRoundDetail,
    getRounds,
    getScoreboard,
    getEconomy,
    getUtility,
    getRoundClasses,
    getMatch,
    errText,
  } from '../services.js';
  import { fmtDuration, fmtInt, fmtTickSeconds, fmtMs } from '../fmt.js';
  import { replayHash } from '../nav.js';
  import { roundStartTick } from '../rounds.js';
  import { buildHash } from '../router.js';
  import { normalizeEvent } from '../replay/landmarks.js';
  import { playerSideClassAt } from '../teams.js';
  import LandmarkRow from '../components/LandmarkRow.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';

  let { id = 0, query = {}, nav = () => {} } = $props();

  const SEQ_LIMIT = 30;

  // ?rounds=3,5,7 — validated (same match, integers, ≤ 4, ≥ 2); anything
  // else → the hint + back path below.
  const sel = $derived.by(() => {
    const raw = query.rounds || '';
    const rounds = raw
      .split(',')
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n))
      .slice(0, 4);
    return rounds.length >= 2 ? { matchId: id, rounds } : null;
  });

  // The origin path (which match tab opened the comparison).
  const backPath = $derived(query.back || '');

  // Return trip back into THIS selection (rounds ride along so coming
  // back never lands on the empty-selection hint).
  const backToCompare = $derived(
    sel ? `compare/${id}?rounds=${sel.rounds.join(',')}` : `compare/${id}`,
  );

  function backHash() {
    return backPath ? '/' + backPath : `/match/${id}`;
  }

  let cols = $state([]);
  let tickRate = $state(64);
  let error = $state('');
  // Round-scoped name colors: the round list (the counted-round index
  // behind the per-round side) and the scoreboard (each player's final
  // side), plus the match's side-switch count. Fetched once per
  // selection alongside the round details above.
  let rounds = $state([]);
  let players = $state([]);
  let sideSwitches = $state(0);

  // Per-round SIDE color for a name in ONE compared round — lib/teams.js
  // playerSideClassAt; '' when the player or round can't be resolved.
  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  $effect(() => {
    if (!sel) return;
    let live = true;
    const wanted = sel.rounds;
    Promise.all([
      getMatch(id),
      getRounds(id),
      getScoreboard(id, 'kills', true).catch(() => []),
      getEconomy(id),
      getUtility(id),
      getRoundClasses(id),
      ...wanted.map((r) => getRoundDetail(id, r)),
    ])
      .then((all) => {
        if (!live) return;
        const [m, roundRows, sb, econRows, utilRows, classRows, ...details] = all;
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        sideSwitches = (m && m.sideSwitches) || 0;
        rounds = roundRows || [];
        players = sb || [];
        const econBy = new Map((econRows || []).map((e) => [e.round, e]));
        const classBy = new Map((classRows || []).map((c) => [c.round, c]));
        const utils = utilRows || [];
        cols = wanted.map((r, i) => {
          const detail = details[i];
          // The bounded sequence comes straight from the round-detail
          // response — no separate per-round event fetch.
          const seq = (detail?.events || []).slice(0, SEQ_LIMIT);
          return {
            round: r,
            detail,
            seq,
            econ: econBy.get(r) || null,
            cls: classBy.get(r) || null,
            utils: utils.filter((u) => u.round === r),
            // Kept as parts (not one formatted string) so both names can
            // carry their per-round side color and link to their profiles.
            firstBlood: detail?.round?.firstKillName
              ? {
                  kill: detail.round.firstKillName,
                  killSteam: detail.round.firstKillSteam,
                  death: detail.round.firstDeathName,
                  deathSteam: detail.round.firstDeathSteam,
                }
              : null,
          };
        });
        error = '';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // The shared row presentation: rows are normalized with policy:false
  // (the user explicitly selected these rounds — show every row) and
  // both click and ▶ open the canonical feed at that tick.
  function toLandmark(e) {
    return normalizeEvent(e, { policy: false });
  }

  function openEvent(row) {
    nav(replayHash(id, {}, { tick: row.tick, sel: row.key, back: backToCompare }));
  }

  function replayStart(col) {
    // The round's start is the promised time: the detail row when it
    // loaded, otherwise the rounds list. Never stamp tick 0 — that reads
    // as "first frame" to entrySeekTick and would silently land the
    // replay before the round; with no known start there is no time
    // promise to keep, so the button does nothing rather than lie.
    const start = col.detail?.round?.startTick ?? roundStartTick(rounds, col.round);
    if (start == null) return;
    nav(replayHash(id, {}, { tick: start, back: backToCompare }));
  }

  function openRound(col) {
    nav(buildHash(`/match/${id}/round/${col.round}`, { back: backToCompare }));
  }

  function utilSummary(col) {
    if (col.utils.length === 0) return 'none';
    const dmg = col.utils.reduce((a, u) => a + (u.damage || 0), 0);
    const flash = col.utils.reduce((a, u) => a + (u.flashMsTotal || 0), 0);
    return `${col.utils.length} nade${col.utils.length === 1 ? '' : 's'} · ${dmg} dmg · ${fmtMs(flash)} flash`;
  }

  const gridStyle = $derived(
    cols.length > 0 ? `grid-template-columns: repeat(${cols.length}, minmax(240px, 1fr));` : '',
  );
</script>

<div class="view">
  <header class="view-header">
    <button class="btn" onclick={() => nav(backHash())}><span class="codicon codicon-arrow-left"></span> Back</button>
    <h1>Compare rounds</h1>
    <div class="spacer"></div>
    {#if sel}
      <span class="muted">{sel.rounds.length} rounds selected</span>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !sel}
    <section class="panel">
      <p class="muted" role="status">
        No rounds selected. Open the match's <strong>Rounds</strong> tab, tick
        two to four rounds (max 4), then press <strong>Compare</strong>.
      </p>
      <div>
        <button class="btn primary" onclick={() => nav(backHash())}><span class="codicon codicon-arrow-left"></span> Back to match</button>
      </div>
    </section>
  {:else}
    <div class="cmp-grid" style={gridStyle}>
      {#each cols as col (col.round)}
        <section class="cmp-col">
          <h3>
            Round {col.round}
            {#if col.detail}
              <span class="chip side {col.detail.round.winner || 'none'}">
                {col.detail.round.winner ? col.detail.round.winner.toUpperCase() : '—'}
              </span>
            {/if}
            {#if col.cls}
              <span
                class="chip cmp-class"
                title="{col.cls.explanation || 'classified'} (rule v{col.cls.ruleVersion})"
                >{col.cls.label}</span
              >
            {/if}
          </h3>

          {#if !col.detail}
            <p class="muted" role="status">Round not found.</p>
          {:else}
            <div>
              <p class="section-title cmp-sec-t">Economy</p>
              <table class="data-table mini">
                <thead>
                  <tr>
                    <th scope="col"></th>
                    <th scope="col" class="num">Equip</th>
                    <th scope="col" class="num">Money</th>
                    <th scope="col" class="num">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><span class="chip side ct">CT</span></td>
                    <td class="num">{col.econ ? col.econ.equipCT : col.detail.round.equipCT}</td>
                    <td class="num">{col.econ ? fmtInt(col.econ.moneyCT) : '—'}</td>
                    <td class="num">{col.econ ? fmtInt(col.econ.spentCT) : '—'}</td>
                  </tr>
                  <tr>
                    <td><span class="chip side t">T</span></td>
                    <td class="num">{col.econ ? col.econ.equipT : col.detail.round.equipT}</td>
                    <td class="num">{col.econ ? fmtInt(col.econ.moneyT) : '—'}</td>
                    <td class="num">{col.econ ? fmtInt(col.econ.spentT) : '—'}</td>
                  </tr>
                </tbody>
              </table>
              {#if col.econ}
                <p class="muted cmp-note">
                  buy CT <span class="chip cmp-class">{col.econ.classCT || 'unknown'}</span>
                  · T <span class="chip cmp-class">{col.econ.classT || 'unknown'}</span>
                  · {fmtDuration(col.detail.round.durationS)}
                </p>
              {:else}
                <p class="muted cmp-note">{fmtDuration(col.detail.round.durationS)}</p>
              {/if}
            </div>

            <div>
              <p class="section-title cmp-sec-t">Loadout summary</p>
              <ul class="cmp-list">
                <li><span class="muted">Kills</span> <strong>{col.detail.round.kills}</strong></li>
                <li>
                  <span class="muted">First blood</span>
                  <span>
                    {#if col.firstBlood}
                      <ProfileLink
                        steam={col.firstBlood.killSteam}
                        name={col.firstBlood.kill}
                        {nav}
                        cls={playerRoundCls(
                          col.round,
                          col.firstBlood.killSteam,
                          col.firstBlood.kill,
                        )}
                        title="Open {col.firstBlood.kill} profile"
                      />
                      killed
                      <ProfileLink
                        steam={col.firstBlood.deathSteam}
                        name={col.firstBlood.death}
                        {nav}
                        cls={playerRoundCls(
                          col.round,
                          col.firstBlood.deathSteam,
                          col.firstBlood.death,
                        )}
                        title="Open {col.firstBlood.death} profile"
                      />
                    {:else}
                      —
                    {/if}
                  </span>
                </li>
                <li>
                  <span class="muted">Bomb site</span>
                  <strong>{col.detail.round.bombSite || '—'}</strong>
                </li>
                <li>
                  <span class="muted">MVP</span>
                  {#if col.detail.round.mvpName}
                    <ProfileLink
                      steam={col.detail.round.mvp}
                      name={col.detail.round.mvpName}
                      {nav}
                      cls={playerRoundCls(
                        col.round,
                        col.detail.round.mvp,
                        col.detail.round.mvpName,
                      )}
                      title="Open {col.detail.round.mvpName} profile"
                    />
                  {:else}
                    —
                  {/if}
                </li>
              </ul>
            </div>

            <div>
              <p class="section-title cmp-sec-t">Utility</p>
              <p class="muted cmp-note">{utilSummary(col)}</p>
              {#if col.utils.length > 0}
                <ul class="cmp-list">
                  {#each col.utils as u, i (i)}
                    <li>
                      <span class="chip">{u.kind}</span>
                      <ProfileLink
                        steam={u.thrower}
                        name={u.throwerName || u.thrower}
                        {nav}
                        cls={playerRoundCls(col.round, u.thrower, u.throwerName)}
                        title="Open {u.throwerName || u.thrower} profile"
                      />
                      <span class="muted">
                        {u.damage > 0 ? `${u.damage} dmg` : ''}
                        {u.flashMsTotal > 0 ? ` · ${fmtMs(u.flashMsTotal)} flash` : ''}
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>

            <div>
              <p class="section-title cmp-sec-t">Event sequence {col.seq.length >= SEQ_LIMIT ? `(first ${SEQ_LIMIT})` : ''}</p>
              <ol class="cmp-events">
                {#each col.seq.map(toLandmark).filter(Boolean) as row (row.key)}
                  <LandmarkRow
                    {row}
                    {nav}
                    compact={true}
                    onselect={openEvent}
                    onseek={openEvent}
                  />
                {:else}
                  <li class="muted">No events.</li>
                {/each}
              </ol>
            </div>

            <div class="toolbar cmp-actions">
              <button
                class="btn small"
                title="Replay from the round start ({fmtTickSeconds(col.detail.round.startTick, tickRate)})"
                onclick={() => replayStart(col)}
              ><span class="codicon codicon-play"></span> Replay start</button>
              <button class="btn small" onclick={() => openRound(col)}>Round detail</button>
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>
