// splittable.svelte.js — the data of a profile split table (sides, maps,
// weapons): the catalog and the seed metrics' reads for the context's player.
// The table reloads when the player changes or a metric finishes, and a player
// change first clears what was shown (the old player's numbers never linger).
// Call it once from a component's top level.
//
//   const table = splitTable(() => ({ spectra, steamId, seeds: SEEDS, errText, reload: sweep.reload, progress: sweep.progress }));
//   const defs = $derived(table.defs);
//   const reads = $derived(table.reads);
//   <td>{table.cellFor(name, dim)}</td>   the cell's presentation for a dim
//   table.rawValue(name, dim)              the dim's fresh number (null if none)
//   table.empty                            the chip of an empty table, with its title (null when up to date)

import { loadSplit, cell, dimValue, emptyChip } from './shared.js';
import { whileCurrent } from '../../current.js';
import { metricStateTitle } from '../../metricstate.js';

export function splitTable(getInputs) {
  let defs = $state(new Map());
  let reads = $state(new Map());
  let loadedFor = null;
  $effect(() =>
    whileCurrent((isCurrent) => {
      const { spectra, steamId, seeds, errText, reload } = getInputs();
      reload;
      const sid = steamId;
      const newPlayer = sid !== loadedFor;
      loadedFor = sid;
      if (newPlayer) defs = new Map();
      if (newPlayer) reads = new Map();
      if (!sid) return;
      loadSplit(spectra, seeds, errText)
        .then((loaded) => {
          if (isCurrent()) {
            defs = loaded.defs;
            reads = loaded.reads;
          }
        })
        .catch(() => {});
    }),
  );
  // cellFor and rawValue read the table's current defs and reads, so a template
  // that calls them tracks the load.
  const cellFor = (name, dim) =>
    cell(defs.get(name), reads.get(name), getInputs().progress, dimValue(defs.get(name), reads.get(name), dim));
  const rawValue = (name, dim) => dimValue(defs.get(name), reads.get(name), dim);
  return {
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
      const { progress, seeds } = getInputs();
      const e = emptyChip(defs, reads, progress, seeds);
      return e && { ...e, title: metricStateTitle(e.state, e.read?.error) };
    },
  };
}
