# Consolidation record — canonical homes

Outcome of the application-wide deduplication pass ("one canonical way to
do anything"). This file records **where each capability canonically
lives** and **which deliberate behavior changes were made**, so future
changes extend the canonical implementation instead of forking it. The
standing rules derived from this pass are in AGENTS.md → "One canonical
way".

## Canonical ownership

| Concern | Canonical home | Notes |
|---|---|---|
| Side-parity / half-switch arithmetic | `internal/rules` (`FlipIndexes`, `SideAt`, `OtherSide`) + frontend twin `lib/sideparity.js` | Cross-language fixture `internal/rules/testdata/sideparity.json` asserted in Go and `frontend/src/lib/sideparity.test.js`; `RoundStrip.svelte` consumes the JS twin. Go production caller is `rules.OtherSide` (clutches) — the parity *guess* for data without exact sides was removed in the legacy-fallback pass |
| Trade window / trade rule | analytics pass (`analytics.Compute` → `store.ReplaceTradeKills`) | `engagements(kind='trade')` is THE rule; extract's 5 s column is the import-time default Compute overwrites; teamkill gates mirrored between extract and analytics (`TestTradeKillsMatchExtractorAtDefault`) |
| Combat stats (KAST, DMG conv, entry, trade…) | `store.GetCombatStats` SQL | The Go twin (`analytics/combat.go`) was deleted; the 3 SQL decision drifts are pinned by `TestGetCombatStatsSQLDecisions` |
| Counted rounds | `analytics.CountedRounds` | SQL predicate cross-referenced at `store.GetEconomy`; frontend twin `lib/rounds.js` `isCounted` |
| Negative-round semantics | `store.queryEvents(exactRound)` | `Round < 0 = all` is the filter contract; round *detail* returns only that round (`round_detail_test.go`) |
| Analysis config building | `analytics.ConfigFrom` | The three literal sites (Recompute, GetEconomy, library.analyze) all call it; validation lives only in `SetConfig` |
| Side-parity/win/utility sets in models | `models.WinFor`, `models.IsUtilityWeapon`/`UtilityWeaponKind` | extract's enum is cross-referenced and set-equality tested |
| KAST/K-D SQL expressions | `kastPerMatchSQL`/`kastCareerSQL`/`kdPerMatchSQL`/`kdCareerSQL` consts in `store/queries.go` | per-match vs career are deliberate scope variants |
| Player name joins | `store.playersJoin(...)` | builds all 11 join fragments; LEFT joins carry the empty-steam guard, INNER joins deliberately do not |
| Column lists | one `<table>Cols` const per table in `internal/store` | pinned to DDL by `TestColumnListConstsMatchSchema`; metrics whitelist + DDL stay separate copies, reconciled by `metrics.TestSchemaConsistency` |
| Delete-then-insert writers | `store.replaceMatchRows` | voice/plugin/SaveExtracted keep bespoke tx (atomicity/upsert reasons in code) |
| Single-match lookups | `store.GetMatchSummary` / `GetTeamNames` + `MatchService.*` | never fetch the whole library for one row; `replayservice` uses `GetPlayerRefs` |
| EventRow → Event conversion | `models.EventFromRow` | payload-free by design; blind-event payloads reach analytics via `store.GetBlindFlashDetails` (keyed by `events.seq`) |
| Read-side caching | `services.js` `cachedRead` | keyed `(method, args)`, flushed on every `spectra:*` event and on mutating wrappers (delete/reprocess emit no event); explicit `invalidate()` |
| Router | `lib/router.js` (`parseHash`, `buildHash`, `MATCH_TABS`) | characterization-tested; all Match tabs deep-linkable; query-carrying routes (`?cat=…&round=…`) parse onto the route object |
| Durable cross-view state | the route query (`buildHash` + `parseHash`) | the one-shot sessionStorage hand-offs (`lib/handoff.js`: timeline-filter, replay-seek, compare-rounds) were retired with the landmark consolidation — every writer now navigates with query params, so deep links/refresh/back-forward preserve context by construction |
| Raw-event browsing (one per match) | Replay's landmark feed + `lib/replay/landmarks.js` | THE categorization (CATEGORIES registry, sparse default kills+round_wins, normalization, feed merge, filter↔query serialization); the feed list, scrubber markers and renderer world layers all consume its pre-bucketed rows — no second classifier anywhere |
| Event retrieval (source paths) | `store.queryEvents` (typed, incl. `Kinds`) / `store.queryChat` / `store.GetGenericEvents` | three paths because there are three tables — no universal event query; generic-event payload labels parse in ONE place: `eventlabels.go` (the JS copy died with Context) |
| Chat time formatting | `fmt.js` `chatClock` | the retired Match Chat tab's clock moved here (round-relative with the match-clock fallback); Replay's feed and RoundDetail's round chat both render it |
| Landmark row presentation | `components/LandmarkRow.svelte` | one row renderer for the feed AND CompareRounds' compact event sequence (source-aware text, category chip, select/seek actions) |
| Definition/tooltip strings | `lib/definitions.js` | Settings' glossary renders the same `GLOSSARY` array the tooltips import |
| Errors / nav / formatting / CSV / download | `lib/services.js` `errText`; `lib/nav.js` (`isSteam`, `openProfile`, `NAV_ACTIONS`); `lib/fmt.js`; `lib/csv.js`; `lib/download.js` + `lib/save.js` | sidebar and command palette share `NAV_ACTIONS` |
| Dialogs & popovers | `components/Dialog.svelte`, `components/Popover.svelte` | Escape/outside-click/focus-return; busy-gating stays with the consumer (MapPackPrompt) |
| Search suggestions | `components/SuggestInput.svelte` | the ONE suggestion dropdown (input + anchored panel, ↑↓/Enter/Esc, substring filter capped at 10): the Library's map & player facets, the Profiles search and the profile finder all render through it instead of keeping their own popovers; sources are `store.ListMapNames` (distinct library maps) and `ProfileService.ListPlayers` (library-wide) |
| Sortable headers / stat cells | `components/SortTh.svelte`, `components/StatCard.svelte` | components own markup only — each view keeps its own sort state and backend |
| Event row bits | `components/LandmarkRow.svelte` (the row), `EventFlags/EventPlay/ProfileLink.svelte` | one row renderer for the Replay feed AND CompareRounds' compact sequence; flags/▶/profile stay shared bits |
| Match pickers | `components/MatchPicker.svelte` | Explorer, Reports, Builder all use it |
| Landmark categories | `lib/replay/landmarks.js` (`CATEGORIES`, `LANDMARK_KINDS`, `drawBucket`, `normalize*`) | the ONE categorization: feed list, scrubber markers and renderer world layers consume its pre-bucketed rows |
| Coordinate transform | `lib/components/mapxform.js` `makeTransform` | THE pack→transform reader — the renderer consumes it (including the additive `layers`/`elevation_regions` passthrough and per-layer transform overrides; stale `elevation` keys are deliberately NOT read); camera and no-pack bounds fallback remain renderer-only |
| Radar layer assignment + elevation indicators | `lib/replay/layers.js` (`layerIndexForZ`, `elevationFor`) + `renderer.js` `flightSplits` | half-open `[z_min, z_max)` bands (a shared boundary belongs to the band whose `zMin` it is), default-layer fallback for unknown Z, REGION-ONLY threshold resolution (`elevationFor` reads `elevation_regions` boxes only — per-floor `elevation` keys are not part of the pack contract — redundant: the panels already say which floor an entity is on; boxes may carry an optional half-open `z_min`/`z_max` floor scope so a threshold can't misfire across bands — e.g. Nuke's catwalk ring ends at −495); `flightSplits` cuts floor-crossing nade flights into per-panel segments. The T/⊥ glyph itself is CANVAS-DRAWN (`renderer.js` `drawElevationIndicator`: a stem from the entity's centre + the flat bar, dark halo under a tinted body — no extracted icon, no text fallback; `TestNoElevIconTable` pins the extractor's deliberate lack of elevation glyphs). Extractor side: `internal/mappack` (`verticalsections` → `meta.layers`; `preserveElevation` carries `elevation_regions` and drops stale `elevation` keys) |
| Glossary of rules for agents | AGENTS.md → "One canonical way" | this file is the deeper reference |

## Deliberate non-consolidations (distinct questions — leave alone)

Heatmaps vs Replay (aggregate vs live); Builder vs SqlConsole vs Reports;
CompareRounds vs RoundDetail vs Rounds tab; PlayerProfile vs Scoreboard;
Scoreboard vs Combat (summary vs deep-dive — share definitions, not
tables); Combat engagements / Utility list (derived analytics — they link
into the landmark feed, they do not browse events; share row bits only);
per-match vs career
rollups (share SQL consts, keep variants); renderer camera/fallback;
`fmtClock` tick vs second units; palette vs sidebar nav (share the list,
different modality); `internal/plugin.MetricDef` / `store.PluginMetricDef`
(manifest schema and write input — not service DTOs).

## Behavior changes made with approval

1. **Overtime side parity** — `RoundStrip.svelte` uses the backend's
   floor-division formula (regulation provably unchanged; diverges only
   for `switches ≥ 2`).
2. **Negative-round round detail** — knife/warmup round detail returns
   that round's rows, not the whole match (`Round < 0 = all` preserved
   for filter callers).
