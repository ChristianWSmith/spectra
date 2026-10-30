# CS2 Demo Data — Extraction Techniques

*A complete technical walkthrough of every technique used to go from `1-5b17ad32-…-1-1.dem.zst` to `FINAL_REPORT.md`, with code patterns, pitfalls hit, and why each choice was made. Companions (all in this directory): `FINAL_REPORT.md` (results), `TAXONOMY.md` (format taxonomy), `extractor/main.go` (extractor), `extractor/probe/` (net-message probes). The research demo itself was never committed; its findings live in these documents.*

---

## 1. Pre-processing: decompression

The deliverable was zstd-compressed (Steam/FACEIT distribution format).

```bash
zstd -d -k 1-5b17ad32-7d8a-46a7-aabe-3a957be67e0a-1-1.dem.zst -o demo.dem
# 171 MB → 224.7 MB, PBDEMS2 magic verified via xxd
```

**Why decompress first:** demoinfocs reads a raw demo stream; it doesn't handle `.zst` wrappers. Verifying the `PBDEMS2` filestamp up-front confirmed CS2/Source 2 format (not HL2DEMO, which would need v3/v4).

---

## 2. Library & version selection

| Step | Decision | Reason |
|---|---|---|
| First attempt | `demoinfocs-golang/v4` (stable) | Has public `Parser.Header()` |
| Problem | **OOM** (~4 GB allocation in `sendtables2.readFields` on a corrupt/oversized entity field; only 3.6 GB RAM free) | v4 lacks hard decode limits |
| Solution | **v6.0.0-rc.1** (official CS2 parser) | Hard frame/size limits, `IgnorePacketEntitiesPanic`, Context-based `ParseToEnd(ctx)` |

**v4 → v6 API migration** hit while porting `main.go`:
- `ParseHeader()`/`Header()` **gone** (unexported struct) → replaced by net-message technique, §4
- `ParseToEnd(ctx)` requires `context.Context`
- Event field names: `NewState` → `NewIsStarted`/`NewIsWarmupPeriod`/`NewIsFreezetime`; `OldPhase/NewPhase` → `OldGamePhase/NewGamePhase`
- `RoundEndReason.String()` doesn't exist → hand-written 20-case name map
- `EqC4` → `EqBomb`, `EqSmokegrenade/EqFlashbang` → `EqSmoke/EqFlash`; MVP reasons limited to 3 constants
- `VoteCast`/`PlayerInspectingWeapon` don't exist in v6 → dropped
- `p.ServerClasses()` is an interface → `len(...All())`
- `OtherDeath` has `OtherType`/`Killer`, no `Player`

**Memory-lean parser configuration** (`main.go:478`):

```go
p := demoinfocs.NewParser(f,
    option.IgnorePacketEntitiesPanic(true), // corrupt PacketEntities → ParserWarn, not fatal
    option.MsgQueueBufferSize(0),           // sequential parse: no unbounded msg queue RAM
)
```

Result: 22 s wall-time on 224.7 MB, **zero parser warnings**.

---

## 3. Typed event-handler fan-out (52 handlers, 51 event types)

Core pattern: `Parser.RegisterEventHandler` with a typed closure per event. The extractor registers handlers for **every domain**:

```
Combat:     Kill, PlayerHurt, WeaponFire, BulletDamage, PlayerFlashed, Footstep,
            PlayerJump, OtherDeath
Objective:  RoundStart, RoundFreezetimeChanged, RoundEnd, RoundMVPAnnouncement,
            BombPlanted/Defused/Explode/PlantAborted/DefuseAborted/Pickup/Dropped,
            HostageRescued/RescuedAll/Hurt/Killed
Utility:    HeExplode, FlashExplode, SmokeStart, FireGrenadeStart, DecoyStart
Flow:       MatchStart, MatchStartedChanged, AnnouncementFinalRound/LastRoundHalf/
            MatchStarted/WinPanelMatch, TeamSideSwitch, IsWarmupPeriodChanged,
            GamePhaseChanged, GameHalfEnded, OvertimeNumberChanged
People:     PlayerConnect/Disconnected, PlayerNameChange, PlayerTeamChange,
            ChatMessage, SayText, RankUpdate
Economy:    ItemPickup, ItemDrop, ConVarsUpdated
Meta:       GenericGameEvent, ParserWarn, POVRecordingPlayerDetected
```

