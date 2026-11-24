<script>
  import LoadBox from '../../components/LoadBox.svelte';
  // Match details: one panel with the match's facts. The key facts (server, tickrate,
  // frames, size, import time, parser, warnings, source file) and the voice and demo
  // copy state come first; then the import details (the reproducibility facts and the
  // encrypted-message note) and the advanced diagnostics (the entity summary). A NULL or
  // missing stored value shows a dash. Every read is through this frame's context.
  import * as S from '../../strings/index.js';
  import { SQL_FACTS, numOf, fmtBytes, parseStamp, fmtDate, fill } from './panelhelpers.js';
  import { DASH, fmtInt, fmt1 } from '../../builtinhelpers.js';
  import { getMatch, getVoicePresence, evictDemoCopy, getProvenance, getEntitySummary, errText } from '../../services.js';
  import StatusChip from '../../components/StatusChip.svelte';

  const COPY = Object.freeze({
    keyFacts: S.match.keyFacts,
    factServer: S.match.factServer,
    factTickrate: S.match.factTickrate,
    factFrames: S.match.factFrames,
    factSize: S.match.factSize,
    factImported: S.match.factImported,
    factParser: S.match.factParser,
    factWarnings: S.match.factWarnings,
    factSource: S.match.factSource,
    factVoice: S.match.factVoice,
    factDemoCopy: S.match.factDemoCopy,
    voiceRecordedTitle: S.match.voiceRecordedTitle,
    voiceRecordedBadge: S.match.voiceRecordedBadge,
    voiceNoneTitle: S.match.voiceNoneTitle,
    voiceNoneBadge: S.match.voiceNoneBadge,
    copyPrefix: S.match.copyPrefix,
    freeCopyTitle: S.match.freeCopyTitle,
    freeing: S.match.freeing,
    freeCopy: S.match.freeCopy,
    copyExternal: S.match.copyExternal,
    copyMissing: S.match.copyMissing,
  });

  let { spectra, context } = $props();

  let facts = $state(null);
  let match = $state(null);
  let voice = $state(null);
  let copyBusy = $state(false);
  let prov = $state(null);
  let provError = $state('');
  let ent = $state(null);
  let entError = $state('');
  // One generation per read: a stale reply (a match switch, a Retry) is dropped.
  let provGen = 0;
  let entGen = 0;

  function parseFacts(r) {
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

  function loadProv(id) {
    const my = ++provGen;
    provError = '';
    // An async arrow turns a synchronous throw into a rejected read: a failed section
    // reports its own error and never takes the other sections down with it.
    spectra
      .track((async () => getProvenance(id))())
      .then((p) => {
        if (my === provGen) prov = p;
      })
      .catch((e) => {
        if (my === provGen) provError = errText(e);
      });
  }

  function loadEnt(id) {
    const my = ++entGen;
    entError = '';
    spectra
      .track((async () => getEntitySummary(id))())
      .then((s) => {
        if (my === entGen) ent = s;
      })
      .catch((e) => {
        if (my === entGen) entError = errText(e);
      });
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    // Each read lands on its own: the stored facts never wait on the match row or the voice read.
    spectra.query(SQL_FACTS).then(
      (res) => {
        if (live) facts = parseFacts(res.rows[0]);
      },
      (e) =>
        spectra.guard(() => {
          throw e;
        })(),
    );
    Promise.all([getMatch(matchId), getVoicePresence(matchId).catch(() => null)]).then(
      ([m, v]) => {
        if (live) {
          match = m;
          voice = v;
        }
      },
      (e) =>
        spectra.guard(() => {
          throw e;
        })(),
    );
    if (matchId) {
      loadProv(matchId);
      loadEnt(matchId);
    }
    return () => {
      live = false;
    };
  });

  async function freeCopy() {
    if (copyBusy || !match) return;
    copyBusy = true;
    try {
      await evictDemoCopy(context.matchId);
      match = await getMatch(context.matchId);
    } catch (e) {
      spectra.guard(() => {
        throw e;
      })();
    } finally {
      copyBusy = false;
    }
  }

  // Encrypted-message note (presence, never content).
  const encNote = $derived.by(() => {
    if (!prov) return '';
    const n = Number(prov.encMessages) || 0;
    if (!n) return '';
    const notes = (prov.notes || []).join(' · ');
    return (
      S.fill(S.library.encryptedNote, { n: fmtInt(n) }) +
      S.library.provPresenceNote +
      (notes ? `${S.library.provNotesPrefix}${notes}` : S.library.provNoDecrypt)
    );
  });
</script>

