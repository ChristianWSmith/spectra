<script>
  import { openReplay, matchPath } from '../../builtinhelpers.js';
  import { sideSwitchesOf } from '../../builtinhelpers.js';
  import EmptyNote from '../../components/EmptyNote.svelte';
  import { roundSideClassOf, namesOf, rosterOf } from '../../builtinhelpers.js';
  import { openRow } from '../../keys.js';
  import { whileCurrent } from '../../current.js';
  import * as S from '../../strings/index.js';
  import {
    SQL_ROSTER,
    SQL_TEAMS,
    SQL_SWITCHES,
    SQL_ROUNDS,
    SQL_MATCH_TICK_RATE,
    SQL_ROUND_MVP_REASON,
    SQL_ROUND_KILLS,
    SQL_ROUND_BOMBS,
    SQL_ROUND_ECONOMY,
    SQL_ROUND_SIDE_CLASSES,
    SQL_ROUND_CHAT,
    fill,
    roundLabel,
    fmtDuration,
    roundOf,
  } from './panelhelpers.js';
  import WinnerCell from '../../components/WinnerCell.svelte';
  import ProfileLink from '../../components/ProfileLink.svelte';
  import EmptyTableRow from '../../components/EmptyTableRow.svelte';
  import {
    DASH,
    isSteam,
    separatorFlags,
    roundWinnerName,
    openPlayer,
    roundClock,
    entryLoopAround,
    hashOf,
    roundsByNumber,
    scoreThrough,
    sideAtRound,
    chatClock,
    chatTag,
    fmtInt,
  } from '../../builtinhelpers.js';

  const COPY = Object.freeze({
    colWatch: S.match.colWatch,
    colWinner: S.match.colWinner,
    colReason: S.match.colReason,
    colDuration: S.match.colDuration,
    colSite: S.match.colSite,
    colMvp: S.match.colMvp,
    firstBloodLabel: S.match.firstBloodLabel,
    colKills: S.match.colKills,
    watchRoundTitle: S.match.watchRoundTitle,
    watchRoundAria: S.match.watchRoundAria,
    openProfile: S.match.openProfile,
    killedVerb: S.match.killedVerb,
    roundDetailLoading: S.match.roundDetailLoading,
    roundDetailFailed: S.match.roundDetailFailed,
    roundDetailShow: S.match.roundDetailShow,
    roundDetailHide: S.match.roundDetailHide,
  });

  // Match rounds: one row per round, in round order. The ▶ watches the round in the replay
  // from its own start, its span looped, back to this tab. A click on the row (or Enter or
  // Space on it) expands it in place to the round's details: the kill feed, the bomb
  // timeline, the economy by side and the round's chat. The details of every round are read
  // in the background once the rounds are, so an expansion opens without a loading flash.
  // expandRound: the round the URL asks open (?round=N), from the economy links.
  // loopSecs: the loop length a replay entry stamps (Settings → Replay, read by the tabs).
  let { spectra, context, back = '', expandRound = null, loopSecs = 5 } = $props();
  // Kill-event flags: the event column, its chip code and its tooltip.
  const FLAGS = [
    ['headshot', S.match.flagHS, S.match.flagHSTitle],
    ['wallbang', S.match.flagWB, S.match.flagWBTitle],
    ['noscope', S.match.flagNS, S.match.flagNSTitle],
    ['through_smoke', S.match.flagSMK, S.match.flagSMKTitle],
    ['attacker_blind', S.match.flagBLD, S.match.flagBLDTitle],
    ['assisted_flash', S.match.flagAFL, S.match.flagAFLTitle],
  ];
  const BOMB_LABEL = Object.freeze({
    bomb_plant: S.match.bombPlanted,
    bomb_defuse: S.match.bombDefused,
    bomb_explode: S.match.bombExploded,
    bomb_drop: S.match.bombDropped,
    bomb_pickup: S.match.bombPickedUp,
  });

  let data = $state(null);
  // Per-round details, keyed by round number: 'loading', {failed: true}, or the loaded detail.
  let details = $state({});
  // The expanded rounds, in the order they were opened.
  let open = $state([]);
  let seededFor = null;

  async function load(matchId) {
    if (matchId == null) return null;
    const [rounds, roster, teamRows, switchRows] = await Promise.all([
      spectra.query(SQL_ROUNDS),
      spectra.query(SQL_ROSTER),
      spectra.query(SQL_TEAMS),
      spectra.query(SQL_SWITCHES),
    ]);
    const list = rounds.rows.map(roundOf);
    return {
      id: matchId,
      rounds: list,
      seps: separatorFlags(list),
      roster: roster.rows,
      switches: sideSwitchesOf(switchRows),
      teams: namesOf(teamRows.rows, rosterOf(roster.rows)),
    };
  }

  $effect(() =>
    whileCurrent((isCurrent) => {
      const matchId = context.matchId;
      details = {};
      open = [];
      seededFor = null;
      load(matchId).then(
        (d) => {
          if (!isCurrent()) return;
          data = d;
          prewarm(d);
        },
        // A failed read is reported into this frame (guard routes the error to it).
        (e) => spectra.report(e),
      );
    }),
  );

  // Open the round the URL asks for, once per request (a user's own collapse stands).
  $effect(() => {
    const want = expandRound == null || expandRound === '' ? null : Number(expandRound);
    if (want === seededFor || !data) return;
    seededFor = want;
    if (want != null && data.rounds.some((x) => x.number === want)) {
      open = [want];
    }
  });

  function toggleRound(n) {
    if (open.includes(n)) {
      open = open.filter((x) => x !== n);
      return;
    }
    open = [...open, n];
    ensureDetail(n);
  }

  // The round's detail reads: the same SQL the other match tabs use, scoped to this round.
  async function loadDetail(matchId, n) {
    const bind = { match_id: matchId, round: n };
    const [mrows, mvp, kills, bombs, econ, sides, chat] = await Promise.all([
      spectra.query(SQL_MATCH_TICK_RATE, { match_id: matchId }),
      spectra.query(SQL_ROUND_MVP_REASON, bind),
      spectra.query(SQL_ROUND_KILLS, bind),
      spectra.query(SQL_ROUND_BOMBS, bind),
      spectra.query(SQL_ROUND_ECONOMY, bind),
      spectra.query(SQL_ROUND_SIDE_CLASSES, bind),
      spectra.query(SQL_ROUND_CHAT, bind),
    ]);
    const classOf = new Map(sides.rows.map((r) => [r[0], { cls: r[1] || '', why: r[2] || '' }]));
    return {
      tickRate: Number((mrows.rows[0] || [0])[0]) || 64,
      mvpReason: (mvp.rows[0] || [''])[0] || '',
      kills: kills.rows.map((r) => ({
        id: r[0],
        tick: Number(r[1]),
        attacker: r[2] || '',
        attackerName: r[3] || '',
        victim: r[4] || '',
        victimName: r[5] || '',
        weapon: r[6] || '',
        flags: Object.fromEntries(FLAGS.map(([col], i) => [col, Boolean(r[7 + i])])),
      })),
      bombs: bombs.rows.map((r) => ({
        id: r[0],
        tick: Number(r[1]),
        kind: r[2],
        attacker: r[3] || '',
        attackerName: r[4] || '',
        site: r[5] || '',
      })),
      economy: econ.rows.map((r) => ({
        side: r[0],
        equip: r[1],
        moneyAvg: Number(r[3]) > 0 ? Math.round(Number(r[2]) / Number(r[3])) : null,
        cls: (classOf.get(r[0]) || {}).cls || '',
        why: (classOf.get(r[0]) || {}).why || '',
      })),
      chat: chat.rows.map((r) => ({
        id: r[0],
        tick: Number(r[1]),
        round: Number(r[2]),
        steamId: r[3] || '',
        name: r[4] || '',
        text: r[5] || '',
        channel: r[6] || '',
      })),
    };
  }

  // Read one round's details (once); resolves when it has landed or failed.
  function ensureDetail(n) {
    if (!data || details[n]) return Promise.resolve();
    const matchId = data.id;
    details = { ...details, [n]: 'loading' };
    return loadDetail(matchId, n).then(
      (d) => {
        if (data && data.id === matchId) details = { ...details, [n]: d };
      },
      (e) => {
        if (data && data.id === matchId) details = { ...details, [n]: { failed: true } };
        spectra.report(e);
      },
    );
  }

  // Warm every round's details, one read at a time, so an expansion is already there.
  async function prewarm(d) {
    for (const r of d.rounds) {
      if (!data || data.id !== d.id) return;
      await ensureDetail(r.number);
    }
  }

  const backTo = () => back || matchPath(data ? data.id : context.matchId);

  // A player's colour in a round, from this match's roster, rounds and switches.
  const playerRoundCls = roundSideClassOf(() => ({
    players: data.roster.map((r) => ({ steamId: r[0], name: r[1], side: r[2] })),
    sideSwitches: data.switches,
    rounds: data.rounds,
  }));
  function winnerName(d, r) {
    return roundWinnerName(d.rounds, d.switches, r.number, r.winner, d.teams);
  }

  // The replay at the round's start, its span looped, back to this tab.
  function watchRound(n) {
    const r = data.rounds.find((x) => x.number === n);
    const start = r && Number.isFinite(r.startTick) ? r.startTick : null;
    const end = r && Number.isFinite(r.endTick) ? r.endTick : null;
    const loop = start != null && end != null && start >= 0 && start <= end ? start + ',' + end : undefined;
    spectra.navigate({ path: '/replay/' + data.id, query: { tick: start, loop, back: backTo() } });
  }

  // Round-detail helpers: a name's side colour in this round, the team behind a side of this
  // round, the clock of an event, and the replay entry an event links to.
  function playerCls(n, steam, name) {
    return playerRoundCls(n, steam, name);
  }
  function teamForSide(n, side) {
    for (const k of ['ct', 't']) {
      if (sideAtRound(data.rounds, data.switches, n, k) === side) return data.teams[k] || side.toUpperCase();
    }
    return side.toUpperCase();
  }
  function watchEvent(tickRate, tick, follow) {
    openReplay(spectra, data.id, {
      tick,
      loop: entryLoopAround(tick, tickRate, loopSecs),
      follow: follow || undefined,
      back,
    });
  }
  // The side a chat speaker held this round (team chat tags it); '' when unknown.
  function sideOfSpeaker(n, c) {
    const k = playerCls(n, c.steamId, c.name);
    return k === 'side-ct' ? 'ct' : k === 'side-t' ? 't' : '';
  }
