# 02 · TICK-STATE — the per-tick fact table

**Status:** design, rewritten 2026-11-20 for raw-SQL metrics. The table
design, density policy, ingest path and cost measurements are unchanged from
the 2026-11-18 design. What changed: no grammar admission, no E1–E3 language
extensions, and SQL joins replace the seed rewrites. Benchmark numbers are
from a scratch run at the time (modernc.org/sqlite v1.61.0, synthetic
1,335,990 rows, golden-shaped). Re-measure at the A1 wave before relying on
them.

---

## 0. Headline

1. **Density is a width decision, not a rate decision.** Event-anchored
   statistics need a row at the event's exact tick. A joined SQL statement
   that equates `(match, tick, steam_id)` silently misses rows at any other
   rate, and the count looks plausible. So the table stays at **64 Hz for
   every present player**. The savings come from keeping only derived columns.
2. **The table is a fact.** Its columns are observations and derived features
   at write time. Metrics read it with ordinary SQL joins.
3. **Chunked writes are mandatory.** A single transaction holding about 1.3 M
   rows takes 14–22 s, which exceeds `busy_timeout=5000` for concurrent
   writers. Chunks of at most 50,000 rows hold the writer for about 0.8 s each.
4. **Stamps.** `events.same_side` and `events.attacker_inair` are dropped; their
   seeds become SQL joins against `player_ticks`. `events.capped_dmg` stays.
   It is an engine emulation (order-dependent, row-local), so no per-tick row
   can reproduce it. Standing test for any future stamp:
   **observable in per-tick state ⇒ tick join and drop; requires emulating
   an engine rule ⇒ stays an ingest stamp.**

## 1. Density policy

| Policy | Rows/match | Verdict |
|---|---|---|
| Full 64 Hz, complete state (position + velocity + everything) | 1,335,990 | **Rejected.** Duplicates the sidecar in SQL at roughly 100× its compressed size, and no SQL reader needs position. |
| Downsampled (e.g. 16 Hz) | ~334 K | **Rejected.** Breaks equality joins at event ticks. |
| **Derived features at 64 Hz, no raw position** | 1,335,990 | **Chosen.** |
| Event-boundary samples only | ~80–120 K (estimate) | **Rejected.** Biased: averages over rows are not time averages, and time-in-air is unavailable. |

**Chosen policy:** one row per (match, tick, present player) at full rate,
with derived features only. Raw position, velocity vector and view angles
stay in the sidecar.

**Measured cost of the chosen policy** (scratch run, golden-shaped):

- 170.8 MB per match with the rowid table plus PK and steam index, or
  128.4 MB as `WITHOUT ROWID`.
- Insert 9–22 s depending on strategy.
- A 100-match library is roughly 13–17 GB of tick rows. Disk is the number
  to watch.

## 2. Table

```sql
CREATE TABLE IF NOT EXISTS player_ticks (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tick     INTEGER NOT NULL,
    steam_id TEXT    NOT NULL,            -- controller identity (0xFF bot keys included)
    round    INTEGER NOT NULL DEFAULT 0,  -- counted-round counter at this frame
    side     TEXT    NOT NULL DEFAULT '', -- sampled per frame; '' = unknown, never guessed
    alive    INTEGER NOT NULL DEFAULT 1,
    hp       INTEGER NOT NULL DEFAULT 100,
    money    INTEGER NOT NULL DEFAULT 0,
    in_air   INTEGER,                     -- NULL when no position sample (dead/absent)
    speed    REAL,                        -- horizontal units/s, derived at write; NULL on gaps
    weapon   TEXT,                        -- canonical weapon name; NULL when dead
    PRIMARY KEY (match_id, tick, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_player_ticks_steam ON player_ticks(steam_id, match_id);
```

- PK order `(match_id, tick, steam_id)` serves event-to-tick point lookups
  (about 45 µs per seek) and per-match sweeps.
- The steam index serves per-player reads across the library. Measured
  single-player-per-match range: 2.46 s vs 6.5 s per 10 queries without it.
- A covering index for the sweep shape measured 2.6 s → 542 ms at +50 MB.
  Ship the minimal pair now, add coverage only on measured pain.
- `WITHOUT ROWID` saves 25% of the space and costs 36% on subject-range reads.
  Deferred; decide on measured sweep pain.

**Column provenance:**

- `side`: sampled per frame from the player's team, alive or dead. Never
  carried forward.
