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
| Side-parity / half-switch arithmetic | `internal/rules` (`FlipIndexes`, `SideAt`, `OtherSide`) | One formula for analytics, store, services; cross-language fixture `internal/rules/testdata/sideparity.json` asserted in Go and `frontend/src/lib/sideparity.test.js`; `RoundStrip.svelte` uses it too |
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
| Router | `lib/router.js` (`parseHash`, `MATCH_TABS`) | characterization-tested; all Match tabs deep-linkable, legacy `#/timeline/:id` redirects |
| Hand-offs | `lib/handoff.js` | the only module that touches `sessionStorage` |
| Definition/tooltip strings | `lib/definitions.js` | Settings' glossary renders the same `GLOSSARY` array the tooltips import |
| Errors / nav / formatting / CSV / download | `lib/services.js` `errText`; `lib/nav.js` (`isSteam`, `openProfile`, `NAV_ACTIONS`); `lib/fmt.js`; `lib/csv.js`; `lib/download.js` + `lib/save.js` | sidebar and command palette share `NAV_ACTIONS` |
| Dialogs & popovers | `components/Dialog.svelte`, `components/Popover.svelte` | Escape/outside-click/focus-return; busy-gating stays with the consumer (MapPackPrompt) |
| Sortable headers / stat cells | `components/SortTh.svelte`, `components/StatCard.svelte` | components own markup only — each view keeps its own sort state and backend |
| Event row bits | `components/EventFlags/EventPlay/ProfileLink.svelte` | scopes stay per-view (Timeline is the canonical *filter*) |
| Match pickers | `components/MatchPicker.svelte` | Explorer, Reports, Builder all use it |
| Landmark kinds | `lib/replay/landmarks.js` (`LANDMARK_KINDS`, `classifyLandmark`) | renderer, Replay scrubber, FilterBar |
| Coordinate transform | `lib/mapxform.js` `makeTransform` | renderer consumes it; camera and no-pack bounds fallback remain renderer-only |
| Glossary of rules for agents | AGENTS.md → "One canonical way" | this file is the deeper reference |

## Deliberate non-consolidations (distinct questions — leave alone)

Heatmaps vs Replay (aggregate vs live); Builder vs SqlConsole vs Reports;
CompareRounds vs RoundDetail vs Rounds tab; PlayerProfile vs Scoreboard;
Scoreboard vs Combat (summary vs deep-dive — share definitions, not
tables); RoundDetail feed / Combat engagements / Utility list / Context
stream (different scopes — share row bits only); per-match vs career
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

## Verification gates used

`make vet && make test && make lint`; full non-short `go test ./...`
(including `TestGolden` against `donk.dem.zst` — fixtures were never
regenerated without an explained diff); `node --test src/lib/*.test.js`
(93 tests); jsdom DOM suites in `frontend/test/`; svelte-compiler pass
over all components; EXPLAIN QUERY PLAN before/after for 15 hot
statements (byte-identical); visual smoke via the xdotool/spectacle
procedure in AGENTS.md.
