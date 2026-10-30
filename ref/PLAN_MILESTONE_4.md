# Spectra — Implementation Plan: Milestone 4 (Communications & Context)

**PRD reference:** §5.9 (voice), §5.15 (chat & administration), §6.2 (availability constraints), §10 Milestone 4
**Depends on:** M1 (events/chat/timeline), M2 (replay seek/sync)
**Exit criteria (PRD §10):** where voice data exists, users can navigate between audio, replay, and game events without losing synchronization.

---

## 1. Grounding facts

- **Voice is real and big — and the golden demo HAS IT.** Baseline 2026-10-30: **123,507 `CSVCMsg_VoiceData` chunks, all 10 XUIDs, 0 casters** on donk (research demo: 77,702). Framing decoded end-to-end (`ref/findings/findings-voice.md`): `m.GetAudio()` = `CMsgVoiceAudio{format=OPUS, sample_rate=48000, num_packets=1, packet_offsets=[N,0,0,0]}` → **`voice_data` bytes are exactly one raw Opus packet** (no TOC/length wrapper), 10 ms frames = 480 samples mono. `m.Tick` is 0 — take tick from `GameState().IngameTick()` at handler time. Payload: 31–137 B, mean 62.5 B (≈50 kbps), **≈7.7 MB raw sidecar** for the golden demo. No DTX (silence = absence of chunks); `section_number` is a per-sender counter — use it to detect the 0.014 % gaps.
- **Availability by source** (PRD §5.9 — web-researched with citations, `ref/findings/findings-q4-voice-availability.md`): **FACEIT yes** (both our demos, empirically + FACEIT support posts + 8 dedicated tools); ESEA yes, 5EPlay yes (restored Nov 2024); **Valve Premier/Competitive MM no** (unanimous across every voice-extractor README + mechanism: GOTV hears nobody with `sv_alltalk` off — MM demos are *the* normal no-voice case, no `.dem.info` sidecar changes it); pro/HLTV GOTV no (`tv_relayvoice 0` in official tournament configs); POV demos: teammates yes, own voice only with `voice_loopback 1`, enemies no (CS:GO-documented, CS2 undertested). UI must show a per-match "Voice: 123k chunks / 10 players" badge — or "not present" — never pretend; a no-voice MM demo must read as normal, not broken.
- Audio format solved (was evaluation task M4-T1 — **spike closed 2026-10-30**): decode with **pure-Go `github.com/pion/opus` pinned to a main pseudo-version** (`v0.1.1-0.20261026214112-e7b8aa55508c` — tag v0.1.0 misses libopus-parity + PLC fixes): **0 errors / 41,288 packets**, spectrograms show real speech, `CGO_ENABLED=0` verified. No libopus/cgo fallback needed; revisit only if a demo with lossy/40–60 ms frames appears (pion issues noted in `ref/findings/findings-deps.md` §2).
- Chat is already captured in M1 (`chat` table; 34 messages on the golden demo). Public-chat **decryption** (post-2026-09 `svc_EncryptedData`) needs the `.dem.info` GC key (`cl_decryptdata_key_pub`, 16 hex chars) — **both known demos had 0 encrypted messages** (probe: EncryptedData 0), so decryption stays implemented-but-dormant and synthetic-tested until a Valve MM demo with companion file appears (M4-T5 research; PRD §5.15).
- Match administration events (connect/disconnect/team/name change, ConVars) already flow into M1 generic/typed events; M4 surfaces them as a proper "Context" view.

## 2. Scope

**In:**

1. **Voice extraction** — during parse, persist every `CSVCMsg_VoiceData` chunk: XUID, tick, caster flag, payload bytes. Gated on round context (skip warmup or tag it).
2. **Voice storage** — sidecar files per match (see §3), DB rows index chunks (player, tick, offset, length). Reprocess regenerates.
3. **Decode pipeline** — Opus → PCM segments per player, lazily on first play (or eager background job with progress). Cache decoded segments (see §3). Seek-friendly: decode to fixed-size blocks (e.g. 100 ms) with an index.
4. **Playback & mixing** — per-player track mute/solo/volume; combined mix; playback speed 0.5×–2× (re-seek segments; Opus decode at rate or resample PCM); loop a segment; sync to M2 replay clock (single master clock in frontend; audio follows).
5. **Voice timeline** — activity lanes per player on the match timeline (density from chunk index, no decode needed); click lane → play from there + seek replay; markers for voice around selected events (PRD §5.5 correlation: comms surrounding kills/plants — P1: simple ±10 s window listing).
6. **Waveforms** — per-player waveform overview for the match (precomputed peaks file, not live decode); zoom with timeline.
7. **Chat & context view** — chat timeline (already in M1) joins connections/disconnects, team changes, name changes, relevant ConVars, announcements into one "Context" stream with filters; exportable (CSV/JSON).
8. **Chat decryption plumbing** — detect `.dem.info` companion next to the demo on import; extract key; if `svc_EncryptedData` present, decrypt → chat table with `decrypted=1`; graceful "key missing" state. (Verification blocked until a suitable demo; code path + unit tests with synthetic vectors.)
9. **Transcription (P2, optional)** — local Whisper via subprocess (whisper.cpp binary path in Settings, off by default); produces timestamped text lines per player segment; stored as `transcripts` rows; searchable in timeline; corrections editable; export SRT/VTT/TXT/JSON. Never cloud.
10. **Voice export** — per-player WAV/Opus and mixed track; transcript export.

