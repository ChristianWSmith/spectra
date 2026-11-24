// The data the source editors complete from, read once and shared. Each read is
// cached for the session; a failed read is not cached, so the next open retries it
// and a completion never shows a stale failure as the list.

import { getSchema, getMetricTables, getReportFields, listMetrics } from '../services.js';

let schema = null;
let readable = null;
let metrics = null;
const fields = new Map();

// consoleTables: every table with its columns, for the SQL console.
export function consoleTables() {
  schema ??= Promise.resolve(getSchema()).catch((e) => {
    schema = null;
    throw e;
  });
  return schema.then((rows) => rows || []).catch(() => []);
}

// metricTables: the tables a metric statement may read, with their columns.
export function metricTables() {
  readable ??= Promise.all([getSchema(), getMetricTables()])
    .then(([rows, names]) => {
      const allow = new Set(names || []);
      return (rows || []).filter((t) => allow.has(t.name));
    })
    .catch((e) => {
      readable = null;
      throw e;
    });
  return readable.catch(() => []);
}

// savedMetrics: the metric definitions a metric('…') reference may name.
export function savedMetrics() {
  metrics ??= Promise.resolve(listMetrics())
    .then((defs) => (defs || []).map((d) => ({ name: d.name, title: d.title || '' })))
    .catch((e) => {
      metrics = null;
      throw e;
    });
  return metrics.catch(() => []);
}

// reportFields: the fields a template of the scope can reference.
export function reportFields(scope) {
  if (!fields.has(scope)) {
    const read = Promise.resolve(getReportFields(scope)).catch((e) => {
      fields.delete(scope);
      throw e;
    });
    fields.set(scope, read);
  }
  return fields.get(scope).catch(() => []);
}
