# PATH.md — roadmap execution plan

The authoritative, **living** execution plan for every accepted roadmap
item. It replaces the old `ROADMAP.md` (deleted — this file is now the
list). Product identity, principles, and the feature decision rubric
live in [`PRODUCT.md`](../PRODUCT.md) — read it before proposing or
building anything.

**Research basis:** each item links its pre-research report in this
directory (`roadmap/*.md`) — LoE, implementation path, scaffolding to
reuse, risks. Read the linked report before starting an item.

## How to use this document

- **Authority chain:** `PRODUCT.md` > this plan > per-item reports.
- **Checking off:** when an item ships, mark it `[x]` and append
  `— YYYY-MM-DD (<commit>)`. Never delete checked entries; the history
  is the record.
- **Phases are soft:** order within and across phases reflects priority
  and dependencies; any item whose prerequisites are met may start early.
- **New candidates:** only on the owner's request; append to the
  appropriate phase. Agents do not invent roadmap items.
- **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done
  · `[!]` blocked (note the blocker on the line).

## De-confliction rules (read before starting work)

1. **ONE mistake/moments engine.** `stats-advanced` owns the engine
   core (moments table + `analytics.Compute` integration + Moments
   panel); `video-detection` owns the flag rule set, extensibility, and
   reels. Two engines = the forbidden second rule layer. The same rule
   applies to **unused utility value** (`stats-descriptive` #5): it must
   be one implementation with `stats-advanced`'s mistake moments (both
   need kill-time grenade inventory).
2. **ONE home for user-authored per-map data** (callout zones ×
   lineups × strategic board) — decision **D1** below before any of the
   three builds storage.
3. **Per-match user data must survive reprocess.** `matches/<id>/` is
   extract-owned and `RemoveAll`ed on failed reprocess — bookmarks,
   notes, voice notes, drawings never go there (annotations' pattern:
   SQLite rows + a sibling data dir). The drawings report's
   `matches/<id>/drawings.json` proposal is therefore rejected until
   the cleanup contract is fixed (**D2**).
4. **Video pipeline contracts:** `video-export` owns all encoders (no
   second encoder anywhere); `video-detection` composes reels and hands
   off. Smart Mode must suspend during capture (`replay-playback` ↔
   `video-export`). Anything painted on the replay canvas is recorded —
   drawings/overlays keep that contract.
5. **One CLI harness** (`export-tooling`); video headless and export
   flags ride it. Keep dump logic Go-side for reuse.
6. **`played_at`:** `metadata` detects and owns the value;
   `export-tooling` only orders by it — semantics decision **D4**.
7. **YAML metrics:** authority model decision **D5** first;
   `stats-advanced` thresholds align to its field names.
8. **The sidecar positions layout is frozen** (8 B/player/frame,
   `q16`). New per-frame data (e.g. shot telemetry) goes to new tables,
   never into the sidecar.
9. **Honest unknowns:** share code, rank outside Valve-MM, played-at
   outside Valve demos may be absent — render "unknown" + `N`, never a
   guess (`PRODUCT.md` honest-metrics rule).

## Open decisions & probes

