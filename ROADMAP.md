# Roadmap

Accepted feature candidates only. This list is **vetted by the owner**;
it carries no priorities or ordering yet — the owner picks what gets
worked. Future candidates are added **only on the owner's request**;
agents do not append feature ideas here. Product identity, principles,
and the feature decision rubric live in `PRODUCT.md` — check it before
proposing anything.

## Replay & playback

- Vision cones / could-see lines — draw where each player is actually looking
- Callout zones — resolve world positions to named places, with a per-team
  zone overlay
- Smart Mode playback — auto speed-up of idle moments with slow-motion on
  frags/flashes, plus hover-to-pause and ¼×–2× presets
- Floating damage numbers — damage numerals rendered over the victim
  during replay

## Video, clips & highlights

- Full video export — WebM/MP4/GIF of arbitrary windows with HUD and drawings
  burned in, frame-rate choices, headless CLI; worth, but
  not if licensing blocks us
- MP4 clip export — in/out points to a short MP4 with map drawings burned in
- Rule-driven highlight detection — aces, clutches, no-scopes, spray transfers,
  ninja defuses each with its tick, assembled into reels
- Automatic mistake flagging — flags such as dying while holding a nade,
  self-flash, teamkill, unused defuse kit, molotov-in-smoke;
  built-ins, but user-extendable

## Drawing, notes & bookmarks

- Drawing / telestration — pens, shapes, paths and arrows over the map, some
  pinned to the demo clock or to a player and persisted as sidecars
- Bookmarks with notes — save moments and notes during review, incl. an
  in-game chat-command bookmark trigger
- Voice notes — audio annotations attached to a round
- Demo notes with autosave — notes kept on a demo with autosave and
  keyboard shortcuts
- Tag store — persistent tags with suggested tags

## Strategy & lineups

- Utility lineup library — browsable lineups by map and type; user-created,
  shareable, and/or extracted by clustering similarly-thrown utility across
  or within matches — NOT bundled pro content
- Lineup replay aids — 3D throw replay, screenshots and teleport command per
  lineup; `setpos`/`setang` clipboard export for practice
- Strategic board / tactic editor — drag-and-drop players and grenades, drawn
  paths, timings, save/load of tactics, snapshot import from a viewer frame;
  far down the road

## Statistics, ratings & benchmarking

- Composite rating metric — HLTV Rating 1.0/2.0 reproduction plus our own
  documented rating, user-extendable
- Progress graphs and personal records — performance over rolling match
  windows, achievements/personal bests
- Cross-library player overview — trends, rank history, teammates,
  head-to-head, benchmarks and achievements for one player across every demo
- Kill and damage matrices — first-class matrix tables
- Clutch step-by-step breakdown — dedicated 1vX replay mode
- Per-match side-split table — CT/T rounds, kills, deaths, ADR, KAST per
  player per match
- Exact opening success rate — opening kills whose round was later won
- Unused utility value — money lost on death from unthrown grenades, with an
  explicit price table
- Per-player blind-time aggregate — total and average enemy flash seconds
  per player
- Grenades thrown by type — per-player counts per grenade type
- Per-throw grenade effectiveness — damage, enemies and teammates blinded
  with blind seconds, kills of blinded enemies
- Player habit / pattern mining — predictability index, roles with reasons,
  stable patterns with confidence intervals and tunable thresholds
- Conditions → actions frequency tables — each round rendered as
  "conditions → decision"
- Duel stance and distance analysis — peek-vs-hold classification and duel
  results by distance bucket
- Self-review mistake moments — untraded deaths, isolated deaths, unused
  grenades ($ lost), re-peeks, each with a `demo_gototick` jump

## Match metadata & event coverage

- Match metadata detection — demo source/provider, played-at date, game mode,
  ranked flag, share code, overtime/max rounds, framerate
- Per-shot aim telemetry — yaw, pitch, recoil index, punch angles and velocity
  per shot; later, further down the road

## Voice (main differentiator)

In-demo voice comms **replay already exists** — these are the analysis
and coverage future:

- Voice comms analysis — analyze in-demo voice comms; the main
  differentiator (voice comms with potential voice analysis)
- Coach voice support — blocked on a golden demo containing a coach

## Export & scripting

- Whole-match stats file export — 34 CSV tables / JSON / CSDM per demo, JSON
  envelope + flat CSV, and profile export to Markdown/JSON
- Position / trajectory export — per-frame entity positions plus always-on
  per-second samples
- XLSX / PDF / TXT export — document formats beyond CSV
- User-authored YAML metric rules — editable rulesets with schema validation,
  completion and a user rules directory; direction: the
  custom metric builder should be equally expressive as YAML, plus direct
  YAML authoring for power users with export/import
- Keyboard shortcut reference — a documented shortcut table;
  exists in the demo viewer today, extend app-wide
- CLI / flag-driven scripting — CLI path argument / "Open with" and all-flags
  runs; CLI yes, TUI no — scope is a known
  concern (a CLI that can't do everything the GUI can would be a gargantuan
  effort)
- Parse cache and played-at ordering — skip-reparse reparse plus library
  ordering by last-played time

## Platform & packaging

- Localization — Russian/English UI; later — start with the most
  commonly spoken languages in CS2 and work down

## Library

- Workspaces — the library reconceptualized as a unit that can be opened,
  modified, closed, exported
- Storage management tools — manual self-management plus eventual
  automation, extending the existing free-copy idea
