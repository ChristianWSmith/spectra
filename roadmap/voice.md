# Voice comms analysis & coach voice — roadmap research

**Unit:** voice · **Priority tier:** P1 (main differentiator) · **Date:** 2026-11-10
**LoE (aggregate):** L — one L (voice analysis: an STT-capable pipeline dominates: runtime choice + packaging + storage + feed UI; the model-free metrics slice alone would be M) and one S (coach voice: small identity/labeling change once a coach-bearing demo exists).
**Feasibility:** medium — replay/serve-side infrastructure is mature and fully offline; blockers are the STT runtime choice (cgo vs external process vs WASM — licensing, binary size, release matrix), multilingual accuracy, and the missing coach demo.

## Items in scope

1. **Voice comms analysis** — analyze in-demo voice comms; the main
   differentiator (voice comms with potential voice analysis)
2. **Coach voice support** — blocked on a golden demo containing a coach

## Current state

**Capture (import).** `src/internal/extract/voice.go` defines
`VoiceChunk{Tick, XUID, Payload, Caster, Section}` + `VoiceSink`;
`extract.go` registers a `CSVCMsg_VoiceData` net-message handler (only when
a sink is wired) and captures the raw Opus payload (10 ms mono frame), the
sender XUID, the proto's `caster` flag, and the section number — tick comes
from `GameState().IngameTick()` (the message's own tick is 0 in SourceTV
demos). **Not captured:** the proto also carries `proximity`,
`audible_mask`, `entity`, `passthrough` — untapped analysis signals (who
could hear whom under alltalk/proximity).

**Storage.** `src/internal/library/library.go` creates a
`sidecar.VoiceWriter` per import (wiped + recreated on reprocess): payloads
stream into `<matchDir>/voice/<steamid>.opus`, and one fixed 16-byte-record
`<steamid>.idx` per player (tick, offset, section, len, flags bit0=caster)
is written at Close — deliberately beside the audio, **not** in SQLite
(`schema.sql`: voice is ~77% of a match's rows). SQLite keeps only the
`voice_presence` header (`internal/store/voice.go`): chunk/player/caster
counts, `key_found`, out sample rate. Golden baseline
(`internal/integration/golden_test.go`): de_cache = **123,507 chunks / 10
XUIDs / 0 casters**, with a "casters == 0" safety net.

**Serve.** `src/voiceservice.go` (`VoiceService` bindings):
`GetVoicePresence` (badge, gated on the sidecar index), `GetVoicePlayers`,
`GetVoiceLanes` (density buckets), `GetVoiceIndex` (THE one match-load
read: players + lanes + server-exact sparse window map).
`src/main.go` HTTP routes `/api/sidecar/<id>/voice/pcm?steamId&fromTick&toTick`
(≤60 s window, s16le mono @16 kHz, gaps zero-filled) and `/voice/wav`
(full-match download); `decodeVoicePCM` decodes Opus with the pinned
pure-Go `pion/opus`. Perf budget pinned in `perf_dev_test.go`
(`TestPerfVoiceDevDB`): 2 s PCM window < 20 ms, full WAV < 60 s.

**Frontend.** `lib/replay/audio.js` — the voice engine: Web Audio locked to
the replay clock, pitch-corrected pre-stretch for speed changes, sparse
window skipping (`voicewindows.js`), per-player gain/mute/solo,
`getStreamTap()` feeding the WebM recorder's mixed audio.
`lib/replay/voiceindex.js` speaking buckets → the live talking bloom on
player dots (`renderer.js` `voiceBloom`). `Replay.svelte`: volume-popover
Voice fader, per-player/per-team mute, the **"hear comms around it"**
event button (seek TO event with voice on), Match-view voice badge,
Explorer inspector `voiceChunks`, Settings Audio & voice section — which
already contains the placeholder line **"Voice-to-text transcription isn't
available yet."** The old voice bar / voice-lanes strip / WAV-export link
were removed from the DOM (`frontend/test/replay.dom.mjs` pins their
absence), but `services.js` `voiceWavURL`, the Go `/voice/wav` route and
`save.js` `saveExportURL` plumbing all still exist.

**Domain facts (CS2.md).** Voice presence is server-config-dependent, not
a format guarantee: SourceTV records it only when voice flags allow
(`sv_alltalk`, `tv_relayvoice` default 1); FACEIT demos demonstrably have
it (38,620 messages in one 228 MB demo); **Valve MM presence is NOT
established** (some MM voice may be encrypted behind the `.dem.info` key).
No coach-voice entry exists; the only coach knowledge is the
`#CSGO_Coach_Join_T/CT` chat messages (never chat rows). demoinfocs-golang
v6 exposes no `IsCoach` player flag (grep of the module: none).

**No STT anywhere** — grep for transcri/whisper/vosk/subtitle finds only
the Settings placeholder.

## Implementation path

### 1. Voice comms analysis — LoE: L

Realistic decomposition (voice analysis is a ladder, not one step):

**a) Model-free comms metrics — M (the honest first delivery).** All
derivable from the existing `.idx` chunk streams (no audio decode):
talk-time and speaking-share per player/round, simultaneous-talking
(overlap of per-player chunk streams = interruptions/teamtalk load),
comms density around key events (plants, first bloods, clutch ticks —
`store.RoundForTick` already maps tick→round), quietest/loudest rounds.
Formula-documented metrics (AGENTS: metric = formula + N), rendered as
Match-view cards / an analytics table; a view-level aggregate is allowed
only per the aggregate rule — stored metrics prefer the analytics pass.
No schema change strictly needed (chunks are read from the sidecar index),
though a per-match projection into SQLite may be wanted for cross-match
queries later.