- `round`: stamped from the counted-round counter at the frame merge.
- `speed`: derived in the sink from consecutive raw float positions. Horizontal
  magnitude over Δtick ÷ tick rate. NULL on the first frame after appearance,
  across a round change, across a gap, and when Δtick is 0. **The definition
  and its units must be sourced from CS2 documentation or the community wiki
  and recorded in `CS2.md` before any speed-based metric ships.** Not decided
  here.
- `in_air`: the position stream's airborne flag, alive frames only.
- `weapon`: canonical name, same vocabulary as `events.weapon`.

## 3. Ingest

- **A third sink** during parse (`TickSink`, a `ParseOptions` field beside
  `Positions`/`State`/`Voice`). Extract merges the per-frame populations and
  the round counter; the sink owns storage and derivation. Derivation holds
  at most 16 previous positions, so memory stays O(1).
- **Chunked transactions.** Rows are flushed inside `AddFrame` in chunks of
  at most 50,000 rows (about 375 frames). The flush finishes before the next
  progress write, so the single connection never re-enters.
- **Strategy:** row-by-row prepared statements inside chunked transactions.
  Batching measured no faster once chunked.
- **Stage:** rides the existing parse stage (0.20 → 0.90). No new stage.
- **Reprocess:** the sink deletes the match's rows at creation.
- **Failure:** every path that cleans up the sidecar also deletes the match's
  tick rows.
- **Deletion:** `DeleteMatchData` removes tick rows explicitly, with the
  foreign-key cascade as backstop.
- **Honest intermediate state:** a match mid-parse holds partial rows. Sweeps
  only process ready matches, so this is harmless, and it self-heals.
- **Not** in `childTables`. `SaveExtracted`'s delete loop runs after the parse
  and would erase streamed rows.

## 4. Sidecar

Two sinks of one parse, unchanged. The sidecar stays the replay renderer's
source. SQL never serves the renderer, because the density policy stores no
position. Revisit only if a metric needs position or velocity as a joinable
fact, or if sidecar loss without re-import becomes a user need.

## 5. Table ownership and freshness class

| Table | Writer | Staleness driver |
|---|---|---|
| Facts (`events`, `rounds`, `players`, `teams`, `round_economy`, `round_player_sides`, `round_player_money`, `sound_events`, `chat`, `generic_events`) | extract (`SaveExtracted`) | reparse only |
| `player_stats` | extract **and** analysis (`trade_kills`) | reparse + analysis rules (conservative; column-level attribution deferred) |
| Analysis outputs (`round_classifications`, `round_side_classes`, `player_round_stats`, `clutches`, `engagements`, `utility_events`, `match_trade_opps`) | analysis Compute | analysis rules |
| `player_ticks` | tick sink during parse | reparse only (derived features carry no rule semantics) |
| `matches` | extract, sidecar meta, analysis stamp | reparse + `analyzed_rule_version` |

This classification is what `03-QUERIES.md` uses to decide which metrics go
behind on which change.

## 6. Wipe bundle (what the schema change needs)

Pre-release, so the bundle is one wipe, followed by a re-import from the
snapshot's demo copies, followed by a value diff against the snapshot.

- New: `player_ticks` and its index.
- Dropped: `events.same_side`, `events.attacker_inair`.
- Dropped (already committed): the opening, damage-by-weapon and warmup columns.
- New on `metrics`: touched-table set (`03-QUERIES.md`).
- New on `metrics`: stub rows for analysis rules (`03-QUERIES.md`).
- Changed: `metric_values` key, if round-grain storage needs it (`03-QUERIES.md`).
- Changed: builtin `expr` text (ported SQL), which `INSERT OR IGNORE` never
  rewrites on an existing row, so the wipe is required.
- Code only: `weapon_fire` promotion to a typed event (before the wipe, so the
  re-imported corpus is uniform).

## 7. Open items

| Item | Disposition |
|---|---|
| `speed` definition and units | CS2.md / web sourcing before any speed metric |
| Counter-strafing threshold | same |
| `SaveExtracted` wall-clock for a golden-sized match | measure at the A1 wave; sizes busy-timeout headroom |
| Covering index / `WITHOUT ROWID` | decide on measured sweep pain, post-wipe |
| `yaw` / `pitch` / velocity vector columns | future wipe, only on a concrete metric |
| Density rate as a sink parameter | revisit if disk binds |
