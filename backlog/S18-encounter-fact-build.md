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

## Unexplained kills, characterized (2026-11-22)

Criteria: bullet kill, no wallbang flag, not through smoke, not HE or Molotov, and
blocked in every sampled frame of [-64, +4] ticks under a dense 3x3x5 target grid.
36 kills (of 1,043 kills with frames). This replaces the earlier "47" count, which
included smoke and used a shorter window and centre-only sampling.

- Range: the event `distance` field is metres (checked: 39.3 units per metre
  against sampled positions). Median about 21 m (about 800 units), range 6 to 64 m.
  The earlier "under 600 units" reading was wrong; these are long-range fights.
- Map: ancient 10, inferno 10, mirage 7, other maps 1 to 4 each (27 of 36 on three maps).
- Weapon: AK-47 16, M4A1 7, others 1 to 3 each.
- Headshot: 20 of 36. Penetrated flag: 0 for all 36 (not penetration).
- Doors: 1 of 58 unexplained blocks lies within 150 units of a door-like entity,
  against 34 of 888 clear kills (about 4%). Doors do not explain them. Caveat: only
  the first entity lump per map is read.
- Time: 8 of 36 have a clear line 1 to 3 seconds before the kill; 28 stay blocked.
  Nothing after the kill: the victim's frames stop at death.
- Geometry: the blocking triangles belong to the largest structural meshes (ancient
  mesh 0, 6,985 triangles spanning most of the map; inferno mesh 4, 16,122 triangles),
  not to small props.

Most likely explanation: the world collision over-blocks long sight lines through
the main structures on those maps (collision thicker or more continuous than the
visible gaps and windows). Position error or server desync would not cluster by
map and mesh like this. Confirmation needs a GUI overlay of the blocking mesh along
these sight lines.

## Box sweep (2026-11-22): can the box size or offset capture the 36?

Tool: `TestBoxSweep` (`src/internal/encounter/sweep_test.go`), parameters in `box.go`.
Kills with frames: 946. Unexplained (no clear dense line in the window): 36.
Production box clears 910 kills. Control: 2,800 random opposing pairs, 5 to 32 m apart.

Swept: half-width 16 to 32, top 8 to 16 above the eye, lateral and forward lean
of -6 to +6 relative to the enemy's yaw, and a corner sampler versus a dense 5x5
grid at four heights. 270 settings. Full table: `~/Programming/spectra-overlays/sweep.md`.

- Best with the corner sampler: 5 of 36 captured, 6 production-clear kills lost,
  control false positives 5.7% (production 4.6%).
- Best with the grid sampler: 6 of 36 captured, 0 lost, control 6.2% (production 4.8%).
- Half-width is the only lever that matters. At top 8 and no lean, width 16 captures
  0, 20 and 24 capture 1, and 28 and 32 capture 3. Lean shifts change at most one kill.
- The corner sampler is not monotone in size: a larger box does not contain the
  smaller box's corners, which is why it loses kills as it widens.

Conclusion: no box setting in this family captures the 36. Widening captures a few
at the cost of more false positives, and the widest setting (32) is a box 64 units
wide, twice a player's real width. The 36 are not explained by box tightness.

## Position and grazing checks (2026-11-22)

- **Position agreement** (`TestPositionAgreement`, opt-in): damage-event victim
  positions vs the sidecar at the same tick, 3,019 events. Mean offset ~0; SD 1.4
  units horizontal, 1.1 vertical. Compares two outputs of the same parse, so it
  rules out sidecar storage error, not parser error. Eye height is not tested.
- **Grazing** (`TestBoxSweep` with `SPECTRA_GRAZE=1`): minimum shooter-eye move (26
  directions per radius) that clears a corner of the production box, for the 36.
  2 kills clear at 1 unit, 2 at 2 units, 4 at 4 units, 4 at 8, 9 at 16, 3 at 32,
  and 12 never clear within 32 units. Only about 4 are plausibly grazing a
  position-error-sized margin. The rest need a move that crosses real geometry.

## Wide sweep (2026-11-22): full parameter search, recall on kills

