# CS2 knowledge cache

Facts about *Counter-Strike 2* — demo formats, game mechanics, official
rules, console variables, event names, community tools — that agents
discovered by web research. Check this file **before** searching the web;
if the answer is here, use it (and verify it still looks current). If it
isn't here, search the web and **append the finding** below so the next
agent doesn't have to.

This file holds domain knowledge only. Repo-specific facts belong in
`AGENTS.md`, product scope in `ref/`.

## Format

Each entry:

- **Question / topic** — what was asked, in a searchable phrase.
- **Answer** — the distilled fact(s), kept short.
- **Source** — URL(s) + approximate retrieval date, so staleness can be
  judged and facts re-verified.

Entries in alphabetical order by topic where practical; otherwise append
at the end of the section.

## Entries

- **Radar/overview assets in a CS2 install** — where radar images and
  transform constants live for extraction. Inside
  `game/csgo/pak01_dir.vpk`: radar textures at
  `panorama/images/overheadmaps/<map>_radar_psd.vtex_c` (plus
  `<map>_lower_radar_psd.vtex_c` for two-level maps: nuke, train,
  vertigo; `_night`/`_v1` variants for ancient etc.; 46 entries total
  in the 2026-06 build). Transform constants + spawn/site fractions in
  plain-text `resource/overviews/<map>.txt` (23 entries; keys:
  `pos_x`, `pos_y`, `scale`, `rotate`, `CTSpawn_x/y`, `TSpawn_x/y`,
  `bombA_x/y`, `bombB_x/y`, `inset_*`) — present for all official
  maps, and matches the values already checked into
  `frontend/public/maps/de_mirage/meta.json`.
  **Source** — local probe of pak01_dir.vpk (2026-11-01); CSDM maps
  guide https://cs-demo-manager.com/docs/guides/maps (2026-11-01).

- **Source 2 VPK v2 format (CS2)** — reading `pak01_dir.vpk` in code.
  Header: magic `0x55aa1234` (not Source 1's `VPKC`), version 2,
  treeSize u32, fileData/archiveMD5/otherMD5/sig sizes. Tree = nested
  NUL-terminated strings (ext → path → filename), each entry 18 bytes:
  crc32 u32, preloadBytes u16, archiveIndex u16, offset u32, length u32,
  terminator u16=0xFFFF. **No Source 1 custom-attribute strings** —
  consuming them desyncs the parse. archiveIndex 0x7fff = data embedded
  in dir file; otherwise `pak01_%03d.vpk` at `offset`. A Go tree parser
  handled all 137,844 CS2 entries.
  **Source** — https://developer.valvesoftware.com/wiki/VPK_(file_format)
  + local probe (2026-11-01).

- **Source 2 vtex_c resource → PNG decode** — full pipeline, verified
  end-to-end (de_mirage radar decodes to a correct 1024×1024 PNG in
  pure Go, no C deps). (1) Resource header: FileSize u32 (structured
  size only — streaming pixel data follows it), HeaderVersion u16=12,
  Version u16, BlockOffset u32, BlockCount u32; block index at
  8+BlockOffset, entries of 12 bytes: FourCC, relative offset (from
  position after the FourCC field), size. (2) DATA block texture
  header (VRF Texture.Read): version u16=1, flags u16, reflectivity
  4×f32, width/height/depth u16, format u8, numMips u8, picmip0 u32,
  extraDataOffset u32, extraDataCount u32; entries at
  40+(extraDataOffset-8), each type u32/offset u32/size u32. (3) CS2
  radars: format 28 = BGRA8888 (**not** BC7), 1024×1024, 1 mip, mip
  LZ4-compressed (extra type 4 = COMPRESSED_MIP_SIZE, method 1 = LZ4;
  method 2 = Zstd). LZ4 block decompress of the streaming section →
  BGRA swizzle → image/png.
  **Source** — https://s2v.app/ValveResourceFormat/guides/read-resource.html
  and VRF `Texture.cs` / `VTexFormat.cs` / `VTexExtraData.cs`
  (github.com/ValveResourceFormat/ValveResourceFormat, 2026-11-01).

- **Steam CS2 install detection** — locating the user's CS2 without
  config. `steamapps/appmanifest_730.acf` (appid 730) has
  `installdir "Counter-Strike Global Offensive"` (CS2 keeps the CS:GO
  folder name); `steamapps/libraryfolders.vdf` lists all library roots
  (multi-drive installs) — parse both for `steamapps/common/<installdir>/game/csgo/pak01_dir.vpk`.
  **Source** — local probe of `~/.steam/steam/steamapps/` (2026-11-01).
- **Eye angles (`m_angEyeAngles`)** — `[pitch, yaw, roll]`; demoinfocs v6:
  `Player.ViewDirectionX()` = **yaw**, 0..360 (reads `.Y` of the prop);
  `Player.ViewDirectionY()` = **pitch**, 270..90 where 270 = −90 (reads
  `.X`). Feeding pitch into a yaw field renders facing garbage (spectra
  bug until 2026-11-01). On a standard radar
  (`px=(x−pos_x)/scale`, `py=(pos_y−y)/scale`), a Source yaw θ draws at
  canvas angle `−θ`. **Source** — demoinfocs-golang v6.0.0-rc.1
  `pkg/demoinfocs/common/player.go` doc comments; awpy reads
  `qangle[0]`=pitch, `qangle[1]`=yaw raw (2026-11-01).

- **GamePhase enum** (demoinfocs `common/gamerules.go`, from hl2sdk):
  0 Init, **1 Pregame**, 2 StartGame (first half), 3 TeamSideSwitch
  (second half / OT halves), 4 GameHalfEnded, 5 GameEnded, 6 StaleMate,
  7 GameOver. **Source** — demoinfocs gamerules.go (2026-11-01).

- **Knife (pre-match) rounds are NOT warmup** — MatchZy-style knife
  rounds run with `IsWarmupPeriod()=false`, `IsMatchStarted()=true`,
  `GamePhase()==Pregame(1)`; `TotalRoundsPlayed()` stays 0 through them
  and the scoreboard resets to 0-0 afterwards. `m_iKills/Deaths` exclude
  them; `m_iMVPs` does NOT (includes the knife MVP). Detection:
  non-warmup round with `GamePhase() < StartGame || !IsMatchStarted()`
  → pregame; gate stats on `IsMatchStarted() && !IsWarmupPeriod() &&
  GamePhase() >= StartGame`. **Source** — spectra golden demo
  (golden/de_cache.dem.zst round 1: phase=1, score resets 0/1 → 0/0);
  MatchZy lifecycle (github.com/shobhit-pathak/MatchZy Utility.cs);
  roundtable docs/round-eligibility.md (2026-11-01).

- **Post-match kills** — after the final round `IsMatchStarted()` flips
  back to false; demos end with trailing `World` suicides (reconnect
  slots). Scoreboards exclude them — gate stats on `IsMatchStarted()`
  (spectra golden demo: 2 trailing suicides). **Source** — golden-demo
  diag dump (2026-11-01).

- **`GameHalfEnded` fires before the winner's score increment** —
  dispatched from the `m_gamePhase` prop write; the same tick's
  `RoundEnd` handler already sees the settled score (golden demo: 7/4
  vs 8/4). Don't snapshot halftime scores at GameHalfEnded; resolve a
  pending half at the next freeze-end (swap sides back if already
  switched). Valve only fixed the analogous in-game halftime scoreboard
  staleness in the 2026-09-23 patch. **Source** — demoinfocs
  datatables.go dispatch order + golden-demo diag (2026-11-01).

- **Assists convention is split** — Valve's scoreboard `m_iAssists`
  INCLUDES flash assists (`AssistedFlash` on player_death); external
  boards (HLTV/Leetify/scoreboard sites) exclude them and track
  "flashbang assists" separately (HLTV api field `flashAssists`).
  spectra convention: `assists` excludes AssistedFlash,
  `flash_assists` column keeps them. **Source** — golden-demo
  scoreboard dump (adamS entity 4 = 3 + 1 flash);
  https://www.hltv.org/news/34796/using-flashbang-statistics-effectively;
  https://leetify.com/blog/leetify-stats-glossary/ (2026-11-01).

- **Enemies flashed** — one credit per ENEMY player blinded by a
  player's flash. The CS2 `player_blind` game event fires per blinded
  player (fields `userid`, `attacker`, `entityid`, `blind_duration`; no
  repeat events for one victim+flash observed — golden demo: 206 events
  = 206 distinct flash-victim runs), so counting the events whose
  attacker is cross-team reproduces the scoreboard stat; team and self
  blinds don't count. Leetify's per-flashbang variant additionally drops
  half-blinds shorter than 1.1 s — spectra counts every enemy blind (no
  heuristic threshold). Distinct from `flashed_times` (victim side, any
  blind) and from flashbang detonations. **Source** —
  https://cs2.poggu.me/dumped-data/game-events/ (player_blind fields);
  https://leetify.com/blog/leetify-stats-glossary/ (Enemies Flashed per
  Flashbang); spectra golden-demo diag (2026-11-04).

