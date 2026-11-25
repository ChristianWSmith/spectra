// strings/settings.js — Settings view chrome (views/Settings.svelte): About,
// Data, Import dirs, Background work, CS2 assets, Appearance, Plugins, Audio
// & voice, Replay and Analysis rules panels.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// The ten <h2> panel headings and the pinned loading-chip copy stay
// inline (source-pinned by docslockstep.test.js's panel census and
// progress-presentation.dom.mjs).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const settings = {
  // header + About
  settingsHeading: 'Settings',
  dismissAria: 'Dismiss',
  spectraName: 'Spectra',
  aboutTagline: '— an offline CS2 demo viewer and match analysis toolkit.',
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
    'Spectra keeps a copy of each imported demo so Re-parse works after your original moves or disappears. Freeing copies reclaims space — matches keep their data, but Re-parse needs the original.',
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
    'files found in these import dirs and imports them with one click — originals are never moved, modified or deleted. Subfolders are scanned four levels deep; demos already in the Library are left out.',
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
    'On (the default): every import keeps its own copy, so Re-parse works\n        after your original moves or is deleted. Off: nothing is duplicated —\n        Re-parse then needs that file to still exist.',

  // Background work panel
  backgroundWorkNote:
    'Heavy background tasks — demo imports, rules re-runs and asset extraction — share one\n      budget of parallel work on this machine, so they never stack on top of each other.',
  parallelWorkLabel: 'Parallel work',
  parallelWorkHint:
    'How many heavy background tasks run at once: 1 = one at a time; default and maximum = this machine’s parallelism ({max}), so Spectra never runs more at once than your hardware can handle.',

  // CS2 assets panel
  cs2AssetsNote:
    'Radar images, map geometry, icons and replay sounds are all\n      read from your own Counter-Strike 2 installation on this machine —\n      nothing is uploaded, and no Valve assets ship with the app.',
  factCs2Install: 'CS2 install',
  notFound: 'not found',
  manualChip: 'manual',
  factRadarPacks: 'Radar packs',
  factEquipmentIcons: 'Equipment',
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
  pluginsNoteLead: 'Declarative bundles: a single',
  pluginManifestName: 'spectra-plugin.json',
  pluginsNoteTail:
    'with your metrics and report\n      templates inlined. Enabled plugins contribute metrics and report\n      templates on the next list — no restart.',
  pluginPathAria: 'Plugin source path',
  browsePlugin: 'Browse…',
  choosePluginFileTitle: 'Choose the spectra-plugin.json file to install',
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
  removePluginLabel: 'Remove plugin',
  removePluginTitle: 'Remove this plugin and its bundle from disk',
  trustModelNote:
    'Trust model: install only bundles you built or got from someone you\n      trust — manifests may pin a sha256 hash; there is no auto-update.',

  // Build plugin… (the w23 dialog): the name/version line over the two
  // TokenSelect chip inputs (user-origin report templates + metrics
  // only), then the native save of the composed single-file manifest.
  buildPlugin: 'Build plugin…',
  buildDialogTitle: 'Build a plugin to share',
  buildPluginNote: 'Bundle your own metrics and report templates into one file to share.',
  buildNameLabel: 'Name',
  buildNamePlaceholder: 'Name this plugin…',
  buildVersionLabel: 'Version',
  buildTplsLabel: 'Report templates',
  buildTplsAria: 'Report templates to bundle',
  buildTplsPlaceholder: 'Search report templates…',
  buildMetricsLabel: 'Metrics',
  buildMetricsAria: 'Metrics to bundle',
  buildMetricsPlaceholder: 'Search metrics…',
  buildNoTpls: 'No report templates of your own yet.',
  buildNoMetrics: 'No custom metrics of your own yet.',
  buildComponentsLabel: 'Components',
  buildComponentsAria: 'Components to bundle',
  buildComponentsPlaceholder: 'Search components…',
  buildNoComponents: 'No components of your own yet.',
  buildSave: 'Save plugin',
  buildSaving: 'Saving…',
  buildSaved: 'Saved {name} to {path}',

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

  // Replay panel — the loop-length setting (the `loop_secs` pref): the
  // ONE knob behind the loop popover's quick-range button and every
  // event-level ▶ link in the analysis views.
  loopSecsLabel: 'Loop length (seconds)',
  loopSecsHint:
    'How many seconds a loop spans around the playhead or an event: 1–60, default 5. The loop popover’s quick-range button and every event ▶ link use it.',

  // Analysis rules panel
  tradeWindowLabel: 'Trade window (seconds)',
  tradeWindowHint: 'Kill after a teammate death within this window = trade (default 5).',
  fullBuyLabel: 'Full-buy threshold (equip $)',
  fullBuyHint: 'Team equipment ≥ this = full buy (default 20000).',
  tradeOppTitle:
    'A death is a missed trade opportunity only if a living teammate of the victim was within this distance of the killer at the death tick. Measured at import; saving recomputes analyzed matches.',
  tradeOppLabel: 'Trade-opportunity distance (units)',
  tradeOppHint:
    '“Missed trades” counts a death nobody answered only when a living teammate of the victim was within this distance of the killer (default 1000).',
  forceLabel: 'Force threshold (equip $)',
  forceHint: 'Team equipment ≥ this = force buy (default 10000).',
  saveRules: 'Save rules',
  noChanges: 'No changes — the rules above are already saved.',
  saveNoChanges: 'No changes — the rules were already saved with these values.',
  saveRecomputing: 'Saved — matches behind the new rules recompute in the background.',
};