Tool: `TestWideSweep` (`src/internal/encounter/sweep_test.go`). Objective: kills
cleared, since every kill is a true line of sight. Parameters: half-width 16 to 36,
top height shift -8 to +16 (standing 72+, crouching 54+), mid fraction 0.25 to 0.75,
lateral and forward lean -8 to +8, corner or grid sampler, shooter eye shift -8 to +8.
Full space 18,000 settings; a random sample of 2,000 was run (about 35 minutes).
Full table: `~/Programming/spectra-overlays/sweep_wide.csv`, summary `sweep_wide.md`.

- Production box: 910 of 946.
- Best: 920 of 946 (grid sampler, half-width 36, top 88/70, mid 0.25, lateral -4,
  forward +8, eye shift +4). It also accepts 195 of 2,800 random opposing pairs,
  against 130 for production.
- 26 kills are cleared by no setting in the sample. They are listed in `sweep_wide.md`.
  Most are on de_ancient, de_inferno and de_mirage.
- The random-pair column is not a false-positive rate. Random pairs are not known to
  be blocked, so it only shows how permissive a setting is.
- The best settings raise the top sample height to 88, 16 above standing eye
  height. The parameter family can gain a few kills, but it does not reach all 946.

## Fail-fast search (2026-11-22)

`TestFailFast`: 27,000 settings (half-width 0 to 36, top shift, mid fraction, lean,
sampler, eye shift), each rejected at the first kill it fails to clear. Hard kills
first. Result: every setting fails on `de_ancient` tick 8013. No kills were dropped
for missing frames (946 of 946 have frames).