- **Trade kill = kill the opponent who killed your teammate, within 5 s**
  (HLTV: "an opponent who had killed their teammate within five
  seconds"; KAST "T" = your death answered the same way). Windows in
  the wild: 5 s (HLTV/spectra/cs2d), 5.25 s (awpy). Loose rules ("any
  kill after a teammate death") overcount. **Source** —
  https://www.hltv.org/news/42485/introducing-rating-30,
  https://www.hltv.org/stats/players,
  https://leetify.com/blog/leetify-stats-glossary/ (2026-11-01).

- **Kills column excludes suicides and teamkills** — awpy: "a kill
  counts if it is against an enemy (not a suicide or team kill)"; first
  blood/opening likewise requires a distinct enemy victim. Deaths
  include them. **Source** — awpy stats.rs (2026-11-01).

- **ADR** — average damage per round: Σ over ENEMY hits of
  MIN(hit damage, victim's remaining HP before the hit) ÷ rounds the
  player played (knife/warmup excluded). Overkill is not damage dealt — a
  115-damage AWP hit on a 10-HP player credits 10. Track each victim's HP
  per round starting at 100 and update it from the player_hurt `health`
  field (the victim's HP AFTER the hit — authoritative; a pure
  `before − dmg` simulation drifts on world/team damage the extractor does
  not attribute the same way). demoinfocs' `HealthDamageTaken` is the same
  quantity when the server build emits it. Verified against the golden
  demo's external scoreboard screenshot: all ten players match to ±0.05
  (forever2kELO 116.9, was 144.3 on the raw-damage basis).
  **Source** — the external scoreboard screenshot (formerly donk.png,
  removed from the repo 2026-11-07); demoinfocs v6
  `events.PlayerHurt` doc comments;
  https://awpy.readthedocs.io,
  https://prosettings.net/blog/cs2-scoreboard/ (2026-11-02).

- **Loss bonus** — a per-TEAM loss count: +1 after every loss, −1 after
  every win (min 0, max 4). `mp_consecutive_loss_aversion` defaults to 1:
  a win STEPS THE LADDER DOWN one level, it does not reset it. A lost
  round pays `cash_team_loser_bonus` (1400) +
  `cash_team_loser_bonus_consecutive_rounds` (500) × count, capped at
  3400 → $1400 / $1900 / $2400 / $2900 / $3400. Every half starts BOTH
  teams at count 1 (`mp_starting_losses`), so losing a pistol round pays
  $1900, not $1400. The count follows the TEAM across the halftime side
  switch — reconstructing it per side mixes two teams' streaks.
  **Source** — https://counterstrike.fandom.com/wiki/Money (mirrors Valve's
  2018-10-09 and 2019-03-13 update notes),
  https://developer.valvesoftware.com/wiki/List_of_Counter-Strike_2_console_commands_and_variables
  (convar defaults; readable dump: https://cs2.poggu.me/dumped-data/convar-list)
  (2026-11-02).

- **Multi-kill columns (2K/3K/4K/5K)** — a round counts at EXACTLY one
  tier: a round with 4 kills is one 4K and NOT also a 3K (cumulative
  counting disagrees with external scoreboards); 5+ kills = one 5K; a
  round with exactly 2 kills is one 2K (same exclusivity — a 3-kill round
  is a 3K, not a 2K). Counted per round over stats-eligible enemy kills
  only.
  **Source** — golden demo's external scoreboard screenshot (formerly
  donk.png, removed from the repo 2026-11-07: adamS 1×3K +
  2×4K not 3×3K; FREELOOK 1×4K + 0×3K; 2K column: adamS 2, llorente 3,
  kRaSnaL 3, hades 3, FREELOOK 2, forever2kELO 6, Zuedsta 4, donk666 2,
  Magnojezzz 2, -meg2k 3 — all ten reproduced by the extractor)
  (2026-11-02).

- **MVPs** — `RoundMVPAnnouncement` (round_mvp) is often absent in CS2
  demos; recover per-round MVPs by diffing `Player.MVPs()` (`m_iMVPs`)
  at each RoundEnd. The counter includes knife-round MVPs (spectra
  counts them to match scoreboards). **Source** — golden-demo diag;
  roundtable src/replay/README.md (2026-11-01).

- **Side is a per-round fact, not a player identity** — `m_iTeamNum`
  (2=T, 3=CT) flips at halftime, at the knife→pistol side pick, and
  every OT half; the end-of-demo roster only carries the FINAL side, and
  a `Participants().Playing()` read drops post-match leavers (see
  "End-of-demo roster vs. post-match disconnects"). Sample sides at
  freeze-end each round (and per frame); never source teams solely from
  the final roster. **Source** —
  https://awpy.readthedocs.io/en/stable/reference.html; golden-demo
  diag (2026-11-01); roster claim re-verified 2026-11-04.

- **End-of-demo roster vs. post-match disconnects** — players leave the
  server between match point and the demo's last tick, so an end-of-demo
  roster read through demoinfocs' `Participants().Playing()` (it iterates
  `ByUserID()`, which requires `IsConnected && Entity != nil`) silently
  drops them: golden demo 3/10 — 7 players disconnect at ticks
  136598..136885 while the stream ends at 136896. Their player-controller
  entity, team, score, ping, money and crosshair state are all still
  intact, so the snapshot must read `Participants().All()` filtered to
  CT/T instead (spectra `extract.finalRoster` → 10/10). **Source** —
  demoinfocs v6 game_state.go `ByUserID` connected filter;
  spectra golden-demo diag dump (2026-11-04).

- **Radar transform convention** — `px=(worldX−pos_x)/scale`,
  `py=(pos_y−worldY)/scale` where `pos_x/pos_y` = world coords of the
  radar image's top-left and scale = world units per image pixel
  (official overview.txt format; cross-confirmed by 4 independent
  viewers). Some radars need a `rotate` flag (inferno 270°) that most
  viewers ignore. Facing renders at canvas angle `−yaw`. **Source** —
  https://developer.valvesoftware.com/wiki/Creating_a_working_mini-map_for_CS:GO;
  identical constants in spectra/roundtable/cs2d/boshgg map packs
  (2026-11-01).

- **Round numbering** — the game numbers rounds from the first counted
  (non-warmup, non-knife) round: the first-half pistol is "Round 1";
  warmup and knife rounds are unnumbered. spectra ingest mirrors that:
  real rounds are 1..N in chronological order and every other round takes
  a NEGATIVE index counting back from round 1 (the round immediately
  before round 1 is −1), so sorting by number stays chronological
  (−2 knife, −1 warmup, 1 pistol, …). MR12 halves are counted-round
  indices 0 and 12. Round-filter sentinels stay "-1 = all" (never a valid
  round number), so filter dropdowns offer counted rounds only.
  **Source** — golden-demo diag; awpy datasets.rs (2026-11-01);
  ingest renumber in `internal/extract/build.go` (2026-11-02).

- **Weapon/inventory icons in a CS2 install** — where the gun icons live
  for extraction. In `pak01_dir.vpk`: (1) killfeed/HUD-style SVG
  silhouettes at `panorama/images/icons/equipment/<weapon>.vsvg_c`
  (101 files: ak47…xm1014, all knives, grenades, armor, c4, defuser…),
  referenced by the game's own layouts as `.vsvg` (e.g.
  `huddeathnotice.vxml_c`, `loadout_grid.vts_c` →
  `file://{images}/icons/equipment/<name>.svg`). The vsvg resource's
  DATA block = 6-byte prefix (u32 CRC32 of the rest + u16 0) + raw SVG
  text starting at `<?xml` or `<svg` through `</svg>\n` — no external
  refs, so extraction is slice-and-write (verified: CRC matches
  `crc32(body[6:])` on all 101; the same layout holds for all 894
  `.vsvg_c` under `panorama/images/{icons,hud,econ}`). (2) inventory
  render images at
  `panorama/images/econ/weapons/base_weapons/weapon_<name>_png.vtex_c`
  (68 files, 512×384 BGRA8888) — these decode with spectra's existing
  `decodeVTex` unchanged (verified: 68/68 → 512×384 PNG), but there is
  NO armor/helmet PNG, so spectra extracts the SVG set only (it covers
  armor, defuser and the bomb too). spectra's extractor is
  `internal/mappack/icons.go` (shared block-table parser with
  `decodeVTex`); manifest keys are demoinfocs'
  `EquipmentType.String()` names — note the exact armor strings are
  **"Kevlar Vest"** (`kevlar.vsvg_c`) and **"Kevlar + Helmet"**
  (`armor_helmet.vsvg_c`), and VPK basename `sg556` = display name
  "SG 553". Per-skin variants live in
  `panorama/images/econ/default_generated/`
  (6,804 files, 1.2 GB — opt-in only).
  **Source** — local probe of pak01_dir.vpk + decode of all entries
  (2026-11-03); full-pipeline re-verify + all 46 mapped CRC checks
  (2026-11-05).

