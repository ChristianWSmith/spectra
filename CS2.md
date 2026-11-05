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
  (donk.dem.zst round 1: phase=1, score resets 0/1 → 0/0);
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
  demo's external scoreboard (donk.png): all ten players match to ±0.05
  (forever2kELO 116.9, was 144.3 on the raw-damage basis).
  **Source** — donk.png (external scoreboard, repo root); demoinfocs v6
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
  **Source** — golden demo's external scoreboard (donk.png: adamS 1×3K +
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
  `decodeVTex` unchanged (verified: 68/68 → 512×384 PNG). Per-skin
  variants live in `panorama/images/econ/default_generated/`
  (6,804 files, 1.2 GB — opt-in only).
  **Source** — local probe of pak01_dir.vpk + decode of all entries
  (2026-11-03).

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
