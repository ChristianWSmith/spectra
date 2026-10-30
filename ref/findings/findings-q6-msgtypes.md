# Q6 — CS2 Demo Message Census: what non-game-event data carries analytical value?

Web research for Spectra PRD open question: *"Which network and user-message types provide
meaningful additional analytical value beyond standard game events?"* Scope: community-knowledge
census of what CS2 demos carry via net messages / user messages / GC messages that analysis tools
exploit. demoinfocs-golang v6.0.0-rc.1 is the target parser.

**Method:** GitHub issues/PRs/code (demoinfocs-golang, demofile, demofile-net, demoparser,
cs-demo-manager, awpy, zer0k-z, DandrewsDev), tool docs, Valve proto dumps (SteamDatabase
GameTracking-CS2), CS2OpenDev reference. No repo changes; findings only.

---

## 1. demoinfocs-golang ecosystem: what handlers tools actually register

### 1.1 What demoinfocs itself parses/dispatches by default

Source: `pkg/demoinfocs/parser.go` (init list), `user_messages.go`, `s2_commands.go`
(`svcMsgCreators` / `csUsrMsgCreators` maps), `parsing.go` (`defaultNetMessageCreators` for S1 path).

| Layer | Default-parsed | Built-in typed dispatch |
|---|---|---|
| Net (SVC) | PacketEntities, GameEvent(±List), UserMessage, SetConVar, ServerInfo, Create/UpdateStringTable, EncryptedData, UserCmds (`CSVCMsg_UserCommands`) | entity state, game events, SayText/SayText2, ConVars, encrypted-packet decrypt (w/ key), `events.UserCmd` (v6) |
| User (CS_UM_*) | only SayText, SayText2, ServerRankUpdate, RoundImpactScoreData | events.SayText / SayText2 / ChatMessage / RankUpdate / RoundImpactScoreData — everything else is **raw-only** via `RegisterNetMessageHandler(func(*msg.CSVCMsg_UserMessage))` + manual `proto.Unmarshal` ([user_messages.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/user_messages.go), TODO comment: "handle more user messages (if they are interesting)") |
| Entity | CCSPlayerResource via `GameState.PlayerResourceEntity()` | scoreboard/economy/ping/etc. via `st.Entity` properties ([game_state.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/game_state.go)) |
| Sidecar | `match730_*.dem.info` → `MatchInfoDecryptionKey()` / full `CDataGCCStrike15V2_MatchInfo` | decrypt key, matchtime, round stats, share-code inputs ([matchinfo.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/matchinfo.go)) |