- **Sound assets (`.vsnd_c`) in a CS2 install** — where gun/footstep/
  grenade audio lives and how to turn it into playable files. In
  `pak01_dir.vpk` under `sounds/`: 20,471 `.vsnd_c` files / 4.66 GB
  (`weapons/` 1,237 files/107 MB incl. `<gun>_01.vsnd_c` fire sounds and
  `hegrenade_detonate_02`, `flashbang_explode1`; `player/footsteps/`
  409 files/25 MB surface variants; `vo/`+`music/` are the other 3.4 GB).
  Two resource versions, both with the audio payload starting at the
  resource header's `FileSize` offset (structured size only — same
  convention as vtex): **v4** (17,978 files) stores a fixed header in
  the DATA block — u16 rate, u8 format (0=PCM16, 1=PCM8, 2=MP3,
  3=ADPCM), u8 channels, i32 loopStart, u32 sampleCount, f32 duration,
  …, u32 streamingSize — while **v5** (2,493) leaves DATA empty and puts
  the same fields in a CTRL block (binary KV3: `_class
  CVoiceContainerDefault`, `m_vSound.{m_nFormat,m_nRate,m_nChannels,
  m_nSampleCount,m_nStreamingSize,…}`). Decoding: PCM16/PCM8 → prepend
  the standard 44-byte RIFF/WAV header (Valve strips it; VRF does the
  same in `Sound.GetSound()`); MP3 → payload is already a raw MP3 stream,
  write as `.mp3`. Formats in this build: v4 header census PCM16 16,721
  / MP3 1,239 / PCM8 18, rates 44,100 (17,888), 22,050 (78), 11,025 (12),
  mono 16,346 / stereo 1,632; v5 CTRL strings MP3 2,030 / PCM16 422.
  Verified end-to-end: `bass_01` footstep → WAV →
  ffprobe `pcm_s16le 44100 mono 0.066s`; `flamenco` → `.mp3` →
  ffprobe `mp3 11025 mono`; ak47 fire (v5) → WAV → `44100 stereo 2.45s`.
  **Source** — local probe of pak01_dir.vpk + ffprobe (2026-11-03);
  VRF `Sound.cs` (github.com/ValveResourceFormat/ValveResourceFormat,
  2026-11-03).

