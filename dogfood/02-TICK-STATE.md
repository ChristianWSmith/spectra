# 02 · TICK-STATE — density, table, ingest, sidecar, the one-wipe bundle

**Step 2 deliverable of `PLANNING.md`.** Contracts against `MANIFESTO.md` §1–2 and
`01-BASELINE.md` (reconciled at `b5373e7`). Read-only evidence only: source
citations verified in this worktree; cost figures are a scratch benchmark
(`/tmp/opencode/tickbench`, modernc.org/sqlite **v1.61.0 — the app's own driver**,
WAL + `busy_timeout=5000`, synthetic **1,335,990 rows** = golden-shaped
133,599 frames × ~10.05 participants). Clock: dispatched 15:22, deadline 18:30.

**Confidence key:** **H** = read/ran directly · **M** = derived from measured
numbers or adjacent code · **L/flagged** = not determined.

---

## 0. Headline findings (read first)

1. **The row rate is not a free design choice: the equality-join mandate pins it
   to 64 Hz.** The whitelist's `joinKey` (`whitelist.go:450-481`) derives ON from
   equated columns only — no nearest/interval join exists. A kill at tick T needs
   a tick row **at T** or the LEFT JOIN silently misses (NULL → filter fails →
   undercount that *looks* healthy). Any downsampling (options b/d as pure
   policies) breaks the manifesto's forward inputs. **Density is therefore a
   WIDTH decision, not a rate decision** — this falsifies the manifesto's own
   hedge "derived-features-at-a-**sane-tick-rate**" (`MANIFESTO.md:42`) as written
   for join purposes; the savings live in columns, not rows (§6, falsified #1).
2. **Measured cost of the mandated rate** (golden-shaped, this machine):
   **170.8 MB/match** (rowid + PK + steam index, 127.8 B/row) or **128.4 MB**
   (WITHOUT ROWID, 96.1 B/row); insert **9.2–21.6 s** depending on strategy; a
   match-scope sweep scan **2.5–2.6 s** without a covering index vs **542 ms**
   with one (+50.4 MB). A 100-match library ≈ **13–17 GB** of tick rows — the
   honest price of the substrate (for scale: the whole current 7-match dev
   library is 50.7 MB, measured via `.backup` scratch copy).
3. **A single-transaction insert of this volume is unusable**: 14–21.6 s in one
   tx exceeds `busy_timeout=5000` for every concurrent writer (other jobs'
   `UPDATE jobs` at `lifecycle.go:199`, another job's `SaveExtracted`, sweeps).
   Chunked transactions (≤50 k rows ≈ 0.8 s hold, measured) cost the same total
   time and are mandatory (§3).
4. **The owner ruling's "tick-join replacements" premise holds for two of the
   three stamps, fails for the third** — `attacker_inair` (clean attacker-anchored
   join) and `same_side` (join works **after two bounded language extensions**,
   §2.4) but **`capped_dmg` is not tick-derivable**: it is an order-dependent,
   payload-edge-cased, row-local ingest computation the DDL itself documents as
   such (`schema.sql:284-296`). Recommended disposition: **drop 2, keep 1** —
   owner question in §6.
5. **Baseline correction:** `01-BASELINE.md` B5.1 prescribes a `childTables`
   entry for the tick table. Under the recommended streaming ingest that entry is
   **wrong** — `SaveExtracted`'s delete loop (`lifecycle.go:304-306`) runs *after*
   the parse and would erase the streamed rows (`ExtractedMatch` carries no tick
   rows, `models.go:566-590`). The companion is a sidecar-mirror lifecycle
   instead (§3.3). B5.1's prescription is conditional on the in-memory design
   this doc rejects.
6. **Correcting the brief:** velocity does **not** live in the sidecar —
   `01-BASELINE` B3 lists it under "Not carried"; only positions do, quantized to
   ±1 world unit (≈ ±64 u/s derivative noise at 64 Hz — derived), so SQL `speed`
   must be derived at write time from raw float positions (§2.3).

---

## 1. Density / derived-feature policy (decided first)

### 1.1 What the forward inputs actually require (the hard constraints)

| Input (manifesto §2) | Anchoring | Join shape it demands |
|---|---|---|
| movement speed (counter-strafing: speed at the shot) | **event tick** (weapon_fire/kill/damage) | row at (match, tick, attacker) with `speed` |
| per-tick in-air (attacker_inair replacement; in-air at any event) | **event tick** | row at (match, tick, attacker) with `in_air` |
| shots fired | events (`weapon_fire`) | not tick-state — event promotion (§5, W7) |
| hit rate / headshot rate | event counts | already expressible (Baseline A/B) |
| position / velocity vector | — | **sidecar keeps them** (§1.4) |

Every named input except the two count-rates is an **equality join at an event's
tick**. `joinKey` can only equate columns; a downsampled table fails the join
silently (LEFT JOIN → NULL → condition false → plausible-looking wrong counts —
the exact failure mode the honesty contract exists to prevent). **Corollary: the
rate is pinned at 64 Hz for all present participants** (the state-stream
population of `extract.go:382-393`, dead included — absence-as-death would be an
inference, forbidden by the no-guessed-values rule).

### 1.2 The cost table

Row count is fixed at ≈1,335,990/match (golden-shaped). **Measured** = this
benchmark; **derived** = arithmetic from it or from Baseline B3's figures.

| Policy | Rows/match | Size | Insert | Event-tick joins | Continuous aggregates (avg speed, % time in air) | Verdict |
|---|---|---|---|---|---|---|
| **(a) full 64 Hz complete state** (position + velocity + everything) | 1,335,990 | **derived** ~230–280 MB (measured base 170.8 + ~40–80 B/row for x,y,z,yaw,velocity) | **measured** 21.6 s base + position cols | ✓ | ✓ | **Rejected.** Duplicates the sidecar in SQL at ~100× its zstd size (2.5 MB, B3) with no SQL consumer of position; the savings-vs-(c) that matter are zero, the cost is +60–110 MB/match. |
| **(b) downsampled rate** (e.g. 16 Hz) | ~334 K (**derived** ÷4) | **derived** ~43 MB | **derived** ~5.4 s | ✗ **breaks the join mandate** (silent misses) | ✓ (sampled) | **Rejected.** Equality-only joins (finding 1). Only revisitable if step 3's SQL grows an interval/nearest-≤-tick join (§6 revisit trigger). |
| **(c) derived features at full 64 Hz, no raw position** — RECOMMENDED | 1,335,990 | **measured** 170.8 MB (rowid) / 128.4 MB (WITHOUT ROWID) | **measured** 21.6 s row-by-row single-tx / 14.3 s batch / 9.2 s batch PK-only — but single-tx is illegal (finding 3) → chunked ≈ same total | ✓ | ✓ (N = frames, unbiased) | **Chosen.** Width carries the savings; every forward input is a join; aggregates are honest (each frame = equal time). |
| **(d) event-boundary samples only** | **derived** ~80–120 K (distinct event ticks × participants; no in-tree distinct-tick count — flagged L) | **derived** ~10–15 MB | **derived** ~2–3 s | ✓ at event ticks only | ✗ **biased**: rows oversample firefight moments → `avg(speed)` over rows ≠ time-average; time-in-air impossible; in-air at *non-event* ticks (pre-shot peeks) unavailable | **Rejected.** The bias is a silent-honesty problem; no continuous facts = the treadmill returns for the duration class. |

**Recommended policy: (c) — one row per (match, tick, participant-present) at
full 64 Hz, carrying only derived/joined features; raw position, velocity
vector and view angles stay sidecar-only.**

### 1.3 What it does NOT store, and why that is acceptable

- **x/y/z position, yaw (view angles)** — sidecar carries them (q16 positions,
  `sidecar.go:6-27`); every position consumer today is a Go/binary reader
  (replay renderer, heatmap `LoadProgress`, spatial series — Baseline B3). No
  metric expression reads position; storing it costs **derived +35–55 B/row
  ≈ +47–74 MB/match** for zero current readers. Pitch is stored **nowhere**
  today (the position sink deliberately drops it, `takeover.go:205-224`) —
  manifesto lists "view angles" as desired state; that stays an open item (§6).
- **velocity vector** — sidecar does **not** carry it (Baseline B3 "Not
  carried"); it is derivable from consecutive sidecar positions but only at ±1
  unit quantization (≈ ±64 u/s frame-difference noise at 64 Hz — derived).
  SQL stores the scalar **`speed`** derived at write from *raw float* positions
  (§2.3). A future metric needing the vector rides a wipe (pre-release: free).
- **armor / helmet / inventory / ammo / duck / attack-button / reloading** —
  all live in the sidecar's sparse state stream (Baseline B3); none is a named
  forward input; shots-fired uses `weapon_fire` events, not the attack proxy
  (the sidecar cross-check puts the button at ≥85% agreement —
  `state_golden_test.go:357` — a proxy, not the fact). Wipe-ride if ever needed.
- **Dead frames' `speed`/`in_air` are NULL, not 0** — the position stream is
  alive-only (`positionRow` gates on `pawnAlive`); writing 0 would fabricate an
  observation that was never taken. Honest consequence: an `avg(speed)` metric's
  true pool is sampled frames while the engine's structural N is `COUNT(*)` —
  an N-semantics question for step 3 (§6, deferred).

### 1.4 Position/velocity: what stays where (the "credible path")

- **Sidecar (unchanged, option §4):** exact positions, yaw, and the full sparse
  state stream — replay, heatmaps, spatial readers keep working as-is.
- **SQL:** `speed` (derived scalar) + `in_air` — the joinable projections the
  metrics need.
- **Path to position/velocity in SQL later:** density is an *ingest-time*
  decision (what the sink writes), not DDL — changing the rate or adding
  position columns is a **re-import, not a schema wipe** for rate changes, and a
  wipe only for added columns (pre-release: free). The trigger is stated in §4.

---

## 2. Table shape

### 2.1 One table, named `player_ticks`

**One table, not a split.** All candidate columns share one grain —
(match, tick, player) — written by the same sink at the same instant. A split
(state-half vs motion-half) would: double the index cost (both halves need the
same PK + steam indexes — measured +40 MB or more each), double the join surface
(every metric wanting `speed` AND `hp` joins two secondaries), and buy nothing:
no access pattern reads one half without the other at this grain. The sidecar
splits positions/state *files* because their encodings differ (dense vs sparse),
not their grain; SQL has no such constraint. `player_ticks` parallels the
`player_*` table family (`player_stats`, `player_round_stats`).

### 2.2 DDL, grain, PK, indexes

```sql
CREATE TABLE IF NOT EXISTS player_ticks (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tick     INTEGER NOT NULL,          -- demo tick of the frame (the join key with events)
    steam_id TEXT    NOT NULL,          -- controller identity at this frame (accumulator key: 0xFF bot keys included)
    round    INTEGER NOT NULL DEFAULT 0, -- stamped from extract's counted-round counter (join dim)
    side     TEXT    NOT NULL DEFAULT '', -- sampled per frame from identity.Team (partition dim; '' = unknown, never guessed)
    alive    INTEGER NOT NULL DEFAULT 1,  -- StatePlayer.Alive sample
    hp       INTEGER NOT NULL DEFAULT 100,-- StatePlayer.HP sample (0 forced when dead — a sample, not an inference)
    money    INTEGER NOT NULL DEFAULT 0,  -- StatePlayer.Money (as-read, survives death)
    in_air   INTEGER,                     -- PositionPlayer.Air; NULL when no position sample (dead/absent)
    speed    REAL,                        -- horizontal movement speed, units/s, derived at write; NULL on gaps (§2.3)
    weapon   TEXT,                        -- canonical wepName (same vocabulary as events.weapon); NULL when dead (not sampled)
    PRIMARY KEY (match_id, tick, steam_id)
);
-- Tier-1 block (schema.sql:580-636) with rationale comment:
CREATE INDEX IF NOT EXISTS idx_player_ticks_steam ON player_ticks(steam_id, match_id);
```

- **Grain:** one row per (match, tick, present participant) — the state-stream
  population, gated to counted rounds exactly like the sidecar
  (`extract.go:325-342`).
- **PK order (match_id, tick, steam_id):** serves the flagship access —
  event→tick point joins (**measured ~45 µs/seek**, 10 k seeks ≈ 450 ms) and
  per-match sweeps (PK prefix range). The player-major alternative
  (H: PK `(match,steam,tick)` + tick index) measured equivalent reads at
  **+6.5 MB** — no win; rejected.
- **`idx_player_ticks_steam`** in the Tier-1 block, rationale to mirror the
  existing convention (library-wide steam_id-leading reads): measured
  single-player-per-match range **2.46 s/10 q with vs 6.5 s/10 q without**
  (2.6×). NOT shipped yet: the **covering** index for the sweep shape
  (`(match_id, steam_id, speed, in_air, …)`) measured **2.6 s → 542 ms (4.8×)**
  at +50.4 MB and +10.9 s build — an index reaches existing DBs **free**
  (Baseline B5), so ship the minimal pair now and add coverage only if
  tick-sourced sweep scans show up as a real cost (revisit trigger §6).
- **WITHOUT ROWID variant (measured, not chosen):** −25% size (128.4 vs
  170.8 MB), −11% match-scan time, **+36% subject-range time** (3.4 vs 2.5 s/10 q).
  No existing table uses it; the subject-range shape is the metric workhorse.
  Revisit with the covering-index decision (both are DDL-light and index-only
  changes ride any future wipe or reach DBs free as `CREATE INDEX`).

### 2.3 Column provenance and derivation rules

- **`side`:** add `Side` to `StatePlayer` (one-field extract addition —
  `sampleStatePlayer` already receives `identity`; `sideString(identity.Team)`
  is the existing spelling, `helpers.go:18-27`). Sourced per frame, alive or
  dead — a direct sample, never carried forward. Rationale: the partition rule
  (`partitionColumns`, `whitelist.go:251-256`) requires *every* source of a
  side-partitioned expression to carry `side`; without the column,
  `from player_ticks partition=side` ("avg speed by side") is refused.
- **`round`:** stamped by extract's `a.currentRound` at the FrameDone merge —
  needed as a join dim (ticks↔rounds, ticks↔player_round_stats on
  (match, round, player)) and for round-scoped reads. Round is a real
  per-frame-varying fact (halftime), unlike side.
- **`speed`:** derived **in the sink** from consecutive raw float positions
  (the pre-quantization `PositionPlayer.X/Y/Z`): horizontal magnitude between
  consecutive frames, divided by Δtick × tick-rate. **NULL** when: no previous
  sample for that player (first frame after appearance), the round changed
  (round-boundary teleport), a player was absent a frame (gap), or Δtick = 0.
  Alternative `demoinfocs Player.Velocity()` (m_vecVelocity with
  `EagerVelocityTracking` position-delta fallback, `option.go:123-137`) is
  game-authoritative but prop-availability-dependent on old GOTV demos;
  sink-side derivation is self-contained and needs no parser option —
  recommended, with Velocity() noted as the upgrade if vertical velocity is ever
  wanted. **The exact speed definition (horizontal vs 3-D magnitude, units) is a
  CS2 fact and must be sourced from official docs/wikis at implementation time,
  never guessed** (`MANIFESTO.md:37` says the same for the counter-strafing
  threshold) — flagged, not decided here.
- **`weapon`:** canonical `wepName` vocabulary — identical to `events.weapon`
  (stated in `StatePlayer`'s doc comment), so weapon-partition expressions join
  consistently; needed anyway because `partitionColumns` requires it on every
  source of a weapon-partitioned expression.
- **`in_air`:** `PositionPlayer.Air` (alive frames only → NULL when dead).
  Same-frame semantics for the attacker_inair replacement: game events for frame
  T dispatch **before** `FrameDone` of frame T (`extract.go:325-342` gate
  comment), so the kill's frame sample should equal the payload flag —
  **gate-reproof risk flagged**: a landing between the event dispatch and
  FrameDone within the same frame would diverge; `kill_flags_test.go:52-106`
  re-proves on the golden corpus and decides.

### 2.4 Whitelist admission (the point of the exercise)

Required companions, exactly:

- `sources` += `"player_ticks"` (`whitelist.go:19-24`).
- `sourceColumns["player_ticks"]` = all 11 columns (`whitelist.go:32+`).
- `sourceSubject["player_ticks"] = "steam_id"` + `playerSources` const grows
  (pinned to `sourceSubject`'s key set by `TestSchemaConsistency`,
  `schema_consistency_test.go:99-130`).
- `sourceDims["player_ticks"] = {"round","side","tick"}`;
  `sourceUniqueKeys["player_ticks"] = {match_id, tick, steam_id}` (must equal the
  real PK — `TestJoinKeyDeclarationsMatchSchema` (b),
  `schema_consistency_test.go:201+`); `sourcePopulation` = `popAllPlayers`
  (bots stored — event-shaped record; humans-only arrives via the compiler's
  unconditional `subjectConds`, Baseline A9.6).
- **`tick` joins the join-dimension vocabulary (E1):** `sourceDims` gains
  `{"tick":"tick"}` for the tick-carrying event sources (`events`,
  `engagements`, `utility_events`, `chat` — all already whitelist `tick`),
  `sourceDimsOf`/`joinKey`/`joinDim` learn the new dim, refusal copy at
  `compile.go:344-347` ("match, round, player, side") grows, and
  `TestJoinKeyDeclarationsMatchSchema`/refusal pins update. This is what makes
  `events ⋈ player_ticks ON (match, tick, attacker)` derivable — the
  counter-strafing join. `joinIsOneToOne` then correctly reports n:1 for
  events-anchored statements (multiple events can share a (tick, attacker)), so
  tick **value** columns are refused in that position (filters are fine —
  `resolveCond` `compile.go:658-666`); "avg speed at shots" as a *value* is
  step-3/SQL territory — flagged §6.
- `tableNotes["player_ticks"]` (`internal/query/schema.go:10-50`; pinned by
  `TestEverySchemaTableHasNote` `notes_test.go:60-81`).
- **Not `childTables`** — see §3.3 (baseline correction, finding 5). Instead:
  `streamedChildTables = ["player_ticks"]` deleted by `DeleteMatchData`
  (`lifecycle.go:597-602`) + FK `ON DELETE CASCADE` as backstop, wipe-at-sink-
  creation for reprocess, cleanup-on-failure for partials.
- Store col-list pin: the sink's INSERT column list is a hand-written const and
  joins `TestColumnListConstsMatchSchema`'s list (`columns_schema_test.go:24-49`)
  under G1's one-list-per-table rule.
- Tier-1 pin: `TestTier1IndexesPresent` (`indexes_test.go:19-31`) gains
  `idx_player_ticks_steam`.

### 2.5 Two language extensions the seed rewrites need (E2, E3)

The three-stamp drops are mandated as seed rewrites; two rewrites are **not
expressible in the current grammar** (verified against `joinKey`/
`resolveColumns`):

- **`same_side` gates (`dmg_no_kill` `schema.sql:1296`, `kill_conversion`
  `:1301`, `weapon_damage`'s gate `:1619`)** need *both* parties' sides at the
  event tick. The star join binds the secondary's player dim to the primary's
  **subject** column (`sourceSubject[events] = attacker`) — the victim's tick
  row is unreachable, and even with two aliases of one table the shared column
  name `side` is an **ambiguous-column refusal** ("the grammar has no
  qualified-identifier syntax", `compile.go:679`). Two bounded, declaration-
  driven extensions fix it:
  - **E2 — per-secondary player-anchor override:** a curated declaration mapping
    a secondary's player dim to a *non-subject* primary column (precedent:
    `sourceTable`/`sourceSubject` aliases, `engagements_victim`). Enables
    `player_ticks_victim ⋈ events ON events.victim = player_ticks_victim.steam_id`.
    `joinKey` already emits `joinDim{PrimaryCol,…}` — this supplies PrimaryCol
    from a declaration instead of always `sourceSubject[primary]`.
  - **E3 — qualified column references:** parser accepts `source.column` in
    operands; the emitter **already qualifies** when joined (`qualify()`,
    `compile.go:700+`), so this is parser + validation + pins, not emission.
  - Same-side semantics then spell exactly: `NOT (atk.side = vic.side AND
    atk.side <> '' AND vic.side <> '')` ≡ the permissive stamp rule
    (`helpers.go:32` `sameSide(a,b) = a != "" && a == b`). Equivalence is exact
    because side is a per-round constant (halftime switches between rounds), so
    side-at-event == side-at-frame.
  - **Sequencing question for the lead:** E2/E3 are language features and sit
    on the step-3 (03-QUERIES) boundary; E1 is squarely step 2. The seed
    rewrites that need them can only land when they exist (W4 below) — flag for
    `PLANNING.md` step ordering, not resolvable here.

---

## 3. Ingest path

### 3.1 Recommendation: streaming sink during parse (option a), as a dedicated third sink

- **Rejected: in-memory `ExtractedMatch` slice (option b).** 1.34 M row structs
  with two strings ≈ **150–200 MB per in-flight job (derived)** × parallel
  budget tokens (`internal/budget`, machine-wide) — an OOM-shaped risk for zero
  benefit; and inserting them via `SaveExtracted` means a **14–21.6 s
  single transaction** (measured), which blows `busy_timeout=5000` for every
  concurrent writer (finding 3). `SaveExtracted`'s row-by-row single-tx style
  (Baseline B4) is safe *today* only because its row counts are small (7-match
  scratch: 29 k events + 142 k generic total — measured; current per-match
  `SaveExtracted` duration is **not measured in-tree — flagged**).
- **Chosen: a `TickSink` as a third `ParseOptions` field** (like `Positions`,
  `State`, `Voice`), called once per frame from the FrameDone handler after both
  existing sinks, with the merged per-frame rows. Extract owns the merge because
  it has the frame's populations (state = spine, all participants; position =
  alive-only, joined by SteamID) and `a.currentRound`; the sink owns storage-side
  derivation (prev-position map, ≤16 entries → **O(1) RAM**, the sidecar's
  precedent `PositionSink`/`StateSink` "must not retain players" discipline
  `extract.go:53-56`). The sidecar keeps its two existing sinks untouched —
  **one parse, two consumers** (this is also §4's answer).
- Slot in the job body (`library.go`): sink created beside the sidecar writers
  (`library.go:985-1006`), wired at the `ParseOptions` literal
  (`library.go:1014-1032`), gated by the same counted-round gate (inside the
  existing `gateOpen` branch, `extract.go:325-393`). **Stage accounting: rides
  `StageParse` (0.20→0.90) — no new stage, no `models.Job` stage-table change**;
  the parse bar is byte-driven and keeps moving while the sink flushes. Cost:
  parse wall time grows by the measured insert total (9–22 s on golden-shaped —
  honest, disclosed).

### 3.2 Write strategy under the single-writer constraint

- **Chunked transactions, flushed inside `AddFrame`** — every ≤50 k rows
  (≈ 375 frames × ~10 players), **measured hold ≈ 0.8 s per chunk** (B/D:
  21.4–22.2 s total across ~27 chunks), comfortably under `busy_timeout=5000`,
  so concurrent writers (progress `UPDATE jobs` `lifecycle.go:199`, other jobs'
  `SaveExtracted`, sweeps under the compute lock) interleave safely.
- **Measured strategy comparison** (1,335,990 rows, with PK+steam indexes):
  row-by-row prepared **single-tx 21.6 s** ✗ (lock violation), batch-500
  multi-row VALUES **single-tx 14.3 s** ✗ (same), row-by-row **chunked 22.2 s**
  ✓, batch-500 **chunked 21.4 s** ✓ (batching buys nothing once chunked —
  measured), PK-only row-by-row 16.5 s / batch 9.2 s (isolates the steam index
  at +5.1–7.3 s insert and +39.5 MB — measured). **Recommendation: row-by-row
  prepared statements inside 50 k-row chunked transactions** — simplest,
  measured-equal to batched-chunked, same lock profile.
- Progress writes during parse are safe because the flush completes *inside*
  `AddFrame` before the next `rep.emit` → `writeProgress` (`library.go:167-177`)
  — no same-goroutine re-entry onto the single connection (a tx held *across*
  frames would deadlock `SetMaxOpenConns(1)`; stated as a design constraint).

### 3.3 Lifecycle (the `childTables` correction) and failure semantics

- **Reprocess:** the sink **wipes the match's rows at creation**
  (`DELETE FROM player_ticks WHERE match_id = ?` — PK-prefix seek, fast),
  mirroring the sidecar's truncate-at-`NewWriter` (`writer.go:63-89`). This is
  what prevents stranded rows — *not* a `childTables` entry (finding 5:
  `SaveExtracted`'s delete loop at `lifecycle.go:304-306` runs after the parse
  and would destroy freshly streamed rows, since `ExtractedMatch` carries none).
- **Failure:** every failure path that calls `cleanupSidecar()`
  (`library.go:991` pattern; content guard `:1067-1075`; cancel `:1046-1053`)
  gains `DELETE FROM player_ticks WHERE match_id = ?` in the same closure —
  half-written cleanup exactly like the sidecar. A sink error aborts the parse
  through the existing `sinkErr`/cancel path (`extract.go:364-367`).
- **Match deletion:** `DeleteMatchData` deletes `player_ticks` explicitly via a
  new `streamedChildTables` list (convention-preserving) with the FK cascade as
  backstop (`foreign_keys(1)` in the DSN, `store.go:73-79`).
- **Honest observable:** while a match is mid-parse, `player_ticks` holds partial
  rows for a non-ready match — benign (sweeps only process ready matches,
  Baseline A6), self-healing (failure cleanup / reprocess wipe), and consistent
  with the sidecar's own on-disk partials during parse. Alternative rejected:
  staging table + `INSERT..SELECT` inside `SaveExtracted` preserves single-tx
  atomicity but costs an extra table (note pin), an extra copy pass, and the
  same long-lock problem for the copy.

---

## 4. Sidecar convergence

**Recommendation: (i) two independent sinks of one parse — for now.**

Costs, argued with the measurements:

- **What SQL reads at 64 Hz would actually cost:** the renderer needs ~10 rows
  per frame; a playback window (1 s = 640 rows) is a PK range scan — point seeks
  measured **~45 µs** each, so a window is well under 1 ms (**derived** from the
  seek measurement); per-frame queries are trivial. **Read throughput is not the
  blocker.**
- **Why (ii) replay-reads-SQL is nonetheless rejected:** (1) the density policy
  stores **no position** — SQL *cannot* serve the renderer without becoming
  policy (a) (+47–74 MB/match, derived); (2) the renderer's protocol is
  byte-range over zstd blocks (`main.go:585-664`, `preload.js:449`,
  `state.js:230` — the bytes deliberately bypass bindings, `services.js:505`)
  — converting to SQL round-trips is a rewrite of 7+ reader sites (including Go
  readers: `LoadProgress`, `spatial/series.go`, `replayservice.go`) for no
  forward input.
- **Why (iii) converged storage + derived replay cache is deferred:** it
  requires position-in-SQL (same cost as above) plus a sidecar-from-SQL
  generator (deterministic rewrite of `positions.bin`/`.idx`/meta — feasible,
  listed as future work). Its real benefit is *repairability* (rebuild a lost
  sidecar from the DB without re-import), not query power.
- **Revisit (iii) when either becomes true:** (a) a forward input needs
  position or the velocity vector as a joinable SQL fact (then store position
  *and* make the sidecar a derived cache — one write path, sidecars become
  regenerable), or (b) sidecar-loss-without-reimport becomes a user-facing need.
  Revisit (b→ii) additionally requires step 3's SQL to be landed (the renderer
  would read through it). Until then: **one parse, two sinks, zero duplicated
  parse cost** — the tick sink consumes the same frames the sidecar writer does.

---

## 5. The one-wipe bundle — exact and ordered

Invariant: **tests build fresh DBs from `schema.sql` every run → every commit
below keeps DDL ↔ seed ↔ whitelist ↔ tests consistent.** Order: language
enablers → table+ingest → seed rewrites (columns still present, unreferenced) →
column drops (no references remain) → data-shape items → owner wipe.

- **W1 — E1 (`tick` join dimension).** Whitelist dims + `joinKey`/`joinDim` +
  refusal copy + pins/tests. No DDL, no seeds. *(If the lead sequences E1 with
  step 3 instead, W2 still lands — the source admission needs E1 only when the
  first expression joins across ticks; flag for lead. Actually: `sourceDims`
  admission of `player_ticks` itself declares `tick`, so E1 lands with W2 —
  stated as one commit either way.)*
- **W2 — tick table + ingest.** DDL (`player_ticks` + Tier-1 index with
  rationale) + `tableNotes` + whitelist admission (`sources`/`sourceColumns`/
  `sourceSubject`/`sourceDims`/`sourceUniqueKeys`/`sourcePopulation` +
  `playerSources`) + `TickSink` + extract merge (+ `StatePlayer.Side`) + library
  wiring + `streamedChildTables` + all pins (schema-consistency, column-list,
  notes, Tier-1) + ingest tests. **No seed references `player_ticks` yet** →
  green. Existing DBs receive the table free (CREATE IF NOT EXISTS); they hold
  no rows until re-import — honest pre-wipe state (no metric reads it yet).
- **W3 — E2 (victim-anchor override) + E3 (qualified columns)** + refusal pins.
  No DDL, no seeds → green. *(Sequencing owner: lead — see §2.5.)*
- **W4 — seed rewrites + read-path switches (columns still in DDL).**
  - `dmg_no_kill` (`schema.sql:1296`), `kill_conversion` (`:1301`): enemy gate
    → tick-join side comparison (E2+E3). Values must be **identical** (side is
    per-round constant → exact); fixtures' `expr` text updates, `wantValues`/
    `wantN` unchanged — that *is* the in-repo equivalence proof.
  - `weapon_damage` (`:1619`): gate → tick join; **value stays `capped_dmg`**
    (kept — below).
  - `attacker_inair`: no seed references it; its drop is W5 — but the
    **renderer read path switches here**: `GetEvents`/`GetEventDetail`
    (`queries.go:253,1281,1671`) fill the DTO field via a LEFT JOIN to
    `player_ticks` on (match, tick, attacker), or `renderer.js:4240` reads the
    sidecar's airborne flag at the kill frame (frontend-only option — lead's
    call, both honest; store-side join keeps the DTO contract unchanged).
  - Oracle/test/guide updates in the same commit: `combat_equivalence_test.go:78-95`
    (the retired oracle SQL reads `e.same_side` — rewrite to the tick join),
    `fixtures_test.go:610,625,989` (expr pins), `kill_flags_test.go:52-106`
    (re-prove via the new path), `store_test.go:333-366` (stamp-write pins
    shrink with the columns in W5), `metric-language.js:110-114` (guide column
    list — docs lockstep), `livestats.js:43,136` comment parity note.
  - **Deliberate fixture change:** `testdata/seed.sql` gains `player_ticks` rows
    (explained diff; values unchanged).
- **W5 — DDL drops of the two droppable stamps.** `events.same_side`
  (`schema.sql:273-283`) and `events.attacker_inair` (`:264-268`) out of:
  DDL, `eventCols`/bind (`lifecycle.go:277-279,475-476`), `eventRowCols` scans
  (`queries.go:253,1281,1671`), DTO (`models.go:398-432`, `dto.go:163-165,205`),
  whitelist entries (`whitelist.go:37-48`), extract's `AttackerInAir` field +
  payload read (`agg.go:1759`), guide (`metric-language.js:110-114`).
  **`extract.sameSide`/`same` and `capDamage` survive** — they gate
  `player_stats.total_damage`'s fold at ingest (`agg.go:1098,1145-1148`) —
  the *stamp* dies, the *predicate* stays (one implementation, no second copy).
  New pin in the `TestDiscardedWarmupColumnsGone` pattern
  (`columns_schema_test.go:99-127`): `TestDroppedEventStampColumnsGone`.
- **W5′ — `capped_dmg` KEPT (recommended; owner ruling required).** Evidence it
  is not a tick-join replacement: the DDL comment itself says "the fact is
  row-local at ingest … a query-time SUM can never reproduce it"
  (`schema.sql:284-296`); `capDamage` replays per victim **in event order** with
  payload-health edges (`agg.go:1167-1194` — default-100, absent-field trust,
  `real=false` post-match zeroing `agg.go:1114-1115`), while `player_ticks` is
  frame-grain: **same-frame multi-hit on one victim and post-match hits inside a
  counted round are not reproducible from frame samples** (derived from the two
  code paths — flagged M). Options for the owner: **(recommended) drop 2, keep
  `capped_dmg`** with this written reason, revisit post-SQL (a windowed author
  query over the event stream can own it, but built-ins must stay sugar —
  `MANIFESTO.md:55`); or keep all three until step 3; or accept a divergent
  tick-join rewrite — **rejected by the no-exceptions bar**
  (`PLANNING.md:50`).
- **W6 — already-committed drops take effect at the wipe (no action):**
  `player_stats.opening_kills/opening_deaths` (`schema.sql:110-116`),
  `damage_by_weapon` (`:133-140`), warmup set (`rounds.warmup/pregame`,
  `matches.warmup_rounds`, `columns_schema_test.go:99-127`). Listed so the
  wipe's effects are enumerable in one place.
- **W7 — `speed`/`in_air` never become event/player_stats columns.** They exist
  only as `player_ticks` columns (a tick fact *is* columns — the prohibition is
  against stamp columns on `events`/`player_stats`). Mechanical pin: extend
  `TestDroppedEventStampColumnsGone`-style assertions so a future `events.speed`
  fails CI.
- **W8 — `weapon_fire` promotion: IN the bundle.** It is the join partner for
  counter-strafing (speed-at-shot) and the shots-fired forward input; today it
  exists only in `generic_events` with the actor inside `payload_json`
  (unjoinable, unwhitelisted — Baseline B6). Promotion = a typed extract handler
  writing `events` rows (kind vocabulary `models.go:69-132` grows — pre-release
  free; **no DDL**; `generic_events` keeps its escape-hatch copy by design).
  Not wipe-gated, but must land **before** the wipe so the re-imported corpus is
  uniform. Rides: feed/landmark frontend check (`feed.js` FEED_SOURCES — verify
  the events descriptor's kind list doesn't double-surface the row — flagged M),
  deliberate golden fixture regen (`donk.golden.json` gains rows — explained).
- **W9 — dead-code sweep (code, not schema):** the folds `MANIFESTO.md:139`
  orders deleted regardless — unused spatial-series reader
  (`internal/spatial/series.go:61-73`, call site `platformservice.go:275`),
  win-percentage fold, two unconsumed team aggregates, raw default scoreboard
  sort (Baseline B5 item 5; each fold's live/dead status asserted at the
  baseline — re-verify at execution). Any commit; bundled for one review.
- **W10 — owner obligations (the sanctioned verification):**
  1. **Before the wipe:** `sqlite3 "<live>" ".backup /tmp/opencode/pre-wipe.db"`
     — the pre-migration snapshot (owner ruling, `PLANNING.md:38`).
  2. Owner runs `make deep-clean CONFIRM=1` + full re-import.
  3. **After re-import:** diff `metric_values` match-by-match between snapshot
     and new DB — join via `matches.sha256` (autoincrement ids differ across
     DBs) on `(metric name, subject_key, dim)` comparing `value` **and** `n`.
     Expected: byte-identical for every seed (the two rewritten gates are exact,
     §2.5; `capped_dmg` untouched) — any diff is a bug, per the no-exceptions
     bar. The three new post-wipe surfaces (tick source, weapon_fire rows, new
     columns) appear only as *added* metric rows, never changed ones.

**Wipe-bundle contents in one line:** tick table + Tier-1 index + companions;
two language enablers (E1–E3); two stamp drops with coordinated seed/quest/
guide/fixture rewrites; `capped_dmg` kept (owner call); `weapon_fire` promotion;
the previously-committed drops (opening_*, damage_by_weapon, warmup) taking
effect; the dead-code sweep; the snapshot→wipe→diff verification.

---

## 5B. Table ownership classification (rule-5 freshness input — verification of 03-QUERIES §6.2)

03-QUERIES §6.2 marked its analysis-vs-extract table list **M** and deferred
verification here. Verified against source at `b5373e7`. Staleness drivers:
**reparse** = `childTables` clear on reprocess (`store.go:41-47`,
`lifecycle.go:304-306`) → the match/career unit axes; **rules** =
`matches.analyzed_rule_version` (`schema.sql:46-57`, stamped
`analytics.go:141-143`, live at `analytics/compute.go:231`) + row `rule_version`
where present.

| table | writer(s) | staleness driver | evidence |
|---|---|---|---|
| `events`, `generic_events`, `chat`, `rounds`, `players`, `teams`, `round_economy`, `round_player_sides`, `round_player_money`, `sound_events` | **extract** via `SaveExtracted` only | **reparse only** — never rules | `lifecycle.go:297` (delete `:304-306`); inserts `:325,383,406,424,450,464,485,498,511` |
| **`player_stats`** | **MIXED**: base+stamps by `SaveExtracted`; **`trade_kills` rewritten by `analytics.Compute`** | **reparse + rules** | base `lifecycle.go:383` (stamps `:342-380`); `ReplaceTradeKills` `analytics.go:262-277`, called `compute.go:195` |
| `round_classifications` | `analytics.Compute` | reparse + rules — **row** `rule_version` `schema.sql:408` + match stamp | `compute.go:169` → `analytics.go:171` |
| `player_round_stats` | `analytics.Compute` | reparse + rules — **row** `rule_version` `:467` + match stamp | `compute.go:175` → `analytics.go:185` |
| `round_side_classes` | `analytics.Compute` | reparse + rules — **match stamp only** (no row `rule_version`; DDL `:440-450` verified) | `compute.go:172` → `analytics.go:352` |
| `clutches` | `analytics.Compute` | reparse + rules — **match stamp only** (no row `rule_version`; DDL `:630-655`) | `compute.go:178` → `analytics.go:202` |
| `engagements` (+ `engagements_victim` alias) | `analytics.Compute` | reparse + rules — **match stamp only** (DDL `:658-672`) | `compute.go:181` → `analytics.go:219` |
| `utility_events` | `analytics.Compute` | reparse + rules — **match stamp only** (DDL `:674-700`) | `compute.go:220` → `analytics.go:236` |
| **`match_trade_opps`** | `analytics.Compute` **only** (`ReplaceTradeOpps` is the one writer) | reparse + rules — **NO `rule_version` column** (DDL `:516-522` verified): match stamp only | `compute.go:217` → `analytics.go:291` |
| `matches` (denominator table) | `SaveExtracted` + `SetPositionMeta` + `SetMatchRuleVersion` + job status | reparse + **rules — `analyzed_rule_version` IS its staleness column** | `lifecycle.go:32,572`; `analytics.go:141-143`; `schema.sql:46-57` |
| `metric_values` (ref joins) | metrics `Sweep` | **row-level**: the `md0` join binds live versions (03-QUERIES §6.2, `compile.go:158-176`) | 03-QUERIES §6.2 |
| **`player_ticks`** (new) | **tick sink during parse** (extract-side) | **reparse only — never rules** (derived features carry no rule semantics) | this doc §3 |
| `player_career` (not a source; footnote) | `RebuildCareer` — called from **both** Compute and the import/delete paths | reparse/unit axes | `analytics.go:948`; callers `compute.go:224`, `lifecycle.go:610`, `analyticservice.go:740` |

**Freshness-precision findings for PLAN (do not smooth over):**

1. **`player_stats` is the one metric source with two writers.** A table-grained
   map cannot split it: classifying it extract-fact would *miss* `trade_kills`
   staleness (under-approximation — wrong); classifying it analysis-derived
   (recommended) keeps fact-only `player_stats` metrics behind on rules bumps —
   i.e. **the rule-5 precision win does not extend to `player_stats`** until
   column-level attribution exists. PLAN item: accept the conservative class now,
   or design column-level touched-sets for this one table.
2. **Five analysis tables carry no row `rule_version`** (`round_side_classes`,
   `clutches`, `engagements`, `utility_events`, `match_trade_opps`) — their
   rules-axis freshness rides *entirely* on `matches.analyzed_rule_version`.
   Correct in the §6.2 map: "row stamps where the table carries `rule_version`"
   is accurate, but the map must not imply row stamps exist uniformly.
3. **`player_ticks` needs no rules axis at all** — its staleness is pure
   reparse; a tick-sourced fact metric goes behind only on reprocess. (Its
   ingest-time derivations — `speed`'s formula — are versioned by nothing today;
   if the formula ever changes, that is a re-import event, recorded here as a
   provenance note, not a `rule_version`.)

---

## 6. What PLAN.md must carry from this step

**Falsified assumptions (first):**

1. **"Derived-features-at-a-sane-tick-rate" (`MANIFESTO.md:42`) as a join
   substrate** — falsified: equality-only joins (`whitelist.go:450-481`) pin the
   rate to 64 Hz for event-anchored inputs; downsampling silently breaks them.
   The density lever is WIDTH, not rate. (The manifesto's row-count estimate
   1–2M is confirmed: 1,335,990 derived from measured 133,599 frames × ~10.05 —
   participants still derived, flagged.)
2. **"Position/velocity already live in the sidecar" (brief/§2 framing)** —
   velocity does not (Baseline B3); only quantized positions do, and their
   finite-difference noise (≈ ±64 u/s, derived) is unfit for speed metrics.
3. **B5.1's `childTables` companion prescription** — wrong under streaming
   ingest (`lifecycle.go:304` would erase streamed rows); corrected to the
   sidecar-mirror lifecycle (§3.3).
4. **"The three stamps are tick-join replacements" (owner ruling's premise)** —
   holds for `attacker_inair` (clean) and `same_side` (needs E2+E3); **fails
   for `capped_dmg`** (order-dependent, row-local — `schema.sql:284-296` says
   so). **Owner ruling 2026-11-18: APPROVED — drop 2, keep `capped_dmg`** (the
   stamp keeps an honest DDL comment; revisit post-SQL). **Criterion (owner,
   same day):** capped damage is *engine emulation*, not invention — same class
   as assist assignment. Standing test for future stamp-drop candidates: value
   observable in per-tick state ⇒ join and drop; requires emulating an
   engine-internal rule ⇒ stays a derived-at-ingest stamp.
5. **Row-by-row single-tx writes scale to tick volume** — falsified by
   measurement: 14–21.6 s/tx violates `busy_timeout=5000`; chunked is mandatory
   and costs nothing (measured parity).

**Decisions made (this doc):**

- Density = **policy (c) at full 64 Hz**: derived features
  (`round, side, alive, hp, money, in_air, speed, weapon`) + identity
  (`match_id, tick, steam_id`), no position/velocity-vector/view angles.
- Table = **one `player_ticks`**, PK `(match_id, tick, steam_id)`, Tier-1
  steam index; one-table-not-split justified (§2.1); WITHOUT ROWID and covering
  index deferred with measured numbers attached (both reach DBs free later).
- Ingest = **streaming `TickSink`** (third `ParseOptions` field), sink-derived
  speed, chunked ≤50 k-row txs inside `AddFrame`, rides `StageParse`, sidecar-
  mirror lifecycle, **not** `childTables`.
- Sidecar = **(i) two sinks of one parse**; revisit (iii) on the triggers in §4.
- Wipe bundle = **W1–W10** with the every-commit-green invariant; `weapon_fire`
  promotion in-bundle; dead-code sweep in-bundle; snapshot→wipe→values+N diff
  as the verification.

**Deferred, with owners:**

| Item | Owner | Note |
|---|---|---|
| E2/E3 sequencing vs step 3 (they are language features) | lead (`PLANNING.md` step order) | W4 blocked until they exist |
| `capped_dmg` disposition (keep 1 vs keep all 3) | ~~product owner~~ **RULED 2026-11-18: keep `capped_dmg`** | §5 W5′ confirmed; drop `same_side` + `attacker_inair`; revisit post-SQL |
| N semantics for tick sources with NULL (unsampled) rows — structural `COUNT(*)` vs `COUNT(col)` | step 3 (rule-3 prototype) | §1.3; affects any `avg(speed)` seed |
| `speed` definition sourcing (horizontal vs 3-D, units; counter-strafing threshold) | implementation-time CS2.md/web lookup (AGENTS rule) | never guessed |
| "Avg speed at shots" as a *value* under events-primary n:1 refusal | step 3 (SQL authoring) | filters express it today |
| `weapon_fire` feed double-surface check (events vs generic merge) | implementation (W8) | flagged M |
| Covering index / WITHOUT ROWID adoption | implementer, on measured sweep pain | free-later (index) / wipe-ride (table option) |
| `yaw`/view-angles SQL column, `pitch` capture | revisit on a concrete metric | wipe-ride |
| Density rate as a sink parameter (re-tunable by re-import, no DDL) | revisit if disk binds | measured 13–17 GB/100 matches |

**Open questions not answerable from the repo:** golden demo's distinct
event-tick count (option d's row estimate stays derived); current
`SaveExtracted` wall-clock duration for a golden-sized match (unmeasured
in-tree — measure at execution, it sizes the busy-timeout headroom).

### 6.1 Execution measurements (2026-11-20, tick table + sink landed)

Measured by `TestGoldenPlayerTicks` (`internal/integration/player_ticks_test.go`)
on the golden demo `de_cache.dem.zst`: real parse, `store.TickWriter` on a
file-backed WAL DB, PK + `idx_player_ticks_steam`. The machine was shared
with parallel agent worktrees, so the timings are upper bounds. **H**.

| Quantity | Run 1 | Run 2 |
|---|---|---|
| rows written / frames delivered | 1,334,370 / 133,599 | same |
| tick-sink wall-clock (buffering + all chunk flushes + final Close) | 33.62 s | 30.96 s |
| parse wall-clock with the sink (parse-only probe, no sink: 67.4 s) | 94.37 s | 86.85 s |
| longest single `AddTicks` call (one ≤50 k-row chunk flush = writer hold) | — | 1.533 s |
| `SaveExtracted` wall-clock (4,357 events) | 1.328 s | 0.554 s |

- **Busy-timeout headroom:** the longest writer hold is a chunk flush at
  ~1.5 s, about 3× under `busy_timeout=5000`. `SaveExtracted` at 0.55–1.3 s
  stays far under it. The §3.2 chunk bound holds. The single-transaction
  alternative (14–21.6 s) would not.
- **Sink cost:** about 31–34 s per golden-sized import, all inside
  `StageParse`. It is higher than the §3.2 synthetic 21–22 s, probably
  because of the file DB, the WAL and the shared machine.
- **Findings from execution:**
  1. The golden demo delivers **36 frames whose tick repeats the previous
     frame's tick**, one every 3,840 ticks (the periodic full-packet
     frame). The PK `(match_id, tick, steam_id)` rejects the second
     observation. Rule implemented: the first observation of a tick
     wins and the repeat is dropped (`store.TickWriter.AddTicks`).
  2. Rows are written only while a **counted** round is current. Frames
     of a discarded (post-match/knife/warmup) round after the first
     counted round are skipped, because their rows would belong to no
     stored round. `round` is the stored 1..N number (`len(a.rounds)`).
  3. **Same-frame in-air re-proof (§2.3 gate risk):** for 159/159 kills
     with a player attacker, a row exists at (match, kill tick, attacker)
     (0 join misses), and `in_air` equals the payload's `attackerinair`
     (0 mismatches). The attacker_inair replacement holds on the golden
     corpus.
  4. `speed` is the horizontal (x/y) frame-difference speed in u/s
     (sourced: CS2.md "Player movement speed for accuracy"). The golden
     maximum is 506.1 u/s, logged and not pinned.
