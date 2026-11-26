// metricreads.js — reading stored metrics by name: the one way a panel reads
// several at once. A read that rejects is a MetricRead in state 'failed' with
// the message, never a throw, so one broken metric shows its own failed chip
// and the rest of the panel still renders.
//
//   const reads = await spectra.readMetrics(['kills', 'deaths']);  // bound by the frame
//   reads.get('kills').state   // 'fresh' | 'processing' | … | 'failed'

// failedRead is the read a panel holds for a metric whose read threw.
function failedRead(e, errText) {
  return { state: 'failed', error: errText(e), value: null, rows: [] };
}

// readMetrics reads each named metric for the context's subject (spectra.metric
// binds default from the mounting surface). The result is a Map by name, in
// the order given.
export async function readMetrics(spectra, names, errText) {
  const results = await Promise.all(names.map((n) => spectra.metric(n).catch((e) => failedRead(e, errText))));
  return new Map(names.map((n, i) => [n, results[i]]));
}
