// workstate.svelte.js — THE background-work aggregate behind the floating
// bottom-right indicator (App's .wk-pill): which sources are running, the
// single display snapshot the pill renders, dismissal, the settle delay,
// and the held failure line.
//
// Deliberately PLAIN JS despite the .svelte.js name (the viewstate.svelte.js
// precedent): the module holds NO runes — `node --test` and the jsdom
// drivers import it raw, and a rune in here would break every plain-node
// import (App copies the snapshot into its own $state through
// subscribeWork).
//
// The seven sources (owner ruling 2026-11-17 — all of them):
//   jobs      — spectra:job-progress / job-done through services.js's
//               canonical jobProgress store (map empty = done).
//   metrics   — spectra:metric-progress / metric-done through the
//               canonical metricProgress store (map empty = done); plugin
//               operations schedule that sweep, so they fold in here.
//   analysis  — spectra:analysis-progress / -done keyed by match (a run
//               announces its start, each member announces completion).
//   assets    — runWork-wrapped: services.js's three extractors (the
//               canonical wrapper layer — covers extractAllAssets callers
//               AND Replay's direct auto-extract of icons).
//   scan      — runWork-wrapped inside services.listDemoFiles.
//   heatmap   — runWork-wrapped at Heatmaps' generate call site (it has
//               TWO binding paths — GetHeatmap and GetHeatmapKD — so the
//               one call site wraps both).
// spectra:asset-progress / scan-progress / heatmap-progress are
// progress-ONLY channels (no begin signal) — they are NOT begin sources
// here; the wrapped call's start is the begin.
//
// ONE canonical helper: runWork(source, promise) below. assets.js adds
// reportWorkError for its AGGREGATED outcome (extractAllAssets resolves
// {error} instead of rejecting).
//
// The ESM cycle services.js ⇄ workstate.svelte.js is deliberate and
// benign: services wraps its long calls through runWork, this module
// reads the two progress stores through subscribeJobProgress /
// subscribeMetricProgress. Neither side calls the other at module-eval
// time (services' wraps run only when a wrapped call is made; wire() runs
// on first subscribeWork), so evaluation order never matters.
//
// Visibility rules (owner answers Q1–Q4, 2026-11-17):
//   * visible ⇔ some source active ∧ not dismissed, OR a held error
//     (a failure is never hidden — Q2);
//   * per-source idle→busy clears `dismissed` (a NEW source re-shows the
//     pill); a same-source update (a second job while jobs already run)
//     never re-shows it (Q3);
//   * when the LAST source goes idle the pill hides after a ~400 ms
//     settle window (queued-behind-parallelism gaps and chained runs —
//     Q4) and `dismissed` resets to false, so the next start shows fresh;
//     an idle pill holding an error does NOT hide until dismissed (Q2);
//   * dismissWork (the pill's ✕) hides now and clears the held error;
//     a later failure re-shows it (reportWorkError resets dismissal).
//
// Aggregation for the chip (Q1): determinate progress only when exactly
// ONE source is active and it is jobs/metrics with a single entry in its
// store — its job-wide 0..1 (or done/total) and its stage ride StatusChip
// (progress 0 = the indeterminate bar per StatusChip's contract). Two
// determinate stores, or any other active source, shows indeterminate —
// no invented cross-source math.
import { subscribeJobProgress, subscribeMetricProgress, onEvent, errText } from './services.js';

// The settle window: hide only after the aggregate stays empty this long.
// Test seam: the unit test and the app-dock driver wait it out with a
// real sleep (the preload.test.js precedent — no fake-timer infra exists
// in this suite), asserting the pill is still up BEFORE the window and
// gone after it.
const SETTLE_MS = 400;

// Wrapped sources: refcounted live runs (concurrent same-source runs
// never double the display — busy ⇔ count > 0).
const counts = new Map(); // source -> live run count
let wrappedLive = 0; // how many wrapped sources currently have count > 0

// Event-driven sources.
let jobsActive = false;
let metricsActive = false;
let analysisActive = false;
let jobsSnap = new Map(); // jobId -> payload (determinate read)
let metricsSnap = new Map(); // metricId -> payload (determinate read)
const analysisRuns = new Set(); // matchId -> in-flight run

let dismissed = false;
let error = '';
let visible = false;
let hideTimer = null;

const subs = new Set();
let wired = false;

function anyActive() {
  return jobsActive || metricsActive || analysisActive || wrappedLive > 0;
}

// The pill's display snapshot. status 'failed' + the held message when an
// error is in hand; 'running' + the aggregate point otherwise.
function snapshot() {
  const det = determinate();
  return {
    visible,
    error,
    status: error ? 'failed' : 'running',
    progress: error ? null : det.progress,
    stage: error ? '' : det.stage,
  };
}

// Determinate read: exactly one active source AND it is jobs/metrics with
// a single entry → that entry's job-wide point + stage; anything else is
// 0 (StatusChip's indeterminate bar — never a fabricated aggregate).
function determinate() {
  const activeSources =
    (jobsActive ? 1 : 0) + (metricsActive ? 1 : 0) + (analysisActive ? 1 : 0) + (wrappedLive > 0 ? 1 : 0);
  if (activeSources !== 1) return { progress: 0, stage: '' };
  if (jobsActive && jobsSnap.size === 1) {
    const p = jobsSnap.values().next().value;
    return { progress: typeof p.progress === 'number' ? p.progress : 0, stage: (p && p.stage) || '' };
  }
  if (metricsActive && metricsSnap.size === 1) {
    const p = metricsSnap.values().next().value;
    return {
      progress: p && p.total > 0 ? Math.min(1, p.done / p.total) : 0,
      stage: (p && p.stage) || '',
    };
  }
  return { progress: 0, stage: '' };
}