3. **Trade-window config now reaches every surface** — scoreboard Trade,
   career trades, profile TradeRate, `successful_trades`, Combat tab all
   follow `analysis_config` after recompute; at default 5 s every number
   is unchanged (golden byte-identical). Teamkill "answered" pairs are
   no longer counted as trades anywhere (they previously disagreed
   between surfaces; zero occurrences in golden).
4. **`flash_ms` was dead in production** — blind-event durations now
   flow via `GetBlindFlashDetails`; Utility/CompareRounds/report show
   real blind times (donk.dem: 160/182 flash rows non-zero, 1,058,868 ms
   total; golden carried no flash field, unchanged).
5. **Report economy enrichment** — `match.md` economy rows gained
   `CT buy`/`T buy` columns matching the Economy tab.
6. **Match Raw tab removed** — Explorer owns the inspectors; the Match
   header link preserves match context (`#/explorer/:id`).
7. **Layout** — five views (Economy, Utility, Heatmaps, Combat, Context)
   now honor the 1400 px `.view` cap.
8. **Dialog behavior** — MapPackPrompt gained busy-gated Escape;
   PlayerProfile results gained outside-click/Escape dismissal; Combat
   modal gained focus return.
9. **KAST scoreboard sort** implemented against `combatBySteam` (was a
   no-op); KAST modal derives from the displayed column value.