- **Sound-event names ↔ demo `soundevent_hash`** — resolving which event
  a demo's `CMsgSosStartSoundEvent` refers to. The demo carries only a
  `fixed32 soundevent_hash`; the names live in `soundevents/*.vsndevts_c`
  (183 files in `pak01_dir.vpk`, binary KV3 v5 with LZ4-compressed
  buffers — VRF `BinaryKV3.cs` is the reference parser; a minimal
  header+LZ4 reader recovers the string table: ~41,552 dotted names
  across all files, e.g. `Weapon_AK47.Single`, `Default.WalkJump`,
  `SmokeGrenade.Bounce`, plus the `.vsnd` paths they play). The hash is
  **MurmurHash2-32 over the LOWERCASED event name with seed
  0x53524332** — verified against the golden demo: 126/127 distinct
  hashes (25,265/25,266 messages) resolve to vsndevts names; CRC32
  (which some proto docs claim) matches 0. The one unmatched hash fired
  once and appears in no shipped file (likely a runtime-generated name).
  `packed_params` parameter names use the same MurmurHash2 with seed
  0x31415926 (verified: `murmur2("public.volume")` → `BD6054E9`, the
  byte-reverse of the published `E9 54 60 BD` sample). This is the
  lookup the sound-event layer (ref/MISSING.md §5.14) needs to turn the
  golden demo's 25,266 SOS messages into named events.
  **Source** — golden-demo parse + vsndevts probe (2026-11-03);
  hash seed from csgocn.net RE post (2025-06-08);
  https://cs2opendev.github.io/CS2OpenDev-Docs/protobufs/gameevents/
  (2026-11-03, its "CRC32" claim disproved above).