<div class="match-details">
  <section class="md-sec">
  {#if facts}
    <h2 class="md-head">{COPY.keyFacts}</h2>
    <dl class="facts">
      <div><dt>{COPY.factServer}</dt><dd>{facts.server || DASH}</dd></div>
      <div><dt>{COPY.factTickrate}</dt><dd>{Number.isFinite(facts.tickRate) ? fmt1(facts.tickRate) + S.match.unitHz : DASH}</dd></div>
      <div><dt>{COPY.factFrames}</dt><dd class="num">{fmtInt(facts.frames)}</dd></div>
      <div><dt>{COPY.factSize}</dt><dd>{fmtBytes(facts.size)}</dd></div>
      <div><dt>{COPY.factImported}</dt><dd>{fmtDate(facts.extractedAt)}</dd></div>
      <div><dt>{COPY.factParser}</dt><dd class="mono">{facts.parser || DASH}</dd></div>
      <div><dt>{COPY.factWarnings}</dt><dd>{Number.isFinite(facts.warnings) ? facts.warnings : DASH}</dd></div>
      <div class="fact-wide"><dt>{COPY.factSource}</dt><dd class="mono">{facts.path || DASH}</dd></div>
      {#if match}
      <div>
        <dt>{COPY.factVoice}</dt>
        <dd>
          {#if !voice}
            <span class="muted">{DASH}</span>
          {:else if voice.hasVoice}
            <span class="chip voice-badge busy" title={fill(COPY.voiceRecordedTitle, { n: voice.playerCount })}><span class="codicon codicon-unmute"></span> {fill(COPY.voiceRecordedBadge, { n: voice.playerCount })}</span>
          {:else}
            <span class="chip voice-badge idle" title={COPY.voiceNoneTitle}>{COPY.voiceNoneBadge}</span>
          {/if}
        </dd>
      </div>
      <div class="fact-wide">
        <dt>{COPY.factDemoCopy}</dt>
        <dd>
          {#if match.copyState === 'copied'}
            <span>{COPY.copyPrefix} {fmtBytes(match.size)}</span>
            <button class="btn small" disabled={copyBusy} title={COPY.freeCopyTitle} onclick={freeCopy}>{copyBusy ? COPY.freeing : COPY.freeCopy}</button>
          {:else if match.copyState === 'external'}
            <span class="muted">{COPY.copyExternal}</span>
          {:else if match.copyState === 'missing'}
            <span class="muted">{COPY.copyMissing}</span>
          {:else}
            <span class="muted">{DASH}</span>
          {/if}
        </dd>
      </div>
      {/if}
    </dl>
  {:else}
    <LoadBox tag="div" class="md-hold" busy name="match-details-summary" key=""></LoadBox>
  {/if}
  </section>

  <section class="md-sec">
    <h2 class="md-head">{S.library.importDetails}</h2>
    {#if provError}
      <p class="error" role="alert">
        {provError}
        <button class="btn small" onclick={() => loadProv(context.matchId)}>{S.library.retry}</button>
      </p>
    {:else if !prov}
      <LoadBox tag="div" class="md-hold" busy name="match-details-import" key=""></LoadBox>
    {:else}
      <dl class="facts">
        <div><dt>{S.library.dtParserVersion}</dt><dd class="mono">{prov.parserVersion || '—'}</dd></div>
        <div><dt>{S.library.dtImported}</dt><dd>{fmtDate(parseStamp(prov.extractedAt))}</dd></div>
        <div><dt>{S.library.dtParseTime}</dt><dd class="num">{fmtInt(prov.parseMs)}{S.library.msSuffix}</dd></div>
        <div><dt>{S.library.dtVoiceSampleRate}</dt><dd class="num">{prov.sampleRate ? `${prov.sampleRate}${S.match.unitHz}` : '—'}</dd></div>
        <div><dt>{S.library.dtVoiceChunks}</dt><dd class="num">{fmtInt(prov.voiceChunks)}</dd></div>
        <div><dt>{S.library.dtWarnings}</dt><dd class="num">{fmtInt(prov.warnings)}</dd></div>
        <div><dt>{S.library.dtStatus}</dt><dd><StatusChip status={prov.status} /></dd></div>
      </dl>
      {#if prov.notes && prov.notes.length}
        <div class="expl-notes md-notes">
          {#each prov.notes as n, i (i)}
            <span class="chip expl-note-chip" title={S.library.noteChipTitle}>{n}</span>
          {/each}
        </div>
      {/if}
      {#if encNote}
        <p class="note-amber" role="note">{encNote}</p>
      {/if}
    {/if}
  </section>

  <section class="md-sec">
    <h2 class="md-head">{S.library.advancedDiagnostics}</h2>
    {#if entError}
      <p class="error" role="alert">
        {entError}
        <button class="btn small" onclick={() => loadEnt(context.matchId)}>{S.library.retry}</button>
      </p>
    {:else if !ent}
      <LoadBox tag="div" class="md-hold" busy name="match-details-diagnostics" key=""></LoadBox>
    {:else}
      <dl class="facts">
        <div><dt>{S.library.dtEntityTypes}</dt><dd class="num">{fmtInt(ent.entityClasses)}</dd></div>
        <div><dt>{S.library.dtEntitiesAtEnd}</dt><dd class="num">{fmtInt(ent.endEntities)}</dd></div>
        <div><dt>{S.library.dtGenericEventTypes}</dt><dd class="num">{fmtInt(ent.genericTypes)}</dd></div>
        <div><dt>{S.library.dtGenericEventsTotal}</dt><dd class="num">{fmtInt(ent.genericTotal)}</dd></div>
      </dl>
    {/if}
  </section>
</div>
