<script>
  import { openMatch, indexBy, DASH } from '../../builtinhelpers.js';
  import { whenCurrent, whileCurrent } from '../../current.js';
  import { openRow } from '../../keys.js';
  import ErrorBanner from '../../components/ErrorBanner.svelte';
  // Match history (builtin profile panel), most recent first. The match rows
  // (import date, map, result, score, starting side) are the player's recorded
  // history. The K/D/A, ADR and KAST cells are stored match-scope metrics read
  // for the context's player in ONE read: metricsByMatch takes the series of
  // every metric (one call) and each match's compute state (one call per row).
  import { errText } from '../../services.js';
  import { liveMetrics } from '../../metricslive.svelte.js';
  import { metricsByMatch } from '../../componentruntime/reads.js';
  import { fmt1, fmtDate, fmtInt, fmtMetric } from '../../fmt.js';
  import { teamStartClass } from '../../teams.js';
  import MetricCell from '../../components/MetricCell.svelte';

  import { loadProfile, readCell } from './shared.js';
  import * as S from '../../strings/index.js';

  let { spectra, context } = $props();
  const steamId = $derived(context.steamId);

  // The per-match metrics the row's stored cells read.
  const HALVES = ['kills', 'deaths', 'assists'];
  const METRICS = [...HALVES, 'adr', 'kast'];

  let history = $state([]);
  let defs = $state(new Map());
  let matchReads = $state(new Map()); // matchId → Map(metric name → MetricRead)
  const sweep = liveMetrics();
  let loadError = $state('');

  $effect(() =>
    whileCurrent((isCurrent) => {
      sweep.reload;
      const sid = steamId;
      matchReads = new Map();
      loadError = '';
      if (!sid) return;
      loadProfile(spectra, sid)
        .then(async ([rows, profile]) => {
          if (!isCurrent()) return;
          const catalog = indexBy(rows || [], 'name');
          defs = catalog;
          const rowsOut = profile ? profile.history || [] : [];
          history = rowsOut;
          const names = METRICS.filter((n) => catalog.has(n));
          const byMatch = await metricsByMatch(
            sid,
            names,
            rowsOut.map((h) => h.matchId),
          );
          if (isCurrent()) matchReads = byMatch;
        })
        .catch(
          whenCurrent(isCurrent, (e) => {
            loadError = errText(e);
          }),
        );
    }),
  );

  // One stored cell of a match: the metric's own presentation.
  function stored(h, name) {
    const read = matchReads.get(h.matchId)?.get(name);
    const def = defs.get(name);
    return readCell(def, read, sweep.progress);
  }

  // The K/D/A cell: each half is its own number; the first half that is not a
  // value sets the cell's title (the honest reason).
  function kda(h) {
    const parts = HALVES.map((n) => stored(h, n));
    const gap = parts.find((p) => p.kind !== 'value');
    return { parts, title: gap ? gap.title : '' };
  }

  const halfText = (p) => (p.kind === 'value' ? fmtInt(p.value) : DASH);
</script>

{#if loadError}
  <ErrorBanner>{loadError}</ErrorBanner>
{/if}
<div>
  <h2>{S.profiles.matchHistoryPrefix}<span class="muted">{S.profiles.mostRecentFirst}</span></h2>
  <div class="table-scroll">
    <table class="data-table">
      <thead>
        <tr>
          <th scope="col" title={S.profiles.importedTitle}>{S.profiles.thImported}</th>
          <th scope="col">{S.profiles.thMap}</th>
          <th scope="col">{S.profiles.thResult}</th>
          <th scope="col" class="num">{S.profiles.thScore}</th>
          <th scope="col">{S.profiles.thStartingSide}</th>
          <th scope="col" class="num">{S.profiles.colKdaHead}</th>
          <th scope="col" class="num">{S.profiles.thAdr}</th>
          <th scope="col" class="num">{S.profiles.thKastPct}</th>
        </tr>
      </thead>
      <tbody>
        {#each history as h, i (i)}
          {@const k = kda(h)}
          {@const adr = stored(h, 'adr')}
          {@const kast = stored(h, 'kast')}
          <tr
            class="clickable"
            tabindex="0"
            title={S.fill(S.profiles.openMatchRow, { id: h.matchId })}
            {...openRow(() => openMatch(spectra, h.matchId), { enterOnly: true })}
          >
            <td>{fmtDate(h.extractedAt)}</td>
            <td>{h.map || DASH}</td>
            <td>
              <span class="chip status {h.win ? 'ok' : 'bad'}">
                {h.win ? S.profiles.winLetter : S.profiles.lossLetter}
              </span>
            </td>
            <td class="num">{h.scoreCT}–{h.scoreT}</td>
            <td>
              <!-- h.startSide is already the START side (identity, not a live
                   side): teamStartClass with zero switches is the no-flip form.
                   NEVER `.chip side` here: that paints the side-AT-TIME color. -->
              <span class="chip {teamStartClass(h.startSide, 0)}" title={S.profiles.startSideTitle}>
                {(h.startSide || DASH).toUpperCase()}
              </span>
            </td>
            <td class="num" title={k.title}>
              {halfText(k.parts[0])}/{halfText(k.parts[1])}/{halfText(k.parts[2])}
            </td>
            <td class="num" title={adr.kind === 'chip' ? adr.title : ''}>
              <MetricCell pres={adr} format={(v) => fmt1(v)} chip={sweep.chip(defs.get('adr'))} />
            </td>
            <td class="num" title={kast.kind === 'chip' ? kast.title : ''}>
              <MetricCell
                pres={kast}
                format={(v) => fmtMetric(v, 'percent')}
                chip={sweep.chip(defs.get('kast'))}
              />
            </td>
          </tr>
        {:else}
          <tr><td colspan="8" class="muted">{S.profiles.noHistory}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
