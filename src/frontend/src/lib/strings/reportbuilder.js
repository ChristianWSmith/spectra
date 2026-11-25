// strings/reportbuilder.js — Reports builder view chrome
// (views/ReportsBuilder.svelte): the template list (search, origin
// filter, rows), the editor form and the preview target/output.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// The template BODY is a power surface (template code, the SQL console /
// expression editor's class) and carries no chrome copy of its own.
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const reportbuilder = {
  // header
  heading: 'Reports builder',
  headNote: 'Built-in and plugin templates are read-only — save one to copy it.',
  retry: 'Retry',

  // list toolbar + the origin filter group
  templatesHeading: 'Templates',
  newLabel: 'New',
  searchAria: 'Search report templates',
  searchPlaceholder: 'Search templates…',
  originLabel: 'Origin',
  filterBuiltIn: 'Built-in',
  filterCustom: 'Custom',
  filterPlugin: 'Plugin',
  filterFormatMd: 'md',
  filterFormatHtml: 'html',
  filterScopeMatch: 'Match',
  filterScopePlayer: 'Player',
  filterScopeRound: 'Round',

  // empty states
  noTemplatesMatch: 'No templates match “{q}.”',
  noTemplatesToShow: 'No templates to show.',

  // list rows (the origin chip renders the row's own origin word — the
  // same spelling the Reports template cards show)
  deleteTemplate: 'Delete template',
  deleteAria: 'Delete {name}',

  // editor form
  editTemplate: 'Edit template',
  newTemplate: 'New template',
  // A built-in is edited in place (owner ruling 44): its text is the one
  // thing that changes; restore to default brings the shipped text back.
  builtinEditNote: 'Your edits replace this built-in. Restore to default undoes them.',
  builtinEditedNote: 'Edited. Restore to default brings back the shipped text.',
  restoreDefault: 'Restore to default',
  restoreTitle: 'Discard your edit and use the shipped text',
  pluginImmutable:
    'Plugin templates are read-only — saving one stores a copy of this template as your own.',
  fieldTitle: 'Title',
  titlePlaceholder: 'Name this report template…',
  fieldScope: 'Scope',
  scopeMatchOption: 'match — one match',
  scopePlayerOption: 'player — one player in a match',
  scopeRoundOption: 'round — one round of a match',
  fieldFormat: 'Format',
  fieldBody: 'Template body',

  // actions row (destructive left, positive actions right)
  saving: 'Saving…',
  saved: 'Saved',
  saveTemplate: 'Save template',
  saveNoteDefault: 'Saving stores this as your own template.',

  // preview
  previewHeading: 'Preview',
  preview: 'Preview',
  running: 'Rendering…',
  targetHeading: 'Preview target',
  roundPlaceholder: 'Enter round 1..{max}', // the round box's hint, naming its counted range
  roundPlaceholderNone: 'Enter round',
  matchLabel: 'Match',
  playerLabel: 'Player',
  roundLabel: 'Round',
  targetNeeded: 'Pick a target to preview — nothing is chosen for you.',
  noPreviewYet: 'Nothing previewed yet — press Preview to render the draft.',
};
