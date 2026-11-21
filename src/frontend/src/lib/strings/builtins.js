// strings/builtins.js — copy the builtin panels share: the state words a metric cell shows, the round and unit labels
// the panel helpers (builtinhelpers.js, matchpanels.js) print. A key lives
// here when two or more builtin panels read it, or when a helper block is the
// only place it is shown; a key one panel alone owns lives in that panel's
// area module (match.js, economy.js, utility.js, …).
// Values are plain strings (no functions, no concatenation); a leading or
// trailing space is part of the value (the text the panel rendered before).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const builtins = {
  // metric state words (a cell that is not fresh shows its state)
  stateCalculating: 'Calculating',
  stateFailed: 'Failed',
  stateOutOfDate: 'Out of date',
  // a metric's failure detail, appended to the failed cell's title
  couldntCalculate: ' — couldn’t calculate: ',

  // round labels: a legacy negative round row shows K (knife) or W (warmup)
  roundLabelKnife: 'K',
  roundLabelWarmup: 'W',
  // the round picker's option label prefix: RD<n> | <ct>-<t>
  roundScorePrefix: 'RD',

  // byte-size units, with their leading space (the size a fact shows)
  unitKb: ' KB',
  unitMb: ' MB',
  unitGb: ' GB',
};
