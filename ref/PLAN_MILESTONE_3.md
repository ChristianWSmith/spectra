# Spectra — Implementation Plan: Milestone 3 (Deep Match Analytics)

**Status: implemented 2026-10-31** — `internal/analytics` (classifications v1 with explanations, player_round_stats + KAST, clutch v2, engagements, utility pairing, combat stats, side recovery for disconnected players), migration 003, analyze stage in the import worker, `AnalyticsService`/`ProfileService` (config/rule versions + explicit recompute, heatmaps streamed from the sidecar, saved filters, career rollups), frontend: Match tabs Economy/Utility/Heatmaps/Combat, KAST column, classification chips + round compare picker, `#/player/:steamid` profile, `#/compare/:id`, advanced FilterBar + saved presets, Settings analysis-rules form + metric definitions. Fixture `donk.analytics.json` (`-update`): clutches **27** (4 won — v1 approximate counted 3 won, +1 delta per PRD §9.2), KAST avg **75.0 %**, classes {pistol 2, full 19, force 2, save 1}, engagements {opening 24, trade 64, untraded 128}, utility 478.

**Measured (golden demo):** analytics pass **0.06 s** (target <10 s), heatmap presence **457 ms** / kills 15 ms (<2 s), event filter query **7 ms** (<100 ms), profile load **1 ms** (<200 ms), career rebuild **45 ms** (<5 s). X11 smoke walked the full DoD: economy explanation (curve + class chips + computed/inferred badges), heatmap generate + bbox drill contract, clutch cards with replay seek, two-round compare, saved-filter UI, profile page, Settings rules + recompute. **Known rough edges** (non-blocking, single-match data): winner-spend-advantage card showed $0, per-side K/D 0.00 + weapon-HS zeros on profile, flash durations 0.0s (blind payload lacks duration), R1 money samples 0, player-round money/equip/spent = 0 (item_equip payloads carry no prices — documented), entry engagement kind deferred (extractor entry_kills column covers attribution), CompareRounds ghost overlay deferred.

**PRD reference:** §5.2 (advanced scoreboard), §5.3 (classification), §5.6 (combat), §5.7 (economy), §5.8 (utility), §5.10 (heatmaps/spatial), §5.12 (clutches), §5.13 (player profiles), §5.5 (filtering), §10 Milestone 3
**Depends on:** M1 (events, stats, store), M2 (positions, map packs, replay sync)
**Exit criteria (PRD §10):** a user can investigate player performance, economy, utility, positioning, and tactical patterns across individual matches and their imported match library.

---

## 1. Grounding facts

- The extractor already computes (or trivially can, per EXTRACTION_TECHNIQUES §7): trade kills (5 s window), entry kills, clutches (approximate), multi-kills, streaks, ADR, accuracy, HS%, kill distances, utility attribution, freeze-end equip/money samples. M3 turns these into first-class stored columns + UI, and upgrades the approximations.
- M2 delivers per-frame positions + map packs — heatmaps and spatial analytics become render problems, not extraction problems.
- PRD discipline: **configurable definitions with transparent rules** (trade window, round classification) and **heuristics labeled as inferred** (§6.1, §5.10).
- Cross-match identity: SteamID64 keys already survive reconnects (M1 `getAgg`); profiles aggregate across `matches`.

## 2. Scope

**In:**

