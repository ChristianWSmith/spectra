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

- **ADR** — enemy health damage (awpy caps per-hit at remaining HP;
  spectra sums `HealthDamage` to enemies only) ÷ rounds played;
  denominator is the player's own counted rounds (knife/warmup
  excluded). Third-party ADR columns may use different damage bases —
  the golden demo's external board reports ~0.8× ours with no derivable
  single rule. **Source** — https://awpy.readthedocs.io,
  https://prosettings.net/blog/cs2-scoreboard/ (2026-11-01).

- **MVPs** — `RoundMVPAnnouncement` (round_mvp) is often absent in CS2
  demos; recover per-round MVPs by diffing `Player.MVPs()` (`m_iMVPs`)
  at each RoundEnd. The counter includes knife-round MVPs (spectra
  counts them to match scoreboards). **Source** — golden-demo diag;
  roundtable src/replay/README.md (2026-11-01).

- **Side is a per-round fact, not a player identity** — `m_iTeamNum`
  (2=T, 3=CT) flips at halftime, at the knife→pistol side pick, and
  every OT half; GOTV end-of-demo rosters are unreliable (golden demo:
  3/10 players present). Sample sides at freeze-end each round (and per
  frame); never source teams solely from the final roster. **Source** —
  https://awpy.readthedocs.io/en/stable/reference.html; golden-demo
  diag (2026-11-01).

- **Radar transform convention** — `px=(worldX−pos_x)/scale`,
  `py=(pos_y−worldY)/scale` where `pos_x/pos_y` = world coords of the
  radar image's top-left and scale = world units per image pixel
  (official overview.txt format; cross-confirmed by 4 independent
  viewers). Some radars need a `rotate` flag (inferno 270°) that most
  viewers ignore. Facing renders at canvas angle `−yaw`. **Source** —
  https://developer.valvesoftware.com/wiki/Creating_a_working_mini-map_for_CS:GO;
  identical constants in spectra/roundtable/cs2d/boshgg map packs
  (2026-11-01).

- **Round numbering** — the game numbers rounds by `total_rounds_played`
  (first real round = "Round 1"); warmup and knife rounds are
  unnumbered. spectra keeps a raw chronological Number (warmup +
  pregame flagged) and excludes flagged rounds from RealRounds and all
  stats. MR12 pistol rounds are counted-round indices 0 and 12.
  **Source** — golden-demo diag; awpy datasets.rs (2026-11-01).
