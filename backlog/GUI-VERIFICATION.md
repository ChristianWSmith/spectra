# GUI verification required (backlog/sprint-2026-11)

Definition of done for this sprint: everything that does not need a GUI is
done. This file lists what still needs a human at a screen. Each item says what
to do and what "pass" looks like.

Branch: `backlog/sprint-2026-11` (pushed to origin, not merged to main).

## 1. Asset gate and extraction flow (new, GUI)

Change: `LibraryService.ImportPaths` refuses to import until the map packs, icons,
sounds and the keep-list world-collision caches exist in the data dir.

Check:
- Fresh data dir (or move `~/.local/share/spectra/{maps,icons,sounds,worldcol}` aside).
- Try to import a demo. Expect the error "extract the CS2 assets before importing
  (missing: ...)".
- Run the asset extraction (Settings or the launch prompt). Expect progress, then
  import to work.
- Confirm the launch prompt and Settings describe the CS2 install as required.
- Copy: the app's "no CS2 install required" wording must be changed. Not done
  (owner: "we'll do it").

## 2. Kill tags rename (GUI)

Change: "Engagements" is now "Kill tags" everywhere. The builtin id is
`builtin-match-combat-kill-tags`. The table is `kill_tags`.

Check:
- Match → Combat tab. The Kill tags card renders, the kind chips filter, and the
  round dropdown works.
- Layouts that placed the old panel: the panel now shows under its new id. Any
  saved layout that referenced the old id will not show it. Confirm the expected
  behaviour and decide whether to migrate.
- Re-import (wipe) required for existing libraries (no migration before v1).

## 3. Visual check of the keep-list world collision (GUI or debug tool)

Change: `mappack.ExtractWorldCollision` writes `<map>.worldcol` for the ten keep
maps (ancient, anubis, cache, dust2, inferno, mirage, nuke, overpass, train,
vertigo).

Check: overlay the collision triangles on the radar for each keep map. Expect
walkable floor to sit on the drawn map. Automated proxies were inconclusive:
- Spawns lie under up-facing triangles on all 23 maps with overviews (30 of 30).
- Radar-mask agreement is weak (58% floor vs 32% random). A scale sweep does not
  peak at the stated transform.

Only a visual check settles this.

## 4a. CLI flows (no GUI, but a new user path)

- `spectra -extract [-cs2 <dir>]` and `spectra -import <demo>` (extracts first when
  assets are missing). Tested headless. A GUI check should confirm the import gate
  error text and the first-run extraction prompt.

## 4. Encounter visibility (no GUI yet, but review needed)

Change: `internal/encounter` builds shot-seeded windows with a bounding-box
sample (top at eye height + 8, width 32 centred on the origin).

Results on the 7-match snapshot:
- Seeds 2,407 of 23,334 shots. Covered tick rows 1.8%.
- Killer line clear at the last frame before a kill: 90.3% (from 80% with the
  centre sample). 81 kills remain blocked without a wallbang flag. Unexplained.

Owner review: is the 1.8% coverage acceptable, and is the 81 unexplained blocks
acceptable? No GUI needed to decide, but it needs your judgment.

## 5. Props and entities: dropped

Removed from the code. Placements were wrong (0.4% kill clear-lines with props),
so nothing in the visibility path uses them. No GUI check.

## 6. Previously deferred GUI items (unchanged)

- S13: UI metric reads. Human GUI acceptance is the acceptance step.
- Driver liveness and DOM tests need a live WebKitGTK run. Not run this sprint.
- Frontend strings: the asset prompt and import error need a read-through.

## Not started, no GUI needed

- S08 (library of 50+ matches): blocked on data.
- S05 (equipment and spend derivation), S16 (round table decision): deferred.
- Cutting radar and frontend support for non-keep maps: owner has not decided.
- Merge to main: not this session.

## 7. Unexplained kills overlay (new)

Change: 36 bullet kills (no wallbang, no smoke, no penetration) are blocked by the
main structural meshes on ancient, inferno and mirage (see S18, "Unexplained kills,
characterized").

Check: in a debug overlay, draw the killer-to-victim sight line and the blocking
mesh for each of the 36. Pass: the blocking geometry is a real solid the kill could
not have passed. Fail: the blocking is thin or gapped geometry the shot passed
through, which means the world collision over-blocks.

## 8. Encounter build at import (decided, not wired)

Decision: the encounter build runs at import. Status: `SaveEncounters` and
`GetEncounters` exist with a round-trip test, but the import pipeline does not call
the builder yet. Wiring it in is the next code step. GUI check after that: an import
produces encounters, and the import stays responsive on a full match.