1. **Round classification** — pistol / anti-eco / eco / force / full-buy / bonus / save, plus retake, post-plant, clutch tags. Configurable thresholds (equipment-value cutoffs per side, pistol detection by round number/side-switch pattern). Stored per round with rule version + explanation string (why it classified that way).
2. **Economy analysis** — per-round team equip/money curves, spend vs outcome scatter, loss-bonus progression (reconstructed, labeled reconstructed), damage-per-dollar / kills-per-dollar, force-buy win rate, pistol conversion (pistol round → next-round win), lost-equipment value, purchase consistency. UI: economy tab per match + round-strip overlays (equip delta coloring).
3. **Combat & engagement deep dive** — kill detail cards (from M1 events + M2 positions): distance, wallbang/smoke/blind flags, attacker-victim geometry on the map (seek replay). Damage analysis: damage-without-kill, damage-before-death, friendly fire, damage conversion. Engagement types: opening duels, entry trades, untraded deaths, trade opportunities missed (victim died, teammate had line/position — heuristic v1: teammate within X units & alive ≤ 5 s later).
4. **Utility analysis** — per-grenade cards (thrower, tick, arc via M2 trajectory, detonation, affected players, damage, flashes), team utility spend per round, flash effectiveness (enemies flashed / duration vs team-blind), smoke coverage timeline per site, molly denial (time-to-area contested — heuristic v1: kills/damages inside burn window).
5. **Heatmaps** — per player/team, per selection (whole match / rounds / player filter): time-weighted presence, kills, deaths, damage, engagements, plant/defuse. Canvas layer over M2 map packs; opacity/colormap controls; click region → timeline filter by position bbox (P1).
6. **Clutch upgrade** — replace M1's sole-survivor approximation with alive-count timeline analysis: detect 1vN start (when Nth teammate dies) → participants, bomb state, HP/equip, outcome. Store clutch records; UI cards with replay deep-link.
7. **Player profiles (cross-match)** — per SteamID: match history, career aggregates (ADR/KD/HS%/KAST trends over time), map breakdown, side breakdown, weapon proficiency, opening-duel & trade & clutch rates, consistency (stddev of ADR). Profiles view + player picker.
8. **Advanced event filtering** — full filter bar: type, round range, player, team, weapon, tick range, distance, damage range, outcome, position bbox; combinable; **saved filter presets** (named, per-library); "open in timeline" from any stat drill-down.
9. **KAST** (if not stretched into M1) — per round: kill / assist / trade-death / survived; stored per player-round for profile trends.
10. **Round comparison** — pick 2–4 rounds, side-by-side: economy, loadouts, utility, event sequences, replay ghost overlay (M2 data; simple: two trail sets, no analytics).

**Out (deferred):** team tactical pattern recognition & recurring-setup detection (M5), custom metric builder (M5), lineup catalog, communication analytics (M4+), behavioral archetypes (M5 — needs cross-match volume), anomaly detection.

## 3. Storage additions (schema v2+)

```
round_classifications(match_id, round, label, confidence, rule_version, explanation)
player_round_stats(match_id, round, steam_id, kills, assists, deaths, traded,
                   survived, kast, dmg, money_start, equip, spent, util_dmg, …)
clutches(match_id, round, size, attacker_steam, start_tick, end_tick, bomb_state,
         hp_left, equipment, won, kill_ticks_json, replay_anchor_tick)
engagements(match_id, tick, round, kind, a_steam, b_steam, distance, won_by,
            supporting_event_ids_json)          -- opening/entry/trade/untraded
utility_events(match_id, tick, round, thrower, kind, throw_pos, det_pos,
               affected_json, damage, flash_ms_total, site, trajectory_ref)
spatial_samples_ref(match_id) → points at M2 sidecar (no duplication)
heatmap_cache(match_id, kind, filter_hash, generated_at, blob_path)  -- optional
player_career(steam_id, matches, adr_avg, adr_std, kd, hs_pct, kast, …)  -- rollup, rebuildable
saved_filters(id, name, scope, filter_json, created_at)
analysis_config(trade_window_s, eco_thresholds_json, …)  -- single-row, versioned
```

Rules table versions matter for reproducibility (PRD §9.2): changing a threshold records a new `rule_version`; stored rows keep the version they were computed with; a "recompute analysis" action reclassifies explicitly (never silently).

## 4. Computation strategy

- Heavy derived rows computed at **extraction time** in M1 style (they need the parse pass context), plus a second **analytics pass** over the stored events+positions after import (cheaper to iterate than re-parsing).
- `internal/analytics` package: pure functions `(events, positions, config) → rows` — unit-testable without demos; the golden demo's committed baseline fixture (M1 §6) is the regression anchor. Research-demo FINAL_REPORT numbers stay as human reference only.
- Heatmaps: streamed over position sidecar (M2 reader), no full load; cache optional on disk under match dir.
- Career rollups: incremental `player_career` update on each import/delete (transactional); full rebuild command for rule changes.

