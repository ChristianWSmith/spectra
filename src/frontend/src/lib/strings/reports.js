// strings/reports.js — Reports view chrome (template/target, stats
// appendix, save)
// Extracted from views/Reports.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(...).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const reports = {
  title: 'Reports',
  subtitle: 'Templated match / player / round reports.',
  retry: 'Retry',
  templateAndTarget: 'Template & target',
  generateReport: 'Save report ',
  originTitle: 'Origin',
  noTemplates: 'No report templates available.',
  noMatches: 'No matches in the library yet.',
  targetThisMatch: 'Report target: this match.',
  matchLabel: 'Match',
  playerLabel: 'Player',
  roundLabel: 'Round',
  statsAppendix: 'Stats appendix',
  appendixHint:
    'Pick the stats to append under this match’s report: type to search and pick — each becomes a chip. Remove it with the chip’s ✕ or Backspace on an empty field; the save composes them into the file.',
  metricHint: 'Search stats…',
  metricAria: 'Stat to append',
  removeStatAria: 'Remove {name}',
  failedLabel: 'failed',
  rowsSuffix: ' rows',
  noMatchScopedStats: 'No match-scoped stats yet — profile-scoped ones live on profiles.',
  noCustomStats: 'No custom stats yet — build one in the Builder.',
};
