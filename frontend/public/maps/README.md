# Map packs

One directory per map under `frontend/public/maps/<mapName>/`.

**No map art ships with this directory — ever.** Official radar images are
Valve IP and are never bundled in public releases, and the app ships no
schematic stand-ins either: when a map's extracted radar isn't found,
replay and heatmaps fall back to one generic presentation — a plain
world-coordinate grid with a "map not found" note. Real pixels come from
the in-app extractor reading the user's own local CS2 install (see
*Acquisition posture* below).

## Contract

```
maps/<mapName>/meta.json     required — numeric metadata only (see schema);
                             image-less packs are valid (the six bundled
                             packs ship no radar)
maps/<mapName>/<radar file>  optional in the schema, never committed here:
                             any raster/vector image the webview can draw
                             (png/webp/svg), filename declared in
                             meta.json — the single radar.png, or one file
                             PER LAYER for a multi-floor pack
                             (radar.png + radar_lower.png, declared in
                             layers[]). Extracted packs serve these from
                             the app data dir instead. Missing image
                             → plain grid fallback.
```

### meta.json

```json
{
  "radar": { "file": "radar.png", "width": 1024, "height": 1024 },
  "transform": { "pos_x": -2000.0, "pos_y": 3250.0, "scale": 5.5 },
  "layers": [
    {
      "id": "default",
      "name": "Upper",
      "file": "radar.png",
      "width": 1024,
      "height": 1024,
      "z_min": -495,
      "z_max": 10000
    },
    {
      "id": "lower",
      "name": "Lower",
      "file": "radar_lower.png",
      "width": 1024,
      "height": 1024,
      "z_min": -10000,
      "z_max": -495
    }
  ],
  "elevation_regions": [
    { "x": 0, "y": 0, "w": 512, "h": 512, "reference_z": 0, "above": 128, "below": 128 },
    { "x": 64, "y": 64, "w": 128, "h": 128, "reference_z": -768, "above": 64, "below": 10000, "z_max": -495 }
  ],
  "sites": {},
  "spawns": {},
  "source": { "note": "provenance of the numbers above" }
}
```

- `transform` — the 3-parameter Valve overview model. World → radar-image
  pixels (Z-up, inverted Y):

  ```
  px = (wx - pos_x) / scale
  py = (pos_y - wy) / scale
  ```

  `pos_x`/`pos_y` are the world coordinates of the image's top-left corner;
  `scale` is world units per image pixel. Coverage:
  `[pos_x, pos_x + width*scale] × [pos_y - height*scale, pos_y]`.
- `radar.width`/`height` — the LOGICAL size of the radar image: the
  image space the `transform` maps world coordinates into (omitted
  together with `radar` when no image is involved). The file on disk may
  be larger — the extractor writes radar/layer PNGs at **2×** this size
  (a Lanczos-3 resample with a light unsharp-mask pass over the
  1024×1024 source vtex, which has no larger mip) so zoomed-in views
  stay sharp. Consumers draw the image destination-size from these
  dims, so a bigger file only adds sampling detail and never shifts
  world mapping.
- `layers` — OPTIONAL (absent = the single-layer contract, unchanged from
  before). One entry per radar floor of a multi-floor map, **default
  first** (the extractor's order — the fallback layer for an unknown Z is
  index 0), each drawn as its own side-by-side panel in the replay
  canvas:
  - `id` — the section name (`default`, `lower`); `name` — the display
    label drawn over the panel (`Upper`/`Lower`).
  - `file`/`width`/`height` — that layer's image and its LOGICAL size
    (the same convention as `radar.width`/`height`; an extracted file is
    written at 2× this size — `radar.png` for `default`,
    `radar_<id>.png` for the rest).
  - `z_min`/`z_max` — the world-Z band the layer claims, from the map's
    own `resource/overviews/<map>.txt` `verticalsections` (real extracted
    values). Convention: **half-open `[z_min, z_max)`** — adjacent bands
    share a boundary value (Nuke: both layers meet at −495) and exactly
    the band whose `z_min` it is claims it. An entity whose Z is unknown
    or outside every band goes to the default layer (index 0).
  - `transform` — OPTIONAL per-layer override of the shared `transform`
    (a complete `{pos_x, pos_y, scale}`; anything partial/malformed
    inherits the shared one). Layers inherit by default — the shared
    transform is verified for Nuke; override only when a map's layer
    genuinely uses different bounds.
