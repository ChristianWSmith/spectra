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

## 3. Visual check of the keep-list render geometry (GUI or debug tool)

Change: `mappack.ExtractRenderGeometry` writes `<map>.render` (and `.mats`) for the ten keep
maps. The encounter sight lines use this geometry. Collision (`.worldcol`) is no longer used.

Check: `spectra-overlays` side-by-side renders (`de_train-prod`, `de_overpass-prod`,
`de_vertigo-prod`, `anubis-steep`) and a live replay of one encounter. Pass: the walls, floors and
props line up with the game. Fail: a solid wall the game lets you see through, or a gap the
game does not have.

## 4a. CLI flows (no GUI, but a new user path)

- `spectra -extract [-cs2 <dir>]` and `spectra -import <demo>` (extracts first when
  assets are missing). Tested headless. A GUI check should confirm the import gate
  error text and the first-run extraction prompt.

## 4. Encounter visibility (review needed)

Change: encounters are built from the render geometry, with the smoke, glass and dynamic-entity
exclusions (see S18). Numbers on the scratch de_cache import: 350 windows, 502 encounters,
20,259 samples.

Owner review: is the exclusion policy (dynamic entities out, glass out, borderline materials in)
acceptable? Borderline materials and their triangle counts are listed in S18.

## 5. Props and entities: partly reinstated

Change: static world props and placed entity models are in the render geometry. Dynamic entities
(doors, breakables, moving brushes, physics props) are out. This reverses the earlier "props dropped"
ruling. Owner to confirm.

## 6. Previously deferred GUI items (unchanged)

- S13: UI metric reads. Human GUI acceptance is the acceptance step.
- Driver liveness and DOM tests need a live WebKitGTK run. Not run this sprint.
- Frontend strings: the asset prompt and import error need a read-through.

## Not started, no GUI needed

- S08 (library of 50+ matches): blocked on data.
- S05 (equipment and spend derivation), S16 (round table decision): deferred.
- Cutting radar and frontend support for non-keep maps: owner has not decided.
- Merge to main: not this session.

## 7. Unexplained kills (superseded)

The 36 kills that collision blocked are cleared by the render geometry (see S18). No overlay check is
needed for them. The overlay tool still works on any kill.

## 8. Encounter build at import (wired; re-run needed)

Required before this check: run `-extract` (writes the render caches, about 1.2 GB for ten maps), then
re-import every match. Encounters are derived at import, so old encounter rows are stale.

Scratch check on a fresh data directory: all ten maps extract; a de_cache import gives 350 windows,
502 encounters and 20,259 samples.

GUI check: an import completes, the match's encounters exist, and the import stays responsive on a full
match. Examples are in `GUI-EXAMPLES.md`, section 4.

## 9. Match view: tabs and scroll (frontend change, GUI check)

Changes: visited match tabs stay mounted (hidden, not destroyed), and the last viewed
match stays mounted across top-level navigation.

Check:
- Switch between Overview, Scoreboard, Rounds and back. The panels should not reload
  (no loading state on return).
- Scroll down on a match, switch to Library and back. The scroll position should
  return. Before this change it reset to the top.
- Open a second match, then return to the first. Its tab and scroll should be
  where you left them. Only one match is kept mounted at a time, so the older
  match reloads.
- Watch for a flicker or a stale layout when a hidden tab is shown.

## 10. Kill overlay and examples (GUI replay)

Examples and the overlay procedure are in \`GUI-EXAMPLES.md\`: encounter windows
(section 4) and the 36 unexplained kills (section 7).

## 11. Mutual encounters (decided)

Decided: one window per pair per round holds the high-fidelity samples. Each side
of a mutual fight is its own encounter, and both encounters reference the window.
Samples are per window, not per encounter, so nothing is stored twice. GUI check:
a mutual fight shows as two encounters that point at the same window.