function emit() {
  const snap = snapshot();
  for (const fn of subs) fn(snap);
}

function clearHide() {
  if (hideTimer != null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide() {
  if (hideTimer != null) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // The window is a pure "stayed empty" check: any activity or a held
    // error that arrived meanwhile cancels the hide by keeping the timer
    // from rescheduling here (evaluate() cleared it on the way in).
    if (anyActive() || error) return;
    visible = false;
    dismissed = false; // last-idle reset — the next start shows fresh (Q3)
    emit();
  }, SETTLE_MS);
}

// The one transition routine — every state mutation ends here.
function evaluate() {
  if (anyActive()) {
    clearHide();
    visible = !dismissed;
  } else if (error) {
    // Never hide a failure: the pill holds the error line until the ✕ (or
    // a later failure supersedes it), regardless of the settle window.
    clearHide();
    visible = true;
  } else if (visible) {
    scheduleHide(); // idle now, but inside the settle window (Q4)
  } else {
    dismissed = false; // already hidden at last-idle: reset for next run (Q3)
  }
  emit();
}

// Per-source idle→busy transition: a NEW source re-shows a dismissed pill
// (Q3). Called only on a real false→true flip (and by reportWorkError —
// a failure lifts dismissal the same way, Q2).
function clearDismissed() {
  dismissed = false;
}

function setJobsActive(next) {
  if (next === jobsActive) return;
  jobsActive = next;
  if (next) clearDismissed();
}

function setMetricsActive(next) {
  if (next === metricsActive) return;
  metricsActive = next;
  if (next) clearDismissed();
}

function setAnalysisActive(next) {
  if (next === analysisActive) return;
  analysisActive = next;
  if (next) clearDismissed();
}

// runWork — THE one source wrapper (cited by the wrapping sites):
// marks `source` busy for the promise's whole life, reports a rejection
// as the held error line (Q2) and rethrows it untouched for the caller's
// own error slot.
export function runWork(source, promise) {
  const prev = counts.get(source) || 0;
  counts.set(source, prev + 1);
  if (prev === 0) {
    clearDismissed(); // THIS source's idle→busy transition (Q3)
    wrappedLive++;
  }
  evaluate();
  return Promise.resolve(promise).then(
    (v) => {
      endWork(source);
      return v;
    },
    (e) => {
      reportWorkError(errText(e));
      endWork(source);
      throw e;
    },
  );
}

function endWork(source) {
  const prev = counts.get(source) || 0;
  if (prev <= 0) return;
  counts.set(source, prev - 1);
  if (prev - 1 === 0) wrappedLive--;
  evaluate();
}

// reportWorkError — the held failure line (Q2): replaces any previous
// message and re-shows a dismissed pill (a failure is never hidden).
export function reportWorkError(msg) {
  const text = String(msg == null ? '' : msg).trim();
  if (!text) return;
  error = text;
  clearDismissed(); // reset dismissal: the failure must be seen
  evaluate();
}

// dismissWork — the pill's ✕: hide now, drop the held error, keep the
// running work untouched (Q1/Q2 — dismissal hides the INDICATOR, never
// the work).
export function dismissWork() {
  dismissed = true;
  error = '';
  visible = false;
  clearHide();
  emit();
}

// subscribeWork hands cb the current snapshot immediately and on every
// change (the services.js store pattern); returns the unsubscribe fn
// ($effect cleanup). The FIRST subscription wires the event sources.
export function subscribeWork(cb) {
  wire();
  subs.add(cb);
  cb(snapshot());
  return () => subs.delete(cb);
}

function wire() {
  if (wired) return;
  wired = true;
  // jobs: the canonical store's snapshot IS the busy signal (map empty =
  // done); every tick also refreshes the determinate read.
  subscribeJobProgress((snap) => {
    jobsSnap = snap;
    setJobsActive(snap.size > 0);
    evaluate();
  });
  subscribeMetricProgress((snap) => {
    metricsSnap = snap;
    setMetricsActive(snap.size > 0);
    evaluate();
  });
  // analysis: one in-flight set keyed by match — a run announces its
  // start (analysis-progress) and each member its completion
  // (analysis-done); the set emptying is the aggregate completion.
  onEvent('spectra:analysis-progress', (p) => {
    if (p && p.matchId != null) {
      analysisRuns.add(p.matchId);
      setAnalysisActive(true);
      evaluate();
    }
  });
  onEvent('spectra:analysis-done', (p) => {
    if (p && p.matchId != null) analysisRuns.delete(p.matchId);
    setAnalysisActive(analysisRuns.size > 0);
    evaluate();
  });
}

// resetWorkState — the cross-test isolation hook (the resetViewState()
// discipline): wipes every source, the dismissal and any pending hide
// timer, and emits so a mounted App's pill re-renders. The wire stays
// (event listeners are idempotent for the process).
export function resetWorkState() {
  clearHide();
  counts.clear();
  wrappedLive = 0;
  jobsActive = false;
  metricsActive = false;
  analysisActive = false;
  jobsSnap = new Map();
  metricsSnap = new Map();
  analysisRuns.clear();
  dismissed = false;
  error = '';
  visible = false;
  emit();
}