**b) Audio-signal pass (optional) — M.** Decode PCM (reuse
`decodeVoicePCM`) for energy/VAD-grade stats (loudness per window,
"shouting" moments, silence-vs-speech segmentation finer than 10 ms
chunks). Runs as an explicit per-match background pass, never in the
import parse (import must stay fast).

**c) STT transcript — the L.** Options against PRODUCT.md's offline
definition (user-initiated network OK; external state must not drive app
behavior; never present a feature the app can't fully support offline):
1. **User-supplied local model + in-process runtime** (whisper.cpp or
   sherpa-onnx family via cgo): best end-user experience after setup, but
   cgo cuts against the "modernc, no cgo" dependency preference, adds a
   Linux+Windows build/packaging matrix, and **model licensing must be
   verified** (whisper's weights are commonly redistributed under
   non-commercial terms — unacceptable to bundle with an MIT app unless a
   clean-licensed alternative model is chosen; VERIFY, do not assume).
2. **External STT binary, user-configured path** (e.g. a whisper.cpp
   CLI): app shells out with a 16 kHz WAV slice, reads text back — zero
   in-process dependencies, fully offline, honors "user-controlled";
   cost is user setup + result-shape plumbing. **Lowest-risk path to a
   working transcript.**
3. **Download-on-demand model** (one explicit Settings click fetches
   weights, then fully offline): allowed by PRODUCT.md (user-initiated),
   but still requires an in-process runtime → same packaging cost as (1),
   plus model files must NOT ride the release-asset contract (they're per
   platform/arch weight files, not app binaries).
4. **WASM runtime in the frontend** (whisper.cpp wasm, model loaded from
   the data dir): avoids cgo, but WebKitGTK memory/perf for a
   multi-hundred-MB model is unmeasured — speculative.
5. **Cloud STT: forbidden** (no cloud ever; offline promise).

   Recommended shape: (a) ships regardless; transcript lands behind
   (1) or (2) as an opt-in built-in with a Settings "local model/tool"
   config, absent → the honest badge-off degradation (transcript absent
   surfaces as absent, never fabricated).

**Data model.** Transcript rows carry tick ranges derived from the chunk
ticks (same source the player-sync already uses) → seek/click-to-seek
identical to chat. Storage decision: sidecar `voice/transcript.*` (matches
"the index belongs with the audio" precedent, bulk derived data) vs a
SQLite table (needed only if metrics/console must query transcript text);
lean sidecar first, SQLite projection only when a SQL consumer exists. No
format-version machinery (pre-release policy): one current layout,
re-transcribe on change.

**Jobs.** `models.Job.Kind` is today `"import" | "reprocess"`; STT takes
minutes of CPU per match and must not ride the import parse or the
reprocess invariants (queue coalescing, match-row flips). Prefer an
explicit per-match "Transcribe" action with progress on the existing
`jobs` table + `spectra:job-progress` (100 ms throttle, rendered through
`StatusChip` — no second progress widget), or a fresh action outside the
import queue if the coalescing rules fight it.

**Frontend surface.** A transcript feed beside the chat/kill feed in
`Replay.svelte` (render through the canonical `LandmarkRow` if it becomes
a feed source), tick-synced like chat, plus transcript search. Settings'
Audio & voice section replaces its placeholder line.

### 2. Coach voice support — LoE: S (data-gated)

Blocked: no coach-bearing demo in the golden pool (7 `de_*.dem.zst`), no
CS2.md coach-voice facts, and demoinfocs v6 exposes no coach flag — how a
coach's voice actually appears (separate XUID outside the roster? caster
flag? audible mask?) is **unknown until a demo is probed**.

When a coach demo appears, the likely work:
1. **Probe/characterize** (small extract-side investigation; extend the
   golden `countingVoiceSink` census to see what the coach's chunks look
   like) and record the finding in CS2.md per the domain-knowledge rule.
