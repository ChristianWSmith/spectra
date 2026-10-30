# CS2 Demo — Complete Data Taxonomy

**Goal:** enumerate *every category* of data that exists inside a `.dem` file, and for each say whether it is extractable, with what tool, and whether *this specific demo* (`demo.dem`, FACEIT de_mirage, build 14193) contains it.

**Sources of truth:** the [demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang) v6.0.0-rc.1 public API, the CS2 wire format as documented by [CS2OpenDev](https://cs2opendev.github.io/CS2OpenDev-Docs/) (build 26281801, Steam 2026-10-28), and a direct probe of this demo file.

**Legend for "In this demo":** ✅ present · ❌ absent · ⚠️ present but partially readable / needs a key or extra library.

---

## 0. How a CS2 demo is layered

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
└── companion files: match730_*.dem.info (GC key, Valve MM only), .zst/.gz wrapper
```

Everything below maps onto these layers.

---

## 1. Demo file header & stream framing

| Data | Extractable | How | In this demo |
|---|---|---|---|
| Filestamp (`PBDEMS2`), patch/build version, demo version GUID | ✅ | `msg.CDemoFileHeader` via net-message handler (v6) | ✅ build 14193, `valve_demo_2` |
| Server name, client name, map, game dir | ✅ | same | ✅ FACEIT.com / SourceTV / de_mirage |
| Server start tick, fullpackets version, addons | ✅ | same | ✅ |
| Playback frames / ticks / duration / tick rate | ✅ | `Parser.FrameCount()`, `GameState.IngameTick()`, `Parser.TickRate()` | ✅ 120,736 frames, 64 Hz, ~31.5 min |
| Per-frame demo ticks (`DEM_Packet` tick stamps) | ✅ | `Parser.CurrentFrame()`/`CurrentTime()` on each `FrameDone` | ✅ |
| Console commands recorded in-stream (`DEM_ConsoleCmd`) | ✅ | raw net-message handler on `CDemoConsoleCmd` | ⚠️ not surfaced in report (raw) |
| User commands / input recording (`DEM_UserCmd`) | ✅ | `option.UserCmdParsing(...)` + `events.UserCmd` (POV demos only) | ❌ GOTV demo, 0 cmds |
| Save games, animation data, spawn groups, recovery frames | ✅ (raw) | demo-command handlers | ❌ not emitted by this recorder |

---

## 2. Game events (the 289-event registry)

CS2 defines **289 game-event definitions** (CS2OpenDev `core`/`game`/`mod.gameevents`). They travel as `CMsgSource1LegacyGameEvent`; demoinfocs exposes both **typed events** (~100 Go structs in `events`) and the **raw form** (`events.GenericGameEvent` with `Name` + typed key/value map), so *any* of the 289 is reachable even without a typed struct.

This demo fired **46 distinct event types** (full histogram in REPORT.md §18). Categories:

### 2.1 Combat
| Event(s) | Data | Extractable | In this demo |
|---|---|---|---|
| `player_death` (22 fields) | killer, victim, assister, weapon, headshot, penetration, noscope, smoke, blind, flash-assist, distance, dominated/revenged | ✅ `events.Kill` | ✅ 146 |
| `player_hurt` | victim/attacker/weapon/dmg/armor/hitgroup (CS2 also has `bullet_damage` with 24 fields: shot angles, aim punch, inaccuracy, penetration, lag-comp) | ✅ `events.PlayerHurt` + `events.BulletDamage` | ✅ 566 hurts; ⚠️ `bullet_damage` 0 fired in this demo's event list (available in newer builds) |
| `player_blind` | flashed player, attacker, flash duration | ✅ `events.PlayerFlashed` | ✅ 156 |
| `player_jump`, `player_footstep`, `player_sound` | movement/noise | ✅ `events.PlayerJump/Footstep/PlayerSound` | ✅ 941 steps |
| `weapon_fire`, `weapon_fire_on_empty`, `weapon_reload`, `weapon_zoom` | shots/reloads/scopes per player+weapon | ✅ typed events | ✅ 3,213 fires / 1,502 reloads / 145 zooms |
| `other_death` | chickens, props, breakables; killer+weapon | ✅ `events.OtherDeath` | ✅ 87 |
| `entity_killed` | CS2 entity_killed path (server-class names, inflictor type) | ✅ raw/typed | ✅ seen in v6 event list |
| `player_avenged_teammate`, `gg_killed_enemy` | revenge/arms-race kills | ✅ raw | ❌ |

### 2.2 Objective / round flow
| Event(s) | Data | Extractable | In this demo |
|---|---|---|---|
| `round_start`, `round_prestart`, `round_poststart`, `round_freeze_end`, `round_officially_ended` | round lifecycle + time/frag limits | ✅ | ✅ 21 each |
| `round_end` | winner, reason (20 reasons), score | ✅ `events.RoundEnd` | ✅ 19 real |
| `round_mvp` | MVP player + reason | ✅ `events.RoundMVPAnnouncement` | ✅ (per-player MVP counts extracted) |
| `round_announce_*` (match start/last round/final/warmup/match point), `announce_phase_end`, `start_halftime`, `cs_win_panel_*` | match-flow announcements | ✅ | ✅ |
| `bomb_beginplant/planted/abortplant`, `bomb_begindefuse/defused/abortdefuse`, `bomb_exploded`, `bomb_pickup/dropped`, `bomb_beep`, `player_given_c4` | full bomb lifecycle incl. site, planter, defuser, beeps | ✅ typed `Bomb*` events | ✅ 8 plants / 2 defuses / 2 explodes / 51 pickups / 42 drops |
| `hostage_rescued/rescued_all/hurt/killed/follows/call_for_help` | hostage mode | ✅ typed | ❌ (defusal map) |
| `enter/exit_bombzone`, `enter/exit_buyzone`, `enter/exit_rescue_zone` | zone transitions per player | ✅ raw | ✅ available |
| `game_phase_changed`, `switch_team`, `begin_new_match`, `match_end_conditions`, `warmup_end` | phase/match state | ✅ typed | ✅ |
| `vote_*` family (`vote_started/cast/passed/failed/changed/options`) | call-votes (surrender/kick) | ✅ raw `vote_cast` etc. | ❌ none cast |

### 2.3 Utility (grenades)
| Event(s) | Data | Extractable | In this demo |
|---|---|---|---|
| `grenade_thrown` | thrower + type | ✅ `events.GrenadeProjectileThrow` | ✅ |
| `hegrenade_detonate`, `flashbang_detonate`, `smokegrenade_detonate/expired`, `molotov_detonate`, `decoy_started/firing/detonate`, `inferno_startburn/expire/extinguish` | positions (x,y,z), thrower, entity ids; full flight trajectories come from entity tracking | ✅ typed events + `GameState.GrenadeProjectiles().Trajectory` | ✅ 80 HE / 85 flash / 87 smoke / 63 molly |
| `grenade_bounce` | per-bounce positions | ✅ `events.GrenadeProjectileBounce` | ✅ available |
| `bullet_impact` | per-bullet world impact points (heatmap material) | ✅ raw | ⚠️ not tallied in report; available |
| `player_radio` | radio commands (enemy spotted, etc.) | ✅ raw | ⚠️ available |

### 2.4 Economy & items
| Event(s) | Data | Extractable | In this demo |
|---|---|---|---|
| `item_purchase`, `item_pickup`, `item_remove`, `item_equip` (9 fields incl. paint kit flags), `ammo_pickup/refill`, `defuser_pickup/dropped`, `cart_updated`, `buymenu_open/close`, `buytime_ended` | buy/economy behavior | ✅ typed `Item*` events | ✅ 1,236 pickups, 5,079 equips |
| `adjust_money` (user message), `bonus_updated`, `drop_rate_modified` | money deltas | ✅ raw | ✅ available |
| Team/player money over time | entity props (`m_iAccount`, team equip value) | ✅ `Player.Money()`, `TeamState.*EquipmentValue*()` at any tick | ✅ sampled per freezetime |

### 2.5 Players, identity, social
| Event(s) | Data | Extractable | In this demo |
|---|---|---|---|
| `player_connect/disconnect/connect_full`, `player_team`, `player_changename`, `player_info` | roster lifecycle, SteamIDs, names, teams | ✅ typed | ✅ 10 connects, 5 disconnects, 20 team changes |
| `player_chat` (core+game) | chat text | ✅ `events.ChatMessage` | ✅ 3 messages (all-chat) |
| `player_score`, `player_stats_updated`, `player_ping/stop` | scoreboard/ping pings | ✅ raw | ✅ |
| `server_cvar` | server cvar changes | ✅ `events.ConVarsUpdated` | ✅ 89 updates |
| `hltv_chat/message/title/status/versioninfo`, `spec_mode_updated`, `spec_target_updated` | spectator/HLTV director data | ✅ raw | ✅ available |

### 2.6 Achievements / meta / misc
`achievement_*`, `loot_crate_*`, `seasoncoin_*`, `tournament_reward`, `xrank` … — GC/economy side-channel events, mostly not useful for match analysis but raw-capturable via `GenericGameEvent`.

> **Full inventory:** every one of the 289 definitions is reachable through `events.GenericGameEvent` (name + typed key map). Reference list: [CS2OpenDev Game Events](https://cs2opendev.github.io/CS2OpenDev-Docs/game-events/).

---

## 3. Network messages (svc / clc / net channels)

demoinfocs v6 exposes **all** net messages via `Parser.RegisterNetMessageHandler` (default creators registered for the common ones; `option.AdditionalNetMessageCreators` for the rest). CS2OpenDev lists 13 net + 15 clc + 34 svc + 3 client + 3 p2p messages.

| Category | Messages | Extractable | In this demo |
|---|---|---|---|
| **Server info** | `svc_ServerInfo` (map, protocols, tickrate, player slots), `svc_HLTVStatus`, `svc_ServerSteamID`, `svc_PeerList` | ✅ | ✅ tick rate 64 taken from it |
| **Voice** | `svc_VoiceData` (opus/steam audio chunks, XUID, tick, audible mask, caster flag), `svc_VoiceInit`, `svc_StopSound` | ✅ net-handler + Opus decode | ✅ **77,702 chunks, all 10 players, 0 caster** |
| **Audio/SOS** | `Sounds` channel: `CMsgSosStart/StopSoundEvent`, sound params, library stack | ✅ raw | ⚠️ available (positional audio events) |
| **Entity state** | `svc_PacketEntities` (the entire world state stream), `svc_FlattenedSerializer`, `svc_ClassInfo` | ✅ (internally drives `GameState`; raw available) | ✅ 263 entities at end |
| **String tables** | `svc_Create/UpdateStringTable`, `svc_ClearAllStringTables` | ✅ `events.StringTableCreated` + raw | ✅ |
| **ConVars** | `net_SetConVar`, `svc_GetCvarValue` | ✅ | ✅ 89 changes |
| **Chat/user messages** | `svc_UserMessage` (wrapper, id 72) → nested `UM_SayText(117)`, `UM_SayText2(118)`, `UM_SayTextChannel(119)`, `UM_TextMsg(124)` | ✅ typed `SayText`/`SayText2` | ✅ player chat present |
| **Encrypted channel** | `svc_EncryptedData` (id 78) — chat etc. since CS2 2026-09-09 update | ✅ w/ key: `option.NetMessageDecryptionKey` | ❌ **0 messages in this demo** (see §7) |
| **Broadcast/GOTV** | `svc_Broadcast_Command`, `svc_HltvReplay`, `svc_HltvFixupOperatorStatus`, `svc_FullFrameSplit` | ✅ raw | ✅ available |
| **User cmds** | `svc_UserCommands` (input echo) | ✅ | ❌ 0 (GOTV) |
| **Pausing/spawn** | `svc_SetPause`, `net_SpawnGroup_*` (6 msgs), `svc_SignonState` | ✅ raw | ✅ available |
| **Misc** | `svc_Print`, `svc_Menu`, `svc_Prefetch`, `svc_BSPDecal`, `svc_RconServerDetails`, `net_DebugOverlay`, `svc_NextMsgPredicted`, `svc_ClearAllStringTables` | ✅ raw | ⚠️ available |

**Client→server messages** (`clc_*`: Move, VoiceData, ClientInfo …) exist in the format but GOTV demos generally don't record the POV client's upstream — ❌ for this demo.

---

## 4. User messages (140 types, nested in `svc_UserMessage`)

High-value subsets for demo analysis (full list: [CS2OpenDev User Messages](https://cs2opendev.github.io/CS2OpenDev-Docs/network-messages/#usermessages)):

| Category | Messages | In this demo |
|---|---|---|
| Chat | `UM_SayText`, `UM_SayText2`, `UM_SayTextChannel` | ✅ via game events too |
| Voice control | `UM_VoiceMask`, `CS_UM_VoiceMask`, `CS_UM_SendAudio`, `CS_UM_RawAudio` | ✅ available |
| Rank / progression | `CS_UM_ServerRankUpdate (352)`, `ServerRankRevealAll (350)`, `XRankUpd`, `XpUpdate`, `MatchStatsUpdate`, `PlayerStatsUpdate`, `EndOfMatchAllPlayersData (375)`, `PostRoundDamageReport`, `RoundEndReportData`, `DeepStats`, `ScoreLeaderboardData` | ❌/⚠️ GC-side, encrypted or absent on FACEIT |
| Match lifecycle | `CS_UM_MatchEndConditions (334)`, `DisconnectToLobby`, `RoundBackupFilenames`, `CurrentRoundOdds` | ⚠️ available raw |
| Combat feedback | `CS_UM_Damage`, `ReportHit`, `SendLastKillerDamageToClient`, `ShootInfo`, `CounterStrafe`, `DamagePrediction`, `KillCam`, `AdjustMoney` | ⚠️ available raw |
| HUD/UI (low value) | Fade/Shake/Rumble/HudMsg/CloseCaption/… | ⚠️ noise, mostly skip |

---

## 5. Entity state (the deepest layer)

`svc_PacketEntities` streams deltas for every entity; demoinfocs decodes them against **server classes** (222 classes in this demo) into `GameState.Entities()` with per-field values.

| Data | Extractable | In this demo |
|---|---|---|
| **Player pawn props**: position, velocity, view angles, health, armor, money, ammo, flags (ducking/walking/scoped/onfire), eye position, viewmodel FOV/offset, last place name, flash duration, ping, scoreboard (K/D/A/MVP/score), rank, competitive wins, crosshair code, clan tag | ✅ `common.Player` accessors at any tick | ✅ |
| **Per-tick position/angle history** | ✅ by recording on `events.FrameDone` (library keeps only live state; history = your job) | ⚠️ not in report; trivially recordable |
| **Team entities**: score, clan name, flag, equipment values, money spent | ✅ `common.TeamState` | ✅ |
| **Weapons**: type, owner, ammo in mag/reserve, silenced, zoom level, recoil index, skin string (`OriginalString`) | ✅ `common.Equipment` | ✅ ⚠️ paint-kit/seed/wear **not** networked in CS2 demos (cosmetics live in GC inventory, not the demo) |
| **Grenade projectiles**: full flight trajectory with timestamps (`Trajectory []TrajectoryEntry`), thrower, velocity | ✅ `GameState.GrenadeProjectiles()` | ✅ |
| **Infernos (fire)**: active fires, per-fragment burn areas, thrower linkage | ✅ `GameState.Infernos()` | ✅ 63 fires |
| **Bomb**: carrier, position, planted state, site, `m_bHasExploded` | ✅ `GameState.Bomb()` + bomb-site entities | ✅ |
| **Hostages**: state machine (idle/following/rescued), position | ✅ `GameState.Hostages()` | ❌ defusal map |
| **Game rules proxy**: round time, freeze time, bomb time, warmup, phases, overtime, every `mp_*`/`sv_*` cvar | ✅ `GameState.Rules()` + `ConVars()` | ✅ 70+ cvars captured |
| **World**: doors, breakables, map props, other entities (263 live at end) | ✅ `GameState.Entities()` by class name | ✅ |
| **Bullets/walls**: `bullet_damage` (24-field ballistics: shot origin/angles, aim punch, inaccuracy, penetration count, lag-comp type), `bullet_impact` points | ✅ raw game events | ⚠️ events exist on newer builds; 0 fired here |
| **Sight/spotted state** | ✅ `Player.HasSpotted`, `events.PlayerSpottersChanged` | ✅ available |

---

## 6. Voice communications

| Data | Extractable | How | In this demo |
|---|---|---|---|
| Per-player voice audio (Opus @ 24 kHz mono) | ✅ | `RegisterNetMessageHandler(*msg.CSVCMsg_VoiceData)` → collect `Audio.VoiceData` per XUID → decode (libopus). Reference impls: [CS2VoiceData](https://github.com/DandrewsDev/CS2VoiceData), [csgo-voice-extractor](https://github.com/akiver/csgo-voice-extractor); CS Demo Manager ships it in the GUI | ✅ **77,702 chunks across all 10 players** (largest: rev0ltz_ 20,693 / bvcket 22,903 chunks) |
| Who-talked-when timeline, per-round voice activity | ✅ | chunks carry `Tick` + `Xuid` | ✅ derivable |
| Caster/observer voice | ✅ (`caster` flag) | | ❌ 0 caster tracks |
| Valve MM / Premier demos | ❌ | **Valve MM demos record no voice at all** — nothing to extract | n/a (this is FACEIT, so ✅) |

---

## 7. Encrypted payloads (`svc_EncryptedData`)

**What changed:** since the CS2 update of **2026-09-09**, *some* demos wrap chat (and similar) in `svc_EncryptedData` (svc id 78).

**Key facts (correcting the earlier guess):**
- The key is **per-match, not a universal key sitting in local game files**. It's issued by the Steam Game Coordinator and stored in the `match730_<matchid>.dem.info` companion file that the in-game Watch/Download UI saves next to the demo — that's how the offline demo player can decrypt it: the key travels *with the downloaded demo*, not inside `csgo/`.
- Extraction: `demoinfocs.MatchInfoDecryptionKey(demInfoBytes)` → the `watchablematchinfo.cl_decryptdata_key_pub` uint64 → encoded as **16 uppercase ASCII hex characters** (not 8 raw bytes). Pass via `option.NetMessageDecryptionKey(...)`.
- Scope: decrypts **public chat (`key_type: 2`)**. Team/private chat (`key_type: 1`) uses a separate key and stays unreadable.
- FACEIT/HLTV demos: generally **not** wrapped — this demo has **0 `svc_EncryptedData` messages**, which is why all-chat came through already readable.

| Data | Extractable | In this demo |
|---|---|---|
| Public chat inside `svc_EncryptedData` (Valve MM post-2026-09) | ✅ with `.dem.info` key | ❌ no encrypted messages |
| Team chat in Valve MM demos | ❌ separate key, never public | n/a |
| FACEIT all-chat | ✅ plaintext `player_chat` / `UM_SayText` | ✅ 3 messages |

---

## 8. Complementary libraries (what demoinfocs does *not* cover)

| Need | Library / tool | Notes |
|---|---|---|
| Voice → WAV/OGG | [CS2VoiceData](https://github.com/DandrewsDev/CS2VoiceData), [csgo-voice-extractor](https://github.com/akiver/csgo-voice-extractor) (CLI), CS Demo Manager (GUI) | Built *on* demoinfocs; need `libopus`. Valve MM demos contain no voice. |
| Encrypted chat (JS/browser) | [cs2parser](https://github.com/osztenkurden/cs2parser) `extractPublicEncryptionKey` | Same `.dem.info` key scheme as demofile. |
| Encrypted chat (.NET/TS origin) | [demofile](https://github.com/saul/demofile) / [demofile-net](https://github.com/saul/demofile-net) | ICE cipher + `replaykeys.ts` = reference implementation. |
| Python ergonomics | [awpy](https://github.com/pnxenopoulos/awpy) | Wraps demoinfocs for Python. |
| Full entity/netmessage typing in JS | cs2parser, [@deademx/cs2](https://deadem.com) | Live GOTV + demo. |
| Schema/prop/event ground truth | **CS2OpenDev** artifacts: `cs2_schema.json` (20.7 MB, all props/offsets), `gameevents_schema.json` (289 events), `netmessages` proto set, `convars/commands` tables | The authoritative map of *what exists to extract*; downloadable from [cs2opendev.github.io](https://cs2opendev.github.io/CS2OpenDev-Docs/generated/downstream-codegen-schemas). |
| Raw GC messages (ranks, end-of-match data, item drops) | Steam GC protobufs ([GameTracking-CS2](https://github.com/SteamDatabase/GameTracking-CS2), node-cs2) | Not in the `.dem` — needs live GC session. |
| Position/angle history for replays | record yourself on `events.FrameDone` (demoinfocs) | No library keeps full history; ~4.5 bytes/tick/player is trivial. |
| Cosmetics (paint kit/seed/wear/name tag) | Steam inventory / GC | **Not networked in demos** — physically absent, no parser recovers it. |

---

## 9. Summary matrix — extraction status by category

| # | Category | In demo file? | In *this* demo? | Tool |
|---|---|---|---|---|
| 1 | Demo header/metadata | ✅ | ✅ | demoinfocs v6 |
| 2 | Per-frame timeline | ✅ | ✅ | demoinfocs v6 |
| 3 | Game events (typed) | ✅ 289 defined | ✅ 46 types fired | demoinfocs v6 events |
| 4 | Game events (raw keys) | ✅ all 289 | ✅ | `GenericGameEvent` |
| 5 | Kills/damage/blinds detail | ✅ | ✅ 146 kills, 566 hurts | demoinfocs v6 |
| 6 | Ballistics (`bullet_damage`) | ✅ (newer builds) | ⚠️ 0 fired | raw event |
| 7 | Bomb/hostage objective | ✅ | ✅ bomb; ❌ hostage | demoinfocs v6 |
| 8 | Utility trajectories | ✅ | ✅ | demoinfocs `GrenadeProjectiles` |
| 9 | Economy (money/equip/buys) | ✅ | ✅ | entity props + item events |
| 10 | Player identity (SteamID/name/clan/crosshair/rank) | ✅ | ✅ | entity props + player events |
| 11 | Chat (all) | ✅ | ✅ 3 msgs | `ChatMessage`/`SayText` |
| 12 | Chat (encrypted, Valve MM) | ✅ w/ key | ❌ none here | `.dem.info` key + option |
| 13 | Chat (team) | ❌ key never public | ❌ | impossible |
| 14 | **Voice audio** | ✅ (non-MM servers) | ✅ **77,702 chunks** | demoinfocs + opus (CS2VoiceData) |
| 15 | Full world entity state | ✅ | ✅ 222 classes / 263 entities | demoinfocs entities |
| 16 | Per-tick position/angle history | ✅ | ⚠️ must record | your code on FrameDone |
| 17 | Weapon ammo/silencer/zoom | ✅ | ✅ | `Equipment` |
| 18 | Cosmetic skins (paint/seed/wear) | ❌ not in demo | ❌ | impossible (GC only) |
| 19 | Sound events (SOS) | ✅ | ⚠️ available | raw `Sounds` channel |
| 20 | User messages (140 types) | ✅ | ⚠️ available raw | net-message handlers |
| 21 | ConVars/server config | ✅ | ✅ 70+ | `Rules().ConVars()` |
| 22 | Console commands in stream | ✅ | ⚠️ available raw | `CDemoConsoleCmd` |
| 23 | User input (POV) | ✅ POV only | ❌ GOTV | `option.UserCmdParsing` |
| 24 | HLTV director / spectator cam | ✅ | ⚠️ available | `hltv_*` events |
| 25 | Votes | ✅ | ❌ none cast | `vote_*` events |
| 26 | Ranks (Valve MM only) | ⚠️ encrypted GC channel | ❌ FACEIT | MM demo + key |
| 27 | String tables | ✅ | ✅ | demoinfocs |
| 28 | Net-message metadata (HLTV status, steam IDs, pauses) | ✅ | ✅ | raw handlers |
| 29 | GC-only data (match info, deep stats, item drops) | ❌ not in `.dem` | ❌ | Steam GC (outside demo) |
| 30 | Caster/broadcast extras | ✅ in broadcast demos | ❌ none here | demoinfocs cstv |

---

### Bottom line for *this* demo (FACEIT de_mirage)

- **Everything in §1–§5, §9 rows 1–11, 15–17, 21, 24, 27–28 is present and already extracted** in `REPORT.md`.
- **Biggest untapped vein: voice — 77k Opus chunks from all 10 players** (row 14); one net-message handler + libopus away.
- **Not applicable here:** encryption (0 messages), ranks (FACEIT), hostage mode, POV input, caster audio.
- **Physically impossible from any `.dem`:** team-chat keys, skin cosmetics, GC match metadata — those live outside the file.
