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
  deleteMetric: 'Delete metric',
  deleteAria: 'Delete {name}',
  // Both delete sites compose these (w19 item 23): the list row's
  // glyph button and the editor footer's destructive action — one
  // word, one aria shape, whichever surface shows the control.

  // header
  heading: 'Metric builder',
  headNoteScopes:
    ')\n        match-scoped metrics show as scoreboard columns on every match, profile-scoped ones as stat cards\n        on a player profile.',
  metricLanguageHelp: 'Metric language help',
  retry: 'Retry',

  // list toolbar + running-metrics popup (components/RunningMetricsDialog)
  runningLabel: 'Running metrics',
  runningTitle: 'See the metrics running now, and cancel any of them',
  runningHeading: 'Running metrics',
  runningNote: 'Cancelled metrics keep no values until you save them again.',
  runningNone: 'No metrics are running.',
  runningCancel: 'Cancel',
  runningCancelAria: 'Cancel {name}',
  runningClose: 'Close running metrics',
  runningLoadError: "Couldn't read the running metrics.",
  runningCancelError: "Couldn't cancel {name}.",
  runningDismiss: 'Dismiss',

  // list toolbar + filters
  metricsHeading: 'Metrics',
  newLabel: 'New',
  searchAria: 'Search metrics',
  searchPlaceholder: 'Search metrics…',
  filtersTitle: 'Choose which metrics the list shows',
  filtersLabel: 'Filters',
  metricFiltersAria: 'Metric filters',
  originLabel: 'Origin',
  filterBuiltIn: 'Built-in',
  filterCustom: 'Custom',
  filterPlugin: 'Plugin',
  typeLabel: 'Type',
  filterAuto: 'Auto',
  filterInt: 'Int',
  filterFloat1: 'Float1',
  filterFloat2: 'Float2',
  filterPercent: 'Percent',
  filterCurrency: 'Currency',
  // The Type group's seventh box (metrics Phase 7, 2026-11-18): the
  // key-valued identity metrics' filter treatment — like every format
  // option, declared on the definition (its `format` column), never in
  // the expression text.
  filterIdentity: 'Identity',
  // The list's ORIGIN group headers (the run labels over the rows).
  // The user-authored group's header reads "Custom" — it lists exactly
  // the rows the Origin group's Custom box selects (origin 'user'), so
  // the two media say one word for one set (W45's Custom filter
  // ruling); it replaced the inline "Yours" spelling with the catalog
  // home (one spelling per concept). "Builtins" is the header's plural
  // noun — the box's label stays the singular "Built-in".
  groupBuiltins: 'Builtins',
  groupCustom: 'Custom',
  groupPlugins: 'Plugins',
  // empty states + paging
  noMetricsMatch: 'No metrics match “{q}.”',
  noMetricsToShow: 'No metrics to show.',
  showingMetrics: 'Showing {n} metrics',
  loadingMore: 'Loading…',
  loadMore: 'Load more',

  // editor form
  editMetric: 'Edit metric',
  newMetric: 'New metric',
  // A built-in is edited in place (owner ruling 44): its SQL is the one
  // thing that changes; restore to default brings the shipped SQL back.
  builtinEditNote: 'Your edit replaces this built-in. Restore to default undoes it.',
  builtinEditedNote: 'Edited. Restore to default brings back the shipped expression.',
  builtinChip: 'built-in',
  editedChip: 'edited',
  editedTitle: 'You have edited this built-in. Its shipped expression is the default.',
  restoreDefault: 'Restore to default',
  restoreTitle: 'Discard your edit and use the shipped expression',
  pluginImmutable:
    'Plugin metrics are immutable — saving stores a copy of this definition as your own metric.',
  pluginReadOnlyChip: 'read-only source',
  fieldName: 'Name',
  namePlaceholder: 'Enter a metric name…',
  fieldTitle: 'Title',
  titlePlaceholder: 'Enter a display label…',
  fieldShortName: 'Short name (optional)',
  shortNamePlaceholder: 'Enter a short label for narrow columns…',
  // The six-character cap (N3) — the save guard's report when a loaded
  // value is already over it (the input's maxlength stops new typing).
  shortNameTooLong: 'Short name must be 6 characters or fewer.',
  fieldFormat: 'Format',
  fieldDoc: 'Doc (formula, required)',
  docPlaceholder: 'Document the formula — what it counts, over what…',
  fieldExpression: 'Expression',
  exprChecking: 'checking…',
  exprValid: 'valid',

  // actions row
  saving: 'Saving…',
  saved: 'Saved',
  saveMetric: 'Save metric',
  saveNoteDefault: 'Saved metrics are appended to match reports in Reports.',

  // preview panel
  previewHeading: 'Preview',
  preview: 'Preview',
  running: 'Running…',
  previewTruncated: 'truncated',
  storedValuesLabel: 'Stored values ·',
  storedProfileScope: 'career (every player)',
  storedMatchScope: 'newest ready match #',
  storedNoMatch: 'no ready match to read from yet',
  noGroups: 'No groups — empty result.',
  noStoredValues: 'No stored values for this metric yet.',
  colGroup: 'Group',
  colLabel: 'Label',
  colValue: 'Value',
  noDataBehind: 'no data behind this value',
  // The Builder's behind chip: its word is the library-wide one (any match
  // behind), so the title says so. The match view reads per match instead.
  behindAnyMatch: 'behind for any match — a match needs a recompute',
  compiledSql: 'compiled SQL (provenance)',
  noPreviewYetLead: 'Nothing previewed yet — press Preview (or',
  noPreviewYetTail: 'on a metric).',
};