| # | Decision | Kind | Blocks |
|---|---|---|---|
| D1 | Single storage home for user-authored per-map data (DB table vs pack-meta key vs data-dir files) | owner + tech | zones, lineups, board |
| D2 | Per-match user-data home + deliberate fix of the reprocess `RemoveAll` cleanup contract | tech | drawings, annotations |
| D3 | Moments-engine ownership (proposal stands: `stats-advanced` core, `video-detection` rules) | tech (confirm) | advanced analytics, mistake flagging |
| D4 | `played_at` semantics: demo date vs last-opened | owner | parse-cache ordering, metadata |
| D5 | YAML metrics authority: DB-native vs files-as-truth | owner + tech | export-metrics, thresholds |
| D6 | MP4 probe: does WebKitGTK `MediaRecorder`/WebCodecs do MP4? (else ffmpeg → licensing + packaging conflict) | probe | full video export, MP4 clips |
| D7 | Language ranking below RU/EN ("most commonly spoken in CS2, work down") | owner | localization scope |
| D8 | Occlusion ("could-see") go/no-go: `.custom.occlusion`/`vvis_c` are undecoded | owner, after cones | vision occlusion spike |
| D9 | Trajectory export scope: player-only (M) vs non-player entities (L, new storage) | owner | position export |
| D10 | Wails pin check: mic permission (`getUserMedia`) works in pinned Wails v3 (PR #5567) | probe | voice notes |

## Phase 0 — decisions & probes (unblocks everything)

- [ ] **D1–D10** — work the table above; owner decisions as listed.

## Phase 1 — replay & analysis quick wins (P1: core loop, main differentiator)

Replay (both reports: feasibility high):

- [ ] **Vision cones** · S · [replay-overlays](replay-overlays.md) —
  yaw already stored; pure renderer wedge. (Occlusion is separate: D8.)
- [ ] **Callout zones** · M · [replay-overlays](replay-overlays.md) —
  needs D1 + zone authoring (or probe `m_szLastPlaceName`).
- [ ] **Smart Mode playback** · M · [replay-playback](replay-playback.md)
  — frontend-only; dwell hysteresis protects audio; suspend during
  capture (rule 4).
- [ ] **Floating damage numbers** · S ·
  [replay-playback](replay-playback.md) — frontend-only, data exists.

Statistics — descriptive batch (aggregate L, [stats-descriptive](stats-descriptive.md)):

- [ ] **Kill and damage matrices** · S
- [ ] **Clutch step-by-step breakdown** · M (replay UI; don't fork
  `clutches.go`)
- [ ] **Per-match side-split table** · S (ADR-basis formula decision)
- [ ] **Exact opening success rate** · S (rename `OpeningRate` together
  with the definition change — no drift)
- [ ] **Unused utility value** · M (ONE implementation — rule 1;
  reimport/golden-fixture decision included)
- [ ] **Per-player blind-time aggregate** · S
- [ ] **Grenades thrown by type** · XS
- [ ] **Per-throw grenade effectiveness** · M (`analytics.Utility` stays
  the single owner)

Tooling & metadata:

- [ ] **Keyboard shortcut reference** · S ·
  [export-tooling](export-tooling.md) — canonical `lib/shortcuts.js` +
  palette dialog; no keymap rewrite.
- [ ] **Parse cache & played-at ordering** · S–M ·
  [export-tooling](export-tooling.md) — after D4; stamp honesty note in
  report.
- [ ] **Match metadata detection** · M · [metadata](metadata.md) —
  after D4 for `played_at`; probe-first for game mode; honest unknowns.
- [ ] **Voice comms metrics (slice a of voice analysis)** · M ·
  [voice](voice.md) — model-free talk-time/overlap/density from the
  existing `.idx` streams; first delivery of the main differentiator.

## Phase 2 — export, ratings & advanced analytics (P1: core)

Export (all [export-formats](export-formats.md), shared core → ship
together, aggregate M):

- [ ] **Whole-match stats export (CSV/JSON bundle + profile md/json)** ·
  M — publish OUR table catalog; CSDM deferred (private layout).
- [ ] **Position / trajectory export** · M — rides the stored 64 Hz
  positions sidecar; scope per D9.
- [ ] **XLSX / PDF / TXT export** · M — excelize (pre-approved dep);
  PDF mirrors report templates.

Ratings ([stats-rating](stats-rating.md), aggregate L):

- [ ] **Composite rating metric** · M — documented approximation
  (weights unpublished); formula docs are a CS2.md follow-up.
- [ ] **Progress graphs & personal records** · M — read-time; no new
  tables.
- [ ] **Cross-library player overview** · L — after metadata (rank +
  played-at); honest rank-unknown handling.

Extensibility & CLI:

- [ ] **User-authored YAML metric rules** · M ·
  [export-metrics](export-metrics.md) — after D5; builder-parity gap
  list in report.
- [ ] **CLI / flag-driven scripting (scoped v1)** · M ·
  [export-tooling](export-tooling.md) — multi-instance DB policy is an
  open question; unscoped parity explicitly out.

Advanced analytics ([stats-advanced](stats-advanced.md), aggregate L;
after D3 + YAML field alignment):

- [ ] **Conditions → actions frequency tables** · M (vocabulary design
  first; no new extraction)
- [ ] **Duel stance and distance analysis** · M (sidecar streaming
  pass; document our peek/hold formula)
- [ ] **Self-review mistake moments** · M (**ships the moments engine
  core** — rule 1)
- [ ] **Player habit / pattern mining** · L (depends on the condition
  vocabulary above)

## Phase 3 — moments, annotations & video (P2: worth)

Detection ([video-detection](video-detection.md), aggregate 2×M; rides
the Phase-2 engine):

- [ ] **Rule-driven highlight detection + reels composition** · M —
  reels encoding hands off to video-export (rule 4); CS2.md lookups for
  spray-transfer/ninja-defuse.
- [ ] **Automatic mistake flagging (built-ins + extensible rules)** · M
  — declarative sibling of the YAML rules dir; observed predicates only.

Annotations ([notes-annotations](notes-annotations.md), aggregate M;
after D2; probe D10 for voice notes):

- [ ] **Bookmarks with notes** · M — SQLite (survives reprocess);
  `!bm` chat trigger is an on-read scan (plaintext-chat bound).
- [ ] **Voice notes** · M — sibling `voicenotes/` dir; PCM→WAV in JS.
- [ ] **Demo notes with autosave** · S
- [ ] **Tag store** · S

Drawings ([notes-drawings](notes-drawings.md)):

- [ ] **Drawing / telestration** · M (v1 S) — after D2; pure `lib/draw/`
  geometry module is **shared with the strategic board** (rule: fork it
  and you pay twice); canvas paint = auto burn-in for clips.

Video ([video-export](video-export.md), aggregate L; feasibility
medium — probe D6 first):

- [ ] **Full video export — WebM + GIF first slice** · S–M — extract
  the existing clip recorder; frame-timed deterministic stepping.
- [ ] **Full video export — MP4 + headless CLI** · M — gated on D6
  (licensing/packaging) and the CLI harness (rule 5).

## Phase 4 — strategy & library (P3: further out)

Strategy ([strategy-lineups](strategy-lineups.md) M ·
[strategy-board](strategy-board.md) L→M):

- [ ] **Utility lineup library** · M — after D1; read-side clustering
  pass; JSON export/import for sharing.
- [ ] **Lineup replay aids** · S — radar throw replay + `setpos/setang`
  clipboard; pitch probe (extract-time enrichment) first.
- [ ] **Strategic board / tactic editor** · L (stripped v1 M) — after
  D1 and the `lib/draw/` module; "far down the road" per owner.

Library ([library.md](library.md), aggregate L):

- [ ] **Storage management tools** · M — size dashboard, bulk frees,
  cron-less retention; honest "reprocess impossible after free" UX
  (parse-cache note).
- [ ] **Workspaces** · L — last: session-indirection refactor across
  ~12 services + DB lock guard for the never-open-another-instance rule.

## Phase 5 — later & data-gated (P4–P5)

- [ ] **Per-shot aim telemetry** · S–M · [metadata](metadata.md) —
  "later"; new `shots` table (~240 KB/match); punch angles probe.
- [ ] **Localization** · L, phased M-first · [platform](platform.md) —
  after D7; infra first, then sweep by canonical home.
- [ ] **Voice comms analysis — STT slice** · L · [voice](voice.md) —
  local model/external process/WASM runtime decision; licensing check
  (whisper weights often non-commercial); user-supplied models only.
- [ ] **Coach voice support** · S · [voice](voice.md) — **blocked: no
  coach-bearing demo exists** (needs a golden fixture).
- [ ] **Vision occlusion ("could-see")** · L ·
  [replay-overlays](replay-overlays.md) — gated on D8; ships after
  cones regardless.
- [ ] **Trajectory export — non-player entities** · L ·
  [export-formats](export-formats.md) — only if D9 approves.

## Effort summary

| Phase | Scope | Aggregate LoE |
|---|---|---|
| 0 | decisions & probes | days at most (mostly meetings/probes) |
| 1 | replay wins + descriptive stats + tooling + metadata + voice metrics | L (≈3–4 weeks) |
| 2 | export formats + ratings + YAML + CLI + advanced analytics | L (≈4–6 weeks) |
| 3 | detection/reels + annotations + drawings + video | L (≈4–6 weeks) |
| 4 | lineups + board + storage + workspaces | L (≈4–6 weeks) |
| 5 | telemetry, localization, STT, coach, occlusion | L (≈3–5 weeks) |

Grand total: **XL** (several months of steady work). Feasibility is
high everywhere except video (medium — MP4/headless probes) and voice
STT (medium — runtime/licensing choice).
