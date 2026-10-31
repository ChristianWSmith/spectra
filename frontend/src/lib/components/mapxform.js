// Shared world↔image transform for map-pack consumers (heatmap layer,
// round-compare ghost, any overlay). World coords are CS2 Z-up units; the
// radar image is a top-down X/Y projection with inverted Y — formula per
// ref/findings/findings-mappack.md §2: px=(wx-pos_x)/scale,
// py=(pos_y-wy)/scale.
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

// Load /maps/<map>/meta.json (null when the pack is missing).
export async function loadMapPack(map) {
  if (!map) return null;
  try {
    const res = await fetch(`/maps/${encodeURIComponent(map)}/meta.json`);
    if (!res.ok) return null;
    const meta = await res.json();
    return { meta, transform: makeTransform(meta) };
  } catch {
    return null;
  }
}