2. **Identity + labeling**: a coach XUID is not in `finalRoster` (rosters
   exclude spectators) → today it maps to `name == ""` exactly like a
   caster (`voiceservice.go` `voiceNames`). Add a coach label/lane: a
   named non-player voice participant with its own row in the voice
   players list + mute control, and (if useful) a distinct presence count
   — possibly a new flag bit in the `.idx` reserved byte (old sidecars
   just lack it; fail-soft, no migration).
3. **Playback itself likely already works** — the engine plays every
   index player regardless of roster membership — so this is mostly
   identity/UI plus fixtures.
4. **Golden fixture**: add the coach demo to the pool (Git LFS), extend
   `golden_test.go` voice baseline, and revisit the "casters == 0"
   safety net deliberately (fixture regen requires justification).

## Existing scaffolding to reuse

- `extract.VoiceSink` / `sidecar.VoiceWriter|VoiceReader` — any new
  capture field or flag rides the existing writer (reserved bytes exist).
- `VoiceService.GetVoiceIndex` — the one match-load read every new
  voice consumer should extend rather than fork.
- `decodeVoicePCM` + `/api/sidecar/.../voice/{pcm,wav}` + `saveExportURL`
  — decode/export plumbing for any audio-signal pass or transcript
  preprocessing (16 kHz WAV is already the natural STT input).
- `lib/replay/audio.js` — clock sync already solved; transcript segments
  sync the same way windows do.
- Chat feed + `LandmarkRow` — the transcript's rendering/seek twin;
  `store.RoundForTick` — tick→round for per-round comms metrics.
- `jobs` table + `spectra:job-progress` + `StatusChip` — job UX;
  `analytics.Compute`/`StageAnalyze` — post-import pass shape (but keep
  STT out of the import path).
- Badge-off degradation pattern (`GetVoicePresence` → `HasVoice=false`)
  — the exact honest-absence shape for "no voice / no transcript".
- `perf_dev_test.go` voice budgets — the perf-target pattern for any new
  decode-based pass.

## Dependencies & overlaps

- **Statistics / ratings:** comms metrics become metrics/cards — formulas
  and N per the honest-metrics rule; cross-match voice metrics would want
  a SQLite projection (today everything voice is sidecar-only).
- **Replay:** transcript feed, speaking index, "comms around it" button,
  player mute — all live in `Replay.svelte` (the biggest conflict surface).
- **Video, clips & highlights:** the WebM recorder already taps the voice
  master bus; a transcript is a natural burn-in/subtitle source —
  co-schedule subtitle decisions with the video unit.
- **Drawing, notes & bookmarks:** "Voice notes" (user-recorded audio
  annotations) is a sibling feature sharing PCM/WAV/save plumbing but not
  in-demo data — keep the two audio pipelines distinct.
- **Library:** a transcribe job touches `jobs` semantics (kind, queue
  coalescing, `ListJobs` 200-recent) — de-conflict with any library-queue
  work.
- **Match metadata:** demo source/provider determines voice presence
  (FACEIT yes, Valve MM likely no) — the metadata unit's provider facts
  feed the honest "voice available?" surface.
- **Localization:** transcripts are multilingual (RU/EN CS2 comms) — STT
  language coverage and future UI strings ride the localization unit.
- **Lineups / export / platform:** no meaningful overlap.

## Risks & unknowns

- **STT runtime choice is the whole ballgame:** cgo vs external process
  vs WASM — packaging (Linux+Windows release matrix), binary size,
  dependency-minimism preference, and **model licensing must be verified
  before any bundling decision** (whisper weights are frequently
  non-commercial; a clean-licensed model or external-binary design dodges
  this).
- **Determinism preference:** STT output varies by runtime/model version —
  pin runtime+model as part of the transcript's contract (documented,
  re-transcribable) or transcripts become non-reproducible derived data.
- **CPU cost:** minutes per match on CPU for a full transcript; must be
  an explicit, cancellable, progress-reporting action — never silent
  background churn (and never import-blocking).
- **Voice availability variance:** Valve MM demos may have no/encrypted
  voice at all (CS2.md) — the feature must degrade to badge-off honestly;
  sample N (which matches even have voice) bounds every comms metric.
- **Storage:** `.opus` sidecars are already MBs per match (PRODUCT.md:
  storage growth is not a big concern) but transcripts + any energy pass
  add per-match files that reprocess must wipe (follow the voice-dir
  lifecycle exactly).
- **Golden-demo gap:** coach item is hard-blocked on data; the golden
  voice baseline is a pinned safety net — any capture change forces a
  deliberate, justified fixture regen.
- **Sync correctness:** transcript tick ranges must come from the same
  chunk ticks playback uses (IngameTick-at-handler), or seek-by-transcript
  drifts from audio — no second tick source.