**Out (deferred):** communication *analytics* (callout classification, frequency analysis — P2, M5+), caster/multi-source audio mixing, noise suppression, cloud transcription, realtime anything.

## 3. Storage layout

```
$XDG_DATA_HOME/spectra/matches/<matchID>/
    voice/
        chunks.idx           # global: chunk# → (steam_id, tick, byte_off, len, flags)
        <steamid>.opus       # concatenated opus payloads for that player
        pcm/<steamid>/<block>.pcm   # decoded cache, block = 100 ms @ 48 kHz mono s16
        peaks/<steamid>.f32  # waveform peaks (e.g. 100 per second)
```

DB:

```
voice_presence(match_id PK, chunk_count, player_count, caster_count, decoded, decode_ms)
voice_players(match_id, steam_id, name, chunks, first_tick, last_tick, seconds)
voice_chunks(match_id, seq, steam_id, tick, round, byte_off, len, caster)  -- index (match_id, steam_id, tick)
transcripts(match_id, steam_id, start_tick, end_tick, text, confidence, source, corrected)
chat(match_id, …, decrypted, key_source)   -- M1 table extended
context_events(match_id, tick, round, kind, steam_id, detail_json)  -- admin stream view index
```

Rationale: opus payloads concatenated per player → one file per player (few handles, simple offsets); decoded PCM cache is disposable (delete button, size shown in Settings); peaks tiny. Decode never blocks import (voice presence recorded at parse; decode is on-demand).

## 4. Sync model

- **Master clock = replay/timeline time (match seconds).** Audio engine consumes the clock: at time T, find chunks with tick ≤ T·tickrate and schedule PCM blocks with offset. Drift correction: resync if > 50 ms off; Web Audio `AudioContext` clock preferred over `<audio>` for precise mixing. **WebKitGTK AudioContext verified (pre-work, `ref/findings/findings-webview.md`): usable — scheduling error ≤0.2 ms, `currentTime` tracks wall clock; NO `<audio>` fallback needed.** Requirements: one user-gesture `resume()` ("Enable voice" pattern, context starts `suspended`), **`gst-plugins-good` as a documented Linux runtime dep** (else "Failed to start the audio device"), startup self-test (`resume()` → `state==='running'` → badge), and `audioCtx.currentTime` for timing (`performance.now()` is 1.0 ms coarse).
- Seek/loop/speed all re-anchor audio; mute/solo are gain nodes.
- Timeline voice lanes are index-only (no audio) → click seeks master clock → audio + replay follow.

## 5. Service & UI surface

**VoiceService** (Go): `GetVoicePresence(matchID)`, `GetVoicePlayers(matchID)`, `GetPeaks(matchID, steamID, fromSec, toSec)`, `GetPCMBlocks(matchID, steamID, fromBlock, toBlocks) → []byte`, `StartDecode(matchID)` (background job + progress events), `CancelDecode`, `ExportTrack(matchID, steamID, format)`, `GetTranscript(matchID, filter)`, `SaveTranscriptEdit(...)`.

**UI:**

```
views/
  Voice.svelte            per-match: player lanes, transport, per-player volume/mute/solo, waveform
  Context.svelte          merged chat + admin stream, filters, export
components/
  VoiceLanes.svelte       density lanes on shared timeline ruler
  CommsAround.svelte      "voice 10 s around this event" popup
```

Match header gains voice badge; Timeline gains voice filter + around-event affordances; Replay transport gains audio controls when voice present. Settings: decoder status, decode cache manager, whisper.cpp path, transcription language.

