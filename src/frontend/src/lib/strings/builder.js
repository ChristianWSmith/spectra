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
  // Pin-button titles — BOTH pin sites compose these (Builder's list
  // row through pinTitle, the Order dialog's metric row directly): the
  // scope names the SURFACE the metric reaches (design §3 — match → a
  // scoreboard column, profile → the player's Career metrics panel),
  // the state whether it is being pinned or unpinned. Wording is
  // byte-identical to the four literals pinTitle carried inline before
  // they moved here (one canonical way, tests pin the exact strings).
  pinToScoreboard: 'Pin as scoreboard column',
  pinToProfile: 'Pin to player profile',
  unpinFromScoreboard: 'Unpin from scoreboard',
  unpinFromProfile: 'Unpin from player profile',
  // The Match-overview table's two-way pin (the dialog's third section,
  // owner item 5 2026-11-18 — that table is the overview's only picker,
  // so its rows carry BOTH states; Builder's rows never pin here).
  pinToOverview: 'Pin as overview card',
  unpinFromOverview: 'Unpin from overview',
  deleteMetric: 'Delete metric',
  deleteAria: 'Delete {name}',
  // Both delete sites compose these (w19 item 23): the list row's
  // glyph button and the editor footer's destructive action — one
  // word, one aria shape, whichever surface shows the control.

  // header
  heading: 'Metric builder',
  headNotePinned: 'Saved metrics are appended to match reports in Reports · pinned (',
  headNoteScopes:
    ')\n        match-scoped metrics show as scoreboard columns on every match, profile-scoped ones as stat cards\n        on a player profile.',
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
  filterCustom: 'Custom',
  filterPlugin: 'Plugin',
  scopeLabel: 'Scope',
  filterMatch: 'Match',
  filterProfile: 'Profile',
  // The Subject group (the list filter over the metrics subject axis —
  // player / match / team, the same three words the editor's Subject
  // select offers below). filterPlayer/filterTeam are this group's own
  // box labels; filterMatch is the shared "Match" word (one spelling).
  subjectLabel: 'Subject',
  filterPlayer: 'Player',
  filterTeam: 'Team',
  denominatorLabel: 'Denominator',
  filterRounds: 'Rounds',
  filterMatches: 'Matches',
  // The Denominator group's third box (Reading B, 2026-11-16): the
  // boxes are exactly the column's three values — this one is the
  // denominator-less rows. Distinct from denomNone ('none'), the
  // editor's Denominator SELECT option.
  filterNone: 'None',
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
  // The Pinning group (the list's fifth filter — client-side: pins live
  // in localStorage, so the backend cannot narrow on them).
  pinningLabel: 'Pinning',
  filterPinned: 'Pinned',
  filterUnpinned: 'Unpinned',

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
  namePlaceholder: 'Enter a metric name…',
  fieldTitle: 'Title',
  titlePlaceholder: 'Enter a display label…',
  fieldShortName: 'Short name (optional)',
  shortNamePlaceholder: 'Enter a short label for narrow columns…',
  // The six-character cap (N3) — the save guard's report when a loaded
  // value is already over it (the input's maxlength stops new typing).
  shortNameTooLong: 'Short name must be 6 characters or fewer.',
  scopeMatchOption: 'match — this subject in this match',
  scopeProfileOption: "profile — this player's career",
  // The editor's Subject select (the metrics subject axis): what the
  // number is ABOUT, picked for the metric like its scope — the server's
  // subject × scope matrix (profile is player-only) is the guard, so no
  // option is disabled here.
  fieldSubject: 'Subject',
  subjectPlayerOption: 'player — about one player',
  subjectMatchOption: 'match — about the match',
  subjectTeamOption: 'team — about one team',
  fieldFormat: 'Format',
  denomNone: 'none', // also the list row's denominator-less chip word (w19)
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