Key behaviors inside handlers:

- **Warmup filtering** — every accumulation gated by `p.GameState().IsWarmupPeriod()` so warmup knife fights don't pollute stats (R2 in the report is a warmup round).
- **Tick-stamping** — objective/flow events capture `GameState().IngameTick()` at fire time for round durations, plant times.
- **Flag extraction on kills** — `IsHeadshot`, `IsWallBang()`, `NoScope`, `ThroughSmoke`, `AttackerBlind`, `AssistedFlash`, `Distance` composed into feed lines.

---

## 4. Header extraction without `Parser.Header()` (v6 gap)

v6 stopped exposing the demo header. The header *is* dispatched as a net-message (`DEM_FileHeader` → `msg.CDemoFileHeader`), so:

```go
var demoHeader msg.CDemoFileHeader
p.RegisterNetMessageHandler(func(m *msg.CDemoFileHeader) {
    demoHeader = *m
    md.MapName = m.GetMapName()          // de_mirage
    md.ServerName = m.GetServerName()    // FACEIT.com…
    md.NetProto = int(m.GetPatchVersion()) // 14193
    md.GameDir = m.GetGameDirectory()
})
```

Post-parse fill-ins: `FrameCount()` (only available at end for S2), `IngameTick()` + `TickRate()` for playback duration, `len(ServerClasses().All())` = 222.

---

## 5. Final-state extraction (`GameState` snapshot)

After `ParseToEnd`:

```go
gs := p.GameState()
// teams: name/flag/score/money spent/equip value
gs.TeamCounterTerrorists() / gs.TeamTerrorists()
// roster: Playing() vs Connected() → scoreboard + spectators
gs.Participants().Playing() / .Connected()
// live world: entities, weapons, grenade projectiles, infernos, hostages, bomb
len(gs.Entities()) // 263 at end
// rules: every mp_*/sv_* ConVar + round/freeze/bomb timers
gs.Rules().ConVars() // 70+ entries
```

Per-player end state pulled from `common.Player` accessors: `Kills()`, `Deaths()`, `Assists()`, `MVPs()`, `Score()`, `Ping()`, `Rank()`, `CrosshairCode()`, `ClanTag()`, `Weapons()` (inventory), `Position()`, `ActiveWeapon()`, `MoneySpentTotal()`, `TotalDamage()`, `UtilityDamage()`.

**Known limitation:** 5/10 players had disconnected before demo end, so `Playing()` returned only 5 — their team/identity/scoreboard fields show empty. Their *event-derived* stats (kills, damage, etc.) were already accumulated during the parse and remain complete.

---

## 6. Player identity map (`getAgg` closure)

One aggregator per human player, keyed to survive reconnects:

```go
getAgg := func(pl *common.Player) *playerAgg {
    key := pl.SteamID64
    bot := pl.IsBot
    if key == 0 { // bots: stable synthetic key from entity id
        key = 0xFF00000000000000 | uint64(pl.EntityID&0x0FFFFFFF)
        bot = true
    }
    if a, ok := md.Players[key]; ok { return a }
    a := newAgg(pl.Name, pl.SteamID64, bot) // init all maps (weapon kills, hitgroups…)
    md.Players[key] = a
    return a
}
```

Notes:
- **SteamID64** is the primary key (immune to name/team changes; verified against scoreboard `Kills()` at end).
- Same dual-key scheme used for round multi-kill counting (`roundKills[round][key]`).
- Structural pitfall hit: **synthetic bot keys can collide with real low steamIDs** if masked badly — the `0xFF…` prefix avoids that but was never exercised (no bots in this demo).

---

## 7. Derived-metric algorithms (computed from event streams)

Nothing below comes free from the library — all reconstructed from event sequences:

### 7.1 Round reconstruction state machine
```
RoundStart → md.CurrentRound++, startTick, init roundKills/clutchState, reset trade window
RoundFreezetimeChanged(old=true→false) → freezeEndTick, team equip values at freeze end,
                                          sample per-player money/equip
RoundEnd → endTick, winner, reason; duration = (end−start)/TickRate;
           running score counters; clutch evaluation (§7.4)
RoundMVPAnnouncement → round MVP + per-player MVP tally/reasons
```
Warmup rounds flagged via `gs.IsWarmupPeriod()` at `RoundStart`.

