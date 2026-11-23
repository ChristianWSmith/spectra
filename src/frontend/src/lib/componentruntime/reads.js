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
} from '../services.js';
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

// metricsByMatch is the History read for a built-in panel (the one curated
// helper of this module, compile.js BUILTIN_HELPERS): one player's values and
// states across many matches over the real services. The rule is readapi.js's.
export function metricsByMatch(steamId, names, matchIds) {
  return readMetricsByMatch(serviceReads, steamId, names, matchIds);
}
