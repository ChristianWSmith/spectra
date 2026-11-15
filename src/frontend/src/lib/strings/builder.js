// strings/builder.js — Builder view chrome (views/Builder.svelte): list rows,
// header note, toolbar + filters, empty states, the metric form and the
// preview panel.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const builder = {
  // list-row actions (snippet)
  originPlugin: 'plugin',
  pluginDisabled: 'disabled',
  previewThisMetric: 'Preview this metric',
  previewAria: 'Preview {name}',
  togglePinAria: 'Toggle pin for {name}',
  deleteMetric: 'Delete metric',
  deleteAria: 'Delete {name}',

  // header
  heading: 'Metric builder',
  headNotePinned: 'Saved metrics are appended to match reports in Reports · pinned (',
  headNoteScopes:
    ')\n        match-scoped metrics show as scoreboard columns on every match, profile-scoped ones as Career\n        metrics on a player profile.',
  metricLanguageHelp: 'Metric language help',
  retry: 'Retry',

  // list toolbar + filters
  metricsHeading: 'Metrics',
  orderDialogTitle: 'Set the order of scoreboard columns and profile cards',
  orderLabel: 'Order…',
  newLabel: 'New',
  searchAria: 'Search metrics',
  searchPlaceholder: 'Search metrics…',
  filtersTitle: 'Choose which metrics the list shows',
  filtersLabel: 'Filters',
  metricFiltersAria: 'Metric filters',
  originLabel: 'Origin',
  filterBuiltIn: 'Built-in',
  filterMyMetrics: 'My metrics',
  scopeLabel: 'Scope',
  filterMatch: 'Match',
  filterProfile: 'Profile',
  denominatorLabel: 'Denominator',
  filterRounds: 'Rounds',
  filterMatches: 'Matches',
  typeLabel: 'Type',
  filterAuto: 'Auto',
  filterInt: 'Int',
  filterFloat1: 'Float1',
  filterFloat2: 'Float2',
  filterPercent: 'Percent',
  filterCurrency: 'Currency',

  // empty states + paging
  noMetricsMatch: 'No metrics match “{q}.”',
  noMetricsToShow: 'No metrics to show.',
  showingMetrics: 'Showing {n} metrics',
  loadingMore: 'Loading…',
  loadMore: 'Load more',

  // editor form
  editMetric: 'Edit metric',
  newMetric: 'New metric',
  builtinReadOnly: "Built-in metrics can't be edited",
  builtinChip: 'built-in',
  pluginImmutable:
    'Plugin metrics are immutable — saving stores a copy of this definition as your own metric.',
  pluginReadOnlyChip: 'read-only source',
  fieldName: 'Name',
  namePlaceholder: 'Enter a metric name (e.g. slug_name)…',
  fieldTitle: 'Title',
  titlePlaceholder: 'Enter a display label…',
  fieldShortName: 'Short name (optional)',
  shortNamePlaceholder: 'Enter a short label for narrow columns…',
  scopeMatchOption: 'match — this player in this match',
  scopeProfileOption: "profile — this player's career",
  fieldFormat: 'Format',
  denomNone: 'none',
  denomRounds: 'rounds',
  denomMatches: 'matches',
  fieldDoc: 'Doc (formula, required)',
  docPlaceholder: 'Document the formula — what it counts, over what…',
  fieldExpression: 'Expression',
  exprChecking: 'checking…',
  exprValid: 'valid',

  // actions row
  saving: 'Saving…',
  saved: 'Saved',
  saveMetric: 'Save metric',
  pinned: 'Pinned',
  pin: 'Pin',
  saveNoteDefault: 'Saved metrics are appended to match reports in Reports.',

  // preview panel
  previewHeading: 'Preview',
  preview: 'Preview',
  running: 'Running…',
  previewTruncated: 'truncated',
  adhocNote: 'Ad-hoc preview — the denominator ({denominator}) applies after save.',
  storedValuesLabel: 'Stored values ·',
  storedProfileScope: 'career (every player)',
  storedMatchScope: 'newest ready match #',
  storedNoMatch: 'no ready match to read from yet',
  noGroups: 'No groups — empty result.',
  noStoredValues: 'No stored values for this metric yet.',
  colGroup: 'Group',
  colLabel: 'Label',
  colValue: 'Value',
  sampleSizeTitle: 'Sample size behind the value',
  noDataBehind: 'no data behind this value',
  compiledSql: 'compiled SQL (provenance)',
  noPreviewYetLead: 'Nothing previewed yet — press Preview (or',
  noPreviewYetTail: 'on a metric).',
};