Notable: `svc_VoiceData`, `svc_Sounds`, `svc_BSPDecal`, `svc_TempEntities`, `GE_SosStartSoundEvent`
are **not** in the default creators map for the S1 path (need `AdditionalNetMessageCreators`);
on the S2/CS2 path `svc_VoiceData` **is** in `svcMsgCreators` and can be handler-registered
([s2_commands.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/s2_commands.go);
[net-messages example](https://github.com/markus-wa/demoinfocs-golang/tree/master/examples/net-messages)).

### 1.2 What third-party tools register / extract

| Tool | Non-event sources exploited | Evidence |
|---|---|---|
| **CS2VoiceData** (DandrewsDev) | `msg.CSVCMsg_VoiceData` → Opus/Steam voice → WAV per SteamID | [cs2-voice-data.go](https://github.com/DandrewsDev/CS2VoiceData/blob/main/cs2-voice-data.go) |
| **saiko-tech voice capture** (CS:GO era) | CELT voice via demoinfocs; notes MM demos omit voice | [csgo-demo-voice-capture-example](https://github.com/saiko-tech/csgo-demo-voice-capture-example/) |
| **CS Demo Manager** (akiver) | `.info` MatchInfo (date, share code, decrypt key), voice-audio extraction package, equipment/money from player entities | [demo.go](https://github.com/akiver/cs-demo-analyzer/blob/main/internal/demo/demo.go), [AGENTS.md](https://github.com/akiver/cs-demo-manager/blob/main/AGENTS.md) (`@akiver/csgo-voice-extractor`), [DemoAnalyzer.cs](https://github.com/akiver/cs-demo-manager/blob/e532ab4f79c0921a28de70cebb9b9d16c9119abe/src/Services/Analyzer/DemoAnalyzer.cs) |
| **demofile** (saul, JS) | full net-message typed surface, all CS_UM_* via `UserMessages` emitter, encrypted-data decrypt + `extractPublicEncryptionKey`, `itemPurchase` supplement from entity state, `usercmd` | [demo.ts](https://github.com/saul/demofile/blob/f8434da/src/demo.ts), [usermessagetypes.ts](https://github.com/saul/demofile/blob/f8434da/src/usermessagetypes.ts), [replaykeys.ts](https://github.com/saul/demofile/blob/f8434da/src/replaykeys.ts) |
| **demofile-net** (C#) | same family; split CS package | [RELEASE_NOTES.md](https://github.com/saul/demofile-net/blob/main/RELEASE_NOTES.md) |
| **demoparser2** (LaihoE, Rust) | entity props (balance/ping/commends/crosshair_code/spotted/match-stats arrays), `parse_convars`, `parse_skins`, `player_sound` events, full usercmd incl. delta_data | [README](https://github.com/LaihoE/demoparser), [issue #340](https://github.com/LaihoE/demoparser/issues/340) |
| **awpy** (Rust backend now) | convars dict, chat, footsteps from `player_sound`, `player_ping` event, per-tick economy/loadout snapshots | [datasets docs](https://awpy.readthedocs.io/en/latest/datasets.html), [demo.html](https://awpy.readthedocs.io/en/latest/modules/demo.html) |
| **zer0k-z/cs2-demo-print-overlap** | decoded `svc_UserCmds` subtick steps → null-detection / anti-aim heuristics | [repo](https://github.com/zer0k-z/cs2-demo-print-overlap) |
| **cs2parser** (osztenkurden) | typed net-message subscription surface | [repo](https://github.com/osztenkurden/cs2parser) |
| **disalytics / DAK / pr1maly** (local-first tools) | economy timelines, enemy-likely-cash, aim/counter-strafe metrics — mostly entity+events; no exotic message deps observed | [disalytics](https://disalytics.disa-67b.workers.dev/), [cs2-demo-analysis-kit](https://github.com/Starfie1d1272/cs2-demo-analysis-kit) |

---

## 2. Census table — message/payload types

Value = analytical value for a demo-review/analytics app (High/Medium/Low).
Exposure = demoinfocs **v6.0.0-rc** as discoverable from public source.

| Type | What it carries | Who uses it | Value | demoinfocs v6 exposure |
|---|---|---|---|---|
| **CCSPlayerResource** entity (via PacketEntities) | Per-slot arrays: money (`m_iAccount` on pawn; cash spent/earned on resource), `m_iPing`, `m_iScore`, `m_iMVPs`, `m_szClan`, commends (leader/teacher/friendly), competitive ranking & wins, `m_szCrosshairCodes`, per-round `m_iMatchStats_*` (damage, equip value, flash, utility, cash), `m_bAlive`, `m_iHealth`, `m_bombsiteCenterA/B`, hostage state ([gamesensical](https://gamesensical.gitbook.io/docs/developers/netprops/important/ccsplayerresource); [demofile CCSPlayerResource](https://demofile.dev/interfaces/CCSPlayerResource.html); [demoparser2 props](https://github.com/LaihoE/demoparser)) | demoparser2/awpy (ping, balance, commends, match-stats columns), go-cs-metrics (spotted-flag transitions), demoinfocs `Player.Money()/Ping()/Score()/MVPs()` (CS:GO-era getters read these) | **High** — economy curves, scoreboard, clan tags, commends, crosshair codes | **Typed accessor**: `GameState.PlayerResourceEntity()` → `st.Entity` property lookups. No generated structs; field names documented in wiki/gamesensical |
| **CDataGCCStrike15V2_MatchInfo** (`match730_*.dem.info` sidecar, also CDemoFileInfo) | `matchid`, `matchtime` (true match date), `watchablematchinfo` (server IP, tv port, `cl_decryptdata_key` / `cl_decryptdata_key_pub`), `roundstatsall[]` (per-round K/D/A/pings/scores/MVPs/spectator counts/switched-teams), share-code ingredients | CS:DM date+sharecode ([demo.go](https://github.com/akiver/cs-demo-analyzer/blob/main/internal/demo/demo.go)); demofile `extractPublicEncryptionKey`; demoinfocs `MatchInfoDecryptionKey()`; node-csgo sharecode flow ([issue #127](https://github.com/markus-wa/demoinfocs-golang/issues/127)) | **High** — real match date, share code, decrypt key, official round stats backup | **Typed**: `MatchInfoDecryptionKey(b []byte)`; full proto in `msg` package for manual unmarshal |
| **svc_EncryptedData / CSVCMsg_EncryptedData** | ICE-encrypted inner net messages (chat, caster voice) post **Sept 9 2026** CS2 update; `key_type`; key from `.dem.info` | demofile `setEncryptionKey` + issue [#322](https://github.com/saul/demofile/issues/322); demoinfocs PRs [#696](https://github.com/markus-wa/demoinfocs-golang)/#697/#699 (v5+v6); statushub patch notes ([statushub](https://statushub.gg/update/25218825)); CS2News ([cs2news](https://cs2news.gg/cs2-update/cs2-update-2026-09-09-d8e2c7a)) | **High** (chat/voice recovery) — without it, MM chat is gone | **Typed handler + decrypt**: `option.NetMessageDecryptionKey`, `CSVCMsg_EncryptedData` re-dispatched after decrypt; warn types for missing/bad key |
| **CS_UM_SayText / SayText2** (+ base `CUserMessageSayText2`) | Chat lines, team/all channels, coach joins, name changes | demoinfocs built-in → `events.ChatMessage` / `SayText2`; demofile `ChatMessage`; awpy `demo.chat` | **High** — toxic/tilt/context analysis; encrypted in modern MM demos | **Typed** (built-in dispatch). Note CS2 may deliver as base `UM_*` or wrapped `CS_UM_*` |
| **CS_UM_RoundImpactScoreData** | Valve's own per-round impact model: initial equip values + `terrorist_odds`, per-event timestamps, victims, damage returned, objective events ([SteamDatabase proto](https://github.com/SteamDatabase/GameTracking-CSGO/commit/edc31b9b2f888ba13b50890b3a2208ad054a96c3)) | demoinfocs dispatches `events.RoundImpactScoreData` (raw); demofile typed emitter | **High** — server-computed win-probability trajectory, hard to rebuild from events alone | **Typed** (raw message on event) |
| **CS_UM_CurrentRoundOdds** | Single `odds` int — live round win probability | demofile typed; demoinfocs raw-only | **Medium-High** | **Raw only** (unmarshal `CCSUsrMsg_CurrentRoundOdds` from `CSVCMsg_UserMessage`) |
| **CS_UM_ShootInfo** | `frame_number`, repeated `hitbox_transforms`, `shoot_pos`, `shoot_dir` — the shooter's server-confirmed shot pose | demofile typed; Valve proto | **Medium-High** — ballistics/aim analysis without inferring from bullet impacts | **Raw only** |
| **CS_UM_CounterStrafe** | `press_to_release_ns`, `total_keys_down` — Valve's anti-SOCD telemetry ([reddit reverse](https://www.reddit.com/r/GlobalOffensive/comments/1ewq87h/review_of_valves_antisocd_implementation/); [CS2OpenDev](https://cs2opendev.github.io/CS2OpenDev-Docs/protobufs/cstrike15_usermessages/)) | demofile typed; no major analytics tool found consuming yet | **Medium** — true counter-strafe timing independent of usercmd decode | **Raw only** (proto exists in msgs2) |
| **CS_UM_DeepStats** | Wraps `CMsgGCCStrike15_ClientDeepStats` (Valve "deep stats" client blob) | demofile typed; sparse public analysis | **Medium** (speculative) | **Raw only** |
| **CS_UM_AdjustMoney** | Per-player money delta notifications | demofile typed; demoparser2 uses entity balance instead | **Medium** — economy event stream without relying on entity delta timing | **Raw only** |
| **CS_UM_ServerRankUpdate** | Rank old/new, wins, rank change (Premier/comp) | demoinfocs built-in → `events.RankUpdate` | **Medium** | **Typed** (built-in) |
| **CS_UM_EndOfMatchAllPlayersData** | End-of-match player cards / MVP scene | demofile typed | **Medium** — end-of-match scoreboard reconstruction | **Raw only** |
| **CS_UM_RadioText / RadioIcon** | Radio commands ("Fire in the hole") | demofile typed; demoinfocs TODO mentions RadioText | **Medium** — utility-callout analysis | **Raw only** |
| **CS_UM_ProcessSpottedEntityUpdate** | Radar "spotted" updates (CS:GO-era message) | demofile typed; **CS2 mostly uses `m_bSpotted` / `m_bSpottedByMask` on `EntitySpottedState_t`** ([s2v.app](https://s2v.app/SchemaExplorer/cs2/server/EntitySpottedState_t); Leetify blog on spotting ([leetify](https://leetify.com/blog/enemy-actually-spotted/)); go-cs-metrics spotted-flag transitions) | **Medium** — prefer entity props in CS2 | Entity prop preferred; message may be legacy/absent in CS2 |
| **CS_UM_SendPlayerLoadout / SendPlayerItemDrops** | Skins/loadout and drop metadata | demoparser2 `parse_skins`; demofile | **Medium** (cosmetics/economy flavor) | **Raw only** |
| **CS_UM_VoteStart/Pass/Failed/Setup** | Callvotes | demofile typed; demoinfocs `events.VoteCast` (v6) | **Low-Medium** | Partial typed (`VoteCast`); raw for full payloads |
| **CS_UM_HintText / TextMsg / HudMsg / KeyHintText** | HUD text, center messages | demofile typed | **Low** | **Raw only** |
| **CS_UM_Train / Geiger** | Legacy Source train/geiger HUD | demofile typed | **Low** (dead tech) | **Raw only** |
| **CCSUsRMsg_HltvChat** | *Does not appear* in current ECstrike15UserMessages enum — spectator chat is a **game event** `hltv_chat` ([CS2 game-events ref](https://cs2opendev.github.io/CS2OpenDev-Docs/game-events/)) | n/a | **Low** | Use game event, not user message |
| **net_SetConVar** | Full server convar snapshot at signon (mp_maxrounds, freezetime, overtime, tv_*, gamemode…) | awpy `demo.convars`; demoparser2 `parse_convars`; demoinfocs stores ConVars on gameState; demofile `.conVars` | **High** — format detection, round math without hardcoding ([awpy datasets](https://awpy.readthedocs.io/en/latest/datasets.html)) | **Typed** (`handleSetConVar` built-in; `CNETMsg_SetConVar` in default creators) |
| **CSVCMsg_ServerInfo** | Map, tick interval, game mode string ("premier"/"competitive"), protocol, server SteamID | demoinfocs `handleServerInfo` → tick rate; cs-demo-analyzer reads game mode ([constants.ts](https://github.com/akiver/cs-demo-analyzer/blob/main/js/src/constants.ts)) | **High** | **Typed** (built-in) |
| **svc_UserCmds / CDemoUserCmd / CMsgServerUserCmd** | POV inputs: buttons, viewangles, mouse dx/dy, subtick moves, input history; **post-2026-07 FACEIT demos use `delta_data` (field 6)** — demoparser silent-loss bug #340, fixed 0.42.0 | demoinfocs v6 `events.UserCmd` + `UserCmdParsingFull` (delta support, #669); demofile `usercmd`; zer0k-z null detection; Leetify derives counter-strafe from **velocity + spotted**, not buttons ([leetify glossary](https://leetify.com/blog/leetify-stats-glossary/)) | **High** (POV) / **N/A** (GOTV) | **Typed** (`events.UserCmd`, buttons-only default; enable Full) |
| **svc_VoiceData** | Opus (CS2) / Steam-CDT voice chunks, XUID, **`caster` flag** (new Sept 2026) | CS2VoiceData, CS:DM voice extractor, saiko (CELT); demofile `svc_VoiceData` listener | **High** (comms mining) / Medium (voice-activity timing only) | **Typed handler available** (register `func(*msg.CSVCMsg_VoiceData)`); needs Opus decode externally |
| **player_sound** game event | Footsteps: radius, duration, step bool, position | awpy footsteps ([parse_demo notebook](https://awpy.readthedocs.io/en/latest/_sources/examples/parse_demo.ipynb.txt)); demoinfocs PR [#535](https://github.com/markus-wa/demoinfocs-golang/pull/535) | **Medium-High** — movement audio without SOS | **Typed** (`events.PlayerSound`) |
| **bomb_beep / cs_round_final_beep** game events | Per-beep C4 entindex; final beep marker | CS2OpenDev game-events docs; mod.gameevents | **Medium** — post-plant timing without polling `m_flC4Blow` | Via generic game-event handler (name-based) |
| **bullet_damage** game event | Richer than player_hurt: shot angles, aim-punch, inaccuracy components, penetration, lag-comp type ([CS2OpenDev](https://cs2opendev.github.io/CS2OpenDev-Docs/game-events/)) | Documented; less tool adoption so far | **Medium-High** (ballistics) | Via generic game-event handler |
| **GE_SosStartSoundEvent / Stop / SetParams** | Named sound-event hash + packed params + source entity (bomb beeps, footsteps, gunfire at SOS layer) ([gameevents.proto](https://cs2opendev.github.io/CS2OpenDev-Docs/protobufs/gameevents/)) | **No mainstream analytics tool found mining SOS for gameplay** — hash-only names, packed params make it research-grade; tools prefer `player_sound` game event or entity state | **Low-Medium** (research) | **Raw only** (register `msg.CMsgSosStartSoundEvent` via AdditionalNetMessageCreators on S1 path; S2 path has gameEventCreators) |
| **svc_Sounds** | Legacy sound list (CS:GO demos show ~9.6k msgs in example dump) | demoinfocs net-messages example "UnhandledMessage" counts | **Low** | Needs AdditionalNetMessageCreators |
| **svc_BSPDecal** | Bullet decal positions | demoinfocs example ([examples/net-messages](https://github.com/markus-wa/demoinfocs-golang/tree/master/examples/net-messages)) | **Low** (superseded by bullet_impact) | AdditionalNetMessageCreators |
| **svc_TempEntities** | Temp entity effects (12.7k in example dump) | none found for analytics | **Low** | AdditionalNetMessageCreators |
| **svc_PacketEntities** | Entire entity delta stream (players, weapons, grenades, C4, infernos, player resource) | Every serious parser (demoinfocs, demofile, demoparser2) | **High** (foundational) | **Typed** (built-in; drives entities + gameState) |
| **svc_HltvReplay / svc_HLTVStatus** | Replay control / HLTV slot info | demofile typed | **Low** (viewer control) | Parsed on S2 path; no analytics use found |
| **CMsgGCCStrike15V2_MatchmakingServerRoundStats** (in `.info` / GC) | Per-round kills/assists/deaths/pings/MVPs/spectators/map_id | SteamDatabase proto; CS:GO-Analyzer fork used `CDataGCCStrike15_v2_MatchInfo` ([CSGO-Analyzer](https://github.com/CSGO-Analysis/CSGO-Analyzer)) | **Medium** (official round stats; usually redundant with demo parse) | Proto in msgs2; parse from `.info` bytes |
| **CDemoUserCmd / CDemoPacket / DEM_FullPacket / signon** | Outer demo framing (commands, signon state) | demofile `_handleUserCmd`, awpy `read_cmd_header` | **Low** (parser plumbing) | Handled internally by demoinfocs |
| **VoiceMask / RawAudio / SendAudio** | Voice processing flags, radio audio triggers | demofile typed | **Low** | **Raw only** |

---

## 3. What Scope.gg / Leetify / FACEIT / csdemo-style platforms show (inferred sources)

| Platform signal | Likely data source(s) | Message needed? |
|---|---|---|
| Economy per-round money curves, buy type (eco/force/full) | Player pawn `m_iAccount` / resource `m_iMatchStats_*` + equipment value at freeze/first shot ([CS:DM DemoAnalyzer](https://github.com/akiver/cs-demo-manager/blob/e532ab4f79c0921a28de70cebb9b9d16c9119abe/src/Services/Analyzer/DemoAnalyzer.cs) uses first-shot detection because `buytime_ended` is unreliable) | PacketEntities only |
| Ping, clan tag, commends, crosshair code | CCSPlayerResource arrays (demoparser2 columns prove demos carry them) | PacketEntities |
| Counter-strafe quality (Leetify) | Velocity + spotted FOV per shot — **not** usercmd buttons ([glossary](https://leetify.com/blog/leetify-stats-glossary/)); newer tools (demoinfocs v6, zer0k-z) use real usercmd | UserCmd (optional, richer) |
| Match date / share code / rank | `.info` MatchInfo + ServerRankUpdate | Sidecar + CS_UM |
| Chat/tilt context | SayText2 (post-Decrypt) | EncryptedData + key |
| Voice comms timing | VoiceData (even without full decode: XUID + timestamps) | VoiceData |
| Enemy-likely-cash (disalytics) | Own team money + round outcomes + loss bonus math — from player resource money history | PacketEntities |
| Round win-probability graphs | Rebuilt heuristically by most tools; **Valve already ships** `RoundImpactScoreData` / `CurrentRoundOdds` | CS_UM (typed/raw) |
| 2D replay, positions, nade paths | PacketEntities + game events (standard) | — |
| Highlight auto-clips (fastcup, clutchkings) | Game events + positions | — |

Leetify blog confirms demos are the sole data source and that CS2 MM demos can lose events
([demos-are-back](https://leetify.com/blog/demos-are-back/)) — resilience to missing event classes matters.

---

## 4. Sound events (SOS) — do tools mine them?

- **Game-level sound events exist**: `player_sound` (footsteps with radius/duration) is a first-class
  game event that **awpy and demoinfocs already use** ([PR #535](https://github.com/markus-wa/demoinfocs-golang/pull/535)).
- **SOS wire messages** (`GE_SosStartSoundEvent` = 208) carry `soundevent_hash` (CRC32 of name) +
  `packed_params` + source entity — theoretically bomb beeps, footsteps, gunfire
  ([gameevents.proto](https://cs2opendev.github.io/CS2OpenDev-Docs/protobufs/gameevents/)).
- **No mainstream analytics tool found** that mines SOS for gameplay signals; the hash-only naming
  and packed params make it reverse-engineering work. `bomb_beep` / `cs_round_final_beep` game events
  cover the bomb-timing use case cleanly. Verdict: register SOS in a research probe, don't build on it yet.

---

## 5. CS2-specific notes (vs CS:GO)

1. **Chat encryption (Sept 9 2026)**: MM demos encrypt team chat; GOTV keys via `cl_decryptdata_key_pub` /
   `tv_encryptdata_key_pub`; `tv_relaytextchat` controls what reaches GOTV. Parsers need `.info` key
   ([statushub](https://statushub.gg/update/25218825), demoinfocs v6.0.0-rc releases).
2. **VoiceData.caster flag** (Sept 2026) distinguishes caster vs player voice — useful for broadcast demos.
3. **Usercmd delta_data cutover (~2026-07-10, FACEIT)**: `CMsgServerUserCmd.data` empty; field 6
   `delta_data` (codegen_delta_encoder). demoparser #340; demoinfocs v6 #669 supports delta decoding.
4. **S2 dual user-message paths**: CS2 can deliver user messages wrapped (`svc_UserMessage` + CS_UM id)
   **or** as direct base `UM_*` / typed messages on the wire — awpy's Rust parser handles both
   (`is_user_message_type` + `decode_direct_user_message`).
5. **Spotted state is an entity prop** (`EntitySpottedState_t.m_bSpotted` / `m_bSpottedByMask`), not the
   CS:GO ProcessSpottedEntityUpdate message, for practical purposes.
6. **New CS2-only CS_UM_***: ShootInfo, CounterStrafe, DamagePrediction, DeepStats, EndOfMatchAllPlayersData,
   SendPlayerLoadout — not present in CS:GO-era tooling writeups; worth probing.
7. **bullet_damage** game event is CS2's richer hurt event (angles, inaccuracy, penetration) — many tools
   still only surface player_hurt.
8. **GC protobufs (match730)** live primarily in the `.dem.info` sidecar, not inside the `.dem` stream;
   tools that skip the sidecar lose date, share code, and decrypt keys.

---

## 6. Recommended census for Spectra (research probe register list)

Priority order for a demoinfocs v6 research probe (register handlers / dump first-N samples / count by type):

### Must register (High value, low cost)

1. **`msg.CSVCMsg_VoiceData`** — count per XUID, caster flag, format enum; store samples if audio mining later.
2. **`msg.CSVCMsg_UserMessage`** switch on `ECstrike15UserMessages` for:
   - `CS_UM_RoundImpactScoreData` (already typed — also subscribe to the event)
   - `CS_UM_CurrentRoundOdds`
   - `CS_UM_ShootInfo`
   - `CS_UM_CounterStrafe`
   - `CS_UM_AdjustMoney`
   - `CS_UM_RadioText`
   - `CS_UM_DeepStats`
   - `CS_UM_EndOfMatchAllPlayersData`
   - `CS_UM_SendPlayerLoadout`
   - dump **unknown** msg_type IDs with size histograms (census for new builds)
3. **`events.UserCmd`** (v6) with `UserCmdParsingFull` on POV demos — verify delta_data coverage on post-2026-07 FACEIT demos.
4. **`.info` sidecar**: parse full `CDataGCCStrike15V2_MatchInfo` (matchtime, roundstatsall, share code, decrypt key); feed key to `option.NetMessageDecryptionKey` and re-parse chat.
5. **CCSPlayerResource snapshot per freezetime end**: dump all `m_i*` array props once to see which are populated per demo source (money, ping, commends, crosshair codes, match stats).
6. **Game events often missed by "standard" pipelines**: `player_sound`, `bomb_beep`, `cs_round_final_beep`, `bullet_damage`, `player_ping`, `item_purchase`, `item_equip` — just ensure they're in the event whitelist (name-based, free).

### Probe / research (Medium)

7. **`msg.CMsgSosStartSoundEvent`** (+ Stop/SetParams) via AdditionalNetMessageCreators — hash frequency table over one demo; check whether bomb/footstep hashes are stable.
8. **`msg.CSVCMsg_BSPDecal`** — volume check only (expect superseded by bullet_impact).
9. **`msg.CCSUsrMsg_ProcessSpottedEntityUpdate`** — presence check; prefer `m_bSpotted` entity props.
10. **`msg.CSVCMsg_EncryptedData`** without key — count occurrences to know how much chat is locked.

### Skip for now (Low)

11. `svc_TempEntities`, `svc_Sounds`, `svc_Prefetch`, Train/Geiger/HintText, VoiceMask, HLTV replay control — log counts once in the unknown-ID histogram, don't build decoders.

### Implementation sketch (probe shape)

```go
// census probe — count + sample, don't interpret yet
p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData) { ... })
p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_UserMessage) {
    switch msg.ECstrike15UserMessages(m.GetMsgType()) {
    case msg.ECstrike15UserMessages_CS_UM_ShootInfo:
        // unmarshal + store
    default:
        // histogram[m.GetMsgType()]++
    }
})
p.RegisterEventHandler(func(e events.RoundImpactScoreData) { ... })
p.RegisterEventHandler(func(e events.UserCmd) { ... })
// + option.NetMessageDecryptionKey(fromInfoFile)
```

### Success criteria for the probe

- Per-demo histogram of every CS_UM_* type with ≥1 occurrence and payload sizes.
- Confirmation that RoundImpactScoreData / ShootInfo / CounterStrafe appear on MM vs FACEIT vs HLTV demos.
- % of chat recoverable with/without `.info` key (post-2026-09 demos).
- Whether VoiceData is present on each source (MM historically omits voice; GOTV/FACEIT differ).
- CCSPlayerResource field population rates across demo sources.

---

## Key URLs (index)

- demoinfocs-golang: [repo](https://github.com/markus-wa/demoinfocs-golang), [v6 releases](https://github.com/markus-wa/demoinfocs-golang/releases), [net-messages example](https://github.com/markus-wa/demoinfocs-golang/tree/master/examples/net-messages), [user_messages.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/user_messages.go), [s2_commands.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/s2_commands.go), [matchinfo.go](https://github.com/markus-wa/demoinfocs-golang/blob/454fddaf761f/pkg/demoinfocs/matchinfo.go), [issue #137](https://github.com/markus-wa/demoinfocs-golang/issues/137), [PR #535 player_sound](https://github.com/markus-wa/demoinfocs-golang/pull/535)
- demofile: [demo.ts](https://github.com/saul/demofile/blob/f8434da/src/demo.ts), [usermessagetypes.ts](https://github.com/saul/demofile/blob/f8434da/src/usermessagetypes.ts), [replaykeys.ts](https://github.com/saul/demofile/blob/f8434da/src/replaykeys.ts), [issue #322](https://github.com/saul/demofile/issues/322)
- demoparser: [LaihoE/demoparser](https://github.com/LaihoE/demoparser), [issue #340 delta_data](https://github.com/LaihoE/demoparser/issues/340)
- CS:DM: [AGENTS.md](https://github.com/akiver/cs-demo-manager/blob/main/AGENTS.md), [cs-demo-analyzer demo.go](https://github.com/akiver/cs-demo-analyzer/blob/main/internal/demo/demo.go)
- awpy: [datasets](https://awpy.readthedocs.io/en/latest/datasets.html), [datasets/README](https://github.com/pnxenopoulos/awpy)
- CS2VoiceData: [cs2-voice-data.go](https://github.com/DandrewsDev/CS2VoiceData/blob/main/cs2-voice-data.go)
- zer0k-z overlap: [cs2-demo-print-overlap](https://github.com/zer0k-z/cs2-demo-print-overlap)
- Protos/reference: [SteamDatabase GameTracking-CS2 Protobufs](https://github.com/SteamDatabase/GameTracking-CS2/tree/master/Protobufs), [CS2OpenDev network-messages](https://cs2opendev.github.io/CS2OpenDev-Docs/network-messages/), [cstrike15_usermessages](https://cs2opendev.github.io/CS2OpenDev-Docs/protobufs/cstrike15_usermessages/), [game-events](https://cs2opendev.github.io/CS2OpenDev-Docs/game-events/), [CCSPlayerResource nets](https://gamesensical.gitbook.io/docs/developers/netprops/important/ccsplayerresource)
- Sept 2026 encryption: [statushub](https://statushub.gg/update/25218825), [cs2news](https://cs2news.gg/cs2-update/cs2-update-2026-09-09-d8e2c7a)
- Leetify: [stats glossary](https://leetify.com/blog/leetify-stats-glossary/), [demos-are-back](https://leetify.com/blog/demos-are-back/), [enemy-actually-spotted](https://leetify.com/blog/enemy-actually-spotted/)
