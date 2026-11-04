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
                             transform-only packs are valid (see de_mirage/)
maps/<mapName>/<radar file>  optional in the schema, never committed here:
                             any raster/vector image the webview can draw
                             (png/webp/svg), filename declared in
                             meta.json. Extracted packs serve radar.png
                             from the app data dir instead. Missing image
                             → plain grid fallback.
```

### meta.json (schema_version 1)

```json
{
  "schema_version": 1,
  "radar": { "file": "radar.png", "width": 1024, "height": 1024 },
  "transform": { "pos_x": -2000.0, "pos_y": 3250.0, "scale": 5.5 },
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
- `radar.width`/`height` — real pixel size of the radar file (omitted
  together with `radar` when no image is involved).
- `sites` / `spawns` — optional fractions or world points (bombsite centers,
  spawn anchors) for future overlays; empty objects today.
- `source` — free-form provenance note (which overview txt / tabulation the
  constants came from).

A **missing** meta.json → the replay view shows a "map not found" note and
falls back to a blank grid derived from sample extents. A meta.json
**without** `radar` (the only committed pack, `de_mirage/`) → transform
applies, grid + players render, no radar pixels.

## Acquisition posture

Numeric metadata (transform constants) is our own JSON in-repo — facts, not
artwork. Radar **pixels** are never bundled: official radars are Valve IP,
and no placeholder/schematic art ships either. The only path to authentic
map backgrounds is the in-app extractor (Settings → Map packs, or the
first-run prompt): it reads
`panorama/images/overheadmaps/<map>_radar_psd.vtex_c` and
`resource/overviews/<map>.txt` from the user's own `pak01_dir.vpk` and
writes packs (meta.json + radar.png) into the app data dir
(`internal/mappack`), which the frontend serves at `/api/mappack/` and
prefers over these bundled metadata copies. Manual extraction into the same
on-disk layout also works. Nothing is uploaded; extraction runs locally.

## Adding a map

1. `mkdir frontend/public/maps/de_yourmap`
2. Write `meta.json` with `pos_x/pos_y/scale` from the map's
   `resource/overviews/de_yourmap.txt` (or a community mirror — verify, don't
   trust a single transcription). No image goes here — radar art is never
   committed.
3. Smoke-test: import a demo on that map → open its replay → players land in
   spawns at freezetime end (grid fallback until packs are extracted).