</script>

{#snippet playerLink(steam, name, cls)}
  <ProfileLink {steam} {name} nav={spectra.navigate} variant="name-link" {cls} />
{/snippet}

{#snippet roundDetail(n)}
  {@const d = details[n]}
  {#if !d || d === 'loading'}
    <EmptyNote>{COPY.roundDetailLoading}</EmptyNote>
  {:else if d.failed}
    <EmptyNote>{COPY.roundDetailFailed}</EmptyNote>
  {:else}
    {@const info = data.rounds.find((x) => x.number === n)}
    {@const rbn = roundsByNumber(data.rounds)}
    {@const score = scoreThrough(data.rounds, n)}
    {@const clock = (tick) => roundClock(tick, rbn.get(n), d.tickRate)}
    <div class="round-detail">
      <p class="muted round-detail-meta">
        {fmtDuration(info.durationS)}
        {S.match.siteMeta}
        {info.bombSite || DASH}
        {S.match.mvpMeta}
        {#if info.mvpName}
          {@render playerLink(info.mvp, info.mvpName, playerCls(n, info.mvp, info.mvpName))}
        {:else}
          {DASH}
        {/if}
        {#if d.mvpReason}({d.mvpReason}){/if}
        <span class="round-detail-score" title={S.match.scoreCountedTitle}>
          {S.match.scoreLabel}
          {#if n >= 1}<span class="ct">{score.ct}</span>–<span class="t">{score.t}</span>{:else}{DASH}{/if}
        </span>
      </p>
      <div class="round-detail-grid">
        <div class="round-detail-col">
          <section>
            <h3>{S.match.colKills} <span class="muted">({d.kills.length})</span></h3>
            {#if d.kills.length === 0}
              <EmptyNote>{S.match.noKills}</EmptyNote>
            {:else}
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
                      <th scope="col">{S.match.colTime}</th>
                      <th scope="col">{S.match.colKiller}</th>
                      <th scope="col">{S.match.colVictim}</th>
                      <th scope="col">{S.match.colWeapon}</th>
                      <th scope="col">{S.match.colFlags}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each d.kills as k (k.id)}
                      <tr>
                        <td>
                          <button
                            class="btn small ghost"
                            title={k.attacker
                              ? fill(S.match.watchKillFollow, { name: k.attackerName || k.attacker })
                              : S.match.watchKillIdle}
                            aria-label={k.attacker
                              ? fill(S.match.watchKillFollow, { name: k.attackerName || k.attacker })
                              : S.match.watchKillIdle}
                            onclick={() => watchEvent(d.tickRate, k.tick, k.attacker)}
                          >
                            <span class="codicon codicon-play" aria-hidden="true"></span>
                          </button>
                        </td>
                        <td class="mono" title={fill(S.match.tickTitle, { n: k.tick })}>{clock(k.tick)}</td>
                        <td>
                          {@render playerLink(
                            k.attacker,
                            k.attackerName || k.attacker,
                            playerCls(n, k.attacker, k.attackerName),
                          )}
                        </td>
                        <td>
                          {@render playerLink(
                            k.victim,
                            k.victimName || k.victim,
                            playerCls(n, k.victim, k.victimName),
                          )}
                        </td>
                        <td class="mono">{k.weapon || DASH}</td>
                        <td>
                          {#each FLAGS as [col, code, title] (code)}{#if k.flags[col]}<span
                                class="chip flag"
                                {title}
                              >
                                {code}
                              </span>{/if}{/each}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </section>

          <section>
            <h3>{S.match.bombHeading}</h3>
            {#if d.bombs.length === 0}
              <EmptyNote>{S.match.noBombEvents}</EmptyNote>
            {:else}
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
                      <th scope="col">{S.match.colTime}</th>
                      <th scope="col">{S.match.colEvent}</th>
                      <th scope="col">{S.match.colPlayer}</th>
                      <th scope="col">{S.match.colSite}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each d.bombs as b (b.id)}
                      <tr>
                        <td>
                          <button
                            class="btn small ghost"
                            title={b.attacker
                              ? fill(S.match.watchBombFollow, { name: b.attackerName || b.attacker })
                              : S.match.watchKillIdle}
                            aria-label={b.attacker
                              ? fill(S.match.watchBombFollow, { name: b.attackerName || b.attacker })
                              : S.match.watchKillIdle}
                            onclick={() => watchEvent(d.tickRate, b.tick, b.attacker)}
                          >
                            <span class="codicon codicon-play" aria-hidden="true"></span>
                          </button>
                        </td>
                        <td class="mono" title={fill(S.match.tickTitle, { n: b.tick })}>{clock(b.tick)}</td>
                        <td>{BOMB_LABEL[b.kind] || b.kind}</td>
                        <td>
                          {@render playerLink(
                            b.attacker,
                            b.attackerName || b.attacker,
                            playerCls(n, b.attacker, b.attackerName),
                          )}
                        </td>
                        <td>{b.site || DASH}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </section>
        </div>

        <div class="round-detail-col">
          <section>
            <h3>{S.match.economyHeading}</h3>
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{S.match.colSide}</th>
                  <th scope="col" title={S.match.buyClassTitle}>{S.match.colClass}</th>
                  <th scope="col" class="num">{S.match.colEquip}</th>
                  <th scope="col" class="num">{S.match.colMoney}</th>
                </tr>
              </thead>
              <tbody>
                {#each d.economy as e (e.side)}
                  <tr>
                    <td><span class="chip side {e.side}">{teamForSide(n, e.side)}</span></td>
                    <td>
                      <span
                        class="chip cmp-class {e.cls || 'unknown'}"
                        title={e.why || S.economy.noExplanation}
                      >
                        {e.cls || 'unknown'}
                      </span>
                    </td>
                    <td class="num">{fmtInt(e.equip)}</td>
                    <td class="num">{fmtInt(e.moneyAvg)}</td>
                  </tr>
                {:else}
                  <EmptyTableRow colspan={4} text={S.match.noEconomySamples} />
                {/each}
              </tbody>
            </table>
          </section>

          <section>
            <h3>{S.match.roundChatHeading}</h3>
            {#if d.chat.length === 0}
              <EmptyNote>{S.match.noChat}</EmptyNote>
            {:else}
              <ul class="chat-list">
                {#each d.chat as c (c.id)}
                  {@const side = sideOfSpeaker(n, c)}
                  <li>
                    <span class="mono muted" title={fill(S.match.tickTitle, { n: c.tick })}>
                      {chatClock(c, rbn, d.tickRate)}
                    </span>
                    <strong>
                      {@render playerLink(
                        c.steamId,
                        c.name,
                        playerCls(n, c.steamId, c.name),
                      )}{#if chatTag(c.channel, side)}{' '}{chatTag(c.channel, side)}{/if}
                    </strong>
                    <span>: {c.text}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#if data}
  <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">{COPY.colWatch}</span></th>
          <th scope="col" class="num">{S.match.colRd}</th>
          <th scope="col">{COPY.colWinner}</th>
          <th scope="col">{COPY.colReason}</th>
          <th scope="col" class="num">{COPY.colDuration}</th>
          <th scope="col">{COPY.colSite}</th>
          <th scope="col">{COPY.colMvp}</th>
          <th scope="col">{COPY.firstBloodLabel}</th>
          <th scope="col" class="num">{COPY.colKills}</th>
        </tr>
      </thead>
      <tbody>
        {#each data.rounds as r, ri (r.number)}
          <tr
            class="clickable"
            class:split-before={ri > 0 && data.seps[ri - 1]}
            tabindex="0"
            aria-expanded={open.includes(r.number)}
            {...openRow(() => toggleRound(r.number), { ignore: 'input, button, a' })}
          >
            <td>
              <button
                class="btn small ghost"
                title={fill(COPY.watchRoundTitle, { round: r.number })}
                aria-label={fill(COPY.watchRoundAria, { round: r.number })}
                onclick={() => watchRound(r.number)}
              >
                <span class="codicon codicon-play"></span>
              </button>
            </td>
            <td class="num">{roundLabel(r.number)}</td>
            <td><WinnerCell name={winnerName(data, r)} winner={r.winner} /></td>
            <td>{r.reason || DASH}</td>
            <td class="num">{fmtDuration(r.durationS)}</td>
            <td>{r.bombSite || DASH}</td>
            <td>
              {#if r.mvpName}
                {@render playerLink(r.mvp, r.mvpName, playerCls(r.number, r.mvp, r.mvpName))}
              {:else}
                {DASH}
              {/if}
            </td>
            <td>
              {#if r.firstKillName && r.firstDeathName}
                {@render playerLink(
                  r.firstKillSteam,
                  r.firstKillName,
                  playerRoundCls(r.number, r.firstKillSteam, r.firstKillName),
                )}
                {COPY.killedVerb}
                {@render playerLink(
                  r.firstDeathSteam,
                  r.firstDeathName,
                  playerRoundCls(r.number, r.firstDeathSteam, r.firstDeathName),
                )}
              {:else}
                {DASH}
              {/if}
            </td>
            <td class="num">{r.kills}</td>
          </tr>
          {#if open.includes(r.number)}
            <tr class="round-expand">
              <td colspan="9">{@render roundDetail(r.number)}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}
