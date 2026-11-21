// strings/heatmaps.js — Heatmaps view chrome (controls, legend, hints)
// Extracted from views/Heatmaps.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site with
// fill() from strings/index.js (the catalog contract).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const heatmaps = {
  dismissError: 'Dismiss error', // the ✕ inside the load/generate alert
  kindLabel: 'Kind',
  floorLabel: 'Floor', // field label + the floor group's aria-label
  playerLabel: 'Player',
  allPlayers: 'All players',
  sideLabel: 'Side',
  bothSides: 'Both',
  roundsFrom: 'Rounds from',
  roundsTo: 'Rounds to',
  allRounds: 'All', // both round-range selects' open-bound option
  controlsChanged: 'controls changed — press Regenerate to redraw the heatmap',
  plottedSuffix: ' plotted points · ', // after the sample count
  gridSuffix: ' grid · square-root scale', // after the W×H cell count
  bboxHint:
    'Drag a box on the map to open the replay events for that region (padded\n        to the splat’s reach); a single click opens one square.',
  noRowsSuffix: ' has no event rows behind it — a drag or click opens nothing.',
  saveImage: 'Save image', // the floating Save on the radar card (V8e)
  // Builtin panel copy (ruling 46, dogfood C5i).
  kindOverview: "Overview",
  kindGrenadeThrown: "Grenade thrown",
  kindGrenadeDetonation: "Grenade detonation",
  regionFiltered: "filtered by region",
  regionNotApplied: "region not applied",
  noMapName: "map name unknown — heatmap overlay unavailable",
  loadingMapPack: "loading map pack…",
  timeWeighted: "time-weighted seconds · live play",
  killsMinusDeaths: "kills − deaths (net)",
  roundRangeError: "First round can’t be higher than the last round.",
  generating: "Generating…",
  regenerate: "Regenerate",
  generate: "Generate",

  // Builtin panel copy (ruling 46, dogfood C5i).
  mapNotFound: "map not found for {map} — plain grid, no radar art",
  mapNoTransform: "map pack for {map} has no transform — plain grid, no radar art",
  mapNoRadar: "map pack for {map} has no radar image — overlay on dark grid only",
  noEventRows: "{kind} has no event rows behind it — nothing to query, so the click did not open the replay",
  bboxLabel: "bbox ({x0}, {y0}) → ({x1}, {y1})",

  // Builtin panel copy (ruling 46, dogfood C5i).
  unitCount: "count",

};
