# Roadmap candidates

Candidate feature list compiled from the competitor analysis of **2026-11-10**
(raw reports: `comp-web.md` web platforms, `comp-viewers.md` 2D viewers,
`comp-oss.md` OSS analyzers; full unfiltered gap record:
`COMPETITOR_FEATURES.md`).

- **Recorded, not analysed** — transcribed at the source reports' level of
  detail only. No feasibility notes, no estimates, no priorities, no ordering:
  this list is unfiltered by priority, and the owner reviews it to select what
  gets worked.
- **Filtered against the product identity** — Spectra is a local-first, fully
  offline desktop app (Linux/Windows): no accounts or auth of any kind, no
  cloud services, no Steam/FACEIT linkage, demos never leave the machine,
  manual import into a local SQLite library, assets self-extracted from the
  user's own local CS2 install, a solo analysis/replay toolkit with no
  multi-user SaaS layer. Anything cutting against that (accounts, cloud
  storage/sharing, server-side processing, multi-user collaboration, online
  pro-demo catalogs, Discord/bot integrations, browser-only delivery,
  bundled Valve art, telemetry) was dropped and is **not** listed here — it
  stays in the gap record.

## Replay & playback

- 3D replay — X-ray, full-body models, volumetric smokes, POV follow and free
  camera over the match (Scope.gg, cs2.cam, RoundIQ, CS2Replays, Memorin)
- In-engine first-person playback — follow recorded players through the
  installed CS2 engine with HUD/radar overlays (Demo Trace)
- Jump to a tick in a running CS2 instance — seek the live game client to the
  moment being viewed, "Live Sync" (DemoViewer.NET)
- Vision cones / could-see lines — draw where each player is actually looking
  (CS2Replays, DemoViewer.NET)
- Smart Mode playback — auto speed-up of idle moments with slow-motion on
  frags/flashes, plus hover-to-pause and ¼×–2× presets (GetReplay, CS2Replays)
- Floating damage numbers — damage numerals rendered over the victim during
  replay (DemReview)
- Callout zones — resolve world positions to named places, with a per-team
  zone overlay (DemoViewer.NET)
- Cross-match round overlay — stack and compare rounds in one view even from
  different matches (Noesis)
- Additional input formats — `.dem.bz2`, `.gz`, `.zip` alongside
  `.dem`/`.dem.zst` (CS2Replays, GetReplay)

## Video, clips & highlights

- Full video export — WebM/MP4/GIF of arbitrary windows with HUD and drawings
  burned in, frame-rate choices, headless CLI (DemoViewer.NET)
- MP4 clip export — in/out points to a short MP4 with map drawings burned in
  (Stratbase)
- Rule-driven highlight detection — aces, clutches, no-scopes, spray transfers,
  ninja defuses each with its tick, assembled into reels (DemoViewer.NET)
- Automatic mistake flagging — flags such as dying while holding a nade,
  self-flash, teamkill, unused defuse kit, molotov-in-smoke (Scope.gg)
- Video generation from demos (CS Demo Manager, per the landscape article)

## Drawing, notes & bookmarks

- Drawing / telestration — pens, shapes, paths and arrows over the map, some
  pinned to the demo clock or to a player and persisted as sidecars (RoundIQ,
  DemoViewer.NET, Stratbase, cs2.cam, Refrag)
- Bookmarks with notes — save moments and notes during review, incl. an
  in-game chat-command bookmark trigger (Demo Trace, GetReplay,
  cs2demoviewer)
- Voice notes — audio annotations attached to a round (RoundIQ)
- Demo notes with autosave — notes kept on a demo with autosave and keyboard
  shortcuts (Stratbase, Noesis)
- Tag store — persistent tags with suggested tags (DemoViewer.NET)

## Strategy & lineups

- Utility lineup library — browsable lineups by map and type, pro-sourced
  where available (Stratbase, GetReplay, RoundIQ, Scope.gg, DemReview)
- Lineup replay aids — 3D throw replay, screenshots and teleport command per
  lineup; `setpos`/`setang` clipboard export for practice (RoundIQ, DemReview)
- Strategic board / tactic editor — drag-and-drop players and grenades, drawn
  paths, timings, save/load of tactics, snapshot import from a viewer frame
  (cs2.cam, RoundIQ, Noesis, Stratbase, DemoViewer.NET, Refrag)
- Veto simulation — BO1/BO3/BO5 veto scenarios with an all-scenarios
  confidence table (cs2.cam)

