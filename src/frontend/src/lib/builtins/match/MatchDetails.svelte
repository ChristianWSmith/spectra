<script>
  import * as S from '../../strings/index.js';
  import { SQL_FACTS, numOf, fmtBytes, parseStamp, fmtDate } from './panelhelpers.js';
  import { DASH, fmtInt, fmt1 } from '../../builtinhelpers.js';
  const DETAILS_COPY = Object.freeze({
    keyFacts: S.match.keyFacts,
    factServer: S.match.factServer,
    factTickrate: S.match.factTickrate,
    factFrames: S.match.factFrames,
    factSize: S.match.factSize,
    factImported: S.match.factImported,
    factParser: S.match.factParser,
    factWarnings: S.match.factWarnings,
    factSource: S.match.factSource,
  });

  // Match details: the key facts of the match (server, tickrate, frames, size,
  // import time, parser, warnings, source file). A NULL or missing stored value
  // shows a dash.
  let { spectra, context } = $props();
  const COPY = DETAILS_COPY;

  let facts = $state(null);

  async function load(matchId) {
    if (matchId == null) return null;
    const res = await spectra.query(SQL_FACTS);
    const r = res.rows[0];
    if (!r) return null;
    return {
      server: r[0] || '',
      tickRate: numOf(r[1]),
      frames: numOf(r[2]),
      size: numOf(r[3]),
      extractedAt: parseStamp(r[4]),
      parser: r[5] || '',
      path: r[6] || '',
      warnings: numOf(r[7]),
    };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (f) => {
        if (live) facts = f;
      },
      // A failed read is reported into this frame (guard routes the error to it).
      (e) => spectra.guard(() => {
        throw e;
      })(),
    );
    return () => {
      live = false;
    };
  });
</script>

<section class="panel" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <span class="builtin-throbber" aria-hidden="true"></span>
  {#if facts}
      <h2>{COPY.keyFacts}</h2>
      <dl class="facts">
        <div><dt>{COPY.factServer}</dt><dd>{facts.server || DASH}</dd></div>
        <div><dt>{COPY.factTickrate}</dt><dd>{Number.isFinite(facts.tickRate) ? fmt1(facts.tickRate) + S.match.unitHz : DASH}</dd></div>
        <div><dt>{COPY.factFrames}</dt><dd class="num">{fmtInt(facts.frames)}</dd></div>
        <div><dt>{COPY.factSize}</dt><dd>{fmtBytes(facts.size)}</dd></div>
        <div><dt>{COPY.factImported}</dt><dd>{fmtDate(facts.extractedAt)}</dd></div>
        <div><dt>{COPY.factParser}</dt><dd class="mono">{facts.parser || DASH}</dd></div>
        <div><dt>{COPY.factWarnings}</dt><dd>{Number.isFinite(facts.warnings) ? facts.warnings : DASH}</dd></div>
        <div class="fact-wide"><dt>{COPY.factSource}</dt><dd class="mono">{facts.path || DASH}</dd></div>
      </dl>
  {/if}
</section>
