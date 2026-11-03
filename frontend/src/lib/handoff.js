// Cross-view hand-off contract (E3): one sessionStorage key per
// hand-off, written by the navigating view just before it navigates and
// read EXACTLY ONCE by the receiving view.
//
// Semantics (unchanged from the services.js originals):
//   setHandoff(key, value)  JSON-encodes value under key; value == null
//                           removes the key instead of writing a payload
//                           (a "clear the stale one" write). Storage
//                           failures THROW — the caller decides whether
//                           to swallow (services.js's writers log) or
//                           surface them (Match's compare picker sets its
//                           status line).
//   takeHandoff(key)        read-once: returns the parsed value and
//                           clears the key in the same step, so a second
//                           read is null. Missing key, an unparseable
//                           payload or a storage failure all return null
//                           (failures are logged, never thrown).
//
// Every writer/reader of every key:
//
//   spectra:timeline-filter  (HANDOFF_KEYS.timelineFilter)
//     writers  setPendingTimelineFilter (services.js) — Match scoreboard
//              row / openPlayerTimeline, Combat/Economy round chips,
//              Utility grenade row, Heatmap bbox click, Context?, Replay
//              "open at tick", CommandPalette actions, ClutchCard round
//     readers  takePendingTimelineFilter (services.js) — Timeline's
//              constructor seed and its match-switch re-arm effect
//
//   spectra:replay-seek      (HANDOFF_KEYS.replaySeek)
//     writers  setPendingSeek (services.js) — Match "watch" (null clears),
//              RoundDetail kill feed, Timeline rows, CompareRounds,
//              Combat/Utility/Context round rows, ClutchCard
//     readers  takePendingSeek (services.js) — Replay on mount / id change
//
//   spectra:compare-rounds   (HANDOFF_KEYS.compareRounds)
//     writer   Match's Rounds-tab "Compare" (goCompare)
//     reader   CompareRounds' readSelection (validates shape + match id)
//
// Prefs/pinned metrics are NOT hand-offs: they live in localStorage
// through the kvstore (Builder's pinned-metrics key) and persist.

export const HANDOFF_KEYS = {
  timelineFilter: 'spectra:timeline-filter',
  replaySeek: 'spectra:replay-seek',
  compareRounds: 'spectra:compare-rounds',
};

// setHandoff writes value (JSON) under key, or clears the key when value
// is null/undefined. Throws on storage failure — see the contract above.
export function setHandoff(key, value) {
  if (value == null) {
    sessionStorage.removeItem(key);
    return;
  }
  sessionStorage.setItem(key, JSON.stringify(value));
}

// takeHandoff reads a hand-off exactly once: the key is removed before
// the payload is parsed, so a corrupt value also clears the slot. Never
// throws; failures log and yield null.
export function takeHandoff(key) {
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}