10. **Cosmetic unifications** — `fmtMoney` (signed, whole dollars for the
    metric currency column), CSV exports CRLF + CR-escaping fix, palette
    action order follows the sidebar, one badge/note/chip-state look per
    concept, corrected tooltip provenance text (Entry%, opening rate,
    trade window, trade opportunities missed).
11. **Bindings boundary** — services return `models.*`; JSON gained
    additive fields (`label`, `explanation`, `matchId`, `ruleVersion`,
    `seq`, metric `createdAt`/`denominator`, RFC3339 `extractedAt`) — no
    key renamed or removed.

## Landmark consolidation pass (Replay owns the raw-event experience)

Third pass: **one canonical raw-event browser per match, owned by
Replay's landmark feed.** The PRD §5.5 universal event explorer now lives
inside the tactical replay instead of as separate destinations.

**What consolidated into the feed** (`lib/replay/landmarks.js` +
`Replay.svelte`'s side panel):

- The feed composes the three source-specific reads (typed
  `MatchService.GetEvents` with the new `EventFilter.Kinds` IN-filter,
  `MatchService.GetChat`, `LibraryService.GetGenericEvents`) — no
  universal event query; source tables keep their own retrieval paths.
- Category registry `CATEGORIES` with the **sparse default: kills +
  round wins only**; every other category (bomb, grenades, damage,
  blinds, connects, chat, team changes, ConVars, name-scoped game
  events) is opt-in. Generic high-volume sources load by name only
  (histogram-gated) — never unrestricted.
- `normalizeEvent/Chat/Generic` stamp every row with `source`,
  `category` and a precomputed `bucket`; the list, the scrubber markers
  and the renderer's world layers all read those fields (the renderer no
  longer classifies anything, and `classifyLandmark` is gone).
- Chat merges chronologically with typed events (tick → source →
  sequence tie-break); chat rows render `fmt.js chatClock` in the detail.
- Detail inspection: typed facts + `detail.json`/`raw.json` (via
  `GetEvent`), chat sender/clock/kind, generic `PayloadTree` + raw —
  the detail replaces the list in the narrow panel and closes back to it.
- Generic-event payload labels parse in Go only (`eventlabels.go` —
  `parseConVarPayload` moved out of `platformservice.go`); the retired
  Context view's JavaScript copy was deleted.

**Retired views/routes** (legacy hashes redirect to the feed):
`Timeline.svelte` and `Context.svelte` deleted; the Match Chat tab
removed (header **Chat** button → `?cat=chat`); `#/match/:id/timeline`,
`#/match/:id/chat` and `#/match/:id/context` resolve to
`#/replay/:id` with the equivalent scope; Explorer lost its generic
payload browser, histogram, ConVar table and warnings panel (warnings
consolidate to the Match header; Explorer keeps provenance, entity
summary and the census reference as the diagnostics surface).

**Removed backend surface:** `ReplayService.GetLandmarks`,
`store.GetLandmarks` + `landmarkKinds` + `LandmarkLimit` (the feed's
draw set is `queryEvents` with `kinds: DRAW_KINDS`),
`PlatformService.GetConVars` (its data is the labelled server_cvar feed).

