# Spectra — Implementation Plan: Milestone 5 (Advanced Platform)

**Status: implemented 2026-10-31** — `internal/metrics` (frozen v1 grammar `from <table>: agg…`, identifier whitelists, AST→parameterized-SQL, denominators/scopes), `internal/query` (read-only session: mode=ro + query_only + progress-handler statement timeout + row cap + multi-statement/write rejection), `internal/spatial` (spacing/spread series from sidecars), `internal/plugin` (declarative manifests, capability whitelist, sha256 bundle pinning, enable/disable installs metrics rows live), `internal/report` (match/player/round MD+HTML templates + plugin templates), migrations 005 (metrics, query_history, saved_queries — **7 builtin PRD §5.16 fixture metrics seeded**) + 006 (plugins), services `MetricsService`/`QueryService`/`PlatformService` (provenance/convars/entity summary/spatial/plugins/reports), HTTP `GET /api/export/<id>/report` + `GET /api/export/library.db`. Frontend: **Builder** (editor+live validation+preview+pins→scoreboard columns), **SQL console** (schema browser/history/saved/CSV+JSON export), **Explorer** (provenance, entity summary, convars, key/value payload tree, warnings, census reference), **Reports** (templates+metrics appendix composite+DB copy), **CommandPalette** (Ctrl-K fuzzy over actions/matches/players/filters/metrics/queries), **theme** dark/light (localStorage + startup apply), **clip recorder** (MediaRecorder canvas.captureStream → WebM vp9/opus with voice mix via master-bus tap, auto range/10s window), **Spatial series** charts in Heatmaps, Settings **Plugins** section (install/enable/remove + trust copy).

**Acceptance walkthroughs:** #1 pin→scoreboard→report appendix (Builder pins localStorage `spectra:pinned-metrics` → Match columns → Reports appendix) ✓; #2 SQL top-N→CSV ✓ (console smoke: JOIN query ran 142 ms, exports wired); #3 explorer payload tree + provenance ✓; #4 pattern detection **DESCOPED** (needs bomb-site region polygons we don't ship — heatmap/series carry the spatial load; recorded in §4 cut-line below); #5 clip with mixed voice ✓ **smoke-recorded live**: `webm; codecs=vp9,opus · canvas + voice mix`, 170 KB video-only sibling, honest error surfaced without gst ("MediaRecorder unsupported" banner) ✓; #6 declarative plugin install → no restart (enable toggles metric rows live; expr validated by the metrics engine at install) ✓ code+tests (UI section shipped).

**Measured:** metric preview @100 matches 6–204 ms (<1 s ✓), compile ×1000 6.4 ms (<3 s ✓), console typical 1–4 ms + CTE-bomb killed 503 ms @500 ms timeout ✓, spatial spacing 551 ms / spread 408 ms (<20 s ✓), palette open instant (<50 ms), plugin metric call = preview path (<50 ms ✓), clip realtime capture (=1× ≤5× ✓).

**Cut-line descoped (plan §4 authority) with rationale:** pattern detectors (§2.4 — requires region polygons; map packs carry centers only), goja/gopher-lua scripting + loopback API (§2.7 — declarative plugins cover acceptance; scripting is the documented v2 path), multi-window, resizable layout persistence, configurable shortcuts, annotations/notes/tags tables, zip export bundle (CSV/JSON via console + DB copy + per-match reports cover export), spatial_series cache table (computed on read — fast enough). Light theme has known residual dark surfaces (replay canvas clear color, heatmap ramp, some shadows) — recorded in build notes.

**PRD reference:** §5.16 (custom analytics), §5.17 (raw data / developer mode), §5.18 (clips/reporting), §5.19 (customization), §5.20 (extensibility), §10 Milestone 5
**Depends on:** M1–M4 (events, positions, analytics, audio — everything this milestone builds on)
**Exit criteria (PRD §10):** advanced users can extend Spectra, define custom analyses, automate workflows, and investigate complex match questions without depending on predefined statistics.

---

## 1. Grounding facts

- The DB now holds the full normalized match corpus (events, generic events, rounds, economy, utility, clutches, voice index, transcripts) plus position sidecars — a real analytical substrate.
- CS2OpenDev taxonomy (FINAL_REPORT Part I): 289 game events, 140 user messages, 65 network messages, 222 server classes — the **Data Explorer** exposes what M1 only histograms.
- PRD differentiators #9/#10 (custom analytics, contextual drill-down) land here; also the developer-inspection identity (§5.17) that separates Spectra from consumer trackers.
- Everything derived must stay reproducible (§9.2): formulas, source data, config, parser version — this milestone makes provenance a first-class UI surface.

## 2. Scope

### 2.1 Custom metric builder (P2 → now P0 of M5)

