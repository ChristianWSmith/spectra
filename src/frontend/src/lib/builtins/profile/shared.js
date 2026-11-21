// shared.js — the presentation rules the Profile panels share. A panel reads
// its values through `spectra.metric()` (a MetricRead: state, value, rows),
// and this module maps one read onto what a cell shows: a value, the honest
// dash, or a state chip. NULL is a dash, never a zero (owner ruling 23); a
// live sweep on a metric shows as processing (lib/metricstate.js precedence).
import { metricStateTitle } from '../../metricstate.js';

export const NO_DATA_TITLE = 'no data for this player';

// liveState: the word a cell shows for its metric. A sweep running on the
// metric right now (the live progress feed, keyed by metric id) wins over
// the read's own state.
export function liveState(def, read, progress) {
  if (def && progress && progress.has(def.id)) return 'processing';
  return read ? read.state : '';
}

// cell maps one value cell onto its presentation. `value` is the fresh
// number for this cell, or null when the fresh read has no row for it.
export function cell(def, read, progress, value) {
  const st = liveState(def, read, progress);
  if (st === 'fresh') {
    if (value == null) return { kind: 'nodata', title: NO_DATA_TITLE };
    return { kind: 'value', value, title: def ? def.title || def.name : '' };
  }
  if (st === '' || st === 'no-data') return { kind: 'nodata', title: NO_DATA_TITLE };
  return { kind: 'chip', state: st, title: metricStateTitle(st, read ? read.error : '') };
}

// emptyChip: a table with no rows shows the chip of the winning live state
// across its own metrics (processing, then failed, then behind). Null keeps
// the up-to-date empty text. `defs` and `reads` are Maps by metric name.
export function emptyChip(defs, reads, progress, names) {
  for (const state of ['processing', 'failed', 'behind']) {
    for (const n of names) {
      const def = defs.get(n);
      const read = reads.get(n);
      if (!def && !read) continue;
      if (liveState(def, read, progress) === state) return { state, def, read };
    }
  }
  return null;
}

// failedRead is the read a panel holds for a metric whose read threw: the
// failure shows as a failed chip in its own cell (the frame banner carries
// the message too), never as a dash.
export function failedRead(e, errText) {
  return { state: 'failed', error: errText(e), value: null, rows: [] };
}

// loadSeeds reads the named metrics of a split table (sides, maps, weapons)
// for the context's player. A name the catalog does not carry is never read:
// its cells show the honest dash, not an error. Each read is one metric()
// call, so its dims come back in `rows`.
export async function loadSeeds(spectra, names, catalog, errText) {
  const defs = new Map(catalog.filter((d) => d && names.includes(d.name)).map((d) => [d.name, d]));
  const found = [...defs.keys()];
  const results = await Promise.all(found.map((n) => spectra.metric(n).catch((e) => failedRead(e, errText))));
  return { defs, reads: new Map(found.map((n, i) => [n, results[i]])) };
}

// dimValue is one split cell's fresh number: the read's row for the dim,
// scaled to display (a percent seed stores the 0..1 fraction; the tables
// render 0..100). Null when the fresh read has no row for the dim.
export function dimValue(def, read, dim) {
  const row = read && read.rows ? read.rows.find((r) => r.dim === dim) : null;
  if (!row || row.value == null) return null;
  return def && def.format === 'percent' ? row.value * 100 : row.value;
}

// dimsOf is the union of the dims the fresh reads carry, in first-seen order.
export function dimsOf(reads, names) {
  const dims = new Set();
  for (const n of names) for (const r of reads.get(n)?.rows ?? []) if (r.dim) dims.add(r.dim);
  return [...dims];
}