### 7.2 Trade kills (≤5 s window)
```
on Kill:  dt = now − lastDeathTick[victim.Team]   // reset every RoundStart
          if dt/TickRate ≤ 5.0 → killer.TradeKills++
on Kill:  lastDeathTick[victim.Team] = now
```

### 7.3 Entry kills / first blood
First `Kill` of a round sets `r.FirstKill/FirstDeath` and increments killer's `EntryKills`.

### 7.4 Clutch detection (approximation)
```
on Kill (non-warmup): count aliveOwn / aliveEnemy from Participants().Playing()
                      if aliveOwn == 1 && aliveEnemy ≥ 1 →
                          soleSurvivorKills[killerKey]++       // per round
on RoundEnd (winner ≠ SPEC): if exactly 1 survivor on winning team
                              and its solo-kills ≥ 1 →
                              Clutch1vN++ where N = solo kills
```
Approximation by design: counts kills made *as* the last man standing, not a full back-tracked "was 1vN from the moment teammates died" analysis.

### 7.5 Multi-kills, streaks, ADR, accuracy
- **3K/4K/ACE:** monotonic per-round kill counter per player key; exact-hit at 3/4/5.
- **Kill streak:** incremented on kill, zeroed on death (cross-round "no-death" streak).
- **ADR:** `sum(HealthDamage from PlayerHurt as attacker) / realRounds` (matches HLTV's dmg-based ADR convention, not HealthDamageTaken).
- **Accuracy:** `PlayerHurt count as attacker / WeaponFire count`.
- **HS%:** headshot kills / kills.
- **Kill distances:** `events.Kill.Distance` → avg/max per player; global max = "longest kill".

### 7.6 Utility attribution
`HeExplode/FlashExplode/SmokeStart/FireGrenadeStart/DecoyStart` → thrower's per-type counters; `PlayerHurt` weapon-type switch → utility damage split. Flash *pops* counted on detonation (thrower attribution), flashed-victims counted on `PlayerFlashed`.

---

## 8. Weapon/economy extraction

- **Damage & kills by weapon:** `PlayerHurt.Weapon` / `Kill.Weapon` → `Type.String()`; fallback to `WeaponString` when type is `EqUnknown` (world damage).
- **Hitgroup damage:** `PlayerHurt.HitGroup` → named map (Head/Stomach/Chest/…).
- **Shots:** `WeaponFire` per shooter+weapon.
- **Bought/acquired items:** `ItemPickup`/`ItemDrop` counters; purchase-intent never recorded by the format itself.
- **Economy:** `TeamState.FreezeTimeEndEquipmentValue()` at freeze-end event per round; `MoneySpentTotal()` per team; per-player money sampled at freeze end for averages.

---

## 9. Raw event coverage (generic escape hatch)

```go
p.RegisterEventHandler(func(e events.GenericGameEvent) {
    md.GenericEventCounts[e.Name]++
})
```
Captures **every** game-event name even without a typed struct — this produced the 46-type histogram (§II.10 of FINAL_REPORT) and doubles as a completeness check: any event the library doesn't model still shows up here. `ParserWarn` handler captures non-fatal parse issues (0 in this run).

---

## 10. Net-message probes (separate pass)

A second, minimal program (`extractor/probe/main.go`) counted payloads the main report never touched — same parse setup, three handlers, atomics:

```go
p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData) {
    voice.Add(1); xuids[m.GetXuid()]++
    if m.GetCaster() { casters.Add(1) }
})
p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_EncryptedData) { enc.Add(1) })
p.RegisterNetMessageHandler(func(m *msg.CDemoUserCmd)        { demoUserCmd.Add(1) })
```

**Results:** 77,702 voice chunks across 10 XUIDs (0 caster) · 0 encrypted messages · 0 user commands (GOTV).

**Why a separate pass:** probes are cheap to iterate (compile/run/throwaway) and avoid bloating the main extractor with handlers whose data we hadn't decided how to report yet. Voice decoding itself was *not* attempted — counting proved presence and player attribution; opus decode (libopus + CS2VoiceData pattern) is the documented next step.

---

## 11. Output assembly & sanitization

- All reporting done with `bufio.Writer` into Markdown tables; sort helpers (`sortedCounts`, kills-desc player sort) keep tables deterministic.
- **Null-byte scrubbing:** player names contained `\0` bytes → `file` reported "data" and editors refused the file; fixed with `tr -d '\000' < REPORT.md`. Lesson: always sanitize untrusted strings (names, chat, clan tags) before writing text output.
- Go formatting: `gofmt -e` + `go vet` + `go build` after each API migration; `go mod tidy` to resolve transitive deps.

---

## 12. Research techniques (for the taxonomy, not the bytes)

Complementary to parsing — establishing *what exists*:

1. **`go doc` API archaeology** — enumerated the entire v6 surface (`events`, `common`, `msg`, `option`) to map every extractable field before writing handlers.
2. **Library source reading** — `parser.go`/`parsing.go`/`s2_commands.go` in the module cache answered "where does the header go in v6?" (dispatched to `msgQueue` as `CDemoFileHeader`) and how demo commands vs net-messages are routed.
3. **CS2OpenDev artifacts** — ground truth for the taxonomy: 289 game-event definitions, 140 user messages, 65 network messages, 20 demo commands, entity schema (20.7 MB JSON). Distinguishes "exists in format" from "demo fired it".
4. **Web research on the encryption key** — demoinfocs release notes (Sept 2026 change), cs2parser `encrypted-chat.md` (key = 16 uppercase hex chars of GC `cl_decryptdata_key_pub`), demofile `replaykeys.ts` (reference implementation) → concluded key lives in the `.dem.info` companion, not game files.
5. **Voice-availability research** — CS2VoiceData/csgo-voice-extractor READMEs established "Valve MM has no voice; FACEIT/server demos do" → motivated the §10 probe.

---

## 13. Techniques considered but not used (and why)

| Technique | Why skipped |
|---|---|
| Per-frame position recording (`events.FrameDone` → `Player.Position()`) | Not requested for v1 report; documented as next step (needs tick-rate-gated sampling, ~4.5 bytes/tick/player) |
| Opus decode of voice chunks | Needs `libopus` system dep; probe proved data exists — decode is a standalone follow-up |
| `.dem.info` key extraction | No companion file exists for this FACEIT demo; and probe showed 0 encrypted messages anyway |
| v4 `ParserHeader()` direct read | v4 OOM'd on this demo (§2); v6 has no public header — net-message technique instead |
| Registering *all* `AdditionalNetMessageCreators` | No unknown-message problem observed; generic events covered the gap |
| String-table / console-command dumps | Available via raw handlers; low analytical value for this report |
| GC protobufs (rank, deep stats) | Not present in `.dem` at all — live GC session required |

---

## 14. Technique → artifact map

| Technique | Where it shows up |
|---|---|
| zstd decompress + filestamp check | `demo.dem`, header table |
| v6 options (sequential, panic-ignore) | successful 22 s parse, no warnings |
| `CDemoFileHeader` net-handler | FINAL_REPORT §II.1 header fields |
| 52 typed handlers | §II.2–II.10 (everything) |
| `GenericGameEvent` histogram | §II.10 (46 event types) |
| `GameState` end snapshot | §II.1/II.2/II.3 final state, ConVars |
| `getAgg` identity map | §II.3 all player aggregates |
| Derived algorithms (§7) | ADR, trades, entries, clutches, streaks, 3Ks |
| Round state machine | §II.4 rounds table, durations, freeze-end econ |
| Net-message probes | §I.6 voice 77,702 / encryption 0 / input 0 |
| Research (§12) | §I taxonomy, key correction, tool list |

---

*Extraction stack: Go 1.27.3 · demoinfocs-golang v6.0.0-rc.1 · zstd 1.5.7 · CS2OpenDev build 26281801 reference · artifacts: `extractor/main.go` (extractor), `extractor/probe/` (probes), `REPORT.md`/`TAXONOMY.md`/`FINAL_REPORT.md` (outputs; REPORT.md superseded by FINAL_REPORT.md and not kept).*
