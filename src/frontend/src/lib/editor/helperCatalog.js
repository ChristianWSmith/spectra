// The helpers a user component can use, by name: the `spectra` prop, the
// pieces under `spectra.ui`, and the fields of the `context` prop. This is the
// one list the component builder's completions read. componentHelperCatalog.test.js
// checks it against the prop the frame builds (components/ComponentFrame.svelte
// and componentruntime/readapi.js), so a helper added to the prop without an
// entry here fails the suite.

// call(name, args, doc): a function helper, inserted with its parameters as tab stops.
function call(name, args, doc) {
  return { name, kind: 'function', detail: `spectra.${name}(${args})`, doc, insert: `${name}(${args ? '$1' : ''})`, snippet: true };
}

function value(name, detail, doc) {
  return { name, kind: 'property', detail: `spectra.${name}: ${detail}`, doc, insert: name, snippet: false };
}

export const SPECTRA_HELPERS = [
  call('metric', 'name, binds?', 'The stored value of one saved metric: { name, doc, state, value, valueKey, error, rows }. state is fresh, no-data, processing, failed or behind. A failed read also rejects.'),
  call('metricsByMatch', 'steamId, names, matchIds', "One player's values for several metrics across many matches, in one read: a Map from match id to a Map from metric name to that metric's read."),
  call('query', 'sql, binds?', 'A live, read-only statement over the library, with no freshness. Resolves to { columns, rows }.'),
  call('readMetrics', 'names', 'spectra.metric for each name at once: a Map from name to read. A failed read is its own failed state.'),
  call('track', 'promise', 'Counts a load the component runs itself as a read in flight.'),
  value('busy', 'boolean', 'True while any read or tracked load is in flight.'),
  call('whileCurrent', 'run', 'For a load started in an effect: run receives isCurrent(), and a late result is dropped once the inputs change.'),
  call('liveMetrics', '{ onDone }', "A panel's metric progress and reload wiring: progress, frac(id), stage(id), chip(def), and reload, which grows each time a metric finishes."),
  call('navigate', 'route', 'Opens a view: a hash such as #/match/…, or { path, query }.'),
  call('guard', 'fn', "Wraps an event or async handler so its error goes to the component's box instead of being lost."),
  call('activateOnKey', 'fn, { enterOnly }', 'Makes a clickable row work from the keyboard: Enter, and Space unless enterOnly is set.'),
  call('isHuman', 'row', 'True unless the roster row is a bot.'),
  call('listedPlayers', 'rows', 'The roster rows with the bots taken out, in order.'),
  call('metricPresentation', 'state, row, unitHasRows', 'Maps a read onto what a cell shows: a value, a no-data dash or a status chip.'),
  call('fmtMetric', 'value, format', "The text of a stored value in a format: int, float1, float2, percent, currency. A percent is a 0 to 1 fraction, shown as 0 to 100%. Any other format name shows an integer, or two decimals."),
  value('dash', 'string', 'The one dash a missing value shows.'),
  call('openMatch', 'matchId', 'Opens a match\'s view.'),
  call('openPlayer', 'steamId', "Opens a player's profile."),
  call('followPlayer', 'steamId, back?', "Opens the replay of the component's match, following this player. back is the route the replay returns to; the match when omitted."),
  call('loadForMatch', 'getMatchId, load, apply, failed?', "The effect body of a load for the component's match: $effect(spectra.loadForMatch(() => context.matchId, load, apply)). apply takes the loaded value while the load is still current. A failure goes to the frame banner, unless failed takes it."),
  call('openRow', 'open, options?', "Spread onto a clickable row: <tr {...spectra.openRow(open)}>. A click, or Enter (and Space unless enterOnly), runs open. ignore is a selector for controls inside the row that must not open it."),
  call('latestOnly', '', "A runner for one kind of load. Create it once, then call it for each load: only the newest load's result applies, so a slow earlier one cannot overwrite a later one."),
  call('loadThen', 'isCurrent, promise, apply, failed?', "A panel load: apply takes the result while isCurrent() still holds, and a failure goes to failed (the frame banner by default)."),
  call('report', 'error',"Shows a failure in the component's frame banner, which the reader can dismiss. Use it for a failed load the component has no banner of its own for."),
  call('fmtDate', 'd', 'A timestamp as a local date and time, or the dash when the match was never extracted.'),
  call('fmtDuration', 'seconds', 'A span in seconds, as a readable duration (1h02m03s over an hour), or the dash when it is unknown.'),
  value('ui', 'object', 'The shared display pieces: spectra.ui.ErrorBanner, EmptyNote, EmptyTableRow, LoadBox, MetricCell, MetricTd, RetryButton, SortTh, WinnerCell, StatCard and StatusChip.'),
  value('Child', 'component', 'Mounts another named component inside this one: <spectra.Child name="…" props={…} />.'),
];

