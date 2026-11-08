// Shared world↔image transform for map-pack consumers (heatmap layer,
// round-compare ghost, any overlay). World coords are CS2 Z-up units; the
// radar image is a top-down X/Y projection with inverted Y — formula:
// px=(wx-pos_x)/scale, py=(pos_y-wy)/scale.
//
// This is THE pack→transform reader: multi-floor packs ride along on the
// same call. `meta.layers` (when present) come back as `out.layers` —
// one entry per radar panel, default first — each carrying its world-Z
// band, display name, image file/size, and its own `tf` (a full
// per-layer transform when meta.layers[i].transform is a complete
// {pos_x,pos_y,scale} override, else the pack's shared transform —
// layers INHERIT by default, per the pack contract). The pack's optional
// `elevation_regions` (world-space indicator boxes — the ONLY threshold
// source) come back as `out.regions`. A pack without `layers` builds no
// `layers` key — consumers treat that as one default layer (renderer.js
// synthesizes the single panel; today's single-layer behavior is
// untouched).
export function makeTransform(meta) {
  const t = meta && meta.transform;
  const w = (meta && meta.radar && meta.radar.width) || 1024;
  const h = (meta && meta.radar && meta.radar.height) || 1024;
  if (!t) return null;
  const mk = (posX, posY, scale, mw = w, mh = h) => ({
    posX,
    posY,
    scale,
    width: mw,
    height: mh,
    toImage(x, y) {
      return { x: (x - posX) / scale, y: (posY - y) / scale };
    },
    toWorld(px, py) {
      return { x: px * scale + posX, y: posY - py * scale };
    },
  });
  const shared = mk(t.pos_x, t.pos_y, t.scale);
  const out = {
    posX: shared.posX,
    posY: shared.posY,
    scale: shared.scale,
    width: w,
    height: h,
    toImage: shared.toImage,
    toWorld: shared.toWorld,
  };
  // Additive optional keys — a pack without them is the single-layer
  // contract (schema_version 1, frontend/public/maps/README.md). Note:
  // a stale top-level `elevation` / `layers[].elevation` key (dropped
  // from the contract) is deliberately NOT read — indicators are
  // region-only.
  if (Array.isArray(meta.elevation_regions) && meta.elevation_regions.length) {
    out.regions = meta.elevation_regions;
  }
  if (Array.isArray(meta.layers) && meta.layers.length) {
    out.layers = meta.layers.map((l) => {
      const lw = (l && Number.isFinite(l.width) && l.width) || w;
      const lh = (l && Number.isFinite(l.height) && l.height) || h;
      // Per-layer transform override: ONLY a complete, finite
      // {pos_x, pos_y, scale} replaces the shared transform — a partial
      // or malformed override inherits the shared transform (a half-
      // applied transform would silently misplace the layer; inheritance
      // is the documented default, not a guess).
      let tf = shared;
      const o = l && l.transform;
      if (
        o &&
        Number.isFinite(o.pos_x) &&
        Number.isFinite(o.pos_y) &&
        Number.isFinite(o.scale) &&
        o.scale > 0
      ) {
        tf = mk(o.pos_x, o.pos_y, o.scale, lw, lh);
      }
      // Elevation is NOT per-layer: thresholds live only in the pack's
      // elevation_regions (out.regions — the renderer applies them across
      // every panel).
      return {
        id: (l && l.id) || 'default',
        name: (l && l.name) || null,
        file: (l && l.file) || null,
        width: lw,
        height: lh,
        zMin: l && Number.isFinite(l.z_min) ? l.z_min : null,
        zMax: l && Number.isFinite(l.z_max) ? l.z_max : null,
        tf,
      };
    });
  }
  return out;
}

// Load a map pack: the user-extracted pack (from the local CS2 install,
// served at /api/mappack/) wins over the bundled copy at /maps/. The
// bundle ships numeric metadata only (a transform-only meta.json, e.g.
// de_mirage) — no radar art ever ships (frontend/public/maps/README.md).
// Returns { meta, transform, base } or null when neither source has the
// map; callers then fall back to a plain world-coordinate grid.
// base is the URL prefix for meta.radar.file.
export async function loadMapPack(map) {
  if (!map) return null;
  const enc = encodeURIComponent(map);
  for (const base of [`/api/mappack/${enc}`, `/maps/${enc}`]) {
    try {
      const res = await fetch(`${base}/meta.json`);
      if (!res.ok) continue;
      const meta = await res.json();
      return { meta, transform: makeTransform(meta), base };
    } catch {
      // try the next source
    }
  }
  return null;
}
