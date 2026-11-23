<script>
  import * as S from '../../strings/index.js';
  import { fill, fmtBytes } from './panelhelpers.js';
  import { DASH } from '../../builtinhelpers.js';
  const FACTS_COPY = Object.freeze({
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

  // Match facts: voice presence and the demo copy's state (the two Details
  // facts that are not stored-fact reads). A failed read is reported into this
  // frame.
  import { getMatch, getVoicePresence, evictDemoCopy } from '../../services.js';
  let { spectra, context } = $props();
  const COPY = FACTS_COPY;

  let match = $state(null);
  let voice = $state(null);
  let copyBusy = $state(false);

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    Promise.all([getMatch(matchId), getVoicePresence(matchId).catch(() => null)]).then(
      ([m, v]) => {
        if (live) {
          match = m;
          voice = v;
        }
      },
      (e) => spectra.guard(() => {
        throw e;
      })(),
    );
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
</script>

<section class="panel" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <span class="builtin-throbber" aria-hidden="true"></span>
  {#if match}
      <dl class="facts">
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
      </dl>
  {/if}
</section>
