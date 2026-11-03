// Canonical CS2 side-parity (half-switch) arithmetic — the JavaScript twin
// of internal/rules (Go). ONE formula: for a match with n COUNTED rounds and
// `switches` side switches, switch k (1-based) sits at counted index
//
//   - floor((n*k + switches) / (switches + 1))   — i.e. ceil(n*k / (switches + 1))
//
// so the counted rounds split into (switches + 1) as-equal-as-possible eras.
// Regulation (switches = 1) is a plain midpoint split; overtime adds more
// boundaries, which is where a uniform `ceil(n / eras)` era length used to
// diverge from the backend (n = 25, switches = 2 → 9 and 17, not 9 and 18).
//
// Both languages assert the same fixture — internal/rules/testdata/
// sideparity.json — from internal/rules/sideparity_test.go (Go) and
// frontend/src/lib/sideparity.test.js (node --test src/lib/sideparity.test.js).
// RoundStrip.svelte is the only renderer and consumes eraOf() per cell.

// flipIndexes returns the counted-round indexes (0-based, ascending) where
// side switches happen. Boundaries outside (0, n) are dropped — a match too
// short to reach the switch yields no flip.
export function flipIndexes(counted, switches) {
  const n = Number.isFinite(counted) ? Math.trunc(counted) : 0;
  const s = Number.isFinite(switches) ? Math.trunc(switches) : 0;
  if (n <= 0 || s <= 0) return [];
  const flips = [];
  for (let k = 1; k <= s; k++) {
    const idx = Math.floor((n * k + s) / (s + 1));
    if (idx > 0 && idx < n) flips.push(idx);
  }
  return flips;
}

// eraOf returns the era (half index) of the counted round at `index`: how
// many switch boundaries are at or before it. RoundStrip derives each cell's
// side label from this, so a moved boundary flips the labels of every round
// from it onward.
export function eraOf(index, flips) {
  let era = 0;
  for (const flip of flips) {
    if (flip <= index) era++;
  }
  return era;
}
