// strings/match.js — Match view chrome (views/Match.svelte): header meta
// line, import-warnings panel, tab bar + rosters, scoreboard, Rounds-tab
// table and the Details key-facts list.
// Values are plain strings with {arg} placeholders (the catalog contract,
// strings/index.js); the view composes them with S.fill at the call site.
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const match = {
  // header + meta line (watch action, patch/status, chat-key badge)
  dismissError: 'Dismiss error',
  replayReturnTitle: 'Return to the replay (resumes where you left it)',
  replayWatchTitle: 'Watch this match in the replay view',
  watchReplay: 'Watch replay',
  patchLabel: '· patch',
  encryptedChatTitle: 'Encrypted chat present — needs the matching .dem.info file to read it',

  // import-warnings panel
  importWarnings: 'Import warnings',
  dismissWarnings: 'Dismiss warnings',
  warningsNone: 'None — this demo imported cleanly.',
  // Cap line under a long warnings list: {n} is the honest remainder
  // (total − shown), so a capped list never silently truncates.
  warningsMore: 'and {n} more',

  // tab bar + Overview rosters
  matchSectionsAria: 'Match sections',
  followReplayTitle: 'Open the replay following {name}',
  openProfile: 'Open {name} profile',
  rosterSuffix: 'roster',
  colPlayer: 'Player',
  colAdr: 'ADR',
  rosterOther: 'Other',


  // Column heads shared beyond this view: RoundDetail's weapon table +
  // kill list and the Rounds tab's kill count.
  colWeapon: 'Weapon',
  colKills: 'Kills',

  // Rounds tab
  compareSelectTitle: 'Select rounds to compare (up to 4)',
  colCmp: 'Cmp',
  colWinner: 'Winner',
  buyClassTitle:
    'Buy type per side (pistol/anti-eco/eco/force/full/bonus/save) with the rule text and rules version — hover a chip',
  colClass: 'Class',
  colReason: 'Reason',
  colDuration: 'Duration',
  colSite: 'Site',
  colMvp: 'MVP',
  firstBloodLabel: 'First blood',
  compareRoundAria: 'Compare round {round}',
  // Per-side buy-class chip (RoundDetail's Economy card — the Rounds
  // tab's Class column left with the watch column, W3a): the why text +
  // rules version only — round-level confidence never rides a side chip,
  // and the tooltip never promises a click (those chips are not buttons;
  // Economy.chipTitle is the click-for-full-text one).
  sideClassTitle: '{why} (rules v{rule})',
  sideCt: 'CT',
  sideT: 'T',
  killedVerb: 'killed',
  roundsSelected: '{n} of 4 rounds selected.',
  compareBtn: 'Compare {n} rounds',

  // Details tab — key facts
  keyFacts: 'Key facts',
  factServer: 'Server',
  factTickrate: 'Tickrate',
  factFrames: 'Frames',
  factSize: 'Size',
  factImported: 'Imported',
  factParser: 'Parser',
  factVoice: 'Voice',
  voiceRecordedTitle: 'Voice recorded for {n} players — Opus, played back live',
  voiceRecordedBadge: '{n} players · voice recorded',
  voiceNoneTitle: 'This demo source does not record voice (e.g. Valve MM) — normal, not broken',
  voiceNoneBadge: 'no voice',
  factWarnings: 'Warnings',
  factSource: 'Source',
  factDemoCopy: 'Demo copy',
  copyPrefix: 'copy ·',
  freeCopyTitle: 'Free the disk space Spectra’s copy uses — your original file is not touched',
  freeing: 'Freeing…',
  freeCopy: 'Free copy',
  copyExternal: 'no copy — using your file',
  copyMissing: 'file not found',

  // RoundDetail (views/RoundDetail.svelte — shares this area file)
  backBtn: 'Back',
  watchRoundTitle: 'Watch round {round} from its start in the replay',
  watchRoundAria: 'Watch round {round}',
  knifeRoundTitle: 'pre-match knife round — not counted play',
  warmupRoundTitle: 'warmup round — not counted play',
  roundWord: 'round',
  roundLabel: 'Round',
  siteMeta: '· site',
  mvpMeta: '· MVP',
  retryBtn: 'Retry',
  roundInfoHeading: 'Round info',
  scoreLabel: 'Resulting score',
  scoreCountedTitle: 'Counted-round wins through this round',
  noKills: 'No kills this round.',
  colTime: 'Time',
  colKiller: 'Killer',
  colVictim: 'Victim',
  colFlags: 'Flags',
  colWatch: 'Watch',
  tickTitle: 'tick {n}',
  watchKillIdle: 'Watch from this kill in the replay',
  bombHeading: 'Bomb',
  noBombEvents: 'No bomb events this round.',
  colEvent: 'Event',
  economyHeading: 'Economy',
  colSide: 'Side',
  colEquip: 'Equip',
  colMoney: 'Money',
  noEconomySamples: 'No economy samples.',
  roundChatHeading: 'Round chat',
  noChat: 'No chat this round.',
  prevRoundLabel: 'Previous round',
  nextRoundLabel: 'Next round',

  // Builtin Match panels (matchpanels.js, ruling 46): the panel names the
  // builtin list shows, the overview's identity cards, the rosters, the
  // scoreboard's column heads and the rounds table's round column.
  panelOverviewLabel: 'Match overview cards',
  panelRostersLabel: 'Match rosters',
  panelScoreboardLabel: 'Match scoreboard',
  panelRoundsLabel: 'Match rounds',
  panelDetailsLabel: 'Match details',
  cardTopFragger: 'Top fragger',
  cardBestAdr: 'Best ADR',
  cardMostUtil: 'Most util',
  cardEntryOpens: 'Entry opens',
  cardMostMvps: 'Most MVPs',
  rosterKdaHead: 'K/D/A',
  colName: 'Name',
  colTeam: 'Team',
  colScore: 'Score',
  colRd: 'RD',
  scoreK: 'K',
  scoreD: 'D',
  scoreDmg: 'DMG',
  scoreUtil: 'Util',
  scoreMvps: 'MVPs',
  scoreA: 'A',
  scoreKast: 'KAST%',
  scoreHs: 'HS%',
  scoreKd: 'K/D',
  scoreKda: 'KDA',
  score2k: '2K',
  score3k: '3K',
  score4k: '4K',
  score5k: '5K',
  scoreOpenK: 'Open K',
  scoreOpenD: 'Open D',
  scoreTrade: 'Trade',
  scoreStreak: 'Streak',
  unitHz: ' Hz',
};
