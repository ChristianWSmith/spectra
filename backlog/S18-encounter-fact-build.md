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
