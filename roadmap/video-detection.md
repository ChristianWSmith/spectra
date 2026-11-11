# Highlight & mistake detection — roadmap research

**Unit:** video-detection · **Priority tier:** P2 · **Date:** 2026-11-10
**LoE (aggregate):** M — most rules are derivations over already-stored rows (clutches table, per-kill flags, kill-time inventory drops, blind rows); the week-class cost is the shared detector-engine coordination, the user-extendable rule surface, and the reels composition view — video encoding itself belongs to the video-export unit.
**Feasibility:** high — every rule grounds out on data the extractor/analyzers already store; blockers are definitional (spray transfer, ninja defuse, molotov-in-smoke have no CS2.md entry) and sequencing (engine shared with stats-advanced item 4; reels consume video export).

## Items in scope

1. **Rule-driven highlight detection** — aces, clutches, no-scopes, spray transfers, ninja defuses each with its tick, assembled into reels
2. **Automatic mistake flagging** — flags such as dying while holding a nade, self-flash, teamkill, unused defuse kit, molotov-in-smoke; built-ins, but user-extendable

## Current state

**Highlight rules — already derivable from stored data (no new detector):**

- **Clutches:** the canonical detector already exists — `src/internal/analytics/clutches.go` writes the `clutches` table (`StartTick`/`EndTick`/`KillTicks`/`ReplayAnchor`/`Won`/`HPLeft`), surfaced today by the Combat tab's Clutches card with a provenance chip and tick seek. Highlight detection must **consume this table, never fork it** (AGENTS canonical-homes rule).
- **No-scopes:** `events.noscope` is stored per kill (extract pairs the raw `player_death` payload), plus `events.weapon`. The frontend already has the scoped-sniper gate twin (`renderer.js` `NOSCOPE_WEAPONS` = AWP/SSG 08/SCAR-20/G3SG1) and the `EventFlags.svelte` `NS` badge — a highlight rule is a one-line predicate over stored rows.
- **Aces:** `player_stats.five_k` (and `four_k`) exist but are per-match counts with no tick. The tick needs a small read-side derivation: kills grouped by `(round, attacker)` from `events` — the exact-tier semantics live in extract's `buildMultiKills` / CS2.md "Multi-kill columns" and must be reused, not re-expressed.
- Kill flags generally (`wallbang`, `through_smoke`, `attacker_blind`, `attacker_inair`, `headshot`, `distance`) are stored per kill — free future highlight seeds.

**Highlight rules — need new detectors:**

- **Spray transfers:** consecutive kills by the same attacker within a short time gap (optionally victim-position distance — `events.pos_*` exists on both victims). CS2.md has no "spray transfer" entry → definition lookup + documented threshold (`analysis_config`) required per the domain rule.
- **Ninja defuse:** derivable in the `clutches.go` pattern — walk the round's events + `round_player_sides` alive sets; flag a completed `bomb_defuse` while ≥1 opponent is alive. CS2.md has no "ninja" entry; the honest predicate is observational ("≥1 enemy alive at completion") — "undetected/unaware" is a judgment and must not be part of the stored rule.

**Mistake flags — derivability inventory:**

