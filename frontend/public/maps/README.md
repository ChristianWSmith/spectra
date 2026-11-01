# Map packs

One directory per map under `frontend/public/maps/<mapName>/`. A pack is
**one image + one JSON**; adding a map never touches code.

## Contract

```
maps/<mapName>/meta.json     required — see schema below
maps/<mapName>/radar.svg     optional — any raster/vector image the webview
                             can draw (png/webp/svg); filename declared in
                             meta.json. Missing image → replay still works on
                             a world-coordinate grid.
```

### meta.json (schema_version 1)

```json
{
  "schema_version": 1,
  "radar": { "file": "radar.svg", "width": 1024, "height": 1024 },
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
- `radar.width`/`height` — real pixel size of the radar file.
- `sites` / `spawns` — optional fractions or world points (bombsite centers,
  spawn anchors) for future overlays; empty objects today.
- `source` — free-form provenance note (which overview txt / tabulation the
  constants came from).

A **missing** meta.json → the replay view shows a "map pack missing" notice
and falls back to a blank grid derived from sample extents. A meta.json
**without** `radar` (see `de_mirage/`) → transform applies, grid + players
render, no radar pixels.

## Acquisition posture

Numeric metadata (transform constants) is our own JSON in-repo — facts, not
artwork. Radar **pixels** are placeholders or user-supplied: official radars
are Valve IP and are never bundled in public releases. The preferred path is
the in-app extractor (Settings → Map packs, or the first-run prompt): it
reads `panorama/images/overheadmaps/<map>_radar_psd.vtex_c` and
`resource/overviews/<map>.txt` from the user's own `pak01_dir.vpk` and
writes packs into the app data dir (`internal/mappack`), which the frontend
serves at `/api/mappack/` and prefers over these bundled copies. Manual
extraction or any user-supplied image named in `meta.json` also works.

The checked-in `de_cache/radar.svg` is an original schematic (grid + rough
A/B markers), not derived from any Valve asset; it exists so the golden
demo's replay has *some* orientation while real pixels stay out of the repo.

## Adding a map

1. `mkdir frontend/public/maps/de_yourmap`
2. Write `meta.json` with `pos_x/pos_y/scale` from the map's
   `resource/overviews/de_yourmap.txt` (or a community mirror — verify, don't
   trust a single transcription).
3. Optionally add a radar image and declare it under `radar`.
4. Smoke-test: import a demo on that map → open its replay → players land in
   spawns at freezetime end.