`TestOneKillEyeCube` on that kill: no shooter eye within ±8 units in x, y or z clears
it, in any of its 64 frames. Sidecar positions match the recorded events (attacker
eye = recorded position + 64; victim matches the kill event's position at tick 8012).
So the sampled positions are not the cause. The occluder is the remaining suspect:
removing mesh 0 of de_ancient clears it (ablation).

## Triangle check, de_ancient tick 8013 (2026-11-22)

`TestTriangleCheck`, frame at tick 8012, mesh 0 (6,985 triangles). All eight target
lines cross the same two triangles, both in the interior of the triangle:
- triangle 6877 at 10% of the line, area 24,288 units², normal cos to line -0.83
- triangle 4721 at 15% of the line, area 76,176 units², normal cos to line +0.56
The two crossings are about 35 units apart along the line, so the line passes
through a solid about 35 units thick, roughly 100 units from the shooter. The
blockers are large faces, not a thin pipe or slivers, and the hits are not at edges.

## Zoomed render, de_ancient tick 8013 (2026-11-22)

`TestZoomRender` writes `zoom-de_ancient-8012-{east,...}.png`. Plan view: the two
blocking triangles form the corner of a wall. All eight rays from the shooter pass
within a few units of that corner. East view: the blockers appear edge-on as one
sloped face. The few-units margin conflicts with the grazing test, which found no
clear line within 8 units of eye movement. Unresolved: the eye move that would
clear it may lie outside the 26 directions tested.

## Player and NPC clip meshes (2026-11-22)

The PHYS block has per-mesh collision attributes (`m_nCollisionAttributeIndex`), and
the worldcol extraction drops them. Exported for seven maps to
`~/Programming/spectra-overlays/attrs/<map>.attrs.json` (`TestDumpPhysAttributes`,
`SPECTRA_DUMP_OUT`). Every mesh that cleared a kill in the ablation, except
de_inferno mesh 0, has `interactAs` of `playerclip` and/or `npcclip`.

Production box, eye 64/46, kills 946:
- With all meshes: clears 910.
- Without the meshes whose `interactAs` is `playerclip` or `npcclip`: clears 944.
  Still blocked: de_nuke tick 58698 and de_nuke tick 91374.

This is an untested hypothesis that bullets pass player and NPC clip meshes. It is
supported by the data, not confirmed in game. The random-pair control has not been
rerun with the filter.

## Control for the clip-mesh filter (2026-11-22): the filter is too broad

Random opposing pairs that look clear under the production box, 2,800 pairs:
- All meshes: 130 (4.6%). Without playerclip/npcclip meshes: 408 (14.6%).
- Per map, 400 pairs each. de_anubis: 16 with all meshes, 243 without (61%).
  de_dust2: 25 to 52. de_ancient: 24 to 34. Other maps change by 1 to 6.

Triangles removed by the filter: de_anubis 41.6% (meshes 1 and 7), de_cache 22.2%,
de_mirage 8.8%, de_dust2 5.9%, de_ancient and de_inferno 0.7%, de_nuke 0.0%.

The 944 of 946 kills does not show the filter is right. On de_anubis it removes most of
the map's blocking geometry. The attribute says players and NPCs are clipped by those
meshes, not that bullets pass through them. Production is unchanged. The filter needs
a finer rule, per mesh or per geometry, checked against the control.

## Render geometry versus PHYS (2026-11-22)

- The map manifest lists render geometry separately from physics: `worldnodes/*.vmdl`
  (aggregated render meshes, e.g. `n0_lr0_agg_merge_*.vmdl`, about 40 of them on
  de_ancient), plus `world.vwrld`, `world.vrman` and `world_visibility.vvis`.
  `world_physics.vmdl` is the PHYS-only model that the worldcol extraction reads.
- PHYS per-triangle materials are empty on de_ancient mesh 0 (`m_Materials` has
  length 0), so PHYS carries no surface data for that map.
- Reading the render geometry needs a vertex and index buffer parser for `vmdl_c`
  (not in the repo). That is the next step if the render route is taken.
- Open point: the kills are bullet hits, so the engine's bullet trace is the target.
  Visibility from the render mesh tests a different question from bullet collision.

## Render geometry (2026-11-22)

- `internal/source2/meshopt.go`: Go port of meshoptimizer's vertex and index decoders
  (scalar paths of VRF's MIT-licensed decoders). Checked on one embedded mesh:
  14,991 vertices (stride 28), index maximum 14,990.
- `internal/mappack/render.go`: `ExtractRenderGeometry` reads the `worldnodes` render
  models (skybox excluded) from the map's manifest. de_ancient: 357 models, 9.16
  million triangles.
- `internal/source2/bvh.go`: median-split hierarchy, checked against brute force on
  random segments (4,000 segments, no mismatches). The render geometry was too slow to
  test without it.
- de_ancient kills, production box, 183 kills: render geometry clears 160; collision
  geometry clears 173. Render geometry blocks more kills (23 blocked versus 10). Not
  yet attributed: foliage, glass and other see-through materials are candidates.

### Correction: base vertices (2026-11-22)

The first render extraction ignored each draw call's base vertex. 1,460 of 4,776
draw calls on de_ancient have a non-zero base, so many triangles pointed at the
wrong vertices. The 160-of-183 figure above is void. With base vertices applied,
the production box on the render geometry clears 183 of 183 de_ancient kills.
Against collision geometry: both clear 173; render-only clears 10 (the kills the
playerclip mesh blocks); collision-only clears 0.

## Render versus collision, all maps with worldnodes (2026-11-22)

Production box, kills per map, with `effects/smoke` and `effects/` materials removed
from the render geometry (they are see-through particle cards):

| Map | Kills | Both clear | Render only | Collision only |
|---|---|---|---|---|
| de_ancient | 183 | 173 | 10 | 0 |
| de_cache | 134 | 130 | 4 | 0 |
| de_dust2 | 108 | 106 | 2 | 0 |
| de_mirage | 113 | 106 | 7 | 0 |
| de_nuke | 163 | 161 | 2 | 0 |

- Render-only clears: the 10 de_ancient kills the playerclip mesh blocks, plus the two
  de_nuke kills (ticks 58698 and 91374) that were the last unexplained kills.
- Collision-only clears: none once the smoke cards are removed. Before that, de_dust2
  had 3 collision-only clears, blocked in the render geometry by `effects/smoke/dust_001b`.
- Random-pair control, render versus collision (400 pairs per map): de_ancient 26 vs 24,
  de_cache 18 vs 16, de_dust2 26 vs 25, de_mirage 20 vs 17, de_nuke 14 vs 15.
- de_anubis and de_inferno have no `worldnodes` models. Their render models are under
  `entities/` and need entity placement transforms. Not done.

## Production: render geometry replaces collision (2026-11-22)

What changed in production:
- `mappack.ExtractRenderGeometry` replaces `ExtractWorldCollision` for the ten
  supported maps. Output: `<data>/render/<map>.render` (+ `.mats` sidecar). The
  encounter occluder (`encounterjob.go` `worldOccluder`) reads it and builds a
  hierarchy per mesh. Asset gate, `-extract`, and map-pack extraction use it.
- Re-extract (`-extract`) and re-import the matches: encounters are derived at import.
  Disk: about 1.2 GB of `.render` files for the ten maps, plus about 0.1 GB of `.mats`.
- Scratch end-to-end (fresh data dir): all ten maps extract; de_cache import gives 350
  windows, 502 encounters, 20,259 samples (collision version: 252, 370, 15,337).

How the world is assembled (validated, see below):
- World nodes from the world resource (`m_worldNodes` prefixes). Scene objects placed by
  `m_vTransform`; aggregate objects cut into fragments (highest LOD, fragment transform
  when `m_bHasTransform`). Fragments without a transform use the identity axes.
- Entity models (`maps/<map>/entities`): placed by origin, angles and scales. Models in
  the map archive, else in the shared archive (`pak01_dir.vpk`).
- Model formats: MDAT/CTRL (current), MBUF/VBIB (classic), KV3 version 4 (shared props),
  meshoptimizer vertex and index codecs. Several LODs: the highest detail is kept.
- Draw-call base vertices are applied. Skybox models are excluded (8 aggregate objects on
  de_ancient).

Validation (each map):
- Render extent lies inside the world resource's stored bounds on all ten maps.
  de_cache: render x and y match exactly; z 1524..3072 against stored 1504..3331.
- Collision (`worldcol`) is incomplete on several maps: its bounds are narrower than the
  world resource's, e.g. de_nuke ends at z 708 against 1760, de_dust2 z 1174 against 1409,
  de_mirage x 2048 against 3114, de_ancient x 2616 against 3224. Render is the complete one.
- Kills (seven maps with kills, 946 total), production policy: render clears all 946;
  collision-only clears 0 on every map; render-only clears 25 (collision missed them).
- Random-pair control (400 pairs per map): render vs collision: ancient 26 vs 24, anubis 17
  vs 16, cache 23 vs 16, dust2 26 vs 25, inferno 20 vs 17, mirage 20 vs 17, nuke 14 vs 15.
- de_overpass, de_train, de_vertigo: no kills in the corpus, so bounds and visuals only.
  Bounds are inside. Visual check: `~/Programming/spectra-overlays/de_train-prod/`
  (and `de_overpass-prod`, `de_vertigo-prod`).

Policy (`internal/mappack/render_policy.go`):
- Dynamic entities excluded: door, breakable, moving or rotating brush, physics and dynamic
  props. Reason: de_nuke's 41 blocked kills came from them (doors 3, brushes 22, props 16);
  with them excluded, every kill clears. Conservative: more permissive. Per-class
  narrowing on the other maps not done.
- See-through excluded: `effects/smoke`, `effects/steam`, light shafts, puddles, glass.
  Removing glass changes no kill; it raises de_cache's control from 16 to 23 of 400.

Borderline materials, kept in (triangles, production sidecars):
- Foliage (cards, plants, leaves, bushes, palms, grass): ancient 1.57M, inferno 0.77M,
  nuke 18k, anubis 322k, cache 550k, dust2 181k, mirage 172k. Removing it changes no kill and
  no control count on ancient, inferno, cache or dust2, so it stays in.
- Decals: dust2 273k, nuke 25k, anubis 78k. Thin planes on walls; untested.
- Cloth, curtains, rugs: inferno 140k, dust2 42k, nuke 28k.
- Wire and rope: dust2 504k, nuke 545k, anubis 162k.
- Grates, fences, mesh: nuke 199k, dust2 100k, mirage 99k.
- Tools (blocklight, solid blocklight): mirage 115, cache 4.8k, inferno 3.7k.
- Fire props: nuke 82k, inferno 11k.
- Opaque and frosted glass are inside the glass exclusion; decide separately.
- `effects/black`, `effects/metalrail` and `effects/urban_puddle` are not in the
  exclusion list (the puddle rule matches the puddle planes).

Known gaps and tests:
- `TestDumpPhysAttributes` and the other dump tests are dev tools (opt-in).
- The mappack map-pack tests (`TestExtractMapPacks`, etc.) fail on the last committed
  state as well; not caused by this work.
