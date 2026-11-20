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
  noUserComponents: 'None yet. Duplicate a built-in to start one.',
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
  builtinReadOnly: 'Built-in components are read-only. Duplicate one to edit your own copy.',
  saveComponent: 'Save',
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
};
