<script>
  // Side-by-side round comparison. Reads the hand-off Match's Rounds tab
  // writes (lib/handoff.js: HANDOFF_KEYS.compareRounds =
  // {matchId: number, rounds: number[]}) — read + cleared once on init;
  // anything else → hint + back.
  //
  // Ghost overlay (two trail sets over the M2 sidecar) is intentionally NOT
  // implemented here — it needs sidecar streaming + mapxform wiring and is
  // deferred (documented in the wave report).
  import {
    getRoundDetail,
    getEvents,
    getEconomy,
    getUtility,
    getRoundClasses,
    getMatch,
    setPendingSeek,
    errText,
  } from '../services.js';
  import { fmtDuration, fmtInt, fmtTickSeconds, fmtMs } from '../fmt.js';
  import { HANDOFF_KEYS, takeHandoff } from '../handoff.js';

  let { id = 0, nav = () => {} } = $props();

  const SEQ_LIMIT = 30;

  // Read-once hand-off from Match's Rounds tab (lib/handoff.js): a
  // missing, foreign-match or malformed payload all land on the hint + back
  // path below.
  function readSelection() {
    const p = takeHandoff(HANDOFF_KEYS.compareRounds);
    if (!p || p.matchId !== id || !Array.isArray(p.rounds)) return null;
    const rounds = p.rounds.filter((n) => Number.isInteger(n)).slice(0, 4);
    return rounds.length >= 2 ? { matchId: id, rounds } : null;
  }

  let sel = $state(readSelection());
  let cols = $state([]);
  let tickRate = $state(64);
  let error = $state('');

  $effect(() => {
    if (!sel) return;
    let live = true;
    const wanted = sel.rounds;
    Promise.all([
      getMatch(id),
      getEconomy(id),
      getUtility(id),
      getRoundClasses(id),
      ...wanted.map((r) => getRoundDetail(id, r)),
      ...wanted.map((r) => getEvents({ matchId: id, round: r, offset: 0, limit: SEQ_LIMIT })),
    ])
      .then((all) => {
        if (!live) return;
        const [m, econRows, utilRows, classRows, ...rest] = all;
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        const details = rest.slice(0, wanted.length);
        const seqs = rest.slice(wanted.length);
        const econBy = new Map((econRows || []).map((e) => [e.round, e]));
        const classBy = new Map((classRows || []).map((c) => [c.round, c]));
        const utils = utilRows || [];
        cols = wanted.map((r, i) => {
          const detail = details[i];
          return {
            round: r,
            detail,
            seq: (seqs[i] || []).slice(0, SEQ_LIMIT),
            econ: econBy.get(r) || null,
            cls: classBy.get(r) || null,
            utils: utils.filter((u) => u.round === r),
            firstBlood: detail?.round?.firstKillName
              ? `${detail.round.firstKillName} killed ${detail.round.firstDeathName}`
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

  function replayStart(col) {
    const tick = col.detail?.round?.startTick || 0;
    setPendingSeek({ tick });
    nav(`/replay/${id}`);
  }

  function openRound(col) {
    nav(`/match/${id}/round/${col.round}`);
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
    <button class="btn" onclick={() => nav(`/match/${id}`)}><span class="codicon codicon-arrow-left"></span> Match</button>
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
        <button class="btn primary" onclick={() => nav(`/match/${id}`)}><span class="codicon codicon-arrow-left"></span> Back to match</button>
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
                  {col.firstBlood || '—'}
                </li>
                <li>
                  <span class="muted">Bomb site</span>
                  <strong>{col.detail.round.bombSite || '—'}</strong>
                </li>
                <li>
                  <span class="muted">MVP</span>
                  {col.detail.round.mvpName || '—'}
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
                      <span>{u.throwerName || '—'}</span>
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
                {#each col.seq as e (e.id)}
                  <li>
                    <span class="mono muted">{e.tick}</span>
                    <span class="chip kind">{e.kind}</span>
                    <span class="cmp-ev-names">
                      {#if e.kind === 'kill'}
                        {e.attackerName || '—'} → {e.victimName || '—'}
                      {:else}
                        {e.attackerName || e.victimName || ''}
                      {/if}
                    </span>
                  </li>
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