## 5. UI surface

```
views/
  Match.svelte            new tabs: Economy | Utility | Heatmaps (Overview grows links)
  PlayerProfile.svelte    cross-match profile (#/player/:steamid)
  CompareRounds.svelte    round comparison overlay
components/
  HeatmapLayer.svelte     canvas over map pack; kind + filter controls
  EconCurve.svelte        team money/equip over rounds (SVG)
  ClutchCard.svelte       1vN summary + replay deep-link
  FilterBar.svelte        composable filters → timeline
  StatDrill.svelte        every headline stat click → filtered events/rounds
```

Progressive disclosure (PRD §8.1): headline numbers first, drill-downs one click; raw tables behind "details". Fact/inference badges on reconstructed/derived/inferred rows (loss-bonus reconstruction, trade opportunities, flash effectiveness heuristics).

## 6. Work breakdown

1. **Analytics core** — `internal/analytics`: player_round_stats, KAST, trade opportunities, clutch v2, classifications v1; config row + rule versions; unit tests with synthetic event sets.
2. **Economy pass** — curves, conversions, scatter; match Economy tab.
3. **Engagements & combat** — engagement detection, damage analysis, detail cards, map anchors via M2.
4. **Utility** — utility_events table, per-grenade UI, team spend, flash/smoke summaries.
5. **Heatmaps** — sidecar streaming reader → canvas layer; kind switcher; bbox filter wiring.
6. **Profiles & career** — rollup job, profile view, trends charts (SVG sparklines, no chart lib yet unless needed).
7. **FilterBar + saved filters** — unify timeline/match filters; presets persistence.
8. **Round comparison** — side-by-side + ghost overlay.
9. **Reprocess UX** — recompute analytics after config/parser change, with provenance note in match header.

## 7. Testing & acceptance

- `internal/analytics` golden tests: synthetic sequences (known trade window, known 1v3) checked in and always run; plus golden-demo aggregates asserted against `donk.golden.json` (skip-if-absent, same harness as M1 §6). Clutch v1→v2 intentionally changes counts — regenerate the fixture after the upgrade and record the delta in the commit message (PRD §9.2).
- Heatmap sanity: time-weighted map of a full match covers both spawns and both sites; kill heatmaps cluster at known engagements (visual check via screenshot harness).
- Performance gates below measured on the golden demo.
- Exit-criteria walkthrough: open the golden demo → explain the winning team's economy advantage round-by-round, show where the top fragger got kills (heatmap), inspect the biggest clutch with replay seek, compare two eco rounds, save an "opening deaths" filter and re-use it across matches.

## 8. Performance targets

| Metric | Target |
|---|---|
| Analytics pass after import (golden demo) | < 10 s |
| Heatmap generate (time-weighted, full match) | < 2 s, streamed |
| FilterBar apply (50 k events) | < 100 ms |
| Profile load (50 matches) | < 200 ms |
| Career rebuild (100 matches) | < 5 s |

## 9. Risks & open questions

1. **Heuristic creep** — every inferred metric (trade opportunity, molly denial, loss bonus) needs the §6.1 badge and a written definition page (Settings → Metric definitions). Budget UI time for it.
2. **Clutch v2 changes headline numbers** — expected; keep v1 numbers in old exports, note the upgrade in release changelog.
3. **Chart library** — hand-rolled SVG for sparklines/curves first; adopt a lib only if box plots/scatter get expensive (PRD §5.16 viz list lives in M5 anyway).
4. **Heatmap cache invalidation** — key on (match, filter, format version); delete on reprocess.

## 10. Definition of done

- All P1 items in §2 shipped; every stat click drills into evidence (events/rounds/replay).
- Classification & trade-window configurable from Settings; versions recorded.
- Golden demo baseline reproduced from the UI; clutch v2 has documented expected values in the regenerated fixture.
- `make lint vet test` green; perf table measured.
