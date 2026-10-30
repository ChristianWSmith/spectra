# Q4: Which CS2/CS:GO demo sources contain voice data (CSVCMsg_VoiceData)?

Web research only, compiled 2026-10-30. Empirical baseline (given): our own parsing found 123,507 and 77,702 `CSVCMsg_VoiceData` chunks (Opus 48 kHz) on two FACEIT CS2 demos.

## TL;DR table

| Demo source | Voice present? | Era | Confidence | Key citations |
|---|---|---|---|---|
| Valve Premier / Competitive MM (`match730_*.dem`, with or without `.dem.info`) | **No** | CS:GO + CS2 | High | [1] [2] [3] [4] [5] [6] |
| POV demo (`record`), teammates' voice | **Yes** (only voices your client received — teammates with alltalk off) | CS:GO confirmed | Medium | [7] [8] |
| POV demo, own voice | **No** unless `voice_loopback 1` at record time | CS:GO confirmed; CS2 same mechanism presumed, undertested | Medium (CS:GO), Low-Med (CS2) | [7] [9] |
| POV demo, enemy voice | **No** with alltalk off (never sent to your client) | CS:GO + CS2 (mechanism) | High (mechanism) | [10] |
| FACEIT (`.dem.zst` from match room) | **Yes** (both teams, Opus 48 kHz) | CS:GO era yes; CS2-era yes after playback-command fix | High | [11] [12] [13] [14] [15] + our empirical data |
| ESEA demos | **Yes** (incl. enemy comms) | CS:GO confirmed; CS2 presumed (league GOTV) | Medium-High (CS:GO), Medium (CS2) | [8] [16] [17] |
| 5EPlay (China) | **Yes** (voice existed, was removed, "restored" Nov 2024) | CS:GO + CS2-era changelog | Medium | [18] [19] [20] |
| Perfect World Arena | **Unknown** — demos exist and are parseable; no voice-specific evidence found | — | Low | [21] (events only, not voice) |
| HLTV / pro-league GOTV downloads | **No** — pro configs deliberately set `tv_relayvoice 0` | CS:GO confirmed by configs; CS2 presumed | Medium-High | [22] [23] |
| ESL official GOTV config | **No** — literal `tv_relayvoice 0` in published config | CS:GO (2016 config) | High | [22] |
| Community/own server GOTV | **Conditional** — CS2: voice only reaches GOTV if server enables it (alltalk or plugin fixing GOTV voice flags); CS:GO: `tv_relayvoice 1` + alltalk | both | High | [24] [25] [26] |
| Grid, SkinClub, other minor platforms | **Unknown** — no evidence found | — | — | — |
| ReGameDemo.ru demos | **Unknown/likely no** — they re-host tournament GOTV demos, and tournament configs set `tv_relayvoice 0` | CS:GO | Low | [22] |

## Per-question findings

### 1. Valve Premier/Competitive MM demos
Unanimous across every voice-extraction tool's README and community:
- DandrewsDev/CS2VoiceData (CS2-era, Nov 2023): "Valve Matchmaking demos do not contain voice audio data, as such there is nothing to extract from MM demo files." [1]
- akiver/csgo-voice-extractor (maintainer of CS Demo Manager): same warning, bolded in README. [2]
- saiko-tech/csgo-demo-voice-capture-example (CS:GO era): "Valve Matchmaking demos do not record voice audio data". [3]
- akiver in CS:DM discussion #800: voice playback option "works only if the demo contains voice data which is not the case with MM demos". [4]
- Reddit (r/cs2 2025, Steam discussions 2025): "Premier, no. Faceit, yes." / "it only works for faceit demos. premier demos don't record comms". [5] [6]

Mechanism (why, not just that): CS2's GOTV behaves like a player w.r.t. voice routing — it hears nobody unless the server runs `sv_alltalk 1` (or a plugin patches GOTV's voice flags, as b0ink's CS2-FixDemoVoiceChat does). Valve MM runs alltalk off, so nothing team-routed is ever written into the GOTV stream that becomes `match730_*.dem`. [24] [25] The `.dem.info` sidecar only carries chat/meta; it does not add voice. Note: chat messages are likewise absent from MM demos but present in FACEIT demos (akiver, discussion #731). No source claims any Valve setting (`sv_voiceenable` etc.) can make MM demos record voice — it is server-side and fixed.

CS:GO-era claims are identical ("Matchmaking demos don't have comms", steam forums 2015; r/GlobalOffensive 2016/2018). [27] [28]

### 2. POV demos
CS:GO-era, well documented:
- Teammates' voice: recorded (your client received those packets and the demo records the client's network stream). Steam user guide 2014: "this will record your team mates in game voice chat it won't record your own". [7]
- Own voice: NOT recorded unless `voice_loopback 1` at record time — workaround documented in IncPlusPlus/csgo-demo-helper (uses loopback + `voice_player_volume 0` to self-mute while recording). [9]
- Enemy voice: never in POV with alltalk off — client never received it (mechanism explained in zeroutil blog + sv_alltalk semantics). [10]