- Definition model: metric = aggregation over an event/dimension set + optional filters + group-by (player/round/team/weapon/map/side/time-bucket) + expression.
- Expression language: start with a small safe evaluator (count, sum, avg, median, min/max, stddev, percentile, ratio, rate, rolling window, time-weighted, conditional) — implement in Go (`internal/metrics`), **not** SQL string interpolation; compile to either Go closure or SQLite SQL (benchmark; SQL wins for large libraries).
- UI: builder form + live preview on current library; saved metrics (`metrics` table) usable everywhere a builtin stat appears (scoreboard columns, profiles, charts).
- Example queries from PRD §5.16 must all be expressible — treat them as acceptance fixtures.
- Documentation strings on every metric; sample size + missing-data indicators on results (§5.16).

### 2.2 Advanced query interface

- Read-only SQL console over the library DB (power-user escape hatch, PRD §5.17): single connection flag `mode=ro`; statement timeout; result grid export CSV/JSON; query history + saved queries; schema browser sidebar (tables, columns, parser schema notes).
- Query language alternative: saved metric expressions referenced from SQL via generated views (`metric_<name>`).
- Performance info per query (rows, ms).

### 2.3 Data explorer / developer mode

- Raw inspectors: game events (with full key/value), user messages, network message histogram, string tables, entity schema browser (server classes + props from parse), ConVars, console commands, parser warnings, encrypted-payload metadata (presence, not content).
- Schema browser searchable; counts labeled parser/build-specific (PRD §5.17).
- Data provenance panel per match: parser version, extraction profile, rule versions (analytics config), sidecar format versions, warning list.

### 2.4 Spatial analytics & pattern recognition (P2)

- Recomputable spatial series from sidecars: teammate spacing over time, team spread, distance-to-bomb/site, choke-point occupancy (map-pack region polygons), time-in-region, crossfire opportunity proxies.
- Pattern detection v1 (explicitly **inferred**, PRD §5.10/5.11): recurring execute routes (cluster of similar path prefixes into a site in a time window), defensive setups (freeze-end positions clustered), rotation timing after first contact. Output = labeled observations with supporting round lists + replay deep-links, never verdicts.
- Comparison tools: match-vs-match, side-vs-side, player-vs-player matrices.

### 2.5 Clips, reports, export

- Clip assembly: tick ranges (+ event-anchored) → 2D replay render capture. V1: canvas capture at fixed res/speed → WebM via MediaRecorder (frontend) with optional mixed audio track (M4); GIF via post-process or pure-Go encoder; ffmpeg subprocess for heavy formats (optional dep, detected in Settings).
- Snapshots (M2) batch into clipboards; annotations (text/tick anchors) stored per match.
- Reports: templated HTML/MD match/player/round reports generated in Go (data → template → file); print-friendly; attach tables + heatmap PNGs + optional clip links.
- Data exports: CSV/JSON (per table + custom metric results), SQLite file copy, position histories (sidecar copy), trajectories, audio, transcripts, full JSON bundle.

### 2.6 Customization & workspaces

- Layouts: resizable panels per view, persisted; workspace presets (Match Review, Tactical Replay, Player Analysis, Utility, Communications, Statistics, Developer Mode) switching view+layout+filters in one action.
- Light/dark themes (dark ships default in M1; light tokens now), accent color.
- Command palette (⌘K / Ctrl-K): fuzzy navigation, actions, saved filters, metrics, players, matches. Global search across matches/players/rounds/events/notes/tags/queries/transcripts.
- Configurable shortcuts; multi-window (open replay + stats side by side — Wails v3 multi-window); recent navigation.

### 2.7 Extensibility

- **Plugin model v1 — declarative first:** plugins as bundles (`spectra-plugin.json` + optional WASM/JS snippets for metric expressions and report templates only). Capabilities: register metrics, event processors (pure transforms over stored events), visualizations (declarative chart specs), report templates, export extensions.
- **Scripting:** embed `goja` (JS) or `gopher-lua` behind a capability API (read-only query + metrics registration); sandbox: no FS, no network, no process; CPU/time budget per call; user-installed only, enabled per plugin.
- **Local read-only API:** loopback HTTP (opt-in, token in Settings) exposing library/queries/metrics for power users and community dashboards (PRD §5.20).
- Plugin registry = local directory scan + manifest validation; signing/hash pinning for shared plugins (community share format = zip + manifest).

### 2.8 Out of scope (explicit)

Cloud sync/accounts, live overlay, marketplace, mobile, auto-updating plugins from the internet (distribution stays user-driven), replacing CS2 3D playback.

## 3. Storage & architecture additions

```
internal/
  metrics/        expression evaluator, metric registry, SQL compiler
  query/          read-only SQL session, history, saved queries
  explorer/       raw inspectors over store + sidecars
  spatial/        series computation, region occupancy
  patterns/       heuristic detectors (inferred outputs)
  report/         templates + renderer
  plugin/         manifest, loader, sandbox bridge
frontend/src/
  views/CommandPalette.svelte, Settings.svelte (expanded), DataExplorer.svelte,
        Builder.svelte, Workspace.svelte
  lib/metrics.js  client mirror of builtins for preview
```

Schema: `metrics`, `saved_queries`, `reports`, `annotations`, `plugins`, `workspaces`, `shortcuts`, `spatial_series(match_id, kind, bucket, blob)` (cached, invalidated on sidecar version bump), `notes`, `tags`. All derived tables carry `(rule_version, computed_at, parser_version)`.

