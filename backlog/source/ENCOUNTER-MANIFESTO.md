# ENCOUNTER-FACT — the encounters fact

**Status:** DIRECTION, not enqueued. Not to be started until the owner says
so; this document does not plan the work.

---

## 1. What this is

A new fact type, **encounters**, recorded only while two enemy players can
see each other. Each encounter stores the precise position and view angles of
both players for the frames it covers, so later analysis can answer:

- Crosshair placement: the angle between a player's view and the enemy's
  position on the first frame the enemy becomes visible.
- Recoil control: how a player's view moves while firing at a visible enemy.
- Reaction time, exposure duration, time-to-kill, first-shot advantage,
  pre-aim quality, target acquisition (§8).

Storing this for every frame of every player would cost too much, so the
fact is sparse by design: it exists only where the two players can see each
other — and, per §3, only where such a period is discovered from a shot.

## 2. Why not tick-state

Tick-state keeps derived features at 64 Hz for every player — ~170 MB per
match. Adding exact positions and view angles to it would multiply that and
buy nothing a sparse table couldn't. The encounters fact is the sparse
answer.

The sidecar is also no substitute: it stores positions at 1.0-unit
quantization with yaw quantized to 1.40625° and no pitch, no roll, and no
view offset — and metric SQL cannot reach it at all (§6).

## 3. Discovery — seed-based, weapon-fire only

Owner ruling (2026-11-20): discovery is **seed-based**, and the seeds are
**weapon-fire events only**. Kill seeds are rejected — a weapon kill is
always preceded by weapon-fire events, and kills from anything other than
weapon fire are outside the encounter context.

### Algorithm

For each weapon-fire event:

1. Identify the firing player and the tick.
2. Identify all living opposing players at that tick.
3. For each, check whether that directional observer→target relationship
   already has coverage at this tick. Dedup is directional: A→B covered
   never blocks B→A or A→C.
4. If not covered, evaluate visibility in both directions (can the shooter
   see them; can they see the shooter).
5. If neither direction holds, discard.
6. For each direction that holds, independently expand the interval backward
   and forward, tick by tick, until visibility ends or a boundary is
   reached: either player's death, round termination, demo start or end.
7. Collect both players' state (§6) for every covered tick — the union of
   the intervals.
8. Create or extend the encounter record.

A single seed may discover multiple encounters (the shooter may see several
opponents). Multiple seeds inside established coverage trigger no
reconstruction. Expansion is straightforward tick-by-tick; optimize only
after profiling. Candidate optimizations — cheap distance filtering,
spatial acceleration structures, temporal coherence, adaptive evaluation —
are profiling-driven, never defaults, and none may be facing-based (§4).

An interval start discovered this way is a true visibility start (given the
geometry estimate): expansion walks back until line of sight actually
breaks.

### Accepted coverage gap

The dataset is **shot-associated visibility**, not a comprehensive record of
visibility. Encounters with no weapon fire are never discovered: holding an
angle without firing, spotting each other and disengaging, tracking without
shooting. This is accepted (owner, 2026-11-20). Consequences:

- Reaction time, time-to-kill and first-shot advantage inherently involve a
  shot — they are unaffected.
- Exposure duration and target acquisition are **incomplete by design**:
  computed only over discovered encounters.
- Additional seed sources can be added later without changing the model.

### Cost

Seeds plus expansion replace full pairwise tracing — roughly 3 million
traces per match if every opposing pair were evaluated on every frame.
Tracer speed on real geometry is unmeasured; the benchmark is the first
spike when the fact is enqueued (§10).

### Seed availability

