// strings/library.js — match library + Explorer (demo-file diagnostics)
// chrome. Extracted from views/Library.svelte and views/Explorer.svelte
// (Strings Stage 3, Sweep-B); values are plain strings with {arg}
// placeholders — compose at the call site with S.fill(...).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const library = {
  // Explorer — the standalone demo-file diagnostics surface
  explorerTitle: 'Explorer',
  explorerSubtitle: 'Diagnostics for this demo file.',
  retry: 'Retry',
  noMatches: 'No matches',
  noMatchesHint: 'Import a demo in the Library first.',
  importDetails: 'Import details',
  dtParserVersion: 'Parser version',
  dtImported: 'Imported',
  dtParseTime: 'Parse time',
  notAnalyzed: 'not analyzed',
  dtVoiceSampleRate: 'Voice sample rate',
  dtVoiceChunks: 'Voice chunks',
  dtWarnings: 'Warnings',
  dtStatus: 'Status',
  noteChipTitle: 'Note',
  advancedDiagnostics: 'Advanced diagnostics',
  dtEntityTypes: 'Entity types',
  dtEntitiesAtEnd: 'Entities at end',
  dtGenericEventTypes: 'Generic event types',
  dtGenericEventsTotal: 'Generic events total',
  networkMessages: 'Network messages',
  protobufTypes: ' protobuf network-message types exist in CS2;',
  goldenDemoShare: ' of them fire in the golden demo (1,965,413 messages total).',
  encPresentPrefix: 'Encrypted messages present (',
  encChip: 'enc',
  encKeyStatus: ' key status is listed under Import details\n            notes above; content is never stored or shown.',
  encNone: 'No encrypted network messages recorded for this match.',
};
