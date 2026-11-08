// Radar layers (multi-floor maps) + CS2-style elevation indicators —
// the pure layer-assignment and above/below rules the renderer draws
// from. Everything here is a pure function of pack config + world
// coordinates; no canvas, no engine.
//
// Pack config shape (frontend/public/maps/README.md): `layers` is an
// ordered array of radar panels — default first (the extractor's
// sortSections order) — each with a world-Z band [zMin, zMax]. A pack
// without `layers` behaves as one default layer (the renderer synthesizes
// the panel).
//
// Indicators are REGION-ONLY (deliberate design): the layer panels
// already say which floor an entity is on, so a mark is only meaningful
// at an XY where an entity could reasonably be at two heights (a
// catwalk over a floor, palace over a ramp). `elevation_regions` are
// world-space X/Y boxes, each carrying its own
// {reference_z, above, below} — the ONLY source of thresholds — plus an
// OPTIONAL z scope ({z_min, z_max}, half-open like the bands) for boxes
// that only apply on one floor (Nuke's catwalk ring sits under walkable
// upper floor — without a scope its ⊥ would fire on every upper-panel
// player in its footprint). A pack without regions draws no indicators,
// ever; per-floor/global threshold keys were dropped from the contract
// (nothing to configure at an unambiguous XY).

// layerIndexForZ — which layer (panel) a world Z belongs to.
//
// Band convention: HALF-OPEN [zMin, zMax) — inclusive low bound,
// exclusive high bound. Adjacent sections share a boundary value in the
// game's own config (de_nuke: default zMin = lower zMax = -495 — CS2.md
// "verticalsections"), and exactly ONE band claims that value: the one
// whose zMin it is. Never both.
//
// Missing/invalid Z (null/undefined/NaN), or a Z outside every band,
// falls back to the DEFAULT layer — index 0, the order the extractor
// writes (default first). Never throws, never guesses a non-default
// layer it cannot prove.
export function layerIndexForZ(z, layers) {
  if (!Array.isArray(layers) || layers.length === 0) return 0;
  if (!Number.isFinite(z)) return 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l) continue;
    const lo = l.zMin;
    const hi = l.zMax;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue; // unbounded band never claims
    if (z >= lo && z < hi) return i;
  }
  return 0; // outside every band → the default layer
}

// thresholdAt — apply one {reference_z, above, below} set: strictly
// above reference_z+above → 'above', strictly below reference_z−below →
// 'below', otherwise null (within the band — the same level, no mark).
// Strict inequalities pin the exact-threshold Z to "same level"
// (hysteresis-free and symmetric). A missing/non-finite field means the
// set is unconfigured → null (never a guessed threshold).
function thresholdAt(z, t) {
  if (!t) return null;
  const ref = t.reference_z;
  const up = t.above;
  const down = t.below;
  if (!Number.isFinite(ref) || !Number.isFinite(up) || !Number.isFinite(down)) return null;
  if (z > ref + up) return 'above';
  if (z < ref - down) return 'below';
  return null;
}

// regionAt — the FIRST elevation_regions box containing (x, y) whose
// z scope admits z, else null. Boxes are world X/Y MIN-CORNER + size,
// half-open like the Z bands ([x, x+w) × [y, y+h)). The optional
// {z_min, z_max} scope is half-open too ([z_min, z_max), the SAME
// convention as the layer bands — so a box scoped to Nuke's lower band
// ends exactly where the upper band begins); an absent/non-finite bound
// leaves that side unconstrained (no scope = the box applies on every
// floor, the default). A box whose scope excludes the entity is
// SKIPPED, not terminal — later boxes at the same XY still get their
// match (stacking a lower-band and an upper-band box at one spot).
// Non-finite coordinates match no region.
function regionAt(x, y, z, regions) {
  if (!Array.isArray(regions)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const r of regions) {
    if (!r) continue;
    const { x: rx, y: ry, w, h } = r;
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    if (!(x >= rx && x < rx + w && y >= ry && y < ry + h)) continue;
    if (Number.isFinite(r.z_min) && z < r.z_min) continue;
    if (Number.isFinite(r.z_max) && z >= r.z_max) continue;
    return r;
  }
  return null;
}

// elevationFor — 'above' | 'below' | null for an entity at world
// (x, y, z) given the pack's `regions`.
//
// REGION-ONLY: the FIRST region box containing (x, y) that also admits
// z decides with its own thresholds; no matching box → null (no
// per-floor fallback — an unboxed XY is declared unambiguous, so it
// never marks). A non-finite Z can never prove elevation → null (an
// indicator from a guessed Z would be a lie); non-finite x/y match no
// region → null.
export function elevationFor(x, y, z, regions) {
  if (!Number.isFinite(z)) return null;
  const region = regionAt(x, y, z, regions);
  if (!region) return null;
  return thresholdAt(z, region);
}
