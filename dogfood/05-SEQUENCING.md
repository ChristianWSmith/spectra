# 05 · SEQUENCING — wave graph, parallelism, the wipe

**Status:** rewritten 2026-11-20. Wave definitions, checks and gates are in
`PLAN.md` §5–§6. This document covers only ordering, parallelism and the wipe.

---

## 1. Graph

```
Track 0   W0 reference export  ───────────────────────────────┐
                                                              │
Track A   A1 tick table+sink ─▶ A4 weapon_fire ─┐             │
                  │                              │             │
                  └──────────▶ A2 tick joins* ─▶ A3 stamp drops │
                                    ▲                          │
Track B   B1 read path ─▶ B2 save gate ─▶ B3 port (+ snapshot  ◀┘
                                           check on a copy)
                                    │
                                    ▼
                         B4 freshness ─▶ B5 retire grammar ─▶ B6 drop N ─▶ B7 round grain
Track C   C0 runtime spike ─▶ C1 storage ─▶ C2 runtime ─▶ C3 builder tab ─▶ C4 placements/prefs ─▶ C5 dogfood
Track S   S1 dead folds  (parallel; no schema)

* A2 is the tick-join content of B3's port for three seeds; it lands with B3.
D-5 (storage and scope, `03-QUERIES.md` §5) is decided. Its scope-aware
cascade change is part of B4.
```

## 2. Parallelism

- **Strictly sequential inside a track.** Track A (A1 → A4), Track B (B1 →
  B7), Track C (C1 → C5).
- **Parallel across tracks.** A and B run in parallel worktrees. C runs
  alongside, with its schema change in C1. S1 runs anytime.
- **Serialized pair.** A1 and A4 both touch `internal/extract` and the golden
  fixtures. Never in parallel with each other.
- **Shared-file regions.** `schema.sql` is touched by A (table, drops), B
  (touched column, n removal), and C (components). Merge in that order; each
  region is distinct.
- **A2 with B3.** The three tick-join seeds are the one place where Track A
  edits a Track B artifact. Land them in the same change as the port.

## 3. The wipe

One wipe, after the schema waves are green: A1, A3, A4, B2, B4, B6, C1, and
B7 if it applies. The non-schema waves (B1, B3 port text, B5, C2–C5, S1) do
not gate it, but B3's port text must be in place before the wipe, because the
wipe is what applies it.

**Choreography** is in `PLAN.md` §6. In short: deep-clean, re-import from the
snapshot's demos, diff values against the reference export, stop on any
change.

## 4. Pre-wipe verification

B3 runs every ported statement against a copy of the snapshot database. This
catches port errors before any wipe, and it needs no schema change. The wipe
then verifies the pipeline end to end (sink, analysis, sweep), which the
pre-wipe check does not exercise.

## 5. Risks to watch

- **B1 changes the sweep's connection.** Metric SQL on the read connection can
  see a different snapshot of the database during a sweep than the writer
  does. Verify that a sweep's reads are consistent with the writes it makes.
- **Runtime compile (D-1).** If the Svelte compiler ships to the webview, its
  size and CSP implications affect C2. Decide before C2 starts.
- **Freshness pins (B4).** The pins are the easiest place for a silent
  over-approximation or under-approximation. Pin behavior on a rule-value edit,
  a code bump, and a fact-only metric before changing the predicate.
