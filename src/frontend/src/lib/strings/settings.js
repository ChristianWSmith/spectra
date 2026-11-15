// strings/settings.js — Settings view chrome (views/Settings.svelte): About,
// Data, Import dirs, Background work, CS2 assets, Appearance, Plugins, Audio
// & voice and Analysis rules panels.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// The nine <h2> panel headings and the pinned loading-chip copy stay
// inline (source-pinned by docslockstep.test.js's panel census and
// progress-presentation.dom.mjs).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const settings = {
  // header + About
  settingsHeading: 'Settings',
  dismissAria: 'Dismiss',
  spectraName: 'Spectra',
  aboutTagline:
    '— an offline CS2 demo\n      viewer and match analysis toolkit. Everything runs on your machine;\n      nothing is uploaded anywhere.',
  updateCheckHint:
    'Checks GitHub Releases for a newer version and offers to install it\n        when one exists (it also tells you when you\'re already up to date).',
  checking: 'Checking…',
  checkForUpdates: 'Check for Updates…',

  // Data panel
  factDatabase: 'Database',
  factMatchesDir: 'Matches directory',
  factDemoCopies: 'Demo copies',
  factParserVersion: 'Parser version',
  demoCopyHint:
    'Spectra keeps its own copy of each imported demo so Re-parse works after your\n          original file moves or disappears. Freeing them reclaims the space — matches keep\n          everything they saved and replay instantly; Re-parse then needs your original\n          file.',
  freeCopiesBusyTitle: 'An import is still running — try again once it finishes',
  freeCopiesEmptyTitle: 'No demo copies to free',
  freeCopiesTitle: 'Delete every demo copy from Spectra’s data folder',
  freeing: 'Freeing…',
  freeAllCopies: 'Free all demo copies',

  // Import dirs panel
  libraryListsLead: 'The Library lists',
  extDem: '.dem',
  extDemZst: '.dem.zst',
  importDirsNote:
    'files found in these import dirs and imports\n      them with one click — your original files are never moved, modified or deleted.\n      Subfolders are scanned up to four levels deep; hidden folders are skipped.\n      Demos already in the Library are left out of the list.',
  noImportDirs: 'No import dirs — the Library won’t offer any demos to import.',
  remove: 'Remove',
  retry: 'Retry',
  defaultsCustom: 'Saved as your list — the defaults no longer apply.',
  defaultsEffect:
    'Defaults in effect: your Downloads folder and the CS2 replay folder, where the client saves downloaded matches.',
  addFolder: 'Add folder…',
  resetDefaults: 'Reset to defaults',
  copyOnImportLabel: 'Copy demos into Spectra’s data folder',
  copyOnImportHint:
    'On (the default): every import keeps its own copy of the demo, so Re-parse works\n        even after your original file is moved or deleted. Off: imports only reference your\n        original file — nothing is duplicated, and Re-parse needs that file to still exist.\n        Stored copies stay evictable either way (Data below, or Free copy in the Library).',

  // Background work panel
  backgroundWorkNote:
    'Heavy background tasks — demo imports, rules re-runs and asset extraction — share one\n      budget of parallel work on this machine, so they never stack on top of each other.',
  parallelWorkLabel: 'Parallel work',
  parallelWorkHint:
    'How many heavy background tasks — demo imports, rules re-runs and asset extraction —\n        run at the same time. 1 = one at a time; the default and the maximum are this\n        machine’s parallelism ({max}), so Spectra never runs more at once than your\n        hardware can handle. A change applies to work already queued or waiting.',

  // CS2 assets panel
  cs2AssetsNote:
    'Radar images, equipment icons and replay sounds are all read from your\n      own Counter-Strike 2 installation on this machine — nothing is\n      uploaded, and no Valve assets ship with the app.',
  factCs2Install: 'CS2 install',
  notFound: 'not found',
  manualChip: 'manual',
  factRadarPacks: 'Radar packs',
  factEquipmentIcons: 'Equipment icons',
  factReplaySounds: 'Replay sounds',
  noneExtractedYet: 'none extracted yet',
  extractHint:
    'Extracts every official-map radar, every equipment icon and the\n        replay\'s gun/utility sounds (safe to run again — re-run after a CS2\n        update to refresh).',
  chooseFolder: 'Choose folder…',

  // Appearance panel
  themeHint:
    'Theme — dark ships as the default. The choice is remembered and\n        applied at startup.',
  themeAria: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light',
  fontSizeHint:
    'Font size — scales the whole UI (13 / 15 / 17 px); applied instantly\n        and remembered across restarts. Medium is the default.',
  fontSizeAria: 'Font size',

  // Plugins panel
  pluginsNoteLead: 'Declarative bundles: a directory with',
  pluginManifestName: 'spectra-plugin.json',
  pluginsNoteTail:
    '(plus optional metric /\n      report-template definitions) or a single manifest JSON. Enabled plugins\n      contribute metrics and report templates on the next list — no restart.',
  pluginPathPlaceholder: '/path/to/plugin-dir or manifest.json',
  pluginPathAria: 'Plugin source path',
  installing: 'Installing…',
  installFromPath: 'Install from path',
  noPluginsYet: 'No plugins installed yet.',
  metricsContributedTitle: 'Metrics contributed',
  metricsWord: 'metrics',
  reportTplsContributedTitle: 'Report templates contributed',
  templatesWord: 'templates',
  invalid: 'invalid',
  disablePlugin: 'Disable plugin',
  enablePlugin: 'Enable plugin',
  enabled: 'Enabled',
  disabled: 'Disabled',
  failed: 'failed',
  trustModelNote:
    'Trust model: install only bundles you built or got from someone you\n      trust — manifests may pin a sha256 hash; there is no auto-update.',

  // Audio & voice panel
  audioSelfTestHint: 'Audio self-test — checks Spectra can open your audio device.',
  audioPass: 'PASS — audio device open at',
  audioFail: 'FAIL —',
  audioHintLead: 'Hint: on Linux install',
  gstPluginsGood: 'gst-plugins-good',
  audioHintTail: '(GStreamer) so WebKitGTK can open the audio device, then retry.',
  volVoiceHint: "Voice volume — the players' radio chatter in the replay.",
  volVoiceAria: 'Voice volume',
  volGunsHint: 'Guns volume — weapon fire in the replay.',
  volGunsAria: 'Guns volume',
  volUtilityHint: 'Utility volume — grenade detonations in the replay.',
  volUtilityAria: 'Utility volume',
  volC4Hint: "C4 volume — the planted bomb's beeps and its explosion.",
  volC4Aria: 'C4 volume',
  volAnnouncerHint: 'Announcer volume — the round-win / bomb voice lines in the\n        replay.',
  volAnnouncerAria: 'Announcer volume',
  volFootstepsHint:
    'Footsteps volume — player footsteps and landings in the replay\n        (80 % by default — muted until you unmute in the replay volume\n        popover).',
  volFootstepsAria: 'Footsteps volume',
  soundEffectsNote:
    'Sound effects are extracted from your local CS2 install (CS2 assets\n      above); the replay plays gun, utility, C4, announcer and footstep\n      sounds when they are available.',
  voiceDecodeNote:
    'Voice is decoded as the replay plays and streamed in small pieces — no\n      extra disk space, always in sync with the replay.',
  voiceToTextNote: "Voice-to-text transcription isn't available yet.",

  // Analysis rules panel
  tradeWindowLabel: 'Trade window (seconds)',
  tradeWindowHint: 'Kill after a teammate death within this window = trade (default 5).',
  fullBuyLabel: 'Full-buy threshold (equip $)',
  fullBuyHint: 'Team equipment ≥ this = full buy (default 20000).',
  tradeOppTitle:
    'A death counts as a missed trade opportunity only if a living teammate of the victim was within this distance of the killer at the death tick — someone close enough to actually trade him. The raw distance is measured for each kill when the demo is imported; this setting is applied when matches are analyzed — saving recomputes the matches already in your library in the background. Deaths with no nearby teammate or no position data never count.',
  tradeOppLabel: 'Trade-opportunity distance (units)',
  tradeOppHint:
    '“Missed trades” counts a death nobody answered only when a living teammate of the victim was within this distance of the killer (default 1000).',
  forceLabel: 'Force threshold (equip $)',
  forceHint: 'Team equipment ≥ this = force buy (default 10000).',
  saveRules: 'Save rules',
  noChanges: 'No changes — the rules above are already saved.',
  saveNoChanges: 'No changes — the rules were already saved with these values.',
  saveRecomputing:
    'Saved. Matches behind the new rules are recomputing in the background — their numbers refresh as each match finishes.',
};
