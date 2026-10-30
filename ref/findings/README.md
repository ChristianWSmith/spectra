# Pre-work findings (2026-10-30)

Research spikes executed **before M1** to close the PRD §13 open technical questions
and the milestone plans' TBD/spike placeholders. Each `findings-*.md` is a full spike
report with evidence and citations; the milestone plans cite these files at the
relevant decisions. Spike source code lives in `spikes/` (nested modules — excluded
from root `./...` builds like `ref/extractor`).

| File | Closes | Headline |
|---|---|---|
| `findings-deps.md` | PRD §13.1, plan dep pins | demoinfocs `v6.0.0-rc.1` still newest (needs **Go ≥1.27** directive bump); `modernc.org/sqlite v1.61.0`; `klauspost/compress v1.20.3` (security fix ≥1.20.2); `pion/opus` pin **pseudo-version of main** (138 commits ahead of tag); Wails pin current; **never bulk-transfer via EventsEmit** (8 KB inline / 64 MiB store / one-shot) — asset-server Handler+Range or GoStream |
| `findings-mappack.md` | PRD §13.8, M2 map pack | Golden demo is **de_cache** (not mirage). Transform: `px=(wx-pos_x)/scale`, `py=(pos_y-wy)/scale` (Z-up, inverted Y); de_cache constants `pos_x=-2000, pos_y=3250, scale=5.5` (verify vs overview txt). Radar = `panorama/images/overheadmaps/<map>_radar_psd.vtex_c` in `pak01_dir.vpk` + `resource/overviews/<map>.txt` (still ships in CS2). **Posture: numeric metadata in-repo; pixels via user-install extraction or runtime download — never bundled in public releases.** awpy `map_data.json` = de-facto metadata schema; site polygons need nav/vmap extraction (no drop-in package) |
| `findings-sqlite.md` | PRD §13.9 (write path), M1 OQ2/3 | modernc SQLite **comfortable**: 11,168-row match insert **0.29–0.32 s** (1 txn) on a 2016 mobile CPU; naive 1 txn/row **58–76× slower**; 100-match library **~31 s**; **5.08 MB/match**; indexed reads 2–32 ms; per-event `json.Marshal` costs ~100 ms/match (hand-built −75%) |
| `findings-voice.md` | PRD §13.4/§13.5, M4-T1 | Golden demo **has voice**: 123,507 chunks / 10 XUIDs / 0 casters. Framing: `audio.voice_data` = **exactly one raw Opus packet**, no wrapper; `sample_rate=48000`, 10 ms → 480 samples mono. **pion/opus pure-Go: 0 errors / 41,288 packets**; spectrograms show real speech. No DTX (silence = absence of chunks); `section_number` detects the 0.014% gaps; `m.Tick=0` → use ingame tick. Voice sidecar ≈ 7.7 MB raw for golden demo |
| `findings-webview.md` | M4 AudioContext, M2-T3 transfer | **AudioContext usable on WebKitGTK 2.54.2**: scheduling error ≤0.2 ms, `currentTime` tracks wall clock; needs user-gesture `resume()` + **`gst-plugins-good` runtime dep** (else "Failed to start the audio device") — no `<audio>` fallback needed. Transfer ranking: asset-server HTTP full fetch **25–30 MB/s** > Range slice (1 MiB @ 16 MiB ≈ 35 ms) > bound `[]byte` **base64 +33%, 14–16 MB/s**. `OffscreenCanvas` present; `performance.now()` = 1.0 ms (use `audioCtx.currentTime`) |
| `findings-q4-voice-availability.md` | PRD §13.4 | **Voice by demo source** (cited): Valve Premier/Comp MM = **no voice** (unanimous across every extractor + GOTV voice-routing mechanism, high confidence); FACEIT = **yes** (our data + FACEIT support posts + 8 tools); ESEA yes, 5EPlay yes (changelog-restored Nov 2024); pro/HLTV GOTV **no** (`tv_relayvoice 0` in official configs); POV = teammates yes / own only with `voice_loopback` / enemies no (CS:GO-documented, CS2 undertested); Perfect World/Grid/SkinClub unknown — settle by parsing one demo each (procedure in file) |
| `findings-q6-msgtypes.md` | PRD §13.6 | **Message-value census** (cited): CCSPlayerResource entity = economy/scoreboard backbone (High); `.dem.info` MatchInfo = date/share-code/decrypt key (High); `svc_EncryptedData` + key = post-2026-09 chat (High); `SetConVar`/`ServerInfo` (High); `ShootInfo`/`CounterStrafe`/`AdjustMoney`/`RadioText`/`DeepStats`/`EndOfMatchAllPlayersData` CS2-only raw-only (Medium); Valve ships win-prob via `CurrentRoundOdds` (+`RoundImpactScoreData` — enum absent from v6 msg pkg, verify); SOS sounds research-grade only; `player_sound`/`bullet_damage` game events preferred. Includes full tool-usage table + recommended probe list (probe's recommendations implemented as `spikes/msgcensus/`) |
| `spikes/sampler/` | M2-T1 (PRD §13.2/3) | 64 Hz sampling of golden demo: **f32 raw 18.4 MB / q16 (1.0 u) raw 9.1 MB / zstd 6.9 / 2.5 MB** — all well under the 30 MB budget; parse overhead **28.9 → 39.8 s (+37.6 %)**, dual-encoding worst case. 136,948 frames, 10 slots, avgAlive 7.56 → ~1.04 M player-records/match |
| `spikes/sqlitebench/` | reproducibility | Bench source + run logs behind `findings-sqlite.md` |
| `spikes/voicespike/` | reproducibility | `dump` (payload capture) + `analyze` (framing×rate sweep, WAV writer) behind `findings-voice.md` |
| `spikes/webvprobe/` | reproducibility | Minimal Wails app + page behind `findings-webview.md`; `shot15.png` = passing gesture run |
| `spikes/sampler/` | reproducibility | FrameDone sampler behind the M2-T1 numbers recorded in PLAN_MILESTONE_2.md §3 |
| `spikes/msgcensus/` | PRD §13.6 empirical | Full net-message census probe (registers `reflect.MakeFunc` handlers for **all 639** protobuf message types) + `census-donk.txt`: on the golden demo **39 types fire / 1,965,413 messages** — UserCommands 1.37M, Tick/PacketEntities/DemoPacket plumbing, VoiceData 123,507, **SOS sounds 25,266**, legacy game events 21,029, **TEFireBullets 3,302 + PlaceDecalEvent 1,514 (ballistics-adjacent, see below)**, chat (SayText2 34 / TextMsg 38), SetConVar 19, EncryptedData 0, EndOfMatchAllPlayersData 1. Encodes the "what actually fires on a FACEIT SourceTV demo" half of Q6 |

## PRD §13 status

| # | Question | Status |
|---|---|---|
| 1 | Parser implementation | **Closed** — demoinfocs v6.0.0-rc.1 proven (245 MB/28.9 s/0 warnings); pin stands; re-check on upgrade (`findings-deps.md`) |
| 2 | Temporal sampling rate | **Closed** — 64 Hz full-rate fits budget; no 32 Hz fallback needed (M2 §3) |
| 3 | Entity sampling optimization | **Closed (design)** — alive-only + bitmask + int16@1.0 u halves raw; zstd −63–74 %; delta/varint remains M2 build-time refinement |
| 4 | Demo formats providing voice | **Closed** — graded answer with citations in `findings-q4-voice-availability.md`: FACEIT **yes** (empirical), ESEA/5EPlay yes, **Valve MM no** (high confidence, mechanism + unanimous tool docs), pro/HLTV no, POV conditional. Residual unknowns (Perfect World/Grid/SkinClub, CS2 POV) are non-blocking with a documented settle-if-needed procedure |
| 5 | Opus decode & sync | **Closed** — raw Opus @ 48 kHz mono 10 ms, pure-Go decode proven (`findings-voice.md`); sync architecture in M4 §5 |
| 6 | Net/user-message value | **Closed** — two-halves: community census (`findings-q6-msgtypes.md`: who reads what, value grades, v6 exposure) + **empirical census** (`spikes/msgcensus/`: all 639 msg types registered, 39 fire on the golden demo, 1.97M messages). Actionable probe list for MM-vs-FACEIT differences included |
| 7 | Ballistics reliability | **Closed for FACEIT SourceTV (negative)** — `bullet_damage`/`bullet_impact` game events absent on **both** demos; **new leads from the census: `CMsgTEFireBullets` (3,302) and `CMsgPlaceDecalEvent` (1,514) DO fire, and `CS_UM_ShootInfo` (raw-only, did not fire on donk) may carry server shot poses — probe these in M1 raw inspector before abandoning ballistics.** Valve builds untested (settle with the one-demo recipe, same as old #4 remainder) |
| 8 | Map assets & transforms | **Closed** — `findings-mappack.md` (formula, sources, licensing posture, JSON schema) |
| 9 | Positional storage format | **Closed** — per-match sidecar files + block-zstd + offset index (M2 §4); sizes measured (M2 §3) |
| 10 | 2D renderer architecture | **Decided** — Canvas 2D layered client-side playback (M2 §6); OffscreenCanvas available if needed later |
| 11 | Parser/schema evolution | **Closed** — `parser_version` column + explicit reprocess (M1 §3.3, PRD §9.2) |
| 12 | Deterministic vs heuristic metrics | **Closed (policy)** — PRD §6.1 fact/inference separation + M3 provenance badges/definition pages |

## Deliberately deferred discovery

- **First-party voice spot-check on a Valve MM demo** — web answered "no voice" at high confidence (Q4); optionally parse one real `match730_*.dem` to see it return 0 VoiceData ourselves. Same one-demo-per-source recipe settles Perfect World/Grid/SkinClub/5EPlay claims and **ballistics coverage on Valve builds** (Q7 remainder), plus one CS2 POV with `voice_loopback 1`.
- **Encrypted-chat flow on a real MM demo** — `svc_EncryptedData` + `.dem.info` key path is designed and API-verified (demoinfocs v6 `option.NetMessageDecryptionKey`), but needs one Valve MM demo + sidecar to exercise end-to-end at M4/M5 time (both known demos: 0 encrypted).
- **macOS WKWebView / Windows WebView2** — transfer + AudioContext numbers here are Linux WebKitGTK 2.54.2; WebView2 buffers whole responses (Range slices still fine). Validate on first macOS/Windows run.
- **pion/opus PLC/FEC** — FEC not implemented upstream; pinned main has PLC. Golden demo loses 0.014 % of chunks (17/123,507) → low impact; revisit if a lossy demo appears.
