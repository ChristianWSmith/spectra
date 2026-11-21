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
  componentQuery,
} from '../services.js';

export const serviceReads = Object.freeze({
  listMetrics,
  getMetricValuesForMatch,
  getMetricValuesForRound,
  getMetricValuesForPlayer,
  getMetricComputeState,
  getMetricStates,
  componentQuery,
});