- **Cumulative cash-spent counter (`m_iTotalCashSpent`)** — is a player's
  total spend readable mid-demo? Yes: the CS2 player property
  `m_pInGameMoneyServices.m_iTotalCashSpent` (field of the player
  controller's economy component; demoinfocs v6
  `Player.MoneySpentTotal()`, sibling `MoneySpentThisRound()`) is a LIVE,
  monotonic cumulative spend counter for the whole match — it advances as
  the demo plays, so sampling it at each freeze-time-end and differencing
  consecutive samples yields per-round spend whose sum reproduces the
  end-of-demo total (verified on the golden demo; `round_economy.spent`
  is built exactly that way).
  **Source** — demoinfocs `Player.MoneySpentTotal()`
  (https://pkg.go.dev/github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common#Player.MoneySpentTotal
  and the source it reads,
  https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/common/player.go);
  CS2OpenDev schema page
  `CCSPlayerController_InGameMoneyServices.m_iTotalCashSpent` ("Cumulative
  money the player has spent across the whole match")
  (https://cs2opendev.github.io/CS2OpenDev-Docs/schemas/server/CCSPlayerController_InGameMoneyServices/)
  (2026-11-04).

- **Freeze-time-end equipment value (`m_unFreezetimeEndEquipmentValue`)** —
  is a side's "equipment value" the gear it holds or the money it spent?
  The game records a PER-PLAYER pawn property
  `m_unFreezetimeEndEquipmentValue` — demoinfocs v6
  `Player.EquipmentValueFreezeTimeEnd()` = "the value of equipment in the
  player's inventory at the end of the freeze time";
  `TeamState.FreezeTimeEndEquipmentValue()` sums it over the team. It is
  INVENTORY value: every weapon in the player's inventory — including
  weapons picked up and carried over from earlier rounds — plus armor,
  grenades and the defuse kit; it is neither this round's spend nor
  unspent money (a stolen AK survives on the carrying player's next
  freeze-end sample). Siblings: `m_unRoundStartEquipmentValue` (before the
  freeze-time buys) and `m_unCurrentEquipmentValue` (live). Verified on
  the golden demo: round 3's CT side spent $4200 yet holds $8350 of gear,
  its T opponent spent $5000 for $23800 (pinned by
  `extract.TestParseGolden`; spectra stores the value as
  `rounds.equip_ct/equip_t` + `round_economy.equip_value`, with the spend
  kept separately in `round_economy.spent`).
  **Source** — demoinfocs v6 `Player.EquipmentValueFreezeTimeEnd` doc
  comment + source
  (https://pkg.go.dev/github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common#Player.EquipmentValueFreezeTimeEnd,
  https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/common/player.go);
  golden-demo round-economy dump (2026-11-04).

- **CS2 demo download folder (in-client)** — where demos the CS2 client
  downloads itself land (Watch / recent-games menu "download", incl.
  Premier): **`<CS2 install>/game/csgo/replays`**. CS2 keeps the CS:GO
  install folder name (`Counter-Strike Global Offensive`, already pinned
  by "Steam CS2 install detection"), so the per-OS difference is only the
  Steam library location — `mappack.FindCS2` resolves that, and
  `library.DefaultDemoDirs` derives the folder as
  `filepath.Join(mappack.FindCS2(""), "replays")`. POV `record` output
  lands in the same folder. Separate path: demos fetched from Steam's web
  "Download GOTV replay" button arrive in the **browser's Downloads
  folder** as a `.bz2`/zip archive that must be extracted into
  `game/csgo` (spectra's default list therefore watches Downloads + this
  folder; it never walks `game/csgo` itself).
  **Source** — scope.gg CS2 demo guide
  (https://scope.gg/guides/cs2-demo-guide-en), Steam thread "Where do i
  find my Demo files?" (https://steamcommunity.com/app/730/discussions/0/4517759395050894377),
  cs2pulse (https://cs2pulse.com/where-to-find-cs2-replay-file-location),
  tradeit.gg CS2 replay controls (https://tradeit.gg/blog/cs2-replay-controls),
  immortalboost "How to Watch CS2 Demos" (2026-11-04).

- **World units ↔ meters, and player movement speeds** — coordinate and
  distance units for any proximity math. One world unit is one inch
  (2.54 cm), so 1 m ≈ 39.37 units and a player model is 72 units tall;
  the game's own `distance` field (what demoinfocs surfaces as
  `events.Kill.Distance`) is in METERS — verified on the golden demo by
  dividing attacker↔victim world-position deltas by it (mean ratio
  39.45). Max run speed is 250 u/s with knife/C4, ~215 u/s with a
  rifle, ~240 u/s pistol, 245 u/s grenades — a player covers roughly
  1075–1250 units inside the 5-second trade window at those speeds.
  **Source** — cs.money movement guide ("one unit is equal to one inch
  or 2.54 centimeters", "250 units per second — maximum running speed",
  https://cs.money/blog/esports/based-movement-in-csgo/, 2026-11-04);
  Counter-Strike Wiki "Movement" (250 u/s knife),
  https://counterstrike.fandom.com/wiki/Movement (2026-11-04);
  cs2-nav `RUNNING_SPEED = 250.0`,
  https://docs.rs/cs2-nav/latest/src/cs2_nav/constants.rs.html
  (2026-11-04); meters observation from this repo's golden-demo events
  (2026-11-04).

- **Starting money (`mp_startmoney`) on pistol rounds** — how much cash does
  each side start a half with? Competitive/Premier/Wingman start every
  player at **$800** (`mp_startmoney` default 800; Casual starts at $1000),
  so a team's pistol-round money is **5 × $800 = $4000** — and halftime
  resets everyone back to $800 for the second pistol round. Verified on the
  golden demo: on rounds 1 and 13 each side's freeze-end
  `money_sampled_sum + spent` equals exactly 4000 (CT 600+3400 / T 1400+2600
  in round 1; 600+3400 on both sides in round 13), i.e. all starting cash is
  accounted for by unspent money + buys.
  **Source** — csdb.gg mp-startmoney ("Default Value 800"),
  https://csdb.gg/command/mp-startmoney/; totalcsgo mpstartmoney
  ("Default is 800 … each half"), https://totalcsgo.com/commands/mpstartmoney;
  Counter-Strike Wiki "Money" (Premier/Competitive/Wingman $800, Casual
  $1000), https://counterstrike.fandom.com/wiki/Money (2026-11-05);
  golden-demo round-economy dump (2026-11-05).

- **Free spawn-issued default pistol inside equipment value (net worth
  caveat)** — is every dollar of freeze-end equipment value money the side
  paid? No: each player is **issued their default sidearm free** (USP-S or
  P2000 for CT, Glock-18 for T — buy price $200), and
  `m_unFreezetimeEndEquipmentValue` counts it at **$200** although nobody
  spent anything on it (verified on the golden demo: a player with only a
  default pistol reads `equipFTEnd = 200`; USP-S + kevlar reads 850). The
  moment a player upgrades their sidearm (P250, dualies, …) the free pistol
  drops out of inventory — and therefore out of equipment value — so two
  sides that both hold exactly $4000 of money show different
  `equipment + cash` totals on a pistol round. Golden demo: round 1 CT holds
  3 free USP-S ($600) vs T 5 free Glocks ($1000) → raw equip+cash 4600 vs
  5000; round 13 CT 5 USP-S ($1000) vs T 4 Glocks ($800) → 5000 vs 4800.
  Two readings follow and spectra uses the first: net worth = equipment +
  cash counts the granted pistols (a genuine asset gap — a side that
  dropped or upgraded its free sidearms really holds less), while net
  worth = equipment + cash − free default pistols makes both pistol-round
  sides read exactly $4000 (= 5 × $800) but can fall BELOW equipment
  value whenever a side holds less cash than the granted pistols it still
  has (golden demo round 13 CT: $600 of cash against $1000 of USP-S →
  4000 < 4400), which the Economy chart forbids — so the chart plots
  equipment + cash and `round_economy.free_pistol_value` records the
  granted-pistol value per side for reference. Caveat: a rebought default
  ($200 buy-back) is also counted as free here — the demo data cannot
  distinguish it. **Source** — spectra golden-demo freeze-end
  inventory dump (2026-11-05); Counter-Strike Wiki USP-S ("free spawn
  pistol", repurchase for $200),
  https://counterstrike.fandom.com/wiki/USP-S; csbepro Glock-18 guide
  ("$200 buy-back"), https://csbepro.com/cs2-weapon/glock-18-guide-for-counter-strike-2/
  (2026-11-05).

- **A flashbang detonation fires TWICE in demoinfocs-golang v6** — why one
  flashbang yields two `grenade` events (flash detonation counts read ~2×).
  `events.FlashExplode` is dispatched from BOTH the `flashbang_detonate`
  game event (`game_events.go` `flashBangDetonate`) and the flash
  projectile's entity on-destroy handler (`datatables.go` `stOnDestroy`),
  each gated on `!disableMimicSource1GameEvents` (zero value → both run);
  HE/smoke/fire/decoy detonations dispatch once. Golden demo: 91 flashbang
  throws → 182 `grenade` rows at 91 distinct ticks (the pair's positions
  differ by ~0.01u — entity position vs game-event position). Code that
  assumes one row per detonation must dedupe flashes by tick+thrower;
  spectra stores the rows as-is (golden-fixture-pinned). **Source** —
  demoinfocs-golang v6.0.0-rc.1 `pkg/demoinfocs/game_events.go` +
  `pkg/demoinfocs/datatables.go`
  (github.com/markus-wa/demoinfocs-golang); golden-demo/dev-DB event
  counts (2026-11-05).
- **Trade kill opportunity (per player) — what a trade rate's
  denominator is** — Leetify's glossary splits trading into "Trade Kill
  Opportunities: how many times did you have the chance to trade a
  teammate", "Trade Kill Attempts" (you actually tried when given that
  chance) and "Trade Kill Successes" (you got the kill and traded them),
  so a per-player trade rate is successes ÷ opportunities — NOT trades ÷
  the player's own deaths (a different, also-used ratio). The
  opportunity belongs to the PLAYER whose teammate died while he was alive
  and in position; the mirror concept "Traded Deaths" measures the
  reverse direction (your own death answered by a teammate). spectra:
  "in position" is the extract-time proximity measure on the kill event
  (`detail_json.nearDist`, the nearest living teammate of the victim to
  the killer, −1 = nobody measurable) gated by the configured
  trade-opportunity distance — see `store.CountPlayerTradeOpportunities`.
  **Source** — https://leetify.com/blog/leetify-stats-glossary (2026-11-05).
- **`weapon_fire` game-event payload (CS2)** — what each shot event
  carries (acceptance cross-check for sampled attack-button state):
  `userid` (player_controller — who fired), `weapon` (string, weapon name
  used), `silenced` (bool), `userid_pawn` (strict ehandle). Fires on every
  client weapon fire (knife attacks included). The event has NO position
  and no ammo fields — ammo/trigger state must come from entity/usercmd
  sampling, not from this event. **Source** — SteamDatabase
  GameTracking-CS2 `resource/mod.gameevents`,
  https://github.com/SteamDatabase/GameTracking-CS2/blob/master/game/csgo/pak01_dir/resource/mod.gameevents;
  cs2.poggu.me dumped game events,
  https://cs2.poggu.me/dumped-data/game-events (2026-11-05).

- **Reserve ammo unit changed to reserve MAGAZINES (March 2026 patch)** —
  what does `AmmoReserve()` / `m_pReserveAmmo` mean on a given demo? The
  "Guns, Guides, and Games" update (2026-03-18) replaced leftover-round
  reserves with a magazine count: reloading dumps the used magazine and
  takes a full one from a finite reserve (post-patch: AK-47 = 3 reserve
  magazines, MP9 = 2; pre-patch demos still report rounds). The stored
  VALUE is correct in both eras — only its interpretation differs — so any
  future ammo UI must label the unit by demo era (demoinfocs documents
  exactly this on `Equipment.AmmoReserve`). **Source** — Valve
  announcement "Counter-Strike 2 :: Guns, Guides, and Games",
  https://steamcommunity.com/games/CSGO/announcements/detail/532126482488623354
  (2026-03-18); HLTV "Valve overhaul reloading mechanics in CS2 update",
  https://www.hltv.org/news/44128/valve-overhaul-reloading-mechanics-in-cs2-update
  (2026-03-19); demoinfocs-golang v6 `Equipment.AmmoReserve` doc comment
  (retrieved 2026-11-05).
- **Competitive round clock (freeze time, round time, C4 timer)** — what
  a round-clock readout counts. The round splits into FREEZE TIME (buy
  phase, `mp_freezetime`: 15 s on casual/many servers, 20 s on Valve
  competitive/Premier) then the ROUND TIME (`mp_roundtime_defuse`
  default **1.92 min = 1:55 = 115 s**; when it expires with no plant CTs
  win). A planted C4 counts **40 s** (`mp_c4timer`, already recorded
  under the bomb entry). spectra stores each round's ACTUAL
  `startTick`/`freezeEndTick`/`endTick`, so a clock reads the freeze
  countdown from `freezeEndTick` (never an assumed duration), then 115 s
  minus the time since freeze end, and a planted C4 as the time to
  `bombEndTick` (`lib/replay/bomb.js` — canonical terminator rule, 40 s
  hard fallback). **Source** — https://totalcsgo.com/commands/mproundtime
  (default 1.92, "1.92 = 1m55s"); https://csdb.gg/command/mp-roundtime
  (default 1.92); https://cybrancee.com/learn/knowledge-base/how-to-configure-your-cs-2-server
  (`mp_roundtime_defuse` 1.92 = 1:55, `mp_freezetime` 15,
  `mp_c4timer` 40); https://wiki.csgoluck.com/cs2-freeze-time/
  (20 s competitive freeze default) (2026-11-06).

- **Bomb `bomb_dropped` / `bomb_pickup` semantics (death drops, release
  vs landing)** — how trustworthy is carrier-position evidence on a
  drop? `BombDropped` fires when the C4 **loses its owner**
  (`m_hOwnerEntity` → invalid handle), i.e. at **RELEASE**, for ANY
  reason that clears the owner: manual drop AND death drop (demoinfocs
  dispatches it from the entity property update, not the game event;
  `BombPickup` fires when the owner changes to a new carrier — and also
  on the round-start bomb hand-out to the first holder). Empirically on
  the golden demo (`extract.TestDiagBombEvidence`, 42 drops / 10
  carriers): 16 drops land within ±3 ticks of the carrier's death (7
  with the carrier already dead at the event) — **death drops DO fire
  it**; the carrier's position equals the bomb entity's position at the
  event in 42/42 (within 64u, x/y identical in samples), but the bomb
  entity then keeps moving until it settles (rest observed ≤ 80 ticks,
  mean 46 ≈ 0.7 s — the event is release, NOT landing, so the stored
  drop position can be a slide short of the final resting spot).
  `bomb_pickup` (57 drops… pickups): bomb entity position present
  56/57 but often STALE (one snapshot behind — round-start hand-outs
  report the previous ground spot), player position present 57/57 and
  current — so spectra stores bomb-entity-first with player fallback
  and flags the source in DetailJSON (ground pickups: both within
  ~60u). Related: `mp_death_drop_c4` (C4 droppable on death, default
  true) and `mp_c4timer` default 40 in CS2 Competitive/Premier (45
  Casual) — the renderer's no-terminator bomb fallback.
  **Source** — demoinfocs v6 `datatables.go` `m_hOwnerEntity` binding
  + `events.BombDropped`/`BombPickup` docs
  (https://pkg.go.dev/github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events,
  2026-11-05); CS2 game-event dump `bomb_dropped`/`bomb_pickup`/
  `player_given_c4` fields (https://cs2.poggu.me/dumped-data/game-events/,
  2026-11-05); golden-demo diag `TestDiagBombEvidence` (2026-11-05);
  mp_c4timer/mp_death_drop_c4 defaults
  (https://developer.valvesoftware.com/wiki/List_of_Counter-Strike_2_console_commands_and_variables,
  https://slashplay.gg/commands/cs2/mp_c4timer, 2026-11-05).

- **Player scoreboard/radar colors from a demo** — read
  `CCSPlayerController.m_iCompTeammateColor` (int32, per controller
  entity — NOT on CCSPlayerResource in CS2; −1 = none/GOTV). Mapping:
  0=blue, 1=green, 2=yellow, 3=orange, 4=purple — verified 10/10 vs
  in-game ground truth on `golden/de_cache.dem.zst` (the ten assignments are pinned
  by `extract.TestParseGolden`), identical to LaihoE demoparser's
  `PLAYER_COLOR`. demoinfocs v6 `Player.ColorOrErr()` returns the right
  raw value but its `Color` enum *names* mislabel CS2 colors (it says
  0=Yellow — that is the CS:GO ordering), so use the raw int only.
  **Source** — github.com/SteamTracking/GameTracking-CS2 DumpSource2
  schemas (`CCSPlayerController.h`);
  github.com/LaihoE/demoparser `src/parser/src/maps.rs`;
  github.com/markus-wa/demoinfocs-golang v6 `common/player.go` +
  `common/common.go` (Color enum); local probe of golden/de_cache.dem.zst
  (2026-11-06).

- **Which `.vsnd_c` files are the weapon-fire / detonation sounds** —
  picking the right assets for replay SFX. Name patterns are WRONG:
  resolve through `soundevents/*.vsndevts_c` DATA blocks (root keys ARE
  the event names — `Weapon_AK47.Single`, `BaseGrenade.Explode`,
  `Flashbang.Explode`, `Molotov.Start`, `IncGrenade.Start`,
  `BaseSmokeEffect.Sound`, `c4.explode` — each value carries
  `vsnd_files_track_01[]` `.vsnd` paths; 183 files → 21,035 events →
  19,986 distinct files) or pin a static table. Pitfalls: orphans exist
  (`ak47_03`, `ak47-1`, `glock_01`, `m4a1_us_01..04` are referenced by
  no event), `*_distant*` files are a separate far layer, and basenames
  repeat across grenade dirs. Conventions: near fire = `<gun>_01.._04`
  or legacy `<gun>-1`; detonations = `<x>_detonate_NN` / `<x>_explodeN`.
  The near layer is PCM16 44,100 stereo everywhere (v4 resource except
  ak47 fire = v5). Utility map: HE `hegrenade_detonate_02/03`, flash
  `flashbang_explode1/2`, smoke = `smoke_emit` (the 14 s bloom — there
  is NO `smoke_explode*` file), molotov `molotov_detonate_1`,
  incendiary `inc_grenade_detonate_1..3`, C4 `c4_explode1`;
  **decoy has NO decoy-specific sound**: the explosion plays the HE boom
  (`BaseGrenade.Explode` → the HE files above) and its noise mimics
  guns — only draw/throw/pinpull files exist under `decoy/` (see the
  decoy lifecycle entry).
  No fire file is shared between weapons, but one dir can hold two
  weapons: `m4a1/` = M4A4 `m4a1_01..04` + M4A1-S `m4a1_silencer_01`,
  `usp/` = USP-S `usp_01..03` (suppressed = default) + unsilenced
  `usp_unsilenced_01..03`. spectra extracts a pinned static table
  (`internal/mappack/sounds.go` `soundTable`, keys = `iconTable`'s
  canonical names).
  **Source** — local probe of pak01_dir.vpk + vsndevts parse (2026-11-07);
  VRF `Sound.cs` (2026-11-03, "Sound assets" entry above).

- **`.vsnd_c` v5 CTRL block decode (binary KV3, LZ4)** — v5 resources
  keep their header in a `CTRL` block instead of DATA. Layout (validated
  against ALL 2,224 KV3-v5 files in the install, 0 errors): 120-byte
  header starting `KV3\x05` + 16-byte GUID + `u32 compression=1` (LZ4),
  LZ4 sizes at offsets 72/76/80/84; buffer1 = the NUL string table
  (`_class | CVoiceContainerDefault | m_vSound | m_nRate | m_nFormat |
  PCM16 | m_nChannels | m_nStreamingSize | …`), buffer2 = `[2×u32
  header][key/value pairs][f64 lane][type bytes][00 dd ee ff trailer]`;
  a key whose next u32 is the next property name has no stored value
  (absent properties + inline objects). `m_nFormat` is a STRING
  (`PCM16`/`MP3`), not an int; `m_nChannels` may be absent (recover as
  `payload/(sampleCount×bps)`, integral-or-error, never guessed);
  `m_nStreamingSize` must equal the payload length. Audio payload starts
  at the resource header's `FileSize` offset either way. A magic-`0x04`
  KV3 variant exists only under `sounds/ambient/train` (no table entry)
  and is rejected with a named error. spectra's decoder:
  `internal/mappack/sounds.go` `decodeVSnd`.
  **Source** — local from-scratch reader validated against the whole
  install (2026-11-07); VRF `BinaryKV3.cs` / `Sound.cs`.

- **Kill-feed indicator glyphs in a CS2 install** — the game's own
  death-notice markers live at `panorama/images/hud/deathnotice/`, and
  `huddeathnotice.vxml_c` binds them to conditions verbatim:
  HeadShot→`icon_headshot`, Penetrate→`penetrate`, NoScope→`noscope`,
  ThroughSmoke→`smoke_kill`, AttackerBlind→`blind_kill`,
  InAir→`inairkill`, Suicide→`icon_suicide` (plus `revenge`,
  `domination` — not used by spectra). They are `.vsvg_c` resources that
  decode with spectra's existing `decodeVSVG` (6-byte CRC32 prefix + raw
  SVG), same as the equipment set — they ride the icon extractor as
  manifest keys `headshot`, `blind_kill`, `noscope`, `wallbang`,
  `throughsmoke`, `airborne`, `suicide`. There is NO explosion glyph in
  the deathnotice dir (the layout shows bomb deaths as Suicide + the
  weapon slot) — spectra uses `panorama/images/hud/kill_pip_blast.vsvg_c`
  as key `explosion` (the hud kill-context "blast" pip; swap point
  documented in `internal/mappack/icons.go`). Existing installs
  re-extract to gain the keys; the feed skips any that are missing.
  **Source** — local probe + decode of pak01_dir.vpk + layout strings
  from `huddeathnotice.vxml_c` (2026-11-07).

- **`player_death` kill flags (what the death notice can show)** —
  every indicator the feed needs is game-computed on the event:
  `noscope` ("kill happened without a scope, used for death notice
  icon"), `thrusmoke`, `attackerblind`, `assistedflash`, `penetrated`
  (short — "number of objects shot penetrated before killing target";
  **`penetrated > 0` IS the game's wallbang notion**, = demoinfocs
  `Kill.IsWallBang()` — no level geometry involved), and
  **`attackerinair`** (bool, "attacker was in midair" — the exact field
  name; there is NO `midair` field). Non-normal deaths: a C4-explosion
  death reports `weapon:"planted_c4"` with `attacker:65535` (ABSENT —
  never the planter; attribution only via `bomb_planted`); world/self
  deaths report `attacker == userid` with `weapon:"world"`; fall deaths
  map through demoinfocs' `attackerWeaponType` to `EqWorld` ("World")
  when a same-frame `player_falldamage` fired. demoinfocs' `events.Kill`
  exposes every flag EXCEPT `attackerinair`, and the typed handler
  dispatches BEFORE `GenericGameEvent` (`game_events.go` dispatches the
  typed event, then the generic) — so the raw payload must be paired
  onto the row at flush time (spectra derives `attackerInAir` in
  `agg.pairRaw` from the same string stored as `raw_json`; all 170
  golden kills carry every key).
  **Source** — SteamDatabase GameTracking-CS2 `resource/mod.gameevents`
  + https://cs2.poggu.me/dumped-data/game-events/ (field comments,
  2026-11-07); demoinfocs v6 `events/events.go` Kill + `game_events.go`;
  dev-DB raw-payload census (2026-11-07).

- **Decoy grenade lifecycle (replay simulation facts)** — thrown →
  comes to rest → makes noise → explodes. `decoy_started` fires ≈2 s
  after the throw = ACTIVATION at the rest position; `decoy_detonate`
  fires ≈15 s later and its payload CARRIES x/y/z (verified at tick
  7536 of the pool's de_dust2 demo — equal to the activation position,
  so the decoy never moves after rest). The explosion plays
  `BaseGrenade.Explode` → the HE files (5/5 detonations across the pool
  demos; no decoy-specific boom). While resting it fires fake gunshots
  mimicking the thrower's MAIN weapon (primary → secondary → side
  starter pistol: Glock-18 for T, USP-S for CT), **1–3 shots every 3–5
  s for 15–18 s, SSG 08/AWP mains exactly 1 per interval** — and
  `decoy_firing` fires in NONE of the7 pool demos, so the noise is
  CLIENT-SIMULATED (nothing in the demo carries it; the networked
  `Weapon_*` mimic soundevents come from the decoy entity but are not
  player-attributable). spectra: activation = the `grenade_land` event
  kind, explosion = the normal `grenade` kind; the shot schedule is
  seeded by the land tick so seeks replay the same pattern.
  **Source** — product spec (user, 2026-11-07: cadence, durations,
  mimic rule) + local parse of `golden/*.dem.zst` + demoinfocs
  `DecoyStart`/`DecoyExpired` (2026-11-07).

- **Grenade THROW sounds (which files, and why name patterns fail)** —
  resolved through the soundevents map: `HEGrenade.Throw` →
  `sounds/items/weapon_hegrenade_throw.vsnd_c` (note: NOT under
  `sounds/weapons/`), `Flashbang.Throw` → `flashbang_throw_03`,
  `SmokeGrenade.Throw` → `smoke_grenade_throw_04`, `Molotov.Throw` →
  `molotov_throw_01..06` (6 variants), `IncGrenade.Throw` →
  `inc_grenade_throw_fire_01..03` (3), `Decoy.Throw` → `decoy_throw_06`
  — DISTINCT per grenade (all v5 MP3 44,100 mono). The six per-dir
  `sounds/weapons/<nade>/grenade_throw.vsnd_c` copies are byte-identical
  (RED2 metadata aside) ORPHANS referenced by NO event — never extract
  them. All `.Throw` events are thrower-LOCAL foley: 0 networked SOS
  across the7 pool demos (only `Molotov/IncGrenade Throw.Loop` are
  networked, at throw tick) — so the replay cues them from extracted
  files, keyed `"<name> throw"`. The shipped game event is
  `grenade_thrown` (not `grenade_throw`) and fires 0 times in every
  demo; spectra's throw rows come from the projectile-throw entity
  event.
  **Source** — soundevents map parse (21,542 rows, hash-validated
  against 126/127 golden SOS messages) + per-file CRC/byte diff +
  7-demo SOS scan (2026-11-07).

- **Radar elevation indicators (T / ⊥ symbols)** — how CS2/CS:GO mark a
  radar entity as above/below the reference level. Game assets (current
  CS2 build): `panorama/images/hud/radar/icon-radar-bomb-above_png.vtex_c`
  = **⊥** (horizontal bar at the bottom, stem rising from it),
  `..._below_png.vtex_c` = **T** (bar at top, stem descending);
  vector twins `panorama/images/icons/ui/map_bomb_above.vsvg_c` /
  `map_bomb_below.vsvg_c`. Layout
  (`panorama/layout/hud/hudradar.xml`): `AbovePlayer`/`BombAbove` use
  class `.PI_Above`, `BelowPlayer`/`BombBelow` use `.PI_Below`;
  CSS (`hudradar.css`): `.PI_Above { y: 8px }` places it 8px **below**
  the marker, `.PI_Below { y: -8px }` 8px **above** (both ~13×7px,
  wash `#CCC`, opacity 0.65). **Settled semantics** (final decision
  2026-11-08): entity **above** the level → **⊥ below the marker**;
  entity **below** → **T above the marker**; the flat bar is the
  "level" line relative to the entity (stem connects marker toward
  the level). Thresholds in Source-era `hud_radar.cpp` were ±128 world
  units vs. the local player; no equivalent constant found in CS2's
  panorama code, so treat thresholds as configurable. Note: the CS2
  limited test replaced *player* elevation indicators with look
  direction arrows (patch note 2023-11-16 "Added direction indicators
  to players in the square radar"), but the Above/Below markup, CSS,
  and both texture sets still ship in the current build.
  **spectra rendering** (decision 2026-11-08): the glyph is DRAWN, not
  shipped — `renderer.js` `drawElevationIndicator` strokes two canvas
  paths (a stem from the entity's centre, terminated by the flat bar)
  with a dark halo under a tinted body. The extracted `map_bomb_*.vsvg_c`
  rendered poorly and are NOT extracted anymore (`TestNoElevIconTable`
  pins their absence); ⊥/T text glyphs are not used either
  (font-dependent).
  **Source** — decoded locally from pak01_dir.vpk (2026-11-08);
  GameTracking-CS2 `hudradar.xml`/`hudradar.css`
  (github.com/SteamDatabase/GameTracking-CS2, 2026-11-08);
  Source `game/client/cstrike/hud_radar.cpp`
  (git.h3cjp.net/H3cJP/source-engine mirror).

- **`verticalsections` in `resource/overviews/<map>.txt`** — the
  game's own per-floor radar selection config. Each section names a
  radar image (`default` → `<map>_radar`, `<section>` →
  `<map>_<section>_radar`) and bounds it with `AltitudeMax` /
  `AltitudeMin` world-Z; the game shows the section whose range
  contains the local player's Z. Sections must not overlap on the
  same bound value (equal pairs crash the game). Values in the
  2026-06 build: **de_nuke** `default` [-495, 10000] (upper),
  `lower` [-10000, -495]; **de_train** `default` [-50, 20000],
  `lower` [-5000, -50]; **de_vertigo** `default` [11700, 20000],
  `lower` [-10000, 11700]; **ar_baggage** `default` [-5, 10000],
  `lower` [-10000, -5]. Maps without the block are single-level.
  This is the authoritative source for layer-assignment Z thresholds
  (community tools hardcode e.g. -480/-575 for nuke and got corrected
  to -495 from this file). Paired radar textures live at
  `panorama/images/overheadmaps/<map>_lower_radar_psd.vtex_c`.
  **Source** — local probe of pak01_dir.vpk `resource/overviews/*.txt`
  (2026-11-08); MurkyYT/cs2-map-icons `data/available.csv` parse of the
  same files (2026-11-08);
  https://github.com/zenojunior/cs2d/discussions/57 (2026-11-08);
  https://www.reddit.com/r/csmapmakers/comments/46dpws/ (2016-02-18).