- **Dying while holding a nade:** authoritative kill-time inventory is already stamped at extract — `weapon_drop` rows with `detail_json.cat = "util"` (`src/internal/extract/drops.go`, THE one drop rule; 1174/1174 kills verified intact inventory). **This is the same computation as stats-advanced item 4's "unused grenades ($ lost)" — one implementation, price from `models.UtilityPrice`.**
- **Unused defuse kit:** same drops read, `cat = "kit"` (kit possession from the pawn's `m_bHasDefuser` at the death tick — CS2.md pins kits as non-inventory). Predicate: "died owning a kit" (observational; "unused" = never defused that round is checkable from `bomb_defuse` rows).
- **Teamkill:** kill events where attacker/victim share the round's side via `round_player_sides` (extract already excludes teamkills from credit; per-tick flag is a read-side derivation). A round without side samples yields **unknown, never a guessed flag** (honest-metrics / no-fallback policy).
- **Self-flash:** `blind` events store both attacker and victim keys (`agg.blind`) — `attacker == victim` is the flag.
- **Molotov-in-smoke:** the tempting exact signal is dead — CS2.md pins `inferno_extinguish` at **0 fires across a 388-demo corpus**. The viable predicate is spatial/temporal overlap: a fire detonation (`grenade` event, Molotov/Incendiary, `pos_*`) inside an active smoke's linger window (smoke ≈18 s per CS2.md; smoke detonation also carries `pos_*`) with a documented radius tolerance. Needs a CS2.md/web lookup for the extinguish mechanics + radius — the riskiest rule of the set.

**Surfacing today:** no moments/highlights/reels surface exists. Existing patterns: `LandmarkRow` seek rows (Combat deep-links engagements/clutches into Replay with ±10 s loops via `nav.replayHash` + `entryLoopAround`), `EventFlags.svelte` per-kill badges, the Replay feed's one categorization (`lib/replay/landmarks.js` — raw events only), and an in-app WebM clip recorder in `Replay.svelte` (MediaRecorder over the canvas, loop range or 10 s from playhead) — a single-window stopgap, not the full video export.

**User-extendable rule machinery:** `internal/metrics` is a **frozen v1 aggregate grammar** (`from <table>: agg…`, whitelisted columns, `group_by`, Value-0-with-N honesty) — it cannot express per-tick predicates or emit a seek target, so flags need a **sibling declarative rule schema**, not metric expressions. Precedents: `metrics/seed.go` builtin origins, `round_classifications` required explanation strings, `analysis_config` thresholds + `rule_version` + `RecomputeAnalysis`.

## Implementation path

### 1. Rule-driven highlight detection — LoE: M

- **Detection (S):** one new detector module in `internal/analytics` (beside `clutches.go`; invoked from `analytics.Compute`) emitting one row per highlight into a new baseline table, e.g. `moments(match_id, kind, polarity, tick, round, steam_id, why, …)`. Rules: clutches and (later) ninja defuses consume stored/derived rows — clutches read the `clutches` table directly; ace/no-scope/spray-transfer are pure functions over fetched `events`. Thresholds (spray-transfer gap) ride `analysis_config` with `rule_version` + recompute, per the established contract. A new table is cheap under the no-migrations policy (added columns to existing tables don't reach old DBs — new tables do).
- **Why stored rows, not on-read only:** stats-advanced item 4 already specifies moments rows written alongside `Compute`; library-scale surfaces (PlayerProfile self-review, cross-match reels) need queryable rows; the SQL console sees new tables for free. Cheap pure derivations can additionally be exposed as on-read helpers for the Builder/queries.
- **Reels (M, the real cost):** a reel = an ordered list of `{moment ref | explicit tick range, lead, tail}` per match. Storage: new `reels`/`reel_segments` tables (queryable, exportable — preferred over a sidecar for the same reason moments are rows; sidecars are for unqueryable blobs like drawings). Composition UX: a Moments/Reels panel where detections (and later bookmarks) are ticked into an ordered reel, reorder/remove, each row with the `LandmarkRow`-style seek + "watch" action = chained `replayHash(id, filter, {tick, loop})` entries — **in-app sequential playback works with zero encoding** and is the v1 deliverable.
- **Sequencing vs video export:** actual file output (WebM/MP4/GIF, HUD burn-in, frame-rate, headless CLI) is the **video-export unit's**; this unit owns detection + reel composition and hands the reel off as a queue of tick windows. Do not build a second encoder; the existing `Replay.svelte` MediaRecorder path is the interim single-window stopgap a reel can queue against.
- **UI placement:** Match tab section or a dedicated view following existing card/table patterns (Combat's Clutches card is the closest precedent, including the provenance chip = honest metrics).

### 2. Automatic mistake flagging — LoE: M

- **One shared engine, de-conflicted with stats-advanced item 4:** both roadmap items need the same machinery — rule registry, moments storage, Moments panel, tick jump. **Proposal: stats-advanced (P1) owns the engine core** — the moments table + `Compute` integration + Moments panel + seek affordance, since its doc already specs `{kind, tick, round, player, why, severity}` rows and its four detectors (untraded deaths → consume `engagements`; unused grenades → the drops read) are subsumed by this item's flag set. **This unit owns the rule set fed into that engine** (the five built-in mistake flags above + the highlight rules of item 1), the **user-extendable rule surface**, and reels. The contract both sides build against: one rule registry `{id, predicate, documented why, polarity, thresholds via analysis_config}`, one `moments` table, one Moments surface — never two engines, never a second rule layer (the stats-advanced doc demands the same). If the orchestrator schedules this unit first, the same contract is built from this side; the risk being managed is co-scheduling, not design.
- **Built-ins (S–M):** the five flag predicates per the inventory above; each is a documented observation with a required `why` (the `round_classifications` explanation rule), stored English-in-DB until localization.
- **User-extendable (M):** flags as **declarative rules**, not metric expressions — a sibling `flags:` schema (YAML-shaped, schema-validated) in the same user-rules directory the "User-authored YAML metric rules" unit creates, with the same import/export story; built-ins seeded with `builtin` origin (the `metrics/seed.go` precedent) so user rules can disable/tune/extend them. Field names aligned with `analysis_config` thresholds so built-in stopgap and YAML long-term home stay compatible (the pattern stats-advanced item 1 already commits to).
- **Honest-metrics obligations:** every flag documents its predicate (a `Formula`-style string + N); flags are **observations, not judgments** — "died holding a grenade" yes, "bad decision" no. If a `severity` field rides along (stats-advanced's row shape), it must be a documented function of observable inputs or be dropped; missing inputs (no side samples) surface as unknown/skipped rows, never a guessed flag.
- **Surfacing:** Moments panel rows on `LandmarkRow` seek affordances + `replayHash(…, {tick, loop: entryLoopAround(tick)})` — the jump itself is done (nav.js is the one entry point). Optional per-kill badges ride `EventFlags.svelte`'s sync-with-Go-flags precedent. **Keep moments out of the Replay feed for v1:** `landmarks.js` is THE categorization for the raw-event browser with exactly three retrieval paths (`mergeFeed`); adding a fourth derived source would fork that contract — revisit only with a designed opt-in category.

## Existing scaffolding to reuse

- `analytics/clutches.go` (canonical clutch detector — consume, never fork), `analytics.Compute` + `ConfigFrom` + `analysis_config` (thresholds/validation/`rule_version`/recompute), `analytics/engagements.go` (untraded deaths for the shared engine's item-4 detectors).
- Extract-stored facts: `events` kill flags (`noscope` etc.), `weapon_drop` rows with `detail_json.cat` (`extract/drops.go`), `blind` attacker/victim keys, `round_player_sides`, `player_stats` multi-kill tiers + CS2.md "Multi-kill columns" exact-tier rule, `clutches` table.
- `internal/metrics` — origin tagging (`builtin`/`user`/`plugin`), whitelist/honesty patterns for the flag-rule schema; `metrics/seed.go` seeding precedent; `round_classifications` required-explanation precedent.
- Frontend: `nav.replayHash`/`entrySeekTick`/`entryLoopAround` (seek + loop), `LandmarkRow.svelte` (the one event-row renderer), Combat's Clutches card (provenance chip + seek), `EventFlags.svelte` (flag badge sync with Go), `services.js` `cachedRead` (flushed on `spectra:*`), `Replay.svelte` MediaRecorder clip recorder (interim reel playback/export stopgap), `Builder.svelte` (user-rule UI precedent).

## Dependencies & overlaps

- **Video export unit (sibling, sequencing):** owns encoding (WebM/MP4/GIF, burn-in, headless CLI). Reels consume it as a queue of tick windows; this unit must not build a second encoder. In-app chained-loop playback lets reels ship before video export does — flag the ordering to the orchestrator.
- **Stats-advanced item 4 "Self-review mistake moments" (hard overlap):** one shared detector engine — proposal above (engine core: stats-advanced; rule set + extensibility: this unit). Its "unused grenades ($ lost)" detector **is** this item's "dying while holding a nade"; its untraded/isolated-death detectors and Moments panel are the engine's first consumers. Orchestrator must co-schedule or the risk is two detectors for one rule.
- **Export-metrics "User-authored YAML metric rules":** flags' user-extendability lives in that unit's user-rules directory + schema-validation + export/import; flags are a sibling `flags:` schema (the metrics v1 grammar is aggregate-only and cannot express per-tick seek-target predicates). Also "Whole-match stats file export" should carry moments rows.
- **Replay:** pure consumer (seek/loop entry URLs, optional future category — see above). **Annotations/bookmarks:** moments and reels are natural bookmark seeds; the bookmark item may want the same storage shape — coordinate before inventing a second persistence format. **Statistics tier:** "Clutch step-by-step breakdown" and "Unused utility value" consume/overlap the same detections. **Library:** new rows ride the existing per-import `"analyze"` stage; any recompute stays a coalesced job (`spectra:job-progress` rule). **Localization:** stored `why` strings English-in-DB until localization lands. **Metadata/lineups:** no dependency.

## Risks & unknowns

- **Definition research is the core rule risk:** CS2.md has no entries for spray transfer, ninja defuse, or molotov-in-smoke — each needs a lookup (AGENTS domain rule) and a pinned, documented, observational predicate with its threshold in `analysis_config`; "undetected" and severity-flavored wording are judgments to keep out of stored rules.
- **Molotov-in-smoke precision:** `inferno_extinguish` never fires (CS2.md, 388-demo corpus), so the rule is a position/time overlap of two grenade events — radius tolerance and smoke-linger mechanics need sourcing; this flag may land as documented-approximate or be deferred.
- **Engine co-scheduling (top process risk):** two units, one engine — if both build, the repo gains the exact second rule layer AGENTS forbids; the split proposed above (framework vs rules) must be agreed before either side starts.
- **Sequencing vs video export:** reels without encoding risk scope drift into a second encoder; guard scope with the in-app chained-loop v1.
- **Storage-shape decisions:** moments/reels as baseline tables (cheap, queryable) vs sidecars; user flag rules' on-disk location; both should follow the metrics/YAML-rules unit rather than inventing parallel homes.
- **Data-quality tiers:** detectors needing sides (`round_player_sides`) or kill-time inventory must surface unknown+N on missing inputs, never a guessed flag (honest metrics; matches the stats-advanced sidecar-absence convention).