Weapon-fire events are typed at ingest (payload: `userid`, `weapon`, … —
no position, which a seed doesn't need).

## 4. What "visible" means

Line of sight between two players, computed from the map's compiled
geometry. Reference implementation: `saiko-tech/bsp-tracer` (Go, MIT) — it
traces a segment through the BSP tree; it needs the map file and the game's
model archives from the user's own install, and ships no map data. We supply
the segment endpoints (observer eye → target midpoint); the tracer does the
segment test only.

**Visible means *could* see each other if they were facing each other** —
pure line of sight, deliberately independent of facing. CS2's field of view
is known (~106.26° horizontal, ~73.74° vertical) but is excluded from the
test on purpose: the fact records opportunity, not perception. One-way
intervals therefore arise from geometry — heights, edges, cover — never
from facing: a player who turns toward an enemy does not thereby acquire
visibility, and one who turns away does not lose it. Facing is what the
*metrics* judge — crosshair placement measures the angle between the
player's actual view direction and the enemy's position at first
visibility, so a player who peeks backwards takes the full ~180° penalty.
Corollary: no facing or view-cone filter may ever prune discovery, or an
encounter would vanish exactly where the metric needs it most.

Its known limits, from its code, not its documentation:

- It doesn't model smoke, flashes, or player hitboxes.
- It skips some geometry: displacements, several prop solid types, and props
  not placed in the world.
- It targets CS:GO's BSP. Whether CS2 maps use the same format is
  unverified — a sourced `CS2.md` entry is required before any code depends
  on it (§7.2).

**Smoke is accepted error** (owner, 2026-11-20): smoke blocks real line of
sight but is not modeled, so visibility intervals can run through smoke. We
can't get around that right now and don't try to; revisit only if the error
proves material for a metric. Flash blindness is unmodeled in the same way.

So "visible" is an estimate, and the fact must say so (§9).

Practical consequence: a reaction time measured from visibility start is an
upper-bound-ish estimate — the stimulus may have been geometrically present
while off-screen.

## 5. Geometry

**Viewpoint (observer eye):** the demo's actual view offset — no
approximation. demoinfocs (v6.0.0-rc.2, the vendored version) exposes
`PositionEyes()` — feet origin plus `m_vecViewOffset` — which already
reflects ducking. A frame whose view offset is unavailable is skipped (no
sample, no trace at that tick); mid-round covered frames always have it, so
skips are edge cases, not a policy. Owner (2026-11-20): the
`64 − 18·duck_amount` fallback is dropped — no eye-height constants live
in code.

**View target (what the crosshair is measured against):** the midpoint
between the target's feet origin and eye position, computed per tick:

`view_target = (origin + eye) / 2` — i.e. `z = feet_z + eye_z / 2`

Both endpoints are known for every covered frame (§6), so the midpoint
tracks crouch automatically — a crouched player's eye is lower, so the
midpoint drops with it — and no static offset can be wrong. Standing, the
midpoint sits at half the eye height (≈ 32 at eye 64): the static
approximation's value, without its crouch error. No hitbox reconstruction;
the rule stays independently replaceable.

## 6. Data model

Four tables in the **main DB** (owner confirmed, 2026-11-20). That is not
optional: metric SQL can only read allowlisted SQLite tables, and the
per-match sidecar (custom zstd-framed streams, read only through Go
services) is unreachable from metrics. Volume is accepted at full fidelity:
the expected scale is the same order as, or smaller than, `player_ticks`
(~1.3 M rows/match), and any measurement taken at implementation is
informational, not a gate.

Keys are TEXT SteamID64 — the repo's player key, never integer ids. Every
table carries `match_id` and `round`. An encounter never spans rounds
(round termination is an expansion boundary); the round derives from the
tick via `rounds.start_tick`/`end_tick`.

### `encounters`

| Column | Description |
|---|---|
| id | encounter id (unique per match) |
| match_id | owning match |
| round | round number |
| start_tick | earliest covered tick |
| end_tick | latest covered tick |

### `encounter_participants`

| Column | Description |
|---|---|
| encounter_id | parent encounter |
| steam_id | participant — exactly two rows |

No A/B roles: participant identity is symmetric, so metrics bind `:steam_id`
to either player.

### `encounter_visibility`

Directional intervals — one or two rows, independent, so mutual visibility
can begin and end at different times from one-way visibility:

| Column | Description |
|---|---|
| encounter_id | parent encounter |
| observer_steam | player doing the seeing |
| target_steam | player being seen |
| start_tick | first visible tick |
| end_tick | last visible tick |

### `encounter_samples`

One row per player per covered tick (covered = union of the visibility
intervals), carrying that player's full state. One row per player rather
than per visibility direction keeps both participants' full state on every
covered frame, and reflects that an observer in a two-participant encounter
has exactly one counterpart:

| Column | Description |
|---|---|
| encounter_id, tick, steam_id | uniqueness constraint |
| x, y, z | exact feet origin (floats) |
| pitch, yaw | exact view angles (floats, pitch included) |
| eye_z | eye position z from the demo's view offset at this tick |

Both participants get a row on every covered frame — both players' position
and view angles are stored, as §1 requires. Exact floats throughout; the
sidecar cannot serve this (§2). Metrics read their subject directly
(`steam_id = :steam_id`) and reach the counterpart with a self-join on
`(encounter_id, tick)`.

Sampling is at **full tick rate and is never decimated** (owner,
2026-11-20): the fact exists to capture position, velocity and view angle
exactly when it matters, and once a moment matters, every frame of it
matters. Full rate also makes velocity derivable — metrics compute it from
consecutive samples, so no column is stored.

### Naming

The new fact tables are `encounters*`. The existing `engagements` table is
a per-kill classification (opening / trade / traded / untraded) — a
misnomer slated for a "kill class" rename. With this fact named `encounters`
there is no collision: that rename is cleanup, not a prerequisite.

## 7. Requirements

1. **Map geometry is extracted at runtime** from the user's install, the
   way the radar map packs are. It is never shipped (PRODUCT.md, Valve IP).
   It is a new extraction family, serialized with the others (the three
   existing families share one mutex and one progress event), and it must
   match the demo's map version.
2. **The CS2 map format is checked first.** This is a domain fact, so it is
   recorded in `CS2.md` with a source before any code depends on it — part
   of the pre-implementation spike batch (§10).
3. **Precise storage.** Positions and view angles are stored as exact
   floats, with pitch. The sidecar quantizes yaw to 1.40625° and stores no
   pitch, so it can't serve this.
4. **Visibility is an ingest-time stamp,** not a tick join. Tick-state
   can't produce it, since it needs geometry. It is an estimate, and it is
   labeled as one. It can't be presented as a recorded fact.
5. **Keying.** Each encounter is keyed by match, round, and the participant
   pair. Metrics bind to `:match_id`, `:round`, and `:steam_id`, where
   `:steam_id` matches either player. The fan-out registry gets an
   encounter-grain entry: the reserved bind, its fact-table enumerator
   (fanning out to **both** participants' values), and the scope-aware
   cascade.
6. **Allowlist.** All four tables are classified readable when they are
   added — the classification test forces the decision — and touched tables
   derived at save then drive freshness automatically.

## 8. Downstream metrics

| Metric | Required information |
|---|---|
| Crosshair placement | Viewpoint, view angles, target position |
| Recoil control | View movement while firing at a visible enemy |
| Reaction time | Visibility start, first relevant shot |
| Time to kill | Shot events, damage events, death |
| Exposure duration | Visibility interval |
| First-shot advantage | Directional visibility intervals, shot events |
| Pre-aim quality | View angles at initial visibility |
| Target acquisition | View-angle deviation over time |

Feasibility notes:

- Crosshair angles are computable **as metric SQL**: the modernc SQLite
  driver is built with `SQLITE_ENABLE_MATH_FUNCTIONS` (`atan2`, …) and the
  raw-SQL metric pipeline imposes no function whitelist. No new computation
  channel is needed, provided the encounter tables are allowlisted (§7.6).
  The angle is measured against the player's actual view direction, so a
  backwards peek lands near 180° by design (§4).
- Samples are retained for both participants on covered frames, so players
  who never fire a shot are still analyzable within discovered encounters.
  Career queries bind `:steam_id` with no A/B role.
- Reaction time — and any visibility-dependent number — is an estimate:
  line-of-sight start marks opportunity, not a perceived stimulus
  (visibility is facing-independent by definition; smoke is accepted
  unmodeled error, §4).
- Builtin metric SQL over these tables carries the standard bot-exclusion
  predicate; user SQL is unfiltered (accepted footgun).
- Freshness: the writer is ingest; touched tables plus encounter-grain
  binds scope the behind-set.

## 9. Labeling estimates

PRODUCT.md's classes are Fact, Metric and Record — there is no "estimate"
class. A view-level `inferred` badge already exists (`.chip.badge-inferred`,
the one badge spelling shared by every view that marks a cell computed vs.
inferred), with `.def` tooltips for definitions.

**Decision (owner, 2026-11-20):** visibility-dependent numbers use the
existing `inferred` badge, with a `.def` tooltip explaining that visibility
is a geometric estimate — could-see line of sight, independent of facing,
smoke not modeled (accepted). PRODUCT.md's classes are unchanged.

## 10. Spikes, deferred decisions, and hygiene

**Spike batch — the first task when enqueued** (both read-only,
cs2find-style, against the local install):

- **Tracer benchmark.** Traces per second on real geometry, multiplied by
  expected covered ticks — this sizes the ingest job. Only pathological
  results (milliseconds per trace) would force design changes such as
  spatial caching; anything sane keeps tick-by-tick expansion.
- **BSP reachability + format.** Confirm the map `.bsp` files are
  obtainable from a CS2 install (path/prefix) and extractable through the
  existing VPK reader, and verify the CS2 BSP format against `bsp-tracer`
  (which targets CS:GO) — recorded in `CS2.md` with a source before code
  depends on it (§7.2). Owner expects the files to be available
  (owner, 2026-11-20).

**Deferred to first release** (principle decided now, 2026-11-20):

- Visibility is always traced against the **currently installed geometry**
  — accepted error, the same class as smoke. The original geometry is
  unrecoverable: the install is overwritten and old BSPs are never
  retained (Valve IP).
- Release prep adds a BSP-content-hash provenance column, and the
  user-facing label for geometry-stale demos is decided then.

**CS2.md hygiene (whenever convenient, non-blocking):** the FOV figures
(~106.26° horizontal / ~73.74° vertical), owner-stated, to be sourced. No
code depends on FOV — it is excluded from the fact by design (§4).

## 11. Relation to the metrics system

The metrics and components system is the substrate: raw-SQL
metrics, one read-only save gate with an explicit allowlist and
touched-tables-at-save, bind-scoped fan-out and freshness, stored
components. Against it:

- New fact tables are additive — schema plus allowlist classification is
  the whole integration.
- The bind design covers match, round and player keys — exactly this fact's
  keys; the encounter grain adds one enumerator.
- Sidecar and tick-state stay as they are. Nothing forecloses storing exact
  positions later — tick-state rejected them as a density policy, not a
  capability.

## 12. Architectural principles

- Seed discovery, visibility reconstruction, encounter persistence, sample
  collection and metric calculation stay separate. Discovery and
  reconstruction know nothing about the database schema.
- Metrics consume encounters without needing to know how they were
  discovered.
- Correctness, determinism and a straightforward data model over premature
  performance optimization. Profiling drives optimization.
