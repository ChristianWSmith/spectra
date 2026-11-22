# S18 — Encounter fact (build) — NOT IN THIS SPRINT

**Type:** build (deferred)
**Status:** DEFERRED. Owner has not enqueued it (`source/ENCOUNTER-MANIFESTO.md` header).
**Depends on:** S07 (G7), owner enqueue, map geometry extraction (manifesto §7.1)
**Source:** `source/ENCOUNTER-MANIFESTO.md`

## Goal
Record in-app the sparse, visibility-seeded fact: four tables in the main DB
(`encounters`, `encounter_participants`, `encounter_visibility`,
`encounter_samples`), with exact positions and view angles.

## Why it is written here
It is the destination for state that tick rows no longer carry (`source/PRUNE.md`
options 1, 8, and the speed/in-air discussion), and it reuses S10's
roster-and-kills rule for discovery. Listing it keeps those dependencies visible.

## Not in scope
Nothing here is scheduled. Start only after S07 reports go, and after the owner
enqueues it.

## Role in tiered fidelity
Encounters are tier 2 (`source/PRUNE.md`, "Tiered fidelity"): dense
position, view-angle and motion data inside shot-seeded windows. They are
expected to be much smaller than tier 1 (owner: CS2 time-to-kill is short, so
windows last seconds), and their size depends on merging of overlapping
windows. Unmerged scenarios on match 4 range from about 41,000 rows (one window
per kill) to about 1 M rows (one per shot).

Speed, in-air and weapon are candidates for tier 2. HP is not: it stays in
tier 1 by decision.

## Open questions
- Coverage fraction and merge rule (S07).
- Map format for CS2 (manifesto §7.2).
- Whether gaps outside encounter windows are acceptable for each moved column.
  Any metric reading tier 2 must label coverage as partial.

## Status update (2026-11-22): owner go, seed rule chosen

Owner rule: a shot seeds an encounter only when the shooter has a line of sight
to an enemy at that tick. The window extends backward and forward as far as the
(shooter, enemy) pair stays visible and alive, within the round. A shot that falls
inside an existing window of the same shooter is skipped as a seed.

Implemented: `internal/encounter` (builder). Spike driver: `internal/encounter/encounter_spike_test.go`.

Snapshot result (7 matches, 9,817,283 tick rows):
- Shots 23,334. Skipped (covered by an encounter): 3,963. Seeds: 1,971.
  No visible enemy at the shot tick: the remaining 17,400 (about 75%).
- Covered tick rows (participants in windows): **1.2%** (116,028 rows).

Validation of the visibility test (`internal/encounter/kill_validation_test.go`):
- At the frame closest to each kill (1,094 kills), the killer's line to the victim
  is clear in 80% of kills. Of the 20% blocked, 36 are flagged wallbang. 181 are
  unexplained: occluder or sampling error, not measured further.
- Eye offset sweep: clear-line rate rises from 20% (feet) to 80% at 64 and 81% at
  72. Standing eye height 64 is the default. Sampled Z is the feet.
- About 95% of shots have a living enemy in the frame. The low seed rate comes
  from the line-of-sight test, not from a missing enemy lookup.

Open for the owner: the 1.2% figure depends on the strict line-of-sight rule. A
looser rule (any enemy audible, or any enemy within range) would cover more.

## Update (2026-11-22, later): bounding-box sample

Owner refinement: the top of the enemy box is eye height + 8 (64 standing, 46
crouching); width is 32, centred on the origin. Samples are four corners at mid
height and four at the top: 8 points per enemy. A line is clear if it reaches any.

Results (7 matches): seeds 2,407 (was 1,971 with the centre sample). Covered tick
rows 1.8% (was 1.2%). Killer line clear at the last frame before a kill: 90.3%
(was 80.2%). Unflagged blocked kills 81 (was 181).

## Props (2026-11-22): experimental, off by default

Entity lump: `maps/<map>/entities/*.vents_c`, DATA `m_entityKeyValues` (363 entities
on anubis, 72 with a model). Hull planes use `n.x <= d` (verified: all 77 anubis
hulls clip). With props added to the occluder, kill clear-lines collapse to 0.4%,
so placements or the transform are still wrong for many props. Props stay off
until that is resolved.

## Blocked kills, explained (2026-11-22)

Of 1,094 kills with both players sampled in the 16 ticks before, the frame closest
to the kill blocked 106. Classification of those 106:

| Explanation | Count |
|---|---|
| Wallbang flag on the kill | 25 |
| HE grenade kill | 4 |
| Molotov kill | 2 |
| Bullet kill, unflagged, clear in an earlier frame of the window (peek timing) | 26 |
| Bullet kill, unflagged, still blocked, but clear under a dense 3x3x5 target grid | 2 (overlap) |
| Bullet kill, unflagged, still blocked under every sampling tried | about 47 |

Unflagged bullet blocks: 75. Clear in an earlier frame: 26. Dense grid clears 28 of
the 75 (overlaps the earlier-frame set). The remaining 47 are about 5% of kills.
They are either world-mesh over-blocking (thin or non-solid geometry) or position
sampling error. Not resolved.

## Viewpoints (2026-11-22)

Each encounter stores one viewpoint per frame in its window where both players
are present: the shooter's eye and the enemy's eye. The enemy's eye is the canonical
aim point (their head), per the owner. This is the encounter table's viewpoint
data for the crosshair-placement metrics.

## CLI (2026-11-22)

- `spectra -extract [-cs2 <dir>]`: runs radar packs (keep list), icons, sounds and
  world collision. Exits non-zero if anything is missing.
- `spectra -import <demo> [-cs2 <dir>]`: runs the extraction first when assets are
  missing, then imports. Tested from an empty data dir on de_cache.

## Keep list (2026-11-22)

Only ancient, anubis, cache, dust2, inferno, mirage, nuke, overpass, train, vertigo
are extracted (radar, world collision). Frontend bundled packs are already a subset.

## Props (2026-11-22): dropped

Code removed. Props gave a 0.4% kill clear-line rate when included, so placements or
the transform are wrong and nothing in the visibility path uses them.
