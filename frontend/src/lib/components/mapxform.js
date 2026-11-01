// Shared world↔image transform for map-pack consumers (heatmap layer,
// round-compare ghost, any overlay). World coords are CS2 Z-up units; the
// radar image is a top-down X/Y projection with inverted Y — formula:
// px=(wx-pos_x)/scale, py=(pos_y-wy)/scale.
export function makeTransform(meta) {
  const t = meta && meta.transform;
  const w = (meta && meta.radar && meta.radar.width) || 1024;
  const h = (meta && meta.radar && meta.radar.height) || 1024;
  if (!t) return null;
  return {
    posX: t.pos_x,
    posY: t.pos_y,
    scale: t.scale,
    width: w,
    height: h,
    toImage(x, y) {
      return { x: (x - t.pos_x) / t.scale, y: (t.pos_y - y) / t.scale };
    },
    toWorld(px, py) {
      return { x: px * t.scale + t.pos_x, y: t.pos_y - py * t.scale };
    },
  };
}

// Load a map pack: the user-extracted pack (from the local CS2 install,
// served at /api/mappack/) wins over the bundled placeholder at /maps/.
// Returns { meta, transform, base } or null when neither source has the
// map. base is the URL prefix for meta.radar.file.
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
