  import { loadThen, whileCurrent, metricStateTitle, liveMetrics } from '../../builtinhelpers.js';
// splittable.svelte.js — the data of a profile split table (sides, maps,
// weapons): the catalog and the seed metrics' reads for the context's player.
// The table reloads when the player changes or a metric finishes, and a player
// change first clears what was shown (the old player's numbers never linger).
// Call it once from a component's top level.
//
//   const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS, errText }));
//   const sweep = table.sweep;   // the live sweep: chips and the reload
//   const defs = $derived(table.defs);
//   const reads = $derived(table.reads);
//   <td>{table.cellFor(name, dim)}</td>   the cell's presentation for a dim
//   table.rawValue(name, dim)              the dim's fresh number (null if none)
//   table.empty                            the chip of an empty table, with its title (null when up to date)

import { loadSplit, cell, dimValue, emptyChip } from './shared.js';

export function splitTable(getInputs) {
  // The panel's live sweep: the reload that re-reads the table, and the progress
  // that the table's chips show.
  const sweep = liveMetrics();
  let defs = $state(new Map());
  let reads = $state(new Map());
  let loadedFor = null;
  $effect(() =>
    whileCurrent((isCurrent) => {
      const { spectra, steamId, seeds } = getInputs();
      sweep.reload;
      const sid = steamId;
      const newPlayer = sid !== loadedFor;
      loadedFor = sid;
      if (newPlayer) defs = new Map();
      if (newPlayer) reads = new Map();
      if (!sid) return;
      // A failed read is the frame's banner (no retry here): an empty table would otherwise lie.
      loadThen(
        isCurrent,
        loadSplit(spectra, seeds),
        (loaded) => {
          defs = loaded.defs;
          reads = loaded.reads;
        },
        (e) => spectra.report(e),
      );
    }),
  );
  // cellFor and rawValue read the table's current defs and reads, so a template
  // that calls them tracks the load.
  const cellFor = (name, dim) =>
    cell(defs.get(name), reads.get(name), sweep.progress, dimValue(defs.get(name), reads.get(name), dim));
  const rawValue = (name, dim) => dimValue(defs.get(name), reads.get(name), dim);
  return {
    sweep,
    get defs() {
      return defs;
    },
    get reads() {
      return reads;
    },
    cellFor,
    rawValue,
    // The chip of an empty table (null when up to date), with its tooltip.
    get empty() {
      const e = emptyChip(defs, reads, sweep.progress, getInputs().seeds);
      return e && { ...e, title: metricStateTitle(e.state, e.read?.error) };
    },
  };
}
