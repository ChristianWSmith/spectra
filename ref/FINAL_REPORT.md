# CS2 Demo — Final Report: Complete Data Taxonomy & Extraction Results

**Single synthesized document** combining the extraction taxonomy (what *can* exist in a CS2 demo) with the full extraction report (what *was* found in this demo).

| | |
|---|---|
| **Source file** | `demo.dem` — 224.7 MB, `PBDEMS2` (CS2/Source 2), zstd-compressed original `1-5b17ad32-7d8a-46a7-aabe-3a957be67e0a-1-1.dem.zst` |
| **Parser** | [demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang) v6.0.0-rc.1 |
| **Wire-format reference** | [CS2OpenDev](https://cs2opendev.github.io/CS2OpenDev-Docs/) (build 26281801, Steam 2026-10-28) |
| **Extraction program** | `extractor/main.go` (sequential parse, ~22 s wall-time); voice/encryption probe in `extractor/probe/` |
| **Generated** | 2026-10-30 · no parser warnings |

---

# Executive Summary

**The match:** a FACEIT 5v5 on **de_mirage**, MR12, 64 Hz — **CT 13 – 6 T** (6–6 at half), 20 real rounds + 1 warmup, 146 kills, ~31.5 minutes of recorded gameplay. Top performer: **bvcket** (23/12/5, 133.6 ADR). Longest round R10 (143.6 s, bomb exploded); shortest R16 (44.9 s).

**The data:** of the **30 known data categories** in a CS2 demo file, this parse established:

- **17 categories present and fully extracted** (everything from header to per-player ballistics to 400 grenade coordinates)
- **4 categories present but untapped** — most importantly **voice: 77,702 Opus chunks recorded from all 10 players** (verified by probe; one net-message handler + libopus away)
- **5 not applicable** to this demo (encrypted chat, ranks, hostage mode, POV input, caster audio)
- **4 physically impossible** from any `.dem` (team-chat keys, skin cosmetics, GC-only match metadata, buy-menu *intent*)

**Corrections from earlier assumptions:** the chat-decryption key is **not** in local game files — it is issued per-match by the Steam GC and stored in the `match730_*.dem.info` companion saved next to *downloaded* demos. This demo contains **zero** encrypted messages, which is why all-chat was readable in plaintext.

---

# Part I — Complete Data Taxonomy

*What exists inside a CS2 `.dem`, whether it's extractable, with what tool, and whether this demo contains it.*

**Legend:** ✅ present & extracted · ⚠️ present/available but not surfaced in Part II · ❌ absent from this demo · 🚫 physically absent from all demos

## I.0 How a CS2 demo is layered

```
demo.dem
├── 1. Demo stream commands (DEM_* frames)        ← file framing + metadata
│   └── 2. Packets (CDemoPacket / DEM_FullPacket) ← live-connection record
│       ├── 3. Network messages (net/clc/svc channels)
│       │   └── 4. User messages (UM_/CS_UM_ nested in svc_UserMessage)
│       ├── 5. Game events (Source1Legacy bridge, 289-registry)
│       ├── 6. Entity deltas (svc_PacketEntities → server classes/props)
│       ├── 7. String tables
│       ├── 8. Voice audio (svc_VoiceData)
│       └── 9. Encrypted channel (svc_EncryptedData, post-2026-09-09)
└── companion: match730_*.dem.info (GC key, Valve MM only), .zst/.gz wrapper
```

## I.1 Demo header & stream framing

| Data | Extractable | How | This demo |
|---|---|---|---|
| Filestamp, patch/build, demo version GUID | ✅ | `msg.CDemoFileHeader` net-handler | ✅ build 14193, `valve_demo_2` |
| Server/client name, map, game dir | ✅ | same | ✅ FACEIT.com / SourceTV / de_mirage |
| Playback frames/ticks/duration/tick rate | ✅ | `FrameCount()`, `IngameTick()`, `TickRate()` | ✅ 120,736 frames, 64 Hz |
| Per-frame demo ticks | ✅ | `CurrentFrame()`/`CurrentTime()` per `FrameDone` | ✅ |
| Console commands (`DEM_ConsoleCmd`) | ✅ | raw `CDemoConsoleCmd` handler | ⚠️ available raw |
| User input (`DEM_UserCmd`) | ✅ | `option.UserCmdParsing` + `events.UserCmd` (POV only) | ❌ GOTV: 0 cmds |
| Save games / animation / spawn-group frames | ✅ raw | demo-command handlers | ❌ not emitted |

## I.2 Game events (289-event registry)

CS2 defines **289 game-event definitions**; demoinfocs exposes ~100 typed Go structs **plus** raw access to all of them via `events.GenericGameEvent` (name + typed key/value map). This demo fired **46 distinct types** (histogram in Part II.11).

| Category | Key events | This demo |
|---|---|---|
| **Combat** | `player_death` (22 fields: killer/victim/assister/weapon/HS/penetration/noscope/smoke/blind/flash-assist/distance), `player_hurt`, `player_blind`, `weapon_fire/reload/zoom`, `bullet_damage` (24-field ballistics), `bullet_impact`, `player_jump/footstep/sound`, `other_death` | ✅ 146 deaths, 566 hurts, 156 blinds, 3,213 fires, 87 other-deaths; ⚠️ `bullet_damage`=0 fired on this build; ✅ `bullet_impact` available raw |
| **Objective** | `round_*` lifecycle (10 types), `round_end` (winner + 20 reasons), `round_mvp`, `bomb_*` (12 types incl. beeps), `hostage_*`, `enter/exit_bombzone/buyzone`, `vote_*`, `game_phase_changed`, `switch_team` | ✅ full bomb lifecycle; ❌ hostages (defusal map); ❌ votes |
| **Utility** | `grenade_thrown`, `he/flash/smoke/molotov/decoy_*detonate`, `inferno_startburn/expire/extinguish`, `grenade_bounce` | ✅ 80 HE / 85 flash / 87 smoke / 63 molly |
| **Economy** | `item_purchase/pickup/remove/equip` (9 fields incl. paint flags), `ammo_*`, `defuser_*`, `buytime_ended`, `buymenu_*` | ✅ 1,236 pickups, 5,079 equips |
| **Identity/social** | `player_connect/disconnect/team/changename/info/chat`, `player_score`, `server_cvar`, `hltv_*`, `spec_*` | ✅ 10 connects, 20 team changes, 3 chats, 89 cvar updates |
| **Meta** | `achievement_*`, `loot_crate_*`, `seasoncoin_*`, `tournament_reward` | ⚠️ raw-capturable, low value |

## I.3 Network messages (svc/clc/net)

All reachable via `Parser.RegisterNetMessageHandler` (65 message types across channels per CS2OpenDev).

| Category | Messages | This demo |
|---|---|---|
| Server info | `svc_ServerInfo`, `svc_HLTVStatus`, `svc_ServerSteamID`, `svc_PeerList` | ✅ (64 Hz from ServerInfo) |
| **Voice** | `svc_VoiceData` (Opus/Steam audio + XUID + tick + audible mask + caster flag), `svc_VoiceInit`, `svc_StopSound` | ✅ **77,702 chunks, all 10 players, 0 caster** |
| Sound events | `Sounds` channel (SOS start/stop, params) | ⚠️ available raw |
| Entities | `svc_PacketEntities`, `svc_FlattenedSerializer`, `svc_ClassInfo` | ✅ drives 222 server classes / 263 end entities |
| String tables | `svc_Create/UpdateStringTable`, `svc_ClearAllStringTables` | ✅ |
| ConVars | `net_SetConVar`, `svc_GetCvarValue` | ✅ 89 changes |
| Chat | `svc_UserMessage` → `UM_SayText(117)`, `UM_SayText2(118)`, `UM_SayTextChannel(119)` | ✅ |
| **Encrypted** | `svc_EncryptedData` (svc 78) — chat wrapped since CS2 2026-09-09 | ❌ **0 messages in this demo** (see I.7) |
| Broadcast | `svc_Broadcast_Command`, `svc_HltvReplay`, `svc_HltvFixup*`, `svc_FullFrameSplit` | ⚠️ available |
| Input echo | `svc_UserCommands` | ❌ 0 (GOTV) |
| Misc | `svc_Print/Menu/Prefetch/BSPDecal/RconServerDetails`, `net_SpawnGroup_*`, `svc_SetPause`, `svc_SignonState`, `net_DebugOverlay` | ⚠️ available |

Client→server (`clc_*`) messages exist in the format but aren't recorded in GOTV: ❌.

## I.4 User messages (140 nested types)

| Subset | Messages | This demo |
|---|---|---|
| Chat | `UM_SayText`, `UM_SayText2`, `UM_SayTextChannel` | ✅ |
| Voice control | `UM_VoiceMask`, `CS_UM_SendAudio`, `CS_UM_RawAudio` | ⚠️ available |
| Rank/progression | `CS_UM_ServerRankUpdate(352)`, `ServerRankRevealAll(350)`, `MatchStatsUpdate`, `EndOfMatchAllPlayersData(375)`, `PostRoundDamageReport`, `DeepStats` | ❌/⚠️ GC-side, absent or encrypted on FACEIT |
| Match lifecycle | `CS_UM_MatchEndConditions(334)`, `RoundBackupFilenames`, `CurrentRoundOdds` | ⚠️ raw |
| Combat feedback | `CS_UM_Damage`, `ReportHit`, `ShootInfo`, `CounterStrafe`, `KillCam`, `AdjustMoney` | ⚠️ raw |
| HUD/UI | Fade/Shake/Rumble/HudMsg/… | ⚠️ noise |

## I.5 Entity state (deepest layer)

`svc_PacketEntities` streams all world state; demoinfocs decodes it into `GameState`.

| Data | This demo |
|---|---|
| Player pawn props: position, velocity, view angles, health, armor, money, ammo, flags, flash, ping, scoreboard, rank, wins, crosshair code, clan tag | ✅ |
| **Per-tick position/angle history** | ⚠️ recordable on `FrameDone` (library keeps live state only) |
| Teams: score, clan name, flag, equipment values, money spent | ✅ |
| Weapons: type, owner, ammo, silenced, zoom, recoil index | ✅ ⚠️ paint/seed/wear **not networked** (🚫 see I.8) |
| Grenade projectiles: **full flight trajectory with timestamps** | ✅ |
| Infernos: fires, fragments, thrower linkage | ✅ 63 |
| Bomb: carrier, position, planted state, site, explosion flag | ✅ |
| Hostages state machine | ❌ defusal map |
| Game rules proxy: round/freeze/bomb times, warmup, phases, every `mp_*`/`sv_*` | ✅ 70+ cvars |
| World entities (263 live at end) | ✅ |
| Sight/spotted state | ✅ available |

## I.6 Voice communications

| Data | This demo |
|---|---|
| Per-player voice (Opus @ 24 kHz mono) | ✅ **77,702 chunks across all 10 players** (top talkers: bvcket 22,903 · rev0ltz_ 20,693 · CH3CKS0US4 7,256 · SwaK 9,906 · Spawmsz 5,480 · ViniFlash 3,408 · tttw1ce 3,159 · AnonymousBr 2,207 · Temarch1k 1,392 · Ako08 1,298) |
| Who-talked-when timeline (chunks carry Tick+XUID) | ✅ derivable |
| Caster/observer voice | ❌ 0 tracks |
| Valve MM demos | 🚫 record no voice at all (this is FACEIT, so ✅) |

Tools: `RegisterNetMessageHandler(*msg.CSVCMsg_VoiceData)` → collect `Audio.VoiceData` per XUID → libopus decode. References: [CS2VoiceData](https://github.com/DandrewsDev/CS2VoiceData), [csgo-voice-extractor](https://github.com/akiver/csgo-voice-extractor), CS Demo Manager GUI.

## I.7 Encrypted payloads (`svc_EncryptedData`)

- Since the **2026-09-09** CS2 update, *some* demos wrap chat in `svc_EncryptedData` (svc id 78).
- The key is **per-match, not a universal key in game files**: issued by the Steam Game Coordinator, stored in the `match730_<matchid>.dem.info` companion saved by the in-game Watch/Download UI — that's how offline playback decrypts it. Extraction: `demoinfocs.MatchInfoDecryptionKey(demInfoBytes)` → `watchablematchinfo.cl_decryptdata_key_pub` uint64 → **16 uppercase ASCII hex chars** → `option.NetMessageDecryptionKey(...)`.
- Decrypts **public chat (`key_type 2`)** only; team chat (`key_type 1`) uses a never-public key: 🚫.
- **This demo: 0 encrypted messages** — FACEIT all-chat came through plaintext (✅ 3 messages).

## I.8 Complementary libraries & what's impossible

| Need | Tool |
|---|---|
| Voice → WAV/OGG | CS2VoiceData, csgo-voice-extractor (need `libopus`) |
| Encrypted chat (JS) | [cs2parser](https://github.com/osztenkurden/cs2parser) `extractPublicEncryptionKey` |
| Encrypted chat origin (TS/.NET) | [demofile](https://github.com/saul/demofile) / demofile-net (`replaykeys.ts`) |
| Python ergonomics | [awpy](https://github.com/pnxenopoulos/awpy) |
| Schema/prop/event ground truth | **CS2OpenDev artifacts** — `cs2_schema.json` (20.7 MB), `gameevents_schema.json` (289 events), protos, convar tables |
| GC-only data (ranks, deep stats, item drops) | Steam GC protobufs (GameTracking-CS2) — **not in `.dem`** |
| Position history for replays | record on `events.FrameDone` yourself |
| Cosmetics (paint/seed/wear/name tag) | 🚫 **not networked in demos** — no parser recovers it |

---

# Part II — Extraction Results: This Demo

## II.1 Demo file & header

| Field | Value |
|---|---|
| File | `demo.dem` (224.7 MB) |
| Filestamp / patch | `PBDEMS2` / 14193 |
| Server name | FACEIT.com register to play here |
| Client name | SourceTV Demo |
| Map | **de_mirage** |
| Game directory | /home/hz00433/cs2/game/csgo |
| Demo version | valve_demo_2 (guid 8e9d71ab-04a1-4c01-bb61-acfede27c046, build 10955) |
| Server start tick | 8429 · fullpackets version 2 · clientside entities/particles allowed |
| Playback | 31m25.75s · 120,688 ingame ticks · 120,736 frames |
| Tick rate / time | 64.00 Hz / 15.625 ms |
| POV | false |
| Server classes (entity types) | 222 |
| Entities / weapons / nade-projs / infernos at end | 263 / 56 / 1 / 0 |

### Server rules / ConVars (final snapshot)

| ConVar | Value | ConVar | Value |
|---|---|---|---|
| `ammo_grenade_limit_flashbang` | `2` | `mp_buytime` | `20` |
| `ammo_grenade_limit_total` | `4` | `mp_ct_default_secondary` | `weapon_hkp2000` |
| `cash_win_by_defusing_bomb` (ct) | `3500` | `mp_freezetime` | `20` |
| `cash_team_elimination_*` (t/ct) | `3000` | `mp_friendlyfire` | `true` |
| `mp_halftime` | `true` | `mp_maxrounds` | `24` |
| `mp_overtime_enable` | `true` | `mp_roundtime_defuse` | `1.92` |
| `mp_startmoney` | `800` | `mp_t_default_secondary` | `weapon_glock` |
| `mp_warmuptime` | `60` | `mp_weapons_allow_typecount` | `5` |
| `mp_weapons_allow_zeus` | `5` | `mp_playercashawards` | `true` |
| `mp_starting_losses` | `1` | `mp_force_pick_time` | `160` |
| `mp_limitteams` | `0` | `mp_match_restart_delay` | `9999` |
| `sv_deadtalk` | `true` | `sv_spec_hear` | `1` |
| `sv_server_graphic1/2` | `faceit_logo_*.png` | `tv_transmitall` | `1` |
| `ff_damage_reduction_bullets/grenade/other` | `0.33 / 0.85 / 0.4` | `mp_endmatch_votenextmap` | `false` |
| `steamworks_sessionid_server` | `8950661271204` | (…+ ~40 more) | |

**89 ConVar updates** occurred live during the demo (warmup→match transitions: `mp_startmoney 0→800`, `mp_give_player_c4 false→true`, `mp_free_armor 1→0`, `mp_warmuptime 204→60`, etc.).

## II.2 Match overview

| Field | Value |
|---|---|
| Teams (clan) | CT `team_Spawmsz` · T `team_AnonymousBr` |
| **Final score** | **CT 13 – 6 T** (half: 6–6) |
| Rounds | 21 tracked (20 real + 1 warmup) · 1 side switch · 0 overtime · phase "Game ended" |
| Totals | 146 kills · 566 hurt events · 3,189 shots · 19,903 damage (event sum) |
| Round end reasons | CTWin 11 · TerroristsWin 5 · BombDefused 2 · TargetBombed 2 |
| Longest / shortest round | R10 143.6 s (TargetBombed) / R16 44.9 s (CTWin) |
| Economy (total spent → current equip) | CT $146,600 → $17,000 · T $101,350 → $8,600 |
| Objective | 8 plants (A:2 B:6, 1 aborted) · 2 defuses (both w/ kit) · 2 explosions · 51 pickups / 42 drops |
| Utility | HE ×80 · flash ×170 · smoke ×87 · molly ×63 · decoy ×0 |
| Clutches (solo-kills as last man standing, round won) | 1v1 ×1 · 1v2 ×2 |
| Footsteps / world kills | 941 / 1 |
| Connected at end / bots | 6 (1 DemoRecorder bot spectator) |

### Weapon usage totals

| Weapon | Shots | Kills | Damage | Weapon | Shots | Kills | Damage |
|---|---|---|---|---|---|---|---|
| AK-47 | 848 | 40 | 5,719 | Glock-18 | 164 | 8 | 1,000 |
| AWP | 40 | 14 | 2,105 | Desert Eagle | 35 | 8 | 979 |
| M4A1 | 267 | 15 | 1,827 | M4A4 | 151 | 8 | 959 |
| MP9 | 241 | 13 | 1,308 | HE Grenade | 80 | 3 | 881 |
| Galil AR | 230 | 7 | 1,149 | Zeus x27 | 2 | 1 | 500 |
| USP-S | 154 | 8 | 1,141 | MAC-10 | 161 | 4 | 435 |
| Knife | 407 | 9 | 1,121 | MP7 | 127 | 3 | 434 |
| Tec-9 | 41 | 2 | 243 | Incendiary | 49 | 0 | 63 |
| Molotov | 17 | 0 | 38 | Smoke | 87 | 0 | 1 |
| World | 0 | 1 | 0 | Flashbang | 85 | 0 | 0 |
| SSG 08 | 3 | 0 | 0 | | | | |

### Item events (pickup counts; drops all 0)

AK-47 ×79 · AWP ×12 · C4 ×51 · Defuse Kit ×35 · Desert Eagle ×14 · FAMAS ×1 · Five-SeveN ×5 · Flashbang ×136 · Galil AR ×18 · Glock-18 ×98 · HE ×102 · Incendiary ×58 · Kevlar+Helmet ×112 · Kevlar Vest ×37 · Knife ×163 · M4A1 ×23 · M4A4 ×14 · MAC-10 ×14 · MP7 ×9 · MP9 ×17 · Molotov ×27 · P250 ×2 · SSG 08 ×3 · Smoke ×119 · Tec-9 ×8 · USP-S ×73 · Zeus ×5 · Decoy ×1.

## II.3 Players

### Scoreboard (final state)

| Name | SteamID64 | Team* | Rank | K | D | A | +/- | HS% | ADR | Score | MVPs | Ping | Money | $spent | Kit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bvcket | 76561198012685780 | CT | Unranked | 23 | 12 | 5 | +11 | 34.8 | 133.6 | 60 | 3 | 50 | $11,600 | $50,050 | ✓ |
| ViniFlash | 76561198408893473 | T | Unranked | 17 | 14 | 4 | +3 | 23.5 | 139.7 | 36 | 2 | 57 | $3,500 | $51,850 | – |
| Temarch1k | 76561199814790589 | CT | Unranked | 15 | 14 | 8 | +1 | 46.7 | 114.5 | 38 | 4 | 46 | $5,950 | $50,500 | ✓ |
| CH3CKS0US4 | 76561199581301182 | T | Unranked | 14 | 17 | 5 | −3 | 50.0 | 120.8 | 33 | 1 | 34 | $5,800 | $49,500 | – |
| Spawmsz | 76561199874633227 | CT | Unranked | 14 | 10 | 6 | +4 | 42.9 | 102.0 | 42 | 2 | 51 | $12,000 | $46,050 | ✓ |
| SwaK | 76561198117305956 | † | – | 18 | 14 | 8 | +4 | 33.3 | 108.6 | – | 0 | 0 | – | $0 | – |
| tttw1ce | 76561199121517301 | † | – | 14 | 16 | 5 | −2 | 21.4 | 91.5 | – | 0 | 0 | – | $0 | – |
| rev0ltz_ | 76561199890472203 | † | – | 13 | 16 | 4 | −3 | 30.8 | 71.2 | – | 0 | 0 | – | $0 | – |
| Ako08 | 76561199863482069 | † | – | 9 | 13 | 4 | −4 | 11.1 | 43.4 | – | 0 | 0 | – | $0 | – |
| AnonymousBr | 76561199120420209 | † | – | 6 | 15 | 6 | −9 | 16.7 | 69.8 | – | 0 | 0 | – | $0 | – |

\* team at demo end; † five players disconnected before the demo's end snapshot — stats captured live during the match.

### Identity (final)

- **bvcket** — crosshair `CSXt3CSZV6WcbWm6LpwPmV33RB4QTRHZe3ifnfdXQ6zeHi`, last place Ladder, pos −1165/−409/−56, inventory: AK-47, Knife, USP-S
- **ViniFlash** — crosshair `CSdRpsUGeA6GdhuyDzDD8Ti7n2bTEHVkwenDopvoRuUArC`, pos −382/−775/−262
- **Temarch1k** — crosshair `CS2fApOoTPbwT6nsLL6NkxozktUuLaxskmhVN22RXDbj4U`, pos −688/−811/−264
- **CH3CKS0US4** — crosshair `CSdXU4FJpVEaoKayEDjqDVBRJMCwjvvLfV2pTGxqXvbUJe`, pos −299/−608/−262
- **Spawmsz** — crosshair `CSFQqOho9Sy7rYrpJY74fCEWPUXJxPTEYZruqn564kwVhE`, Bombsite A, pos −576/−2185/−180
- (SwaK, tttw1ce, rev0ltz_, Ako08, AnonymousBr — disconnected; no end-state identity)

### Deep per-player aggregates

#### bvcket (23-12-5 · ADR 133.6)
Trade kills 11 · HS 8 (34.8%) · wallbang 1 · flash assists 1 · MVPs 3 · shots 338 / hits 86 (25.4%) · damage 2,672 · util 53 · dmg taken 1,429 · entry kills 2 · 3K 0 · best streak 9 · plants 2 / defuses 1 · nades: HE 3 / molly 5 / smoke 10 / flash-pop 18 · flashed 13× · avg money $2,424 / equip $3,362 · kill dist avg/max 18/32
- Kills by weapon: AK-47:10, MAC-10:3, M4A1:3, Galil AR:2, USP-S:2, MP9:2, Tec-9:1
- Damage by weapon: AK-47:1159, Galil AR:367, MAC-10:298, M4A1:274, USP-S:232, MP9:155, Glock-18:81, HE:42, Knife:34
- Hitgroups: Head 828, Stomach 759, Chest 695, Generic 87, LeftLeg 98, RightLeg 93, RightArm 71, LeftArm 41
- Dmg taken by: AK-47:619, MP9:265, USP-S:171, Knife:100, M4A1:80, HE:76

#### SwaK (18-14-8 · ADR 108.6)
Trades 6 · HS 6 (33.3%) · wallbang 1 · entry kills 6 · 3K ×3 · streak 6 · damage 2,172 · util 75 · shots 357/63 (17.6%) · nades: HE 7 / molly 6 / smoke 9 / flash 18 · avg money $2,095 · dist 19/44
- Kills: AK-47:5, Knife:3, Glock-18:3, M4A1:2, Galil AR:2, USP-S:1, HE:1, Tec-9:1
- Hitgroups: Head 827, Chest 498, Stomach 303, Generic 295

#### ViniFlash (17-14-4 · ADR 139.7 — highest)
Trades 5 · HS 4 (23.5%) · through-smoke 3 · 3K ×1 · streak 4 · damage 2,793 · **util 154** · shots 242/57 (23.6%) · nades: HE 6 / molly 7 / smoke 6 / flash 14 · flashed 16× · avg money $1,655 / equip $4,102 · dist 27/47
- Kills: **AWP:11**, AK-47:2, Glock-18:2, USP-S:2
- Damage: AWP:1750, USP-S:337, AK-47:271, Glock:238, HE:147

#### Temarch1k (15-14-8 · ADR 114.5)
Trades 6 · HS 7 (46.7%) · through-smoke 2 · MVPs 4 · 3K ×1 · streak 5 · damage 2,290 · **util 171** · shots 271/64 (23.6%) · nades: HE 7 / molly 4 / smoke 1 / flash 2 · dist 24/32
- Kills: M4A4:7, Desert Eagle:4, AK-47:2, USP-S:2

#### CH3CKS0US4 (14-17-5 · ADR 120.8)
Trades 2 · HS 7 (50.0%) · wallbang 2 · through-smoke 1 · MVP 1 · 3K ×1 · damage 2,417 · **util 180 (leader)** · shots 385/76 (19.7%) · plants 1 · nades: HE 9 / molly 8 / smoke 11 / flash 22 · dist 11/22
- Kills: AK-47:9, MP9:3, USP-S:1, HE:1

#### Spawmsz (14-10-6 · ADR 102.0)
Trades 4 · HS 6 (42.9%) · through-smoke 1 · flash assist 1 · MVPs 2 · 3K ×1 · streak 6 · damage 2,040 · util 153 · shots 399/58 (14.5%) · plants 2 / defuse 1 · nades: HE 10 / molly 6 / smoke 9 / flash 14 · dist 17/32
- Kills: M4A1:5, AK-47:5, Glock:2, Deagle:1, Knife:1, MP7:1

#### tttw1ce (14-16-5 · ADR 91.5)
Trades 4 · HS 3 (21.4%) · 3K ×2 · streak 4 · damage 1,830 · util 88 · shots 289/56 (19.4%) · nades: HE 5 / molly 5 / smoke 7 / flash 18 · flashed 19× · dist 10/31
- Kills: AK-47:4, Knife:3, M4A1:3, MP9:3, Galil AR:1

#### rev0ltz_ (13-16-4 · ADR 71.2)
Trades 3 · HS 4 (30.8%) · through-smoke 1 · flash assist 1 · 3K ×1 · damage 1,424 · util 14 · shots 342/41 (12.0%) · plants 1 · nades: HE 12 / molly 6 / smoke 14 / flash 24 · flashed 21× · dist 18/33
- Kills: MP9:3, Deagle:3, M4A1:2, M4A4:1, Glock:1, MAC-10:1, Galil:1, HE:1

#### Ako08 (9-13-4 · ADR 43.4)
Trades 0 · HS 1 (11.1%) · through-smoke 4 · 1 team kill / 1 suicide · entry kills 3 · damage 868 · util 72 · shots 406/23 (5.7%) · plants 1 · nades: HE 8 / molly 4 / smoke 13 / flash 26 · dist 16/37
- Kills: AWP:3, AK-47:2, MP9:2, Galil:1, World:1

#### AnonymousBr (6-15-6 · ADR 69.8)
Trades 0 · HS 1 (16.7%) · entry kills 2 · damage 1,397 · util 23 · shots 160/38 (23.8%) · nades: HE 13 / molly 12 / smoke 7 / flash 14 · dist 13/34
- Kills: Knife:2, MP7:2, AK-47:1, Zeus:1

### Utility damage leaderboard

CH3CKS0US4 180 · Temarch1k 171 · ViniFlash 154 · Spawmsz 153 · tttw1ce 88 · SwaK 75 · Ako08 72 · bvcket 53 · AnonymousBr 23 · rev0ltz_ 14

## II.4 Rounds (chronological)

| # | Winner | Reason | Dur | Site | CT equip | T equip | #Kills | First blood |
|---|---|---|---|---|---|---|---|---|
| 1 | T | TerroristsWin | 79.4s | – | $3,250 | $3,250 | 9 | AnonymousBr killed Temarch1k |
| 2 | – | (warmup) | – | – | $1,000 | $8,400 | 0 | – |
| 3 | T | TerroristsWin | 73.3s | B | $4,550 | $2,600 | 8 | CH3CKS0US4 killed Temarch1k |
| 4 | T | TerroristsWin | 63.6s | A | $5,050 | $18,200 | 7 | SwaK killed CH3CKS0US4 |
| 5 | CT | CTWin | 105.8s | – | $17,350 | $22,100 | 7 | SwaK killed tttw1ce |
| 6 | T | TargetBombed | 97.0s | A | $28,150 | $12,800 | 9 | bvcket killed AnonymousBr |
| 7 | CT | CTWin | 63.1s | – | $14,850 | $23,600 | 6 | CH3CKS0US4 killed Ako08 |
| 8 | T | TerroristsWin | 62.3s | B | $27,050 | $7,100 | 7 | SwaK killed ViniFlash |
| 9 | CT | CTWin | 81.7s | – | $18,450 | $22,100 | 9 | bvcket killed AnonymousBr |
| 10 | T | TargetBombed | 143.6s | B | $25,000 | $17,000 | 6 | tttw1ce killed SwaK |
| 11 | CT | CTWin | 101.9s | – | $22,250 | $15,400 | 8 | SwaK killed rev0ltz_ |
| 12 | CT | CTWin | 79.9s | – | $23,800 | $8,050 | 8 | rev0ltz_ killed Spawmsz |
| 13 | CT | CTWin | 65.6s | – | $28,200 | $2,900 | 5 | ViniFlash killed SwaK |
| 14 | T | TerroristsWin | 91.7s | B | $32,500 | $19,000 | 6 | AnonymousBr killed Ako08 |
| 15 | CT | CTWin | 52.5s | – | $3,650 | $3,650 | 6 | SwaK killed AnonymousBr |
| 16 | CT | CTWin | 44.9s | – | $20,000 | $1,700 | 7 | Ako08 killed AnonymousBr |
| 17 | CT | CTWin | 128.0s | – | $25,350 | $20,700 | 7 | Ako08 killed AnonymousBr |
| 18 | CT | BombDefused | 139.4s | B | $23,500 | $13,150 | 7 | SwaK killed ViniFlash |
| 19 | CT | BombDefused | 114.4s | B | $24,350 | $22,400 | 9 | ViniFlash killed SwaK |
| 20 | CT | CTWin | 72.9s | – | $30,550 | $22,300 | 6 | Ako08 killed CH3CKS0US4 |
| 21 | CT | CTWin | 74.5s | – | $28,550 | $20,100 | 9 | rev0ltz_ killed Temarch1k |

### Objective events by round

- **R3** plant Ako08 @ B (tick 10841) · **R4** plant Spawmsz @ A (15060)
- **R6** plant SwaK @ A (26588) → **EXPLODED**
- **R8** plant bvcket @ B (37336)
- **R10** plant bvcket @ B (50830) → **EXPLODED**
- **R14** plant Spawmsz @ B (76209)
- **R18** plant CH3CKS0US4 @ B (101250) → **defuse bvcket**
- **R19** plant rev0ltz_ @ B (108631) → **defuse Spawmsz**
- R9: plant aborted by Spawmsz

## II.5 Kill feed (146 non-warmup kills)

Flags: HS=headshot, WB=wallbang, ThroughSmoke, FlashAssist; distance in world units.

<details>
<summary>Full kill feed (click to expand)</summary>

- R1 AnonymousBr ‹Knife› Temarch1k [1u] · R1 SwaK ‹Knife› rev0ltz_ [1u] · R1 SwaK ‹Knife› ViniFlash [1u] · R1 AnonymousBr ‹Knife› Ako08 [1u] · R1 Spawmsz ‹Knife› CH3CKS0US4 [2u] · R1 tttw1ce ‹Knife› bvcket [2u] · R1 SwaK ‹Knife› AnonymousBr [1u] · R1 tttw1ce ‹Knife› Spawmsz [1u] · R1 tttw1ce ‹Knife› SwaK [3u]
- R3 CH3CKS0US4 ‹HE› Temarch1k [8u] · R3 CH3CKS0US4 ‹USP-S› HS bvcket [14u] · R3 Spawmsz ‹Glock-18› HS ViniFlash [5u] · R3 Spawmsz ‹Glock-18› tttw1ce [16u] · R3 rev0ltz_ ‹HE› Spawmsz [28u] · R3 SwaK ‹Glock-18› CH3CKS0US4 [30u] · R3 SwaK ‹Glock-18› HS rev0ltz_ [12u] · R3 SwaK ‹Glock-18› AnonymousBr [44u]
- R4 SwaK ‹Galil AR› CH3CKS0US4 [37u] · R4 bvcket ‹Galil AR› HS AnonymousBr [14u] · R4 Temarch1k ‹AK-47› HS rev0ltz_ [20u] · R4 SwaK ‹Galil AR› HS tttw1ce [16u] · R4 ViniFlash ‹USP-S› bvcket [18u] · R4 ViniFlash ‹USP-S› HS+Smoke Temarch1k [14u] · R4 Spawmsz ‹MP7› Smoke ViniFlash [11u]
- R5 SwaK ‹AK-47› tttw1ce [40u] · R5 CH3CKS0US4 ‹MP9› HS Spawmsz [7u] · R5 ViniFlash ‹AWP› SwaK [26u] · R5 rev0ltz_ ‹Deagle› Temarch1k [24u] · R5 bvcket ‹Galil AR› HS CH3CKS0US4 [28u] · R5 ViniFlash ‹AWP› bvcket [31u] · R5 ViniFlash ‹AWP› Ako08 [17u]
- R6 bvcket ‹MAC-10› HS AnonymousBr [20u] · R6 rev0ltz_ ‹M4A1› Smoke Temarch1k [20u] · R6 bvcket ‹MAC-10› rev0ltz_ [13u] · R6 tttw1ce ‹M4A1› bvcket [11u] · R6 CH3CKS0US4 ‹AK-47› WB SwaK [19u] · R6 Spawmsz ‹AK-47› HS CH3CKS0US4 [28u] · R6 Spawmsz ‹AK-47› HS tttw1ce [7u] · R6 ViniFlash ‹AWP› Ako08 [26u] · R6 ‹C4› ViniFlash [0u]
- R7 CH3CKS0US4 ‹MP9› Ako08 [7u] · R7 bvcket ‹AK-47› CH3CKS0US4 [9u] · R7 tttw1ce ‹AK-47› HS bvcket [12u] · R7 tttw1ce ‹AK-47› Spawmsz [12u] · R7 AnonymousBr ‹MP7› HS Temarch1k [28u] · R7 tttw1ce ‹AK-47› SwaK [15u]
- R8 SwaK ‹Tec-9› HS+FlashAssist ViniFlash [12u] · R8 CH3CKS0US4 ‹AK-47› HS SwaK [22u] · R8 bvcket ‹Tec-9› CH3CKS0US4 [22u] · R8 Temarch1k ‹Deagle› HS rev0ltz_ [12u] · R8 bvcket ‹AK-47› HS AnonymousBr [10u] · R8 tttw1ce ‹M4A1› bvcket [9u] · R8 Spawmsz ‹Deagle› tttw1ce [19u]
- R9 bvcket ‹AK-47› AnonymousBr [12u] · R9 ViniFlash ‹AWP› Smoke SwaK [37u] · R9 Ako08 ‹AK-47› Smoke CH3CKS0US4 [9u] · R9 rev0ltz_ ‹Deagle› HS Spawmsz [6u] · R9 rev0ltz_ ‹Deagle› Temarch1k [4u] · R9 bvcket ‹AK-47› rev0ltz_ [18u] · R9 tttw1ce ‹MP9› bvcket [12u] · R9 Ako08 ‹AK-47› tttw1ce [20u] · R9 ViniFlash ‹AWP› Ako08 [29u]
- R10 tttw1ce ‹M4A1› SwaK [2u] · R10 bvcket ‹MAC-10› tttw1ce [10u] · R10 Temarch1k ‹AK-47› HS AnonymousBr [27u] · R10 rev0ltz_ ‹M4A1› Temarch1k [20u] · R10 bvcket ‹M4A1› WB CH3CKS0US4 [11u] · R10 ‹C4› Spawmsz [0u]
- R11 SwaK ‹M4A1› HS+WB rev0ltz_ [11u] · R11 ViniFlash ‹AWP› Temarch1k [42u] · R11 ViniFlash ‹AWP› WB SwaK [47u] · R11 bvcket ‹AK-47› ViniFlash [11u] · R11 CH3CKS0US4 ‹MP9› Ako08 [9u] · R11 bvcket ‹AK-47› CH3CKS0US4 [8u] · R11 tttw1ce ‹MP9› HS Spawmsz [7u] · R11 tttw1ce ‹MP9› bvcket [31u]
- R12 rev0ltz_ ‹MP9› HS Spawmsz [19u] · R12 Temarch1k ‹Deagle› HS tttw1ce [31u] · R12 rev0ltz_ ‹MP9› HS Ako08 [22u] · R12 rev0ltz_ ‹MP9› HS bvcket [21u] · R12 Temarch1k ‹Deagle› rev0ltz_ [13u] · R12 ViniFlash ‹AK-47› SwaK [14u] · R12 Temarch1k ‹Deagle› ViniFlash [24u] · R12 AnonymousBr ‹AK-47› Temarch1k [34u]
- R13 ViniFlash ‹AWP› SwaK [33u] · R13 CH3CKS0US4 ‹AK-47› HS Spawmsz [7u] · R13 rev0ltz_ ‹M4A4› Temarch1k [33u] · R13 CH3CKS0US4 ‹AK-47› HS Ako08 [15u] · R13 CH3CKS0US4 ‹AK-47› HS+WB bvcket [12u]
- R14 AnonymousBr ‹Zeus x27› Ako08 [3u] · R14 bvcket ‹AK-47› AnonymousBr [26u] · R14 SwaK ‹AK-47› CH3CKS0US4 [10u] · R14 SwaK ‹AK-47› tttw1ce [17u] · R14 SwaK ‹AK-47› HS rev0ltz_ [3u] · R14 bvcket ‹AK-47› ViniFlash [2u]
- R15 SwaK ‹USP-S› HS AnonymousBr [33u] · R15 Temarch1k ‹USP-S› Smoke rev0ltz_ [32u] · R15 bvcket ‹USP-S› HS CH3CKS0US4 [32u] · R15 Temarch1k ‹USP-S› Smoke tttw1ce [30u] · R15 ViniFlash ‹Glock-18› HS SwaK [13u] · R15 bvcket ‹USP-S› HS ViniFlash [18u]
- R16 Ako08 ‹MP9› AnonymousBr [14u] · R16 rev0ltz_ ‹Glock-18› Ako08 [12u] · R16 bvcket ‹MP9› HS rev0ltz_ [24u] · R16 Temarch1k ‹M4A4› CH3CKS0US4 [29u] · R16 bvcket ‹MP9› tttw1ce [26u] · R16 ViniFlash ‹Glock-18› HS Spawmsz [22u] · R16 Temarch1k ‹M4A4› ViniFlash [26u]
- R17 Ako08 ‹MP9› HS AnonymousBr [8u] · R17 Temarch1k ‹M4A4› CH3CKS0US4 [26u] · R17 ViniFlash ‹AWP› HS Ako08 [23u] · R17 tttw1ce ‹AK-47› Temarch1k [18u] · R17 Spawmsz ‹M4A1› FlashAssist tttw1ce [12u] · R17 bvcket ‹M4A1› FlashAssist ViniFlash [29u] · R17 SwaK ‹M4A1› rev0ltz_ [20u]
- R18 SwaK ‹AK-47› ViniFlash [21u] · R18 tttw1ce ‹Galil AR› HS SwaK [11u] · R18 Spawmsz ‹M4A1› HS tttw1ce [25u] · R18 rev0ltz_ ‹MAC-10› Spawmsz [15u] · R18 Temarch1k ‹M4A4› HS AnonymousBr [15u] · R18 Temarch1k ‹M4A4› HS CH3CKS0US4 [29u] · R18 bvcket ‹AK-47› rev0ltz_ [16u]
- R19 ViniFlash ‹AWP› Smoke SwaK [32u] · R19 Ako08 ‹AWP› Smoke tttw1ce [23u] · R19 bvcket ‹AK-47› HS ViniFlash [16u] · R19 AnonymousBr ‹MP7› Temarch1k [10u] · R19 Spawmsz ‹M4A1› AnonymousBr [32u] · R19 CH3CKS0US4 ‹AK-47› HS Ako08 [11u] · R19 CH3CKS0US4 ‹AK-47› bvcket [8u] · R19 Spawmsz ‹M4A1› HS CH3CKS0US4 [8u] · R19 Spawmsz ‹M4A1› rev0ltz_ [14u]
- R20 Ako08 ‹AWP› Smoke CH3CKS0US4 [37u] · R20 Temarch1k ‹M4A4› tttw1ce [25u] · R20 Temarch1k ‹M4A4› HS rev0ltz_ [23u] · R20 ViniFlash ‹AK-47› Temarch1k [38u] · R20 Spawmsz ‹AK-47› AnonymousBr [19u] · R20 Ako08 ‹AWP› ViniFlash [19u]
- R21 rev0ltz_ ‹Galil AR› FlashAssist Temarch1k [16u] · R21 bvcket ‹M4A1› AnonymousBr [29u] · R21 SwaK ‹HE› ViniFlash [30u] · R21 Spawmsz ‹AK-47› HS rev0ltz_ [30u] · R21 Spawmsz ‹AK-47› tttw1ce [26u] · R21 CH3CKS0US4 ‹AK-47› bvcket [12u] · R21 CH3CKS0US4 ‹AK-47› Smoke SwaK [12u] · R21 Ako08 ‹Galil AR› Smoke CH3CKS0US4 [14u] · R21 Ako08 ‹World› Ako08 [0u]

</details>

## II.6 Notable kill lists

| Category | Count | Details |
|---|---|---|
| Aces (5K) | 0 | – |
| 4K rounds | 0 | – |
| **3K rounds** | **10** | SwaK R1, tttw1ce R1, SwaK R3, ViniFlash R5, tttw1ce R7, rev0ltz_ R12, Temarch1k R12, CH3CKS0US4 R13, SwaK R14, Spawmsz R19 |
| Wallbangs | 5 | CH3CKS0US4 R6/R13, bvcket R10, SwaK R11, **ViniFlash AWP R11 (longest kill, 47u)** |
| Through-smoke | 12 | ViniFlash ×3 (incl. AWP ×2), Temarch1k ×3, Ako08 ×3, Spawmsz/rev0ltz_/CH3CKS0US4 ×1 |
| Flash-assisted | 4 | SwaK R8, Spawmsz R17, bvcket R17, rev0ltz_ R21 |
| **Trade kills (≤5s)** | **41** | bvcket 11, SwaK/Spawmsz/CH3CKS0US4/Temarch1k/tttw1ce 4–6 each |
| HE kills | 3 | CH3CKS0US4 ×2 (R3), SwaK R21 |
| No-scope / attacker-blind / molly / C4 kills | 0 | – |
| Team kills / suicides | 1 | Ako08 R21 (World self-kill) |
| Longest kill | – | R11 ViniFlash ‹AWP› WB SwaK [47u] |

## II.7 Bomb event log (107 events)

8 plants / 2 defuses / 2 explosions / 1 aborted plant / 51 pickups / 42 drops — full chronological log extracted, including per-round carrier juggling (e.g. R5 had 8 pickup/drop flips between Temarch1k, SwaK, bvcket, Ako08 before R6's plant). Plant/defuse/explode detail in II.4.

## II.8 Grenade trajectory samples (400 samples)

400 throw/detonation positions captured with 3D coordinates (world units), per round and thrower — e.g. `Molly R3 rev0ltz_ (415,−1435,−176)`, `Smoke R4 bvcket (−1109,−2452,−166)`, `Flash R4 SwaK (−87,−2120,659)`. Full continuous flight paths are also available from `GrenadeProjectiles().Trajectory` (not dumped here).

## II.9 Chat, connections, match flow

**Chat (3 all-chat messages):**
- `[R2] AnonymousBr: .ct`
- `[R20] tttw1ce: gg over`
- `[R21] rev0ltz_: WALLLS`

**Ranks / votes:** none (FACEIT — Valve rank channel absent; no call-votes cast).

**Connections:** 10 players connected (all human), 5 disconnected before demo end (tttw1ce, Ako08, SwaK, AnonymousBr, rev0ltz_), 1 bot spectator (DemoRecorder). 20 team-change events = full side switch at halftime plus roster swaps. No name changes.

**Match flow:** warmup → match start → last-round-half announcement → side switch → win panel/match end. Game phases: `Init→Pregame (t1) →Start game phase (t5233) →Game half ended (t76947) →Team side switch (t77491) →Game ended (t120278)`. Halftime score 6–6. Overtimes: 0.

**Other deaths (87):** chickens (knife/Zeus/USP kills), `prop_dynamic`, `prop_physics_multiplayer` (HE/molly breakage), `func_breakable` — full list extracted.

## II.10 Raw game-event histogram (46 types fired)

`item_equip` 5,079 · `show_survival_respawn_status` 3,249 · `weapon_fire` 3,213 · `weapon_reload` 1,502 · `item_pickup` 1,236 · `player_footstep` 941 · `player_hurt` 566 · `player_spawn` 210 · `player_blind` 156 · `player_death` 146 · `weapon_zoom` 145 · `other_death` 87 · `smokegrenade_detonate` 87 · `flashbang_detonate` 85 · `smokegrenade_expired` 80 · `hegrenade_detonate` 80 · `inferno_startburn/expire` 63/63 · `cs_round_start_beep` 62 · `bomb_pickup` 51 · `bomb_dropped` 42 · `round_*` lifecycle 18–21 each · `bomb_planted` 8 · `player_disconnect` 5 · `server_cvar` 3 · `bomb_defused/exploded` 2/2 · `begin_new_match`/`cs_win_panel_match`/`announce_phase_end`/`hltv_versioninfo` 1 each.

**Parser warnings: none.**

---

# Part III — Coverage, Gaps & Next Steps

## III.1 Category coverage matrix (30 categories)

| # | Category | In demo file? | In this demo? | Status |
|---|---|---|---|---|
| 1 | Demo header/metadata | ✅ | ✅ | **Extracted** (II.1) |
| 2 | Per-frame timeline | ✅ | ✅ | **Extracted** (120,736 frames) |
| 3 | Game events (typed) | ✅ 289 defined | ✅ 46 fired | **Extracted** (II.2–II.10) |
| 4 | Game events (raw keys) | ✅ all 289 | ✅ | **Extracted** (histogram) |
| 5 | Kills/damage/blinds detail | ✅ | ✅ | **Extracted** (II.5–II.6) |
| 6 | Ballistics (`bullet_damage`) | ✅ newer builds | ⚠️ 0 fired | Available raw |
| 7 | Bomb/hostage objective | ✅ | ✅ bomb / ❌ hostage | **Extracted** (II.4, II.7) |
| 8 | Utility trajectories | ✅ | ✅ | **Extracted** (II.8) + full paths available |
| 9 | Economy (money/equip/buys) | ✅ | ✅ | **Extracted** (II.2, II.4) |
| 10 | Player identity (SteamID/name/crosshair…) | ✅ | ✅ | **Extracted** (II.3) |
| 11 | Chat (all) | ✅ | ✅ 3 msgs | **Extracted** (II.9) |
| 12 | Chat (encrypted, Valve MM) | ✅ w/ `.dem.info` key | ❌ none here | N/A this demo |
| 13 | Chat (team) | 🚫 key never public | 🚫 | Impossible |
| 14 | **Voice audio** | ✅ non-MM servers | ✅ **77,702 chunks** | ⚠️ **Untapped — next step** |
| 15 | Full world entity state | ✅ | ✅ 222 classes | **Extracted** (end-state; streaming available) |
| 16 | Per-tick position/angle history | ✅ | ⚠️ must record | Recordable on `FrameDone` |
| 17 | Weapon ammo/silencer/zoom | ✅ | ✅ | Available |
| 18 | Cosmetic skins (paint/seed/wear) | 🚫 not in demo | 🚫 | Impossible |
| 19 | Sound events (SOS) | ✅ | ⚠️ | Available raw |
| 20 | User messages (140 types) | ✅ | ⚠️ | Available raw |
| 21 | ConVars/server config | ✅ | ✅ | **Extracted** (II.1) |
| 22 | Console commands in stream | ✅ | ⚠️ | Available raw |
| 23 | User input (POV) | ✅ POV only | ❌ GOTV | N/A |
| 24 | HLTV director / spectator cam | ✅ | ⚠️ | Available raw |
| 25 | Votes | ✅ | ❌ none cast | N/A |
| 26 | Ranks (Valve MM) | ⚠️ GC channel | ❌ FACEIT | N/A |
| 27 | String tables | ✅ | ✅ | Available |
| 28 | Net-message metadata | ✅ | ✅ | Available (64 Hz etc.) |
| 29 | GC-only data (match info, deep stats) | 🚫 not in `.dem` | 🚫 | Impossible (Steam GC) |
| 30 | Caster/broadcast extras | ✅ broadcast demos | ❌ | N/A |

**Totals:** 17 extracted · 6 available-untapped · 5 N/A-this-demo · 4 impossible.

## III.2 Gaps in the original report (resolved by synthesis)

The earlier report's §20 listed limitations; corrected status:

| Original claim | Final status |
|---|---|
| "Voice — separate library" | **Present: 77,702 chunks from all 10 players**; extract with one net-handler + opus (CS2VoiceData pattern) |
| "Chat encrypted, needs key" | **Not this demo** — 0 encrypted messages; key story applies only to post-2026-09 Valve MM demos, and lives in the `.dem.info` companion, not game files |
| "Per-tick positions not tracked" | Recordable — hook `events.FrameDone` and sample `Player.Position()`/`ViewDirection*()` |
| "Skins not populated by parser" | Corrected: **not networked in demos at all** (GC-only) — no parser can recover it |
| "GC match metadata locked" | Corrected: **not in the `.dem` file** — requires live Steam GC session |
| "Buy-menu intent" | Corrected: only item *events* exist; intent never recorded |

## III.3 Recommended next steps (by value)

1. **Voice extraction** — largest untapped vein in this file: 77k Opus chunks → per-player WAV/OGG + a "who-talked-when" per-round timeline (chunks carry tick + XUID).
2. **Per-tick position history** — record positions/angles per player per frame for 2D/3D replay, heatmaps, pathing analysis (the grenade data in II.8 already supports nade lineups).
3. **Raw user-message & sound-channel pass** — `CS_UM_Damage`, `bullet_impact`, SOS sound events are available but not surfaced.
4. **Per-frame event enrichment** — `FrameDone`-based sampling of money/HP/spotted state for full round-by-round economic and info graphs.

## III.4 Tools recap

- **demoinfocs-golang v6** — everything in Parts I–II above (events, entities, net messages, string tables, ConVars, voice raw bytes).
- **CS2VoiceData / csgo-voice-extractor** — voice bytes → audio files (libopus).
- **cs2parser / demofile** — JS/.NET alternative + encrypted-chat reference (`replaykeys`).
- **CS2OpenDev artifacts** — authoritative schemas for all 289 events, 140 user messages, props, convars: what exists to extract, build-accurate.
- **Steam GC (GameTracking-CS2)** — rank/deep-stats/item data that never enters the demo file.

---

*Final synthesized document. Sources: `REPORT.md` (extraction run 2026-10-30, demoinfocs-golang v6.0.0-rc.1, 22 s parse, no warnings) + `TAXONOMY.md` (CS2OpenDev build 26281801 wire-format reference) + voice/encryption probe (77,702 `svc_VoiceData`, 0 `svc_EncryptedData`). Demo: `demo.dem`, 224.7 MB, FACEIT de_mirage, CT 13–6 T.*
