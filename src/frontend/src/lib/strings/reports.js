// strings/reports.js — Reports view chrome (template/target, stats
// appendix, preview)
// Extracted from views/Reports.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(...).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const reports = {
  title: 'Reports',
  subtitle: 'Templated match / player / round reports.',
  retry: 'Retry',
  templateAndTarget: 'Template & target',
  generateReport: 'Generate report ',
  originTitle: 'Origin',
  noTemplates: 'No report templates available.',
  noMatches: 'No matches in the library yet.',
  targetThisMatch: 'Report target: this match.',
  matchLabel: 'Match',
  playerLabel: 'Player',
  roundLabel: 'Round',
  statsAppendix: 'Stats appendix',
  appendixHint:
    'Pick the stats to append their tables under the report (scoped to this match): search a row to choose a stat, add another row with +, and remove a row with −. They are composed with the rendered document and shown in the Preview below.',
  metricHint: 'Search stats…',
  metricAria: 'Stat to append',
  addStat: 'Add stat',
  removeStat: 'Remove stat',
  failedLabel: 'failed',
  rowsSuffix: ' rows',
  noMatchScopedStats: 'No match-scoped stats yet — profile-scoped stats surface on the player profile.',
  noCustomStats: 'No custom stats yet — build one in the Builder.',
  previewHeading: 'Preview',
  appendixSuffix: ' + appendix',
  pressGenerate: 'Press Generate report to create the report.',
};
