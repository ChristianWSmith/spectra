# Sprint 2026-11: index of decisions and measurements

Branch: `backlog/sprint-2026-11` (on origin, not merged to main). Pick up from here.
GUI work is listed in `GUI-VERIFICATION.md`.

## Owner rulings

| Date | Ruling | Where recorded |
|---|---|---|
| 2026-11-22 | Post-round tick rows are kept; post-match rows (after the final counted round) are dropped | S17, S02 |
| 2026-11-22 | OT `money_start` takes the player's first tick of the round (option B) | S02 |
| 2026-11-22 | Presence rule: safe option. Absence is absence; no inference from the last row | S21, PATH |
| 2026-11-22 | Speed is absorbed into encounters, not the tick table | PATH |
| 2026-11-22 | Keep list only: ancient, anubis, cache, dust2, inferno, mirage, nuke, overpass, train, vertigo. Radar, render geometry and bundled frontend packs are limited to it. Binary KV3 versions 4 and 5 are both read (version 4 for shared props) | PATH, GUI-VERIFICATION |
| 2026-11-22 | Seed rule: a shot seeds an encounter only with line of sight to an enemy at that tick. The window extends while the pair stays visible and alive, within the round. Shots already inside an existing window of the same shooter are skipped | S18 |
| 2026-11-22 | Enemy sample is a bounding box: 32 wide, centred on the origin, top at eye height + 8 (64 standing, 46 crouching) | S18 |
| 2026-11-22 | Canonical aim point is the opponent's eye (their head). Encounter samples store shooter eye, enemy eye and enemy world position per tick; the body midpoint is derivable from eye and world | S18, PATH |
| 2026-11-22 | `spectra -extract [-cs2 <dir>]` runs every extractor. `spectra -import <demo>` extracts first when assets are missing | S18, GUI-VERIFICATION |
| 2026-11-22 | Import is refused until the map packs, icons, sounds and keep-list render-geometry caches exist (`ImportPaths`) | GUI-VERIFICATION |
| 2026-11-22 | The encounter build runs at import (wired). Encounter tables are windows with their samples; encounters reference their window (S18) | S18, GUI-VERIFICATION item 8 |
| 2026-11-22 | Sight-line geometry is the map's render geometry, not the collision mesh. Collision is incomplete on several maps (its bounds fall short of the world resource's). Render geometry clears all 946 kills on the seven maps with kills | S18 |
| 2026-11-22 | Dynamic entities (doors, breakables, moving brushes, physics and dynamic props) are excluded from sight-line geometry, a conservative choice. This reverses the earlier "props dropped" ruling for static world props, which are now in. Owner to confirm | S18 |
| 2026-11-22 | See-through materials excluded: smoke and steam effects, light shafts, puddles, glass. Borderline materials (foliage, decals, cloth, wire, grates, tools) stay in | S18 |
| 2026-11-22 | S21 presence ruling: safe option, absence is absence | S21 |
| 2026-11-23 | Backlog pushed forward by subagents on isolated worktrees (S03, S05, S06, S09, S12, S13); results are reviewed before merge | this file |
| 2026-11-23 | S09 landed: damage-family seeds read sides from round_player_sides. Existing libraries keep the old seed text (seeds are INSERT OR IGNORE): a wipe is needed to pick it up | S09 |
| 2026-11-23 | S12 decisions: tick queue depth 2; write errors at StageParse accepted | S12 |
| 2026-11-22 | VRF is MIT-licensed. Its license is in `src/internal/source2/LICENSE-VRF.txt`, and the reader carries attribution | source2 headers |
| 2026-11-22 | The CS2 install is now required for the app (the "no install required" wording must change) | GUI-VERIFICATION |
| 2026-11-22 | GUI verification is deferred to a later batch, documented in GUI-VERIFICATION.md | GUI-VERIFICATION |
| 2026-11-22 | Not merging to main this session | this file |

## Measurements (7-match snapshot, scratch library)