## 4. Work breakdown

1. **Metrics engine** — evaluator + SQL compiler + registry; PRD example queries as fixtures; UI builder + preview; scoreboard/profile integration.
2. **SQL console + saved queries** — read-only connection, history, schema sidebar, exports.
3. **Data explorer** — raw event/message/table/entity/ConVar inspectors; provenance panel.
4. **Spatial series** — spacing/spread/distance/occupancy precompute + charts; region polygons in map packs.
5. **Pattern detectors v1** — executes/setups/rotations as inferred observations with evidence links.
6. **Exports & reports** — CSV/JSON/SQLite bundle; report templates (match/player/round); heatmap PNG embed.
7. **Clips** — recorder, annotation store, clip library, audio mix-in.
8. **Workspaces & theming** — presets, layout persistence, light theme.
9. **Command palette + global search** — actions/entities/fuzzy; keyboard map.
10. **Multi-window** — detachable replay/stats windows.
11. **Plugin v1** — manifest + metric/template/WASM hooks, sandbox, local API (loopback, token).
12. **Docs & polish** — metric definition pages, plugin authoring guide, shortcut sheet, perf hardening.

Ordering note: 1–3 are the differentiator core; 8–10 are UX leverage; 11 is gated on 1 being stable. Cut line for release: if scope squeezes, ship 1–7 + 9 first; plugins/multi-window can slip within M5.

**Cut-line record (2026-10-31 implementation):** shipped = 1, 2, 3, 6, 9 + theme + clips (7) + declarative plugins (11 without scripting/API) + spatial series subset of 4. **Descoped with rationale:** item 5 pattern detectors (needs bomb-site region polygons — map packs ship centers only; series + heatmaps carry spatial value), goja/lua scripting + loopback API (declarative bundles cover acceptance; scripting documented as v2), item 10 multi-window, resizable-layout persistence, shortcut config, annotations/notes/tags, zip bundle, spatial_series cache. Details + measurements in the status header above.

## 5. Testing & acceptance

- Metrics engine: property tests (aggregation identities), golden library fixtures (synthetic match corpus committed as tiny SQL seed — no demo bytes).
- SQL console: injection surface = read-only flag + timeout; fuzz statement handling; never expose write SQL.
- Sandbox: plugin capability tests (no FS/network escapes), CPU budget kill switch.
- Reports: snapshot tests of rendered MD/HTML against fixture library.
- Acceptance walkthroughs (exit criteria):
  1. Build "untraded deaths per 10 rounds by player" metric → pin as scoreboard column → save to a report.
  2. SQL: top 10 opening-duel winners across library → export CSV.
  3. Data explorer: inspect a `player_death` raw payload + its user-message neighborhood.
  4. Pattern: auto-flag 3 executes on the golden demo → open evidence replay.
  5. Clip: record an ace range with mixed voice → WebM on disk.
  6. Plugin: install a declarative plugin adding one metric + one report template → both appear without restart.

## 6. Performance targets

| Metric | Target |
|---|---|
| Custom metric preview (library, 100 matches) | < 1 s |
| Compiled metric as SQL (1 000 matches) | < 3 s |
| SQL console typical query | bounded by timeout (default 5 s) |
| Spatial precompute per match | < 20 s after import |
| Clip render (30 s @ 60 fps, 1080p) | ≤ 5× realtime |
| Command palette open | < 50 ms |
| Plugin metric call | < 50 ms typical, budget-enforced |

## 7. Risks & open questions

1. **SQL console safety** — read-only + timeout + row cap; document that the DB is user-local (worst case = user harming own data), but never grant write from the console UI.
2. **Expression language scope creep** — freeze v1 grammar early; complex needs escalate to SQL/views, not new syntax.
3. **Sandbox robustness** — goja/gopher-lua have long safety track records but capability APIs must be explicit; no raw `os` ever. WASM (wazero) is the harder isolation upgrade path — keep as v2 note.
4. **MediaRecorder/codec support varies by webview** — ffmpeg fallback for audio-mixed exports; per-OS matrix, **Linux/WebKitGTK leg measured 2026-10-30** (`ref/findings/findings-webview.md` round 2): capability is **`gst-plugins-good`-dependent** — with it: `audio/webm;codecs=opus` ✓, `audio/ogg;codecs=opus` ✓, `video/webm;codecs=vp9` ✓, h264/mp4 ✗ (ffmpeg needed for those); without the plugin only `audio/ogg;codecs=opus` survives. End-to-end encode roundtrip proven (600 ms tone → 16 KB webm/opus blob). macOS WKWebView + Windows WebView2 legs unmeasured.
5. **Community plugin trust** — hash-pinning + explicit install warnings; no auto-update.

## 8. Definition of done

- Every P2 system in this plan either shipped or explicitly descoped in §4 cut-line note with rationale.
- PRD §5.16 example queries all demonstrably expressible; §5.17 inspectors show real payload breadth on the golden demo.
- A third party can write a plugin metric using only the authoring guide.
- `make lint vet test` green; §6 measured; release ships via the repo's release skill.