- `elevation_regions` — OPTIONAL world-space boxes `{x, y, w, h}`
  (**min-corner + size** in world coords, half-open `[x, x+w) × [y, y+h)`
  like the Z bands) with their own `reference_z`/`above`/`below` — the
  ONLY source of T/⊥ indicator thresholds (region-only design: the layer
  panels already say which floor an entity is on, so a mark is only
  meaningful at an XY that could hold two heights — a catwalk over a
  floor, palace over a ramp; an unboxed XY is declared unambiguous and
  never marks). `reference_z` sits BETWEEN the box's two sampled
  surfaces (their midpoint), `above`/`below` half the gap minus
  headroom — so inside an ambiguous box BOTH surfaces always mark: an
  entity at `z > reference_z + above` draws ⊥ below its marker, at
  `z < reference_z - below` draws T above it (CS2's own orientation —
  `CS2.md` "Radar elevation indicators"); between the two surfaces,
  nothing draws. A pack with NO regions draws NO indicators — ever. Marks
  draw for **players, the dropped/planted C4, and LANDED decoys**
  (the rest icon) — never for in-flight utility, transient effects
  (detonation pops, lingering smoke/fire), or death markers.
  Never derived by the extractor — hand-authored (walk the corners +
  stand on each of the two surfaces with `getpos_exact`). **This bundled
  copy is their canonical home**: on every extraction the regions flow
  into the data-dir pack in priority order bundled copy → the pack's
  existing data-dir `meta.json` → none (`preserveElevation` in
  `internal/mappack/extract.go`, fed the bundled bytes through
  `mappack.WithBundledMeta` / `bundledMapMeta` in `mappackservice.go`),
  so a refresh can never lose them, while a map extracted but never
  bundled keeps whatever it already had. This key is the ONLY one that
  flows: everything else in the fresh data-dir meta (radar, transform,
  layers + Z bands, sites, spawns, `source.note`) is extractor-derived
  and stays fresh. A refresh also DROPS stale per-floor `elevation`
  keys — nothing reads them anymore.
  - `z_min`/`z_max` — OPTIONAL floor scope for the box, half-open
    `[z_min, z_max)` — the SAME convention as the layer bands, so a box
    scoped to Nuke's lower band ends exactly where the upper band begins
    (`z_max: -495`). An absent/non-finite bound leaves that side open
    (no scope = the box applies on every floor, the default). A box
    whose scope excludes the entity is skipped, not terminal — another
    box at the same XY still decides (stack a lower-band and an
    upper-band box at one spot if needed). Needed wherever a threshold
    would misfire across bands: the catwalk ring's `z > -704` must never
    mark upper-panel players standing over the same XY.
  - **Ordering** — boxes match first-to-last: put a z-scoped box before
    any unscoped box it overlaps (a scope is strictly narrower), then
    smaller area first (a nested box must beat its container — Lobby
    Platform sits inside T Roof's footprint). The checked-in pack data
    follows this order.
- `sites` / `spawns` — optional fractions or world points (bombsite centers,
  spawn anchors) for future overlays; empty objects today.
- `source` — free-form provenance note (which overview txt / tabulation the
  constants came from).

All new keys are additive: a pack without them is the single-layer
layout and behaves exactly as before.

A **missing** meta.json → the replay view shows a "map not found" note and
falls back to a blank grid derived from sample extents. A meta.json
**without** `radar` (every bundled pack — `de_nuke`, `de_mirage`,
`de_inferno`, `de_dust2`, `de_cache`, `de_anubis` ship transform + bands
+ `elevation_regions`, no pixels) → transform applies, grid + players
render, no radar pixels; the elevation marks work too, since regions are
world-space data.

## Acquisition posture

Numeric metadata (transform constants) is our own JSON in-repo — facts, not
artwork. The bundled packs (six maps) also carry the hand-derived
`elevation_regions` (measured in-game with `getpos_exact`) and Nuke's
layer Z bands, so end-users get elevation marks on a fresh install
without extracting anything; extraction adds the pixels, keeps its own
fresh metadata for every extractor-derived key, and carries these
regions into the data-dir pack it writes — so the copy the app serves
first (the data-dir one) keeps the marks too. Radar **pixels** are never
bundled: official radars are Valve IP,
and no placeholder/schematic art ships either. The only path to authentic
map backgrounds is the in-app extractor (Settings → Map packs, or the
first-run prompt): it reads
`panorama/images/overheadmaps/<map>_radar_psd.vtex_c` (plus each
`<map>_<section>_radar_psd.vtex_c` layer) and
`resource/overviews/<map>.txt` from the user's own `pak01_dir.vpk` and
writes packs (meta.json + radar.png [+ layer images]) into the app data dir
(`internal/mappack`), which the frontend serves at `/api/mappack/` and
prefers over these bundled metadata copies. Manual extraction into the same
on-disk layout also works. Nothing is uploaded; extraction runs locally.

**Refreshing an existing installation:** extraction is idempotent —
Settings → "Extract all CS2 assets" rewrites every pack (new radar/layer
images, new `layers` metadata) and the icon set from the current game
files. Extracted radar/layer images are written at **2×** their logical
size (1024 source → 2048 px file, `radarUpscale` in
`internal/mappack/extract.go`; meta.json always declares the logical
1024, so old 1:1 packs and new 2× packs world-map identically). Packs
extracted before that upscale shipped keep their smaller files — and
`meta.json` keeps whatever it already declared — until you re-extract
here. Every extractor-derived key is overwritten with the current game
files; the one hand-authored input, your `elevation_regions` (see
above), is MERGED in instead — the bundled copy's values win, falling
back to the pack's own previous data-dir values only for maps with no
bundled copy — and stale per-floor `elevation` keys are dropped on
refresh: nothing reads them anymore.
Without a re-extract, packs extracted before a feature shipped keep their
old files: optional metadata does not appear on its own.

## Adding a map

1. `mkdir frontend/public/maps/de_yourmap`
2. Write `meta.json` with `pos_x/pos_y/scale` from the map's
   `resource/overviews/de_yourmap.txt` (or a community mirror — verify, don't
   trust a single transcription). No image goes here — radar art is never
   committed.
3. Smoke-test: import a demo on that map → open its replay → players land in
   spawns at freezetime end (grid fallback until packs are extracted).