## 6. Work breakdown

1. **Opus evaluation spike (M4-T1)** — **DONE as pre-work 2026-10-30** (full report `ref/findings/findings-voice.md`, code `ref/findings/spikes/voicespike/`): whole payload = one raw Opus packet @ 48 kHz mono 10 ms; `pion/opus` main pseudo-version, 0/41,288 decode errors; WAVs + spectrograms verified as real speech; pure-Go verdict = **ship it** (no libopus). Remaining build work: the chunk dump/drain pipeline below.
2. **Extraction + storage** — chunk writer sidecar + DB index; presence job; reprocess integration; unit tests with synthetic chunk streams.
3. **Decode pipeline** — block cache, background decode job, progress, cache eviction.
4. **Audio engine (frontend)** — master-clock sync, per-player gain, Web Audio spike on WebKitGTK; fallback path.
5. **Voice UI** — lanes, transport, controls; replay sync; comms-around-event.
6. **Context view** — merged stream + filters + export; wire chat decryption detection + key extraction (synthetic tests).
7. **Export** — WAV/mixed Opus; transcript formats.
8. **Transcription (optional track)** — whisper.cpp subprocess integration, searchable transcript UI, manual corrections.
9. **Polish** — missing-voice UX, decode cache UI, perf pass, docs.

## 7. Testing & acceptance

- Synthetic chunk-stream unit tests for writer/index/decode scheduling (no demo bytes in repo).
- Integration (same skip-if-absent + fixture harness as M1 §6): golden demo → `voice_presence` asserted against `donk.golden.json` — baseline says **present (123,507 chunks / 10 XUIDs / 0 casters)**. The absence path (Valve MM demos, fixture=zero) is covered by synthetic/unit tests since the golden demo no longer exercises it.
- Manual acceptance on the golden demo itself: play match audio; solo a chosen player; verify a known voice spike aligns with a round event; seek mid-round — audio resumes in sync < 100 ms; mute one player while replay plays at 2×.
- Exit-criteria walkthrough: open a voice-bearing match → see voice badge + lanes → click a plant event → hear comms around it while replay shows the plant → export a chosen player's track.

## 8. Performance targets

| Metric | Target | Notes |
|---|---|---|
| Voice extract overhead on parse | ≤ +10 % (≈ +2 s on golden demo) | sidecar write only |
| Decode (full match, background) | < 60 s for 10 players | lazy per-player preferred |
| PCM block fetch (100 ms) | < 20 ms | local disk |
| Seek → audible | < 150 ms | |
| Lanes render (index only) | 60 fps with timeline scrub | no decode on scrub |

## 9. Risks & open questions

1. **Opus framing** — **closed by pre-work spike**: framing/rate proven (0 decode errors on two full player corpora, spectrograms clean; `ref/findings/findings-voice.md`). Residual: pion/opus has no FEC (LBRR discarded upstream) and PLC only on our pinned main — golden demo loses 0.014 % of chunks (17/123,507), `section_number` detects gaps; acceptable. libopus/cgo fallback retired unless a badly-behaved demo appears.
2. **WebKitGTK AudioContext** — **verified by pre-work spike**: usable, ≤0.2 ms scheduling; residual = document `gst-plugins-good` Linux runtime dep + user-gesture `resume()` + startup self-test (§4). No fallback path budgeted anymore.
3. **Disk bloat** — PCM cache for 10 players × 30 min ≈ 3.4 GB @ 48 kHz s16 mono… too big: decode compressed (FLAC) or store 16 kHz mono for speech (≈ 1.1 GB), or stream-decode without cache. Decision in M4-T2: **default 16 kHz mono FLAC cache** (speech-band sufficient), full-rate optional. Scale reference: raw compressed voice sidecar for the golden demo ≈ **7.7 MB** (measured).
4. **Valve MM voice absence** — product must not look broken; presence badge + explainer link.
5. **Whisper runtime weight** — keep fully optional, external binary, no bundled models.

## 10. Definition of done

- Golden demo (voice confirmed present): fixture says voice_presence=true/123,507; per-player tracks playable synced to replay, lanes render, export works. The zero-voice path is unit/synthetic-tested (the golden demo no longer exercises it).
- A Valve-MM-style no-voice demo degrades gracefully with a clear badge.
- Chat decryption path implemented + tested with synthetic vectors; `.dem.info` discovery works.
- Transcription either shipped behind a Settings flag or explicitly deferred with a note in this file.
- `make lint vet test` green; §8 measured.
