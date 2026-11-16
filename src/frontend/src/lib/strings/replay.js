// strings/replay.js — Replay view chrome (views/Replay.svelte): top bar,
// stage, transport, camera/UI/drops/volume popovers, mini dock, event feed
// and the detail pane.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// The four StatusChip detail literals and the feed busy ternary stay
// inline (source-pinned by progress-presentation.dom.mjs).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const replay = {
  // top bar
  closeLabel: 'Close',
  minimizeLabel: 'Minimize',
  theaterModeAria: 'Theater mode',
  theaterModeTitle: 'Theater mode — hide the top bar and controls',
  eventsCountAria: 'Events ({n} events)',

  // no-sidecar empty state + frame-mismatch note
  noReplayData: 'No replay data for this match',
  noSidecarNote:
    'This match was imported without position data — run Re-parse on it in\n          the Library, then come back.',
  goToLibrary: 'Go to Library',
  frameMismatchLead: 'frame count mismatch: stream has',
  frameMismatchMid: ', meta says',

  // stage
  canvasAria: 'Replay canvas',
  exitTheaterLabel: 'Exit theater mode',
  followingRow: 'Following {name}',

  // transport
  transportAria: 'Replay transport',
  frameAria: 'Frame',
  readoutTitle: 'frame {frame}/{frames} · tick {tick}',
  prevRoundLabel: 'Previous round',
  seekBackLabel: 'Seek −15 seconds',
  pause: 'Pause',
  play: 'Play',
  pauseSpace: 'Pause (Space)',
  playSpace: 'Play (Space)',
  seekFwdLabel: 'Seek +15 seconds',
  nextRoundLabel: 'Next round',
  speedTriggerTitle: 'Playback speed (, / .)',
  speedAria: 'Playback speed',
  skipFreezeAria: 'Skip freeze time',
  skipFreezeTitle: 'Skip freeze time — auto-jump the pre-round freeze during playback (X)',
  loopRangeAria: 'Loop range',
  loopRangeTitle: 'Loop range (L) — set the from/to times and toggle the loop',
  loopStartTime: 'Loop start time',
  loopStartPlaceholder: 'start',
  loopStopTime: 'Loop stop time',
  loopStopPlaceholder: 'stop',
  toggleLoopTitle: 'Toggle loop (L)',
  loopBtnLabel: 'Loop',
  // The quick-range button: label + tooltip read the SAME `loop_secs`
  // pref the Settings control writes (S.fill at the call site), so the
  // button can never advertise a width it does not arm.
  loop10Label: '±{n} s',
  loop10Title: 'Loop ±{n} s around the playhead',

  // camera / follow / UI overlays / drop markers
  cameraHelpTitle:
    'Smart keeps every player and the bomb on screen — drag or wheel takes over → Free; Free is manual; Follow locks onto a player (1-9, F toggles) — dragging releases.',
  cameraModeAria: 'Camera mode',
  followPlayerAria: 'Follow player',
  followPlayerTitle:
    'The player the camera follows — 1-9, 0 picks one, F toggles follow, dragging releases',
  uiOverlaysAria: 'UI overlays',
  uiOverlaysTitle:
    'Show/hide individual overlays — score/timer, kill feed, chat and stage indicators (never hides the theater-exit button)',
  overlayScoreTitle: 'Show the team score and round clock',
  overlayScore: 'Score/timer',
  overlayFeedTitle: 'Show the kill feed',
  overlayFeed: 'Kill feed',
  overlayChatTitle: 'Show the in-game chat',
  overlayChat: 'Chat',
  overlayStageTitle: "Show the stage's status rows (following, loop, map-pack note)",
  overlayStage: 'Stage indicators',
  dropMarkersAria: 'Drop markers',
  dropMarkersTitle: 'Show dropped guns, utility and defuse kits on the map (off by default)',
  dropsLabel: 'Drops',

  // volume popover
  volumeAria: 'Volume',
  volumeTitle: 'Volume — voice, guns, utility, C4, announcer and footsteps',
  volVoiceLabel: 'Voice',
  volVoiceAria: 'Voice volume',
  muteVoice: 'Mute voice',
  unmuteVoice: 'Unmute voice',
  volGunsLabel: 'Guns',
  volGunsAria: 'Guns volume',
  muteGuns: 'Mute guns',
  unmuteGuns: 'Unmute guns',
  volUtilityLabel: 'Utility',
  volUtilityAria: 'Utility volume',
  muteUtility: 'Mute utility',
  unmuteUtility: 'Unmute utility',
  volC4Aria: 'C4 volume',
  muteC4Aria: 'Mute c4',
  muteC4: 'Mute C4',
  unmuteC4: 'Unmute C4',
  volAnnouncerLabel: 'Announcer',
  volAnnouncerAria: 'Announcer volume',
  muteAnnouncer: 'Mute announcer',
  unmuteAnnouncer: 'Unmute announcer',
  volFootstepsLabel: 'Footsteps',
  volFootstepsAria: 'Footsteps volume',
  muteFootsteps: 'Mute footsteps',
  unmuteFootsteps: 'Unmute footsteps',

  // voice device error hint
  voiceErrLead: '— install',
  gstPluginsGood: 'gst-plugins-good',
  voiceErrTail: '(GStreamer) if audio fails to start.',

  // snapshot + clip
  snapshotAria: 'Snapshot',
  snapshotTitle: 'Save a PNG snapshot of the current frame (S)',
  dismissSnapshotErrorAria: 'Dismiss snapshot error',
  dismissLabel: 'Dismiss',
  stopClip: 'Stop clip',
  recordClip: 'Record clip',
  recordClipTitle:
    'Record a WebM clip — loop range if set, else 10s from the playhead (video only)',
  encodingState: 'encoding…',

  // mini dock
  playheadTitle: 'Playhead',
  clickToExpand: 'Click to expand',

  // event feed — toolbar + filters
  eventFeedAria: 'Event feed',
  eventsHeading: 'Events',
  feedControlsAria: 'Feed controls',
  filtersToggleTitle: 'Show/hide the category dropdown and every filter control',
  filtersLabel: 'Filters',
  exportFeedAria: 'Export the loaded feed',
  exportFeedTitle: 'Export the loaded feed — CSV or JSON',
  exportCsvLabel: 'CSV',
  exportJsonLabel: 'JSON',
  categoriesTitle: 'Choose which event categories the feed shows',
  categoriesLabel: 'Categories',
  eventCategoriesAria: 'Event categories',
  savedPresetsAria: 'Saved filter presets',
  savedFiltersAria: 'Saved filters',
  savedFiltersOption: 'Saved filters…',
  applyBtn: 'Apply',
  saveFilterTitle: 'Save the current filter as a preset',
  saveBtn: 'Save',
  deleteFilterTitle: 'Delete the selected saved filter',
  resetFiltersTitle: 'Reset every filter to the sparse default',
  resetBtn: 'Reset',
  eventsListAria: 'Events',
  noCategoriesEnabled: 'No categories enabled — turn some on in Filters.',
  noEventsMatch: 'No events match these filters.',

  // detail pane
  selectedEventAria: 'Selected event',
  tickLabel: 'tick {tick}',
  hearVoiceTitle: 'Open playback at this event with voice on — hear comms around it as it loops',
  hearBtn: 'Hear around the event',
  closeDetailAria: 'Close detail',
  closeDetailTitle: 'Close detail — back to the list',
  factAttacker: 'Attacker',
  openProfile: 'Open {name} profile',
  factVictim: 'Victim',
  factAssister: 'Assister',
  factWeapon: 'Weapon',
  factDamage: 'Damage',
  factDistance: 'Distance',
  factHitgroup: 'Hitgroup',
  factSite: 'Site',
  factFlags: 'Flags',
  detailJsonSummary: 'detail.json',
  rawJsonSummary: 'raw.json',
  copied: 'Copied',
  copyPayloads: 'Copy payloads',
  factTime: 'Time',
  factFrom: 'From',
  factKind: 'Kind',
  decryptedSuffix: ' · decrypted',
  factEvent: 'Event',
  factTick: 'Tick',
  factRound: 'Round',
  factPlayer: 'Player',
  factDetail: 'Detail',
  filterKeysPlaceholder: 'Filter keys…',
  filterPayloadKeysAria: 'Filter payload keys',
  toggleRawJsonTitle: 'Toggle raw JSON',
  copyLabel: 'Copy',
  seekToEvent: 'Watch this event',
};
