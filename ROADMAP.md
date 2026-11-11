# Roadmap

Accepted feature candidates only. This list is **vetted by the owner**;
it carries no priorities or ordering yet — the owner picks what gets
worked. Future candidates are added **only on the owner's request**;
agents do not append feature ideas here. Product identity, principles,
and the feature decision rubric live in `PRODUCT.md` — check it before
proposing anything.

## Replay & playback

- Vision cones / could-see lines — draw where each player is actually looking
  (CS2Replays, DemoViewer.NET)
- Callout zones — resolve world positions to named places, with a per-team
  zone overlay (DemoViewer.NET)
- Smart Mode playback — auto speed-up of idle moments with slow-motion on
  frags/flashes, plus hover-to-pause and ¼×–2× presets (GetReplay, CS2Replays)
- Floating damage numbers — damage numerals rendered over the victim during
  replay (DemReview)

## Video, clips & highlights

- Full video export — WebM/MP4/GIF of arbitrary windows with HUD and drawings
  burned in, frame-rate choices, headless CLI (DemoViewer.NET); worth, but
  not if licensing blocks us
- MP4 clip export — in/out points to a short MP4 with map drawings burned in
  (Stratbase)
- Rule-driven highlight detection — aces, clutches, no-scopes, spray transfers,
  ninja defuses each with its tick, assembled into reels (DemoViewer.NET)
- Automatic mistake flagging — flags such as dying while holding a nade,
  self-flash, teamkill, unused defuse kit, molotov-in-smoke (Scope.gg);
  built-ins, but user-extendable

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

- Utility lineup library — browsable lineups by map and type; user-created,
  shareable, and/or extracted by clustering similarly-thrown utility across
  or within matches — NOT bundled pro content (Stratbase, GetReplay, RoundIQ,
  Scope.gg, DemReview)
- Lineup replay aids — 3D throw replay, screenshots and teleport command per
  lineup; `setpos`/`setang` clipboard export for practice (RoundIQ, DemReview)
- Strategic board / tactic editor — drag-and-drop players and grenades, drawn
  paths, timings, save/load of tactics, snapshot import from a viewer frame
  (cs2.cam, RoundIQ, Noesis, Stratbase, DemoViewer.NET, Refrag); far down the
  road

## Statistics, ratings & benchmarking

- Composite rating metric — HLTV Rating 1.0/2.0 reproduction plus our own
  documented rating, user-extendable (cs-demo-analyzer,
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

## Match metadata & event coverage

- Match metadata detection — demo source/provider, played-at date, game mode,
  ranked flag, share code, overtime/max rounds, framerate (cs-demo-analyzer,
  cs2-analyser-tool, DemReview)
- Per-shot aim telemetry — yaw, pitch, recoil index, punch angles and velocity
  per shot (cs-demo-analyzer); later, further down the road

## Voice (north star)

In-demo voice comms **replay already exists** — these are the analysis
and coverage future:

- Voice comms analysis — analyze in-demo voice comms; the north-star
  feature (voice comms with potential voice analysis)
- Coach voice support — blocked on a golden demo containing a coach

## Export & scripting

- Whole-match stats file export — 34 CSV tables / JSON / CSDM per demo, JSON
  envelope + flat CSV, and profile export to Markdown/JSON (cs-demo-analyzer,
  cs2-analyser-tool, DemReview)
- Position / trajectory export — per-frame entity positions plus always-on
  per-second samples (cs-demo-analyzer)
- XLSX / PDF / TXT export — document formats beyond CSV (cs2.cam)
- User-authored YAML metric rules — editable rulesets with schema validation,
  completion and a user rules directory (DemoViewer.NET); direction: the
  custom metric builder should be equally expressive as YAML, plus direct
  YAML authoring for power users with export/import
- Keyboard shortcut reference — a documented shortcut table (DemReview);
  exists in the demo viewer today, extend app-wide
- CLI / flag-driven scripting — CLI path argument / "Open with" and all-flags
  runs (cs2-analyser-tool, DemReview); CLI yes, TUI no — scope is a known
  concern (a CLI that can't do everything the GUI can would be a gargantuan
  effort)
- Parse cache and played-at ordering — skip-reparse reparse plus library
  ordering by last-played time (DemReview)

## Platform & packaging

- Localization — Russian/English UI (DemReview); later — start with the most
  commonly spoken languages in CS2 and work down

## Library

- Workspaces — the library reconceptualized as a unit that can be opened,
  modified, closed, exported
- Storage management tools — manual self-management plus eventual
  automation, extending the existing free-copy idea