export const UI_PIECES = [
  { name: 'ErrorBanner', detail: 'spectra.ui.ErrorBanner', doc: 'An error line, with an optional Retry and an optional dismiss. Props: onretry, retryLabel, ondismiss, dismissLabel; children.' },
  { name: 'EmptyNote', detail: 'spectra.ui.EmptyNote', doc: 'A muted note for an empty state. Children.' },
  { name: 'EmptyTableRow', detail: 'spectra.ui.EmptyTableRow', doc: 'The one row a table shows when it has nothing to list: a state chip, or the text. Props: colspan, empty, text, chip.' },
  { name: 'LoadBox', detail: 'spectra.ui.LoadBox', doc: 'The loading shell: holds its height while a load runs and shows a spinner over the content. Props: busy, name, key, tag; children.' },
  { name: 'RetryButton', detail: 'spectra.ui.RetryButton', doc: 'The button beside a failed read, to load it again. Props: onretry, label.' },
  { name: 'MetricCell', detail: 'spectra.ui.MetricCell', doc: "A metric's cell. Props: pres (from metricPresentation), format, chip, words." },
  { name: 'WinnerCell', detail: 'spectra.ui.WinnerCell', doc: "A side's name, as a chip. Props: name, winner, title." },
  { name: 'StatCard', detail: 'spectra.ui.StatCard', doc: 'A labelled figure, with an optional sub-line. Props: label, labelTitle, value, sub, title; slots subSlot and valueSlot.' },
  { name: 'MetricTd', detail: 'spectra.ui.MetricTd', doc: 'A numeric table cell (td) for one stored value. Props: pres (from metricPresentation), format, chip, words, title.' },
  { name: 'SortTh', detail: 'spectra.ui.SortTh', doc: 'A sortable table header cell. Props: label, cls, title, active, desc, onclick. The view keeps its own sort state.' },
  { name: 'StatusChip', detail: 'spectra.ui.StatusChip', doc: 'A status chip, with optional progress. Props: status, progress, stage, block, detail, title.' },
];

// The fields of the `context` prop: the match, player and round the component is mounted on.
export const CONTEXT_FIELDS = [
  { name: 'matchId', detail: 'context.matchId', doc: 'The match the component is mounted on (a number), or null.' },
  { name: 'steamId', detail: 'context.steamId', doc: 'The player the component is mounted on (a SteamID64 string), or null.' },
  { name: 'round', detail: 'context.round', doc: 'The round the component is mounted on, or null.' },
];

// componentCompletions returns the items for a component source at the cursor.
// linePrefix is the text of the line before the cursor: after `spectra.ui.` the
// ui pieces are offered, after `spectra.` the helpers, after `context.` its fields.
export function componentCompletions(linePrefix) {
  if (/\bspectra\.ui\.\w*$/.test(linePrefix)) {
    return UI_PIECES.map((p) => ({ label: p.name, kind: 'component', detail: p.detail, doc: p.doc, insert: p.name, snippet: false }));
  }
  if (/\bspectra\.\w*$/.test(linePrefix)) {
    return SPECTRA_HELPERS.map((h) => ({ label: h.name, kind: h.kind, detail: h.detail, doc: h.doc, insert: h.insert, snippet: h.snippet }));
  }
  if (/\bcontext\.\w*$/.test(linePrefix)) {
    return CONTEXT_FIELDS.map((f) => ({ label: f.name, kind: 'property', detail: f.detail, doc: f.doc, insert: f.name, snippet: false }));
  }
  return [
    { label: 'spectra', kind: 'helper', detail: 'the read API and helpers prop', doc: 'The read API and helpers a component receives. Type spectra. for the list.', insert: 'spectra', snippet: false },
    { label: 'context', kind: 'property', detail: 'the mounting surface', doc: 'The match, player and round the component is mounted on.', insert: 'context', snippet: false },
  ];
}
