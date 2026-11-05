# Spectra — What's Still Missing

**Status: open backlog (2026-10-31), current as of Milestone 5 shipped.**
`ref/PRD.md` is the product spec (the intent); this file is the only
prospective roadmap — everything listed here is *not* in the app yet. Items
carried from an old milestone plan cite the PRD section that defines them.
When something ships, move it out; when something is permanently cut, delete
it rather than archive it.

---

## 1. Features not yet built

### Extraction & raw data

- **Ballistics** (PRD §5.6 "Advanced Ballistics") — impacts, shot-to-hit,
  penetration, weapon accuracy. Blocked on event availability: the
  `bullet_damage` / `bullet_impact` game events are absent on FACEIT
  SourceTV demos. **Probe leads:** `CMsgTEFireBullets` (3,302 fires on the
  golden demo), `CMsgPlaceDecalEvent` (1,514), `CS_UM_ShootInfo` (raw-only,
  did not fire on donk) — all visible in the Explorer's message census.
  Valve MM demos untested; settle by parsing one.
- **Sound-event layer** (PRD §5.14) — `CMsgSosStartSoundEvent` fires 25,266
  times per golden demo and is captured as generic events; the Replay
  landmark feed browses them by name (game-events category), but there is
  no dedicated scrubber track or spatial visualization.
- **Per-grenade trajectory reconstruction** beyond the recorded throw/det
  samples (PRD §5.4 utility visualization) — research-grade.
- **Chat decryption is implemented but dormant** — needs a Valve MM demo
  that carries encrypted `svc_EncryptedData` messages plus its
  `match730_*.dem.info` companion (GC key). Both known demos have 0
  encrypted messages; `chat.decrypted` honestly stays 0 until one arrives.

### Replay

- **Follow modes** (PRD §5.4 "Advanced Replay"): follow a grenade, a
  killer/victim. Follow-a-player ships, and the default **smart camera**
  keeps the planted/dropped bomb framed automatically (dropped-C4
  evidence + reconstruction) — an explicit "follow the bomb" target is
  the remaining bomb item.
- **Split-screen + ghost replay** — overlay two rounds/matches; also the
  CompareRounds ghost overlay.
- **Custom replay annotations** (draw on the replay) — needs the
  notes/tags annotations tables (below).
- **Exportable 2D replay video** beyond the WebM clip recorder (GIF/PNG
  sequence).
- **Spectator POV.**

### Analytics

- **Pattern recognition / executes & setups** (PRD §5.11 "Pattern
  Recognition") — descoped from M5: **blocked on bomb-site region polygons**
  (map packs ship site *centers* only; polygons need nav/vmap extraction).
  Heatmap + spatial series carry the load meanwhile.
- **Team tactical analysis** (PRD §5.11): offensive/defensive structure,
  setups, rotation timing, trade/flash coordination.
- **Advanced positioning analysis** (PRD §5.10): overexposure, isolation,
  trade spacing, defensive gaps, crossfire opportunities — spacing/spread
  series shipped (M5); the interpreted layer hasn't.
- **Event correlation tools** (PRD §5.5): shots-before-kills, flash→kill,
  voice-around-critical-events, etc.
- **Advanced utility tools** (PRD §5.8): lineup catalog (searchable/saved/
  annotated), utility effectiveness metrics, utility coordination.
- **Advanced clutch review** (PRD §5.12 P2): success by size/map/side,
  clutch duration/weapon, replay mode, last-known positions.
- **Behavioral archetypes + anomaly detection** (PRD §5.13) — needs
  cross-match volume beyond the single golden demo.
- **Entry engagement kind** — deferred; extractor `entry_kills` column
  covers attribution only.

### Communications

- **Transcription** (PRD §5.9) — local whisper-style, timestamped,
  searchable, SRT/VTT export; explicitly deferred from M4 v1 (Settings
  notes this).
- **Communication analytics** (PRD §5.9): callout classification, comms
  frequency around engagements/critical events.
- **Voice UX gaps (M4 deferrals):** standalone voice view, waveform peaks,
  voice filter in the FilterBar, CommsAround popup (Hear ±10s covers the
  core need), caster/multi-source mixing, noise suppression.

### Platform & workflow

- **Scripting plugins** (PRD §5.20 Lua/JS) — declarative plugins shipped in
  M5; a goja/gopher-lua interpreter + local read-only API is the documented
  v2 path.
- **Annotations / notes / tags** — no tables, no UI (PRD §5.19).
- **Multi-window / multi-monitor**, resizable **layout persistence**,
  **configurable keyboard shortcuts** (PRD §5.19) — all cut at M5.
- **Workspace presets** (PRD §5.19): Match Review / Replay / Analysis …
- **Zip export bundle** (PRD §5.18) — CSV/JSON via SQL console, library.db
  copy, and per-match reports cover export today.
- **Spatial pattern detectors** (executes/setups) — same polygon blocker as
  above.

## 2. Data & asset gaps

- **Radar art**: none ships with the app — official pixels are Valve IP,
  and the schematic placeholder shipped earlier has been removed too
  (`frontend/public/maps/README.md`). Real pixels come from the in-app
  extractor (Settings → Map packs → extracts from the user's local CS2
  into the data dir — Valve IP never ships in releases;
  `internal/mappack`); until a pack is extracted, maps render a plain
  grid ("map not found").
- **Map packs**: the only bundled pack is `de_mirage` (transform only,
  no image); the extractor covers every official map at runtime from
  `resource/overviews/<map>.txt` in the user's install.
- **Bomb-site region polygons** — extractable from nav/vmap; unblocks
  pattern detection, better heatmaps, and clutch/site analytics.
- **Per-round money columns are 0** — `item_equip` payloads carry no
  prices, so `player_round_stats.money/equip/spent` and the winner-spend
  card show $0. Needs a price table (game items schema) or a
  `CCSPlayerResource`-based read.
- **R1 (pistol) money samples = 0** — freeze-end money sampling misses
  round 1.
- **Profile per-side K/D 0.00 / weapon-HS zeros** — single-match data
  quirks; verify against multi-match libraries.
- **Single golden demo** — career/anomaly/archetype work needs a bigger
  local library; voice/decryption gaps need a Valve MM demo + `.dem.info`.

## 3. Platform & polish gaps

- **macOS/Windows unmeasured** — all perf figures and visual smoke runs are
  Linux/X11 only; transfer, import, and first-frame timings need a pass on
  the other two supported platforms.
- **Light theme residuals** — replay canvas clear color, heatmap ramp, and
  some shadows still read dark in light mode.
- **Clip recording needs `gst-plugins-good`** on WebKitGTK (MediaRecorder
  fails honestly without it; hint text exists). macOS/Windows webviews
  differ — verify.
- **Import/replay fps + first-frame not instrumented** (only wall-clock
  smoke numbers exist).

## 4. Settle-if-needed research recipes

- **Voice availability on Perfect World / Grid / SkinClub** — parse one
  demo of each and check `voice_presence`; procedure: import, then look at
  the match voice badge (or query `voice_presence` on the row).
- **CS2 POV-demo voice** (own voice with `voice_loopback`, teammates
  always) — undertested; same one-demo recipe.
- **Valve MM ballistics** — if the FACEIT leads in §1 fail, a Valve MM demo
  is the remaining unknown for §5.6.