## Statistics, ratings & benchmarking

- Composite rating metric — HLTV Rating 1.0/2.0 per player and a documented
  3.0-style rating with a published methodology (cs-demo-analyzer,
  cs2-analyser-tool)
- Progress graphs and personal records — performance over rolling match
  windows, achievements/personal bests (Scope.gg, Leetify, DemoViewer.NET)
- Cross-library player overview — trends, rank history, teammates,
  head-to-head, benchmarks and achievements for one player across every demo
  (DemoViewer.NET)
- Kill and damage matrices — first-class matrix tables (GetReplay)
- Clutch step-by-step breakdown — dedicated 1vX replay mode (GetReplay)
- Per-match side-split table — CT/T rounds, kills, deaths, ADR, KAST per
  player per match (cs2-analyser-tool)
- Exact opening success rate — opening kills whose round was later won
  (cs2-analyser-tool)
- Unused utility value — money lost on death from unthrown grenades, with an
  explicit price table (cs2-analyser-tool, DemReview)
- Per-player blind-time aggregate — total and average enemy flash seconds per
  player (cs2-analyser-tool, DemReview)
- Grenades thrown by type — per-player counts per grenade type
  (cs2-analyser-tool)
- Per-throw grenade effectiveness — damage, enemies and teammates blinded
  with blind seconds, kills of blinded enemies (DemReview)
- Player habit / pattern mining — predictability index, roles with reasons,
  stable patterns with confidence intervals and tunable thresholds (DemReview)
- Conditions → actions frequency tables — each round rendered as
  "conditions → decision" (DemReview)
- Duel stance and distance analysis — peek-vs-hold classification and duel
  results by distance bucket (DemReview)
- Self-review mistake moments — untraded deaths, isolated deaths, unused
  grenades ($ lost), re-peeks, each with a `demo_gototick` jump (DemReview)
- BO3/BO5 series aggregation — cross-map team identity over multiple demos
  (cs2-analyser-tool)

## Match metadata & event coverage

- Match metadata detection — demo source/provider, played-at date, game mode,
  ranked flag, share code, overtime/max rounds, framerate (cs-demo-analyzer,
  cs2-analyser-tool, DemReview)
- Niche event families — chicken, coach and hostage rows, per-purchase and
  per-player economy rows, grenade bounce/destroy rows (cs-demo-analyzer)
- Per-shot aim telemetry — yaw, pitch, recoil index, punch angles and velocity
  per shot (cs-demo-analyzer)

## Export & scripting

- Whole-match stats file export — 34 CSV tables / JSON / CSDM per demo, JSON
  envelope + flat CSV, and profile export to Markdown/JSON (cs-demo-analyzer,
  cs2-analyser-tool, DemReview)
- Position / trajectory export — per-frame entity positions plus always-on
  per-second samples (cs-demo-analyzer)
- XLSX / PDF / TXT export — document formats beyond CSV (cs2.cam)
- Embeddable APIs — Go `AnalyzeDemo` API and npm `analyzeDemo()` with progress
  callbacks; an importable Go package (cs-demo-analyzer, cs2-analyser-tool)
- Terminal pickers and flag-driven scripting — interactive pickers or
  all-flags runs; CLI path argument / "Open with" (cs2-analyser-tool, DemReview)
- Streaming reader input — parse from any reader with mid-parse cancellation
  (cs2-analyser-tool)
- Parser / entity inspector — frame → message → byte range → `.proto` field,
  with entity-tracking tabs (DemoViewer.NET)
- User-authored YAML metric rules — editable rulesets with schema validation,
  completion and a user rules directory (DemoViewer.NET)
- Keyboard shortcut reference — a documented shortcut table (DemReview)
- Parse cache and played-at ordering — skip-reparse reparse plus library
  ordering by last-played time (DemReview)

## Platform & packaging

- macOS builds (cs-demo-analyzer, cs2-analyser-tool, DemoViewer.NET)
- linux-arm64 builds (cs-demo-analyzer)
- Localization — Russian/English UI (DemReview)
- CS:GO demo support alongside CS2 (cs-demo-analyzer)

## Local install tooling

- Game-binary introspection — offsets, schemas, convars, concommands,
  interfaces and buttons read from CS2's DLLs (cs2-analyzer)
- Registry install discovery — resolve the CS2 install from the Windows
  registry (cs2-analyzer)

## Testing

- HLTV-oracle regression testing — maps checked against published HLTV values
  with source URLs and SHA-256 digests (cs2-analyser-tool)
