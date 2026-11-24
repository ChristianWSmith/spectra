// metricslive.svelte.js — the metric-progress wiring a panel mounts, once.
//
// Every panel that reads stored metrics needs the same three things: the live
// sweep progress (so a metric that is being computed shows its bar and stage),
// a reload counter bumped whenever a metric finishes (so the panel re-reads),
// and the progress lookups its StatusChips take. liveMetrics() is that wiring.
// Call it once from a component's top level: it registers two effects, and
// effects belong to the component's own lifecycle.
//
//   const live = liveMetrics();
//   $effect(() => { live.reload; /* re-read on a finished metric */ });
//   <StatusChip progress={live.frac(id)} stage={live.stage(id)} />
//
// progress is the Map from subscribeMetricProgress (metric id → progress);
// reload is a number that only ever grows. Both are read through getters, so
// reading them inside an effect or a derived value tracks them.

import { subscribeMetricProgress, onMetricDone } from './services.js';
import { metricProgressFrac, metricProgressStage } from './metricstate.js';

// onDone (optional) runs after the reload bump on each metric-done, for a panel
// that refetches more than its own reads.
export function liveMetrics({ onDone } = {}) {
  let progress = $state(new Map());
  let reload = $state(0);
  $effect(() => subscribeMetricProgress((snap) => (progress = snap)));
  $effect(() =>
    onMetricDone(() => {
      reload += 1;
      if (onDone) onDone();
    }),
  );
  return {
    get progress() {
      return progress;
    },
    get reload() {
      return reload;
    },
    // frac and stage take a metric id (undefined when the def is not loaded,
    // which the lookups answer as "no progress").
    frac: (id) => metricProgressFrac(progress, id),
    stage: (id) => metricProgressStage(progress, id),
    // chip(def): the progress and stage props of a StatusChip for one metric
    // definition, spread onto the chip: <StatusChip {...sweep.chip(def)} />.
    chip: (def) => ({ progress: metricProgressFrac(progress, def?.id), stage: metricProgressStage(progress, def?.id) }),
  };
}