**Removed frontend surface:** `lib/handoff.js` and all three
sessionStorage hand-offs (timeline-filter, replay-seek, compare-rounds —
replaced by the route query), `services.js` pending-* wrappers,
`RoundDetail`'s kill feed (economy/chat stay; **Events in Replay**
entry point added), CompareRounds' per-round `getEvents` (its
`GetRoundDetail` response already carries the sequence).

**Navigation model:** `replayHash(matchId, filter, extras)` (`lib/nav.js`)
is the one way into the browser; `?cat/?round/?player/?weapon/?tick*/
?dmg*/?dist/?hs/?bbox/?gname` carry the durable filter, `?tick/?sel` the
entry position/selection and `?back` the origin path (used by
RoundDetail/Compare/Replay Back buttons so drill-downs return to their
source). `?rounds=` on `#/compare/:id` replaced the one-shot compare
hand-off (selection now survives refresh/back). Saved filter presets are
stored in the serialized query shape.

**Layout/behavior notes:** the lanes strip is height-aware (hidden by
default below an 820px viewport, toggle in the voice bar); the detail
pane replaces the list while open (the panel is one scroll region);
scrubber markers follow the enabled categories + round/player scope
(the map's world layers always show the drawable set); Timeline's knife/
warmup round selection, export, saved presets, voice "Hear ±10s" and
payload inspection all moved into the feed.

## Legacy-fallback / migration removal pass (pre-release)

Second pass: the app is 100% pre-release, so everything whose only job was
to serve data or links from an older pre-release build was deleted rather
than maintained. The standing policy is in AGENTS.md → "Version nothing
until the first release — no versioned migrations, no versioned
contracts, no legacy-data fallbacks".

- **Versioned schema migrations → one baseline.** `migrate.go`, the
  `schema_version` table, and `migrations/001–010.sql` are gone;
  `internal/store/schema.sql` + `schema.go` hold the complete schema and
  run (idempotently) on every `Open`. ALTERs were folded into their
  CREATE TABLEs (verified byte-identical column/index metadata against
  the old path before deletion); `009`'s threshold data-fix and `010`'s
  `two_k` backfill were dropped (`store.DefaultConfig` already seeds the
  corrected thresholds; the extractor writes `two_k`). Stale dev DBs are
  no longer upgraded — recreate them.
- **`analytics.RecoverSides` + side-parity guesses deleted.** Evidence on
  `donk.dem`: 10/10 players have a final side, 23/23 counted rounds have
  exact `round_player_sides` for every player, and `RecoverSides` changed
  0/10 sides — the graph recovery and the `HalfSwitchRound`/`FlipIndexes`
  parity fallback (`resolveRoundSides`, `store.sideFlips` heuristic,
  heatmap `sideAt`) were dead for new imports. Missing data now means
  unknown sides → skipped team-dependent rows, never a guess.
- **Frontend shims removed:** the legacy `#/timeline/:id` rewrite
  (`canonicalize()`), string-typed pref coercion (writers verified to emit
  JSON booleans), and the unreachable `he`/`he_explode` event-kind aliases
  (not in `models.EventKind`; the utility-kind `"he"` is a different
  vocabulary). The renderer's final-side fallback was **kept** — the
  side bits are legitimately absent for dead/unassigned slots.
- **Versioned contracts flattened (third pass).** The state stream's
  format ladder (`stateFormatVersion`, `stateCapable`, the
  "reprocess to regain state" note), the positions sidecar's
  `formatVersion` field + `q16-v2` encoding name, and the map pack's
  `schema_version` key were deleted: each contract is described once as
  THE current layout, absence fails soft (no state stream ⇒ state-less
  cards; a missing pack ⇒ grid fallback), and stale local data is
  deleted and re-imported. Structural corruption guards (mask legality,
  truncation, monotonic frames, record-count/frame-count consistency)
  stayed — they are not version machinery.
- Golden fixtures byte-unchanged; only behavior changes are the two
  expected ones (no auto-upgrade of stale DBs; no parity guess for data
  lacking exact sides).

## Verification gates used

`make vet && make test && make lint`; full non-short `go test ./...`
(including `TestGolden` against `golden/de_cache.dem.zst` — fixtures were never
regenerated without an explained diff); `node --test src/lib/*.test.js`
(93 tests); jsdom DOM suites in `frontend/test/`; svelte-compiler pass
over all components; EXPLAIN QUERY PLAN before/after for 15 hot
statements (byte-identical); visual smoke via the xdotool/spectacle
procedure in AGENTS.md.
