// strings/componentbuilder.js — the Component builder view
// (views/ComponentBuilder.svelte): the list of built-in and yours, the
// source editor, the live preview and its save, duplicate and delete
// actions. {name} = a component name, {n} = a copy number, {line} /
// {err} = a source refusal (components.sourceAtLine).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const componentbuilder = {
  heading: 'Component builder',
  headNote: 'Write a component, check it, and preview it on a match or player.',
  componentsHeading: 'Components',
  builtinGroup: 'Built-in',
  yoursGroup: 'Yours',
  builtinChip: 'built-in',
  placeholderChip: 'example',
  placeholderTitle: 'A small example to copy from.',
  placeholderName: 'Example: recent rounds',
  noUserComponents: 'None yet. Write one with New.',
  loadingList: 'Loading…',
  newLabel: 'New',
  newComponent: 'New component',
  editComponent: 'Edit component',
  fieldName: 'Name',
  namePlaceholder: 'Name your component…',
  fieldSource: 'Source',
  // Live check states, shown under the source.
  checking: 'Checking…',
  checkOk: 'Ready to save.',
  // Save is refused while the source has a problem.
  saveBlockedTitle: 'Fix the problem in the source to save.',
  builtinReadOnly: 'This is the built-in version. Your edits replace it wherever it appears.',
  // Editing a built-in in place (owner ruling 43): the edited source is kept
  // as the built-in's override; restore brings the shipped source back.
  editedChip: 'edited',
  editedTitle: 'You have edited this built-in. Its shipped version is under the edit.',
  restoreDefault: 'Restore to default',
  restoreTitle: 'Discard your edit and use the shipped version',
  // Use as my view (owner ruling 43): a surface renders the placed component.
  viewsHeading: 'Use as my view',
  viewsNeedSave: 'Save the component to use it as a view.',
  surfaceMatch: 'Match view',
  surfaceProfile: 'Profile view',
  viewDefault: 'Shows the default',
  viewUsingThis: 'Shows this component',
  viewUsingOther: 'Shows another component',
  useAsView: 'Use as my view',
  resetView: 'Reset to default',
  viewBusy: 'Working…',
  saveComponent: 'Save',
  cancelCompile: 'Cancel',
  cancelCompileTitle: 'Stop the check. Nothing is saved.',
  saving: 'Saving…',
  saved: 'Saved',
  duplicate: 'Duplicate',
  duplicateTitle: 'Save a copy as yours and open it',
  copyName: '{name} copy',
  copyNameN: '{name} copy {n}',
  deleteComponent: 'Delete',
  deleteAria: 'Delete {name}',
  retry: 'Try again',
  dismissError: 'Dismiss',
  // Preview.
  previewHeading: 'Preview',
  contextLabel: 'Preview with',
  contextMatch: 'A match',
  contextPlayer: 'A player',
  matchLabel: 'Match',
  playerLabel: 'Player',
  noPreviewYet: 'The preview appears once the source checks out.',
  // The names of the compiled built-in components in the list, keyed by
  // builtin id (every id in the registry, builtins/panels.js, has one:
  // componentbuiltins.test.js pins it).
  builtinNames: {
    'builtin-profile-view': 'Profile view',
    'builtin-profile-career': 'Career',
    'builtin-profile-trend': 'Trend',
    'builtin-profile-sides': 'Sides',
    'builtin-profile-maps': 'Maps',
    'builtin-profile-weapons': 'Weapons',
    'builtin-profile-history': 'History',
    'builtin-reports': 'Reports view',
    'builtin-reports-templates': 'Report templates',
    'builtin-reports-appendix': 'Stats appendix',
    'builtin-explorer': 'Explorer view',
    'builtin-explorer-provenance': 'Explorer provenance',
    'builtin-explorer-diagnostics': 'Explorer diagnostics',
    'builtin-explorer-reference': 'Explorer reference',
    'builtin-match-tabs': 'Match tabs',
    'builtin-match-heatmaps': 'Match heatmaps',
    'builtin-match-heatmap': 'Heatmap',
    'builtin-match-combat': 'Match combat',
    'builtin-match-combat-engagements': 'Kill tags',
    'builtin-match-combat-clutches': 'Clutches',
  },
};
