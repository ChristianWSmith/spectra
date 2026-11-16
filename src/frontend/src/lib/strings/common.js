// strings/common.js — shared chrome — button labels, dialog verbs, generic nouns (Save/Cancel/Retry-class copy across every view)
// Populated by Sweep-B extraction; values are plain strings with {arg}
// placeholders — compose at the call site with fill() (strings/index.js).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const common = {
  // docs popup (DocsPopup.svelte — routed at merge, strings Stage 1 ∥ docs wave)
  closeHelp: 'Close help',
  tocLabel: 'Contents',
  searchSections: 'Search sections', // header input: placeholder + aria-label
  searchPrev: 'Previous match', // match-stepper button: title + aria-label
  searchNext: 'Next match', // match-stepper button: title + aria-label
  noSectionsMatch: 'No sections match your search.', // TOC empty state under a filter
  guideComingSoon: 'Coming soon — this part of the guide isn\'t written yet.',
  // manual TOC subsection toggle (manual-console wave, 2026-11-14) — the
  // one per-major fold button; the label reads from the EXPANDED state
  // (aria-expanded carries the state too)
  collapseSubsections: 'Collapse subsections',
  expandSubsections: 'Expand subsections',

  // App shell (App.svelte — the sidebar rail and the replay dock)
  appSidebarLabel: 'Main', // <nav class="sidebar"> accessible name
  appMarkAlt: 'Spectra', // the sidebar app-mark image (favicon) alt text
  appHelpLabel: 'Help', // sidebar Help button: title + aria-label
  viewHelp: 'Help for this view', // view-header `?` (HelpButton.svelte): title + aria-label
  appExpandReplayLabel: 'Expand replay', // collapsed dock wrapper: title + aria-label
  appCloseReplayLabel: 'Close replay', // dock close X: aria-label
  appCloseReplayTitle: 'Close the replay — it reloads when reopened', // dock close X: title
  navMatchDisabled: 'Open a match first', // disabled sidebar Match tab: title (why it is greyed)

  // command palette (CommandPalette.svelte — Ctrl/Cmd-K overlay)
  commandPaletteLabel: 'Command palette', // Dialog accessible name
  commandPalettePlaceholder: 'Type a command or search…', // search input placeholder
  commandPaletteSearchLabel: 'Command palette search', // search input aria-label
  commandPaletteNoResultsPrefix: 'No results for “', // empty state, before the echoed {query}
  commandPaletteMoveHint: ' move', // footer: after the ↑↓ arrow glyphs
  commandPaletteRunHint: 'Enter run', // footer
  commandPaletteCloseHint: 'Esc close', // footer
  commandPaletteToggleHint: 'Ctrl/⌘K toggle', // footer

  // economy curve panel (EconCurve.svelte — the hand-rolled SVG chart)
  econCurveEquipHeading: 'Equip value per round', // panel heading, equip metric
  econCurveNetWorthHeading: 'Team net worth per round', // panel heading, net-worth metric
  econCurveMetricGroupLabel: 'Curve metric', // toggle group aria-label
  econCurveEquipToggle: 'Equip value', // toggle button label
  econCurveNetWorthToggle: 'Net worth', // toggle button label
  econCurveNoRows: 'No economy rows for this match.', // empty state
  econCurveTeamLinesLabel: 'Team lines', // legend aria-label
  econCurveEquipAria: 'equipment value', // chart aria-label, equip metric
  econCurveNetWorthAria: 'net worth', // chart aria-label, net-worth metric
  econCurveChartAriaSuffix: ' per round, one line per team — click a column to open the round', // chart aria-label, after the metric name
  econCurveOpenRoundAria: 'Open round ', // hit-area aria-label prefix, before {r.round}
  econCurveRoundTitle: 'Round ', // round number prefix (<title> + tooltip <strong>)
  econCurvePistolChip: 'pistol', // hover tooltip's pistol-round chip
  econCurveTooltipEquip: 'equip', // hover tooltip column label
  econCurveTooltipNetWorth: 'net worth', // hover tooltip column label
  econCurveStripLabel: 'Round strip', // winner-strip aria-label
  // Strip legend (the <p> under the strip): each phrase runs up to the
  // next codicon glyph; the values carry the exact spacing the static
  // text rendered with (edge whitespace the compiler trimmed is already
  // trimmed here — rendered text stays byte-identical).
  econCurveStripPistol: ' pistol round · ',
  econCurveStripFavorite: ' favorite (higher buy\n      type) held · ',
  econCurveStripUpset: ' upset (lower buy type\n      won) · ',
  econCurveStripEven: ' even buy (toss-up) · ',
  econCurveStripNoVerdict: ' no verdict · click a round to open\n      it',

  // confirmation dialog (ConfirmDialog.svelte — the one window.confirm replacement)
  confirmDialogCancel: 'Cancel', // the cancel button label (the confirm button's label is the caller's confirmLabel prop)

  // kill-event flag chips (EventFlags.svelte — the "no flags apply" fallback)
  eventFlagsNone: 'none', // rendered when the none prop is set and no flag chip applies

  // event-filter bar (FilterBar.svelte — the Replay feed's advanced filter)
  filterBarLabel: 'Event filters', // the group aria-label
  filterBarRound: 'Round', // the round row's label cell
  filterBarFrom: 'from', // round-from input placeholder
  filterBarTo: 'to', // round-to input placeholder
  filterBarFirstRound: 'First round', // round-from input aria-label
  filterBarLastRound: 'Last round', // round-to input aria-label
  filterBarPlayer: 'Player', // the player facet's label cell
  filterBarAll: 'All', // every unconstrained <select>'s option text
  filterBarSide: 'Side', // the side facet's label cell
  filterBarTeam: 'Team', // the team facet's label cell
  filterBarStartedCt: 'Started CT', // team option — the start-side identity spelled out
  filterBarStartedT: 'Started T', // team option — the start-side identity spelled out
  filterBarWeapon: 'Weapon', // the weapon facet's label cell
  filterBarDist: 'Dist', // the distance row's label cell
  filterBarMin: 'min', // distance-min input placeholder
  filterBarMax: 'max', // distance-max input placeholder
  filterBarMinDist: 'Minimum distance', // distance-min input aria-label
  filterBarMaxDist: 'Maximum distance', // distance-max input aria-label
  filterBarHeadshotsOnly: 'Headshots only', // the headshot facet's label cell
  // The Position row (the bbox filter — first-class and manually
  // enterable): the row label, the two static axis labels (NO input
  // placeholders — Check E stays out; the axis letter in front of each
  // min–max pair is the per-field visible name) and one aria-label per
  // spinner. The old chip's two fill strings left WITH the chip: the
  // bounds are now readable in the inputs themselves.
  filterBarPosition: 'Position', // the position row's label cell
  filterBarBboxAxisX: 'X', // static axis label in front of the X min–max pair
  filterBarBboxAxisY: 'Y', // static axis label in front of the Y min–max pair
  filterBarBboxMinX: 'Position minimum X', // the x-min spinner's aria-label
  filterBarBboxMaxX: 'Position maximum X', // the x-max spinner's aria-label
  filterBarBboxMinY: 'Position minimum Y', // the y-min spinner's aria-label
  filterBarBboxMaxY: 'Position maximum Y', // the y-max spinner's aria-label
  filterBarClearBbox: 'Clear position filter', // the clear × button's aria-label
  filterBarReset: 'Reset', // the local reset button

  // canvas heatmap layer (HeatmapLayer.svelte — the radar/raster overlay)
  heatmapLayerLabel: 'Heatmap over the map grid', // the canvas aria-label
  heatmapLayerDrillTitle: 'Drag a box or click the map to open the replay events for that region', // drillable kind: the canvas tooltip
  heatmapLayerNoDrillTitle: 'No region drill for this heatmap kind — its raster has no event rows behind it', // non-drillable kind: the canvas tooltip

  // landmark row (LandmarkRow.svelte — the shared event presentation)
  landmarkRowRoundPrefix: 'Round ', // the round label cell + its tooltip prefix
  landmarkRowSiteInfix: ' · site ', // between a site event's kind and its site
  landmarkRowTitleInfix: ' — tick ', // between the row title and its tick
  landmarkRowTickTitle: 'tick ', // the match-clock tooltip prefix

  // launch asset prompt (MapPackPrompt.svelte — the presence-driven dialog)
  mapPackNotFoundTitle: 'Counter-Strike 2 not found', // not-found variant: dialog label + heading
  mapPackExtractTitle: 'Extract CS2 assets', // found variant: dialog label
  mapPackFoundTitle: 'Found Counter-Strike 2', // found variant: heading
  mapPackInstallFallback: 'CS2 install', // the path line's fallback when no path is known yet
  mapPackChooseFolder: 'Choose folder…', // the manual-install button label
  mapPackNotNow: 'Not now', // the session-only dismissal button label
  mapPackExtracting: 'Extracting…', // the extract button, busy
  mapPackExtractAll: 'Extract all CS2 assets', // the extract button, idle
  // Body paragraphs — the values carry the exact spacing the compiler
  // renders the static text with (edge whitespace trimmed, the internal
  // line breaks and their indentation preserved), so the rendered text
  // stays byte-identical.
  mapPackNotFoundIntro:
    'Spectra reads the official radar images from a local Counter-Strike 2\n        installation for authentic map backgrounds in replay and heatmaps.\n        Without one, maps render as a plain grid.',
  mapPackNotFoundFine:
    'Nothing from Counter-Strike ships with the app, and nothing is\n        uploaded — your game files are read locally and the extracted packs\n        are stored in Spectra\'s data folder on this machine.',
  mapPackFoundIntro:
    'Spectra can read the official radar images, equipment icons and replay sounds from your local Counter-Strike 2 installation — authentic map backgrounds, inventory silhouettes and in-replay audio.',
  mapPackFoundFine:
    'Assets are read from your game files and stored in Spectra\'s data\n        folder on this machine. Nothing is uploaded, and nothing from\n        Counter-Strike ships with the app.',

  // match picker (MatchPicker.svelte — the Explorer/Reports match selector)
  matchPickerTriggerLabel: 'Match', // the trigger button's aria-label
  matchPickerFilterLabel: 'Filter matches', // the filter input's aria-label
  matchPickerListLabel: 'Matches', // the listbox's aria-label
  matchPickerRoundsTitle: 'Rounds', // the rounds-count cell's tooltip
  matchPickerDurationTitle: 'Duration', // the duration cell's tooltip
  matchPickerShowing: 'Showing {cap} of {n} — type more to narrow.', // the render-cap hint (fill: cap = the render cap, n = matches after filtering)
  matchPickerNoMatch: 'No matches match “{q}.”', // empty state under a typed query (fill: q = the query)
  matchPickerEmpty: 'No matches yet — import one in the Library.', // empty state with no query

  // picker popover footers (MatchPicker + PlayerPicker share the ↑↓/Enter/Esc row)
  pickerMoveHint: ' move', // after the ↑↓ arrow glyphs
  pickerEnterSelect: 'Enter select',
  pickerEscClose: 'Esc close',

  // metric order dialog (MetricOrderDialog.svelte — the pin-order UI)
  metricOrderDialogLabel: 'Metric order', // the Dialog accessible name
  metricOrderFixedCaption: 'Fixed stats — always first, not reorderable', // the read-only fixed block's caption
  metricOrderNoProfileMetrics: 'No profile metrics yet.', // empty state, profile section
  metricOrderNoMatchMetrics: 'No match metrics yet.', // empty state, match section
  metricOrderNothingToOrder: 'Nothing to order yet — pin metrics from the metric list.', // pins-only empty state
  metricOrderMoveUp: 'Move {name} up', // per-row move button aria-label (fill: name = the metric)
  metricOrderMoveDown: 'Move {name} down', // per-row move button aria-label (fill: name = the metric)
  metricOrderScoreboardSection: 'Scoreboard (match metrics)', // the match section's heading
  metricOrderProfileSection: 'Player profile (profile metrics)', // the profile section's heading
  metricOrderReset: 'Reset order', // the reset button label
  metricOrderClose: 'Close', // the close button label
  // Help line: the text run after the ↑↓ glyphs (the value carries
  // the exact spacing the static text rendered with).
  metricOrderHintKeys: ' move · Esc close',
  metricOrderNote:
    'Only your pinned metrics are listed here, in the order they\'ll appear — pin more from the pin\n      buttons in the metric list.',

  // payload browser (PayloadTree.svelte — Explorer's generic payload tree)
  payloadTreeNoKeys: 'No keys match “{query}.”', // the key-filter empty state (fill: query = the filter text)

  // player card (PlayerCard.svelte — one player's live replay card)
  playerCardNoStateTitle: 'No player state for this match', // the whole-card tooltip when no state stream exists
  playerCardFollowTitle: 'Camera follows this player', // the follow marker's tooltip
  playerCardDeadTitle: 'Dead — showing last-known state', // the DEAD chip's tooltip
  playerCardDeadLabel: 'DEAD', // the DEAD chip's text
  playerCardNoStreamTitle: 'This replay has no player state stream', // the "no state" marker's tooltip
  playerCardNoStateLabel: 'no state', // the "no state" marker's text
  playerCardMuteLabel: 'Mute {name}', // the mute button's aria-label (fill: name = the player)
  playerCardReloadingTitle: 'Reloading', // the reload ring's tooltip
  playerCardMoneyTitle: 'Unspent money', // the money cell's tooltip
  playerCardC4Title: 'C4 bomb', // the bomb badge's tooltip
  playerCardKitTitle: 'Defuse kit', // the kit badge's tooltip
  playerCardKitLabel: 'Kit', // the kit badge's icon alt + its mandatory text fallback

  // player picker (PlayerPicker.svelte — the Reports target selector)
  playerPickerTriggerLabel: 'Player', // the trigger button's aria-label
  playerPickerSelectPlayer: 'Select player…', // the trigger's empty-selection text
  playerPickerFilterLabel: 'Filter players', // the filter input's aria-label
  playerPickerListLabel: 'Players', // the listbox's aria-label
  playerPickerKdaTitle: 'K / D / A in this match', // the K/D/A cell's tooltip
  playerPickerAdrTitle: 'ADR in this match', // the match ADR cell's tooltip
  playerPickerRoundsTitle: 'Rounds played', // the rounds cell's tooltip
  playerPickerMatchesTitle: 'Matches in the library', // the career-matches cell's tooltip
  playerPickerMatchesSuffix: ' matches', // after the career-matches count
  playerPickerCareerAdrTitle: 'Career ADR', // the career ADR cell's tooltip
  playerPickerAdrSuffix: ' ADR', // after the career ADR value
  playerPickerInMatch: 'in this match', // the line-2 state, player appears in the selected match
  playerPickerNotInMatch: 'not in this match', // the line-2 state, player absent from the match
  playerPickerSeenPrefix: 'seen ', // before the last-seen date
  playerPickerNoMatch: 'No players match “{q}.”', // empty state under a typed query (fill: q = the query)
  playerPickerEmpty: 'No players yet — import a match in the Library.', // empty state with no query

  // round progression strip (RoundStrip.svelte — one cell per round)
  roundStripLabel: 'Round progression', // the strip's aria-label

  // sortable table header (SortTh.svelte — label + direction caret)
  sortThSortByPrefix: 'Sort by ', // the sort button's aria-label, before the column label

  // suggestion dropdown (SuggestInput.svelte — the one suggest panel)
  suggestInputSuggestions: 'Suggestions', // the listbox's fallback aria-label
  suggestInputMatchWord: ' match', // the player row's count word, before the plural morpheme
  suggestInputAdrPrefix: 'ADR ', // the player row's career ADR prefix

  // team column (TeamColumn.svelte — one team's card stack)
  teamColumnMuteLabel: 'Mute {name} voice', // the team mute button's aria-label (fill: name = the team)
};
