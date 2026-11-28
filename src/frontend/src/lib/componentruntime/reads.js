// The real services behind the component read API (readapi.js
// ReadServices): the existing frontend metric read path (cached stored
// values + the uncached compute state) and the component query read.
// Kept apart from readapi.js so the API stays testable without the
// generated service layer; the DOM harness replaces this file.

import {
  listMetrics,
  getMetricValuesForMatch,
  getMetricValuesForRound,
  getMetricValuesForPlayer,
  getMetricComputeState,
  getMetricStates,
  getMetricSeries,
  componentQuery,
  evictDemoCopy,
} from '../services.js';
import { downloadCanvasPNG, downloadText } from '../download.js';
import { metricsByMatch as readMetricsByMatch } from './readapi.js';

export const serviceReads = Object.freeze({
  listMetrics,
  getMetricValuesForMatch,
  getMetricValuesForRound,
  getMetricValuesForPlayer,
  getMetricComputeState,
  getMetricStates,
  getMetricSeries,
  componentQuery,
});

// The component write surface (ReadApi.freeDemoCopy). Kept out of
// serviceReads and out of the helper registry: only the frame's spectra prop
// reaches it, and no component can import it.
export const serviceWrites = Object.freeze({
  freeDemoCopy: (matchId) => evictDemoCopy(matchId),
  saveText: (filename, mime, text) => downloadText(filename, mime, text),
  saveCanvasPNG: (canvas, filename) => downloadCanvasPNG(canvas, filename),
});

// metricsByMatch is the History read for a built-in panel (the one curated
// helper of this module, compile.js BUILTIN_HELPERS): one player's values and
// states across many matches over the real services. The rule is readapi.js's.
export function metricsByMatch(steamId, names, matchIds) {
  return readMetricsByMatch(serviceReads, steamId, names, matchIds);
}