CS2-era: `record` is heavily bugged (ValveSoftware/csgo-osx-linux#3673 — recording at match start freezes the client; Leetify warned about POV crashes Nov 2023; r/GlobalOffensive Nov 2024 "POV recording is broken"). [29] [30] ericek111's 2024 issue confirms the loopback-workflow lived into CS2 ("including my own voice with voice_loopback, but since you haven't added voice_player_volume back, I cannot mute myself anymore"). So: same mechanism presumed, but no CS2-era source explicitly enumerating POV voice contents; treat CS2 POV voice as low-confidence-until-tested. [29]

### 3. FACEIT — community corroboration
- FACEIT's own support/social posts hand out `tv_listen_voice_indices -1; tv_listen_voice_indices_h -1; tv_relaytextchat 2` for demo playback (FACEIT VK post Apr 2025; FACEIT_Darwin on r/FACEITcom). [13] [14]
- Hotspawn guide: "FACEIT demos actually contain all the voice comms spoken in the game". [12]
- Multiple extraction tools target FACEIT demos specifically: akiver/csgo-voice-extractor, DandrewsDev/CS2VoiceData, pythaeusone/CS2-SourceTV-Demo-Voice-Calculator ("SourceTV(Faceit,ESEA ...) demos"), Small-Demo-Manager, KakkaMistaOhJaJa/CaunterComms (FACEIT .dem.zst → per-player WAVs + Whisper transcription), boris-on/faceit-voicechat, DemoVoice browser extension. [15] [31] [32]
- 2023-CS2-transition noise: early CS2 FACEIT demos (Sep–Oct 2023) appeared voiceless because the *player* needed `tv_listen_voice_indices` set (default 0 = hear nobody) — FACEIT staff said "the demo player at the moment is not pulling the voices". Voice data was in the file the whole time per the current consensus. [11]

### 4. ESEA / other third-party
- ESEA: CS:GO-era reddit (2015): ESEA-downloaded GOTV demos have both teams' comms ("Both team's comms should only be on the demo you acquire from ESEA"); Steam forum 2014: "ESEA does have enemy voice chat in their gotv demos". [8] [16]
- ESEA forum thread "Can't hear voice comms in demos anymore" exists (CS2-era, title implies ESEA demos historically had comms; content not retrievable). [17]
- pythaeusone's bitfield tool explicitly markets to "SourceTV (Faceit, ESEA ...) demos". [15]
- 5EPlay: Chinese sources — Baidu guide notes the demo-player voice toggle button "只有5e平台的demo才有" (only 5E demos have it); a Q&A site states "官方匹配听不到语音，5Eplay平台的录像可以听到"; and the 5E client changelog v7.1.47 (2024-11-19) says "DEMO语音恢复" (demo voice restored) across ranked/league/match modes — implying it existed, was lost, and was deliberately restored. [18] [19] [20]
- Perfect World Arena: demos downloadable (WangChuDi tools, CS:DM analyzer has a `perfectworld` source), but no voice-specific evidence. Leetify only says PW demos have full game events. Unknown. [21]
- Grid / SkinClub / Esportal / fastcup / popflash: no voice evidence found either way. Unknown.

### 5. HLTV re-stream vs in-client GOTV download
No evidence of a format difference — HLTV downloads are ordinary GOTV `.dem` files (cs2demo.gg, memorin). The difference is server-side config: ESL's published official GOTV config contains `tv_relayvoice 0` ("Relay voice data: 0=off"), i.e., pro tournaments deliberately strip voice (privacy). memorin.app states flatly that HLTV demos "carry no voice". [22] [23] [33]

### 6. CS2-specific voice changes
- Codec: proto `VoiceDataFormat_t` gained `VOICEDATA_FORMAT_OPUS = 2` (SteamDatabase/Protobufs csgo/netmessages.proto); CS2 demos carry `CMsgVoiceAudio` with format OPUS. DandrewsDev's CS2 sample decodes OPUS at 48 kHz mono — matches your empirical 48 kHz. CS:GO-era demos used `VOICEDATA_FORMAT_STEAM` (Opus-in-Steam-wrapper at 24 kHz in the sample) and earlier CELT (`vaudio_celt`, 22.05 kHz). [34] [35] [36]
- Playback, not recording, changed in CS2: CS:GO used `voice_enable`/`voice_player_volume`; CS2 uses `tv_listen_voice_indices` + `tv_listen_voice_indices_h` (64-bit slot bitfield, defaults 0 = hear nobody, reset on every game launch). CS:DM's `enablePlayerVoices()` shows the mapping. [37]
- CS2 recording side: GOTV must be "unlocked" to hear players (alltalk or voice-flag plugin) — b0ink's finding, Jan 2024. Whether Valve's *own* MM GOTV would record anything if unlocked is moot; they don't. [24] [25]
- No Valve developer-wiki or patch-note found announcing a demo-voice change; the CS:GO→CS2 story is "same net message, new codec enum, different playback cvars, GOTV-as-listener restriction".

### 7. Tools that extract demo voice (claimed sources)
| Tool | Sources claimed | Notes |
|---|---|---|
| akiver/csgo-voice-extractor | CS:GO + CS2 demos; **not** Valve MM | Uses Valve's CELT lib (CS:GO) + DandrewsDev's CS2 Opus method; modes: split-compact/split-full/single-full [2] |
| DandrewsDev/CS2VoiceData | CS2 demos; **not** Valve MM | Reference implementation on demoinfocs-golang v5; Opus 48k + Steam format [1] |
| LaihoE/demoparser (`parse_voice`) | CS2 demos | Rust; Opus 48 kHz decode, per-SteamID segments with ticks (issue #249) [38] |
| saiko-tech/csgo-demo-voice-capture-example | CS:GO demos; **not** Valve MM | CELT via CS:GO Linux binaries [3] |
| xkti/demo-voice-extract | CS:S + TF2 (not CS2) | CELT + Steam/Opus [39] |
| pythaeusone/Small-Demo-Manager (+ predecessor Voice-Calculator) | "SourceTV (Faceit, ESEA ...)" CS2 demos | .NET → Python port; Opus→WAV + bitfield calculator [15] [31] |
| CaunterComms (KakkaMistaOhJaJa) | FACEIT .dem.zst | Wrapper over akiver's extractor; Whisper transcription [32] |
| DemoVoice extension (zeroutil/selim.services) | FACEIT match rooms only | Browser-local; commands, not audio extraction [40] |
| zeroutil CS2 Demo Voice Extractor (web) | FACEIT/server demos; explicitly "Matchmaking and Premier demos contain no voice" | In-browser Opus→Ogg [41] |
| CS Demo Manager (akiver) | In-game voice aliases + "Generate audio file" in 2D viewer; docs warn "Valve Matchmaking demos do not [contain voice data]" [37] [42] |
| scope.gg / Leetify / Skybox | No shipped demo-voice feature; Skybox has a feature *request* for pulling comms from FACEIT/3rd-party demos (explicitly "not MM") [43] |

## Bottom line

1. **Valve Premier/Competitive MM demos (CS:GO and CS2): no voice. High confidence.** Every extractor's README says so, the community consensus (Reddit, Steam, HLTV-adjacent forums) says so across both eras, and the mechanism (GOTV voice routing + alltalk off + privacy) explains it. No console command or `.dem.info` sidecar changes this. We found no contrary claim anywhere.
2. **FACEIT demos: yes, both teams, Opus 48 kHz in CS2. High confidence** — your empirical data plus FACEIT's own support posts, guides, and at least eight tools that exist specifically to extract/play FACEIT demo voice.
3. **ESEA: yes (CS:GO documented, CS2 presumed).** **5EPlay: yes (changelog-confirmed restoration Nov 2024).** Perfect World, Grid, SkinClub, ReGameDemo.ru: unknown — web evidence genuinely absent; ReGameDemo likely no because tournament GOTV configs ship `tv_relayvoice 0`.
4. **POV demos: teammates yes, own voice only with `voice_loopback 1`, enemies never** (CS:GO-documented; CS2 same design presumed but empirically untested — CS2 `record` is so buggy there's little organized testing).
5. **Pro/HLTV GOTV demos: voice deliberately disabled** (`tv_relayvoice 0` in ESL's official config); treat as no.
6. **CS2 did change the codec stack** (OPUS enum, 48 kHz audio payload in `CMsgVoiceAudio`) and replaced `voice_enable` with `tv_listen_voice_indices`/`_h` playback gating — but did not change *which servers record voice*; that remains a per-server decision.

### How to settle remaining unknowns empirically
- Valve MM: grab any recent `match730_*.dem` from Watch menu (or CS:DM share-code download) and count `CSVCMsg_VoiceData` — expect 0; one demo per era (CS:GO-era if obtainable via archive) closes the history question.
- CS2 POV: record with `voice_loopback 1`, talk, parse own XUID chunks; repeat without loopback; have a teammate talk.
- Perfect World / Grid / SkinClub: download one demo from each (CS:DM supports PW/5E downloads) and count voice messages — nothing published exists to answer this.
- 5EPlay: verify the "restored demo voice" claim still holds in CS2-era demos by parsing one (CS:DM can download 5E demos).