| Measurement | Value | Where |
|---|---|---|
| Tick rows total | 9,817,283 | S17, S07 |
| Post-round tick rows (kept) | 678,930 (6.9%); 17,101 in each final round (dropped) | S17 |
| Shot-seeded merged windows, coverage | 47% at 2 s, 36% at 1 s, 26% at 0.5 s (no visibility test) | S07 |
| Kill-seeded merged windows, coverage | 12% | S07 |
| Encounters with the visibility rule (bounding box) | 2,407 seeds from 23,334 shots; 1.8% of tick rows covered | S18 |
| Kill clear line, last frame before kill: centre sample / bounding box | 80.2% / 90.3% | S18 |
| Blocked kills explained by a flag | 25 wallbang, 4 HE grenade, 2 Molotov | S18 |
| Render geometry, production policy, seven maps with kills (946 kills) | both clear 946 minus render-only; collision-only 0 on every map; render clears all 946 | S18 |
| de_cache encounters on the render geometry (scratch import) | 350 windows, 502 encounters, 20,259 samples (collision version: 252, 370, 15,337) | S18 |
| Unexplained kills (36 of 1,043) | long range (median about 21 m), 27 on ancient, inferno, mirage; AK-47 16; none penetrated; doors do not explain them; blocking in the largest structural meshes | S18, GUI-VERIFICATION item 7 |
| Event `distance` field | metres (39.3 units per metre) | S18 |
| Unexplained kills after 3 s look-back | 33 of 36 still blocked | S18 |
| Viewpoint storage | about 3 MB per 7-match snapshot (9 floats per tick) | S18 |
| Radar agreement (superseded by the render-geometry check on the same question) | weak (58% floor vs 32% random); scale sweep does not peak at the stated transform: inconclusive | S07, PATH |
| Spawn on walkable floor | 30 of 30 on the 23 maps with overviews | S07, PATH |
| World collision | 1,543,751 triangles, 11 meshes on de_cache; all 10 keep maps extract | S07, GUI-VERIFICATION |
| dmg_no_kill, snapshot, 7 matches | old query 493 s; new query 1.5 s; values identical to stored metric_values | S09 |
| Raycast against brute force | 0 disagreements on 1,650 mesh queries; about 330k segments/s mixed, 516k/s unblocked | S07 |

## Format facts (CS2)

- Map resource: manifest in RED2 (de_cache), empty DATA. World collision: `world_physics.vmdl`, or `maps/<map>/world_physics.vmdl_c` when the manifest omits it (anubis, inferno, vertigo).
- Physics: PHYS block, KV3 v5 (zstd or LZ4). Mesh vertices float32 x3, triangles int32 x3; kd nodes 32 bytes, second child at index + ChildOffset.
- Hull planes: a point is inside when n.x - d <= 0 (verified).
- Entity lump: `maps/<map>/entities/*.vents_c`, DATA `m_entityKeyValues`. Only the first lump per map is read.
- Hull dimensions: 32 wide; 72 standing and 54 crouching (sources disagree; the older Source base hull says 36 for crouch).
- Angle matrix: Source AngleMatrix.
- Kill events: `penetrated`, `wallbang`, `through_smoke`, `distance` (metres) are in the payload.

## Open items (not decided)

- Whether to chase the roughly 33 unexplained long-range blocks further (GUI overlay first).
- Dynamic entities: excluded (see the rulings table). Static world props are in the render geometry, placed by their scene transforms. Confirm the policy.
- S18 and the 36 unexplained kills: superseded. Render geometry clears all 946 kills on the seven maps with kills; the 36 were blocked by incomplete collision and dynamic props.
- De_overpass, de_train and de_vertigo have no kills in the corpus; their render geometry is checked against stored bounds and by eye only.
- Competitive-pool list confirmed by owner; no further cuts pending.
- S08 needs a library of 50 or more matches. Not available here (the local library has 4 matches). Blocks the library-scale acceptance of S09, S10 and S17, and the baseline for S14.
- Wipe and re-import needed for the kill-tags rename, the post-match tick discard, the money fix and the new collision caches.
- S08 (library of 50+ matches), S05 and S16: blocked or deferred.
