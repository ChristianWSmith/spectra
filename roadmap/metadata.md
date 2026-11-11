# Match metadata & per-shot telemetry — roadmap research

**Unit:** metadata · **Priority tier:** P4 · **Date:** 2026-11-10
**LoE (aggregate):** M — item 1 (M) is seven fields of which ~half are already
stored or one query away, but game mode / provider / share code need a probe +
research pass (CS2.md entries) before code; item 2 (S, marked "later") is a
small per-shot table over an event spine that is already persisted. No hard
blockers; ≈ up to a week combined.
**Feasibility:** high — every item-1 field except share code has a real source
or a defensible honest-unknown; item 2's per-shot spine (`generic_events`
`weapon_fire` rows) already ships on every import. Blockers: the share code is
a GC/client token probably absent from demo data, played-at exists only for
Valve `.dem.info` demos, and the aim-punch source is unverified — all three
must render "unknown", never a guessed value (honest-metrics rule).

## Items in scope

1. **Match metadata detection** — demo source/provider, played-at date, game
   mode, ranked flag, share code, overtime/max rounds, framerate
2. **Per-shot aim telemetry** — yaw, pitch, recoil index, punch angles and
   velocity per shot; later, further down the road

## Current state

- **`matches` already carries most header facts**: `map`, `patch_version`
  (`CDemoFileHeader` net message — v6 dropped `Parser.Header()`, spectra reads
  it in `extract/handlers.go`), `tick_rate` (`p.TickRate()`), `duration_ticks`
  (final `gs.IngameTick()`), `playback_time_s` (= duration/tickRate),
  `frames` (`p.FrameCount()` — fed by the trailing `CDemoFileInfo`), `server_name`,
  `client_name` ("SourceTV Demo" on GOTV), `game_dir`, `is_pov`
  (`POVRecordingPlayerDetected`), `side_switches`, `real_rounds`,
  `enc_messages` (svc_EncryptedData count), `extracted_at` (import time —
  NOT played-at). Writer: `agg.build` → `lifecycle.SaveExtracted`; column list
  is the ONE `store.matchColumns` (`queries.go`, pinned by
  `columns_schema_test.go`).
- **Ranked data is already extracted per player**: `players.rank/rank_type/wins`
  from `m_iCompetitiveRanking` / `m_iCompetitiveRankType` / `m_iCompetitiveWins`
  on the end-of-demo roster (`extract.go finalPlayer`), plus the `rank_update`
  game event (`RankUpdate` handler → `agg.rankUpdate`). Never displayed. The
  one imported dev match (FACEIT de_inferno) shows rank=0, **rank_type=−1** for
  all 10 humans and 0 for the bot — semantics of −1/0/positive unverified.
- **Overtime/max rounds**: no stored field; both are derivable from `rounds`
  (counted rounds > 24 ⇒ OT; canonical MR12/MR3 rules in CS2.md, side-parity
  arithmetic in `internal/rules.FlipIndexes`) and `matches.side_switches`
  (regulation = 1). demoinfocs v6 also dispatches `events.OvertimeNumberChanged`
  from the gamerules prop `m_nOvertimePlaying` — unused by spectra today.
- **Framerate**: derivable TODAY from existing columns —
  `frames / playback_time_s` (dev match: 181,924 / 2842.34 ≈ 64.0 fps).
- **No provider/source detection exists** (no FACEIT/GOTV/Valve heuristic
  anywhere in `src/`); no share-code code (zero hits repo-wide); CS2.md has no
  share-code, played-at, game-mode or rank-type entry (the `m_szLastPlaceName`
  probe belongs to replay-overlays, not here).
- **`.dem.info` discovery already exists** for the chat key:
  `library.findInfoFile` / `netKeyFromInfoFile` → `demoinfocs.MatchInfoDecryptionKey`
  (`internal/library/library.go`). The companion protobuf
  `CDataGCCStrike15V2_MatchInfo` also carries `matchid`, **`matchtime`** and
  `WatchableMatchInfo{GameType, MatchId, ReservationId}` — none of it read yet.
- **Frontend surfaces**: Match header meta line (map/half/duration/patch/status)
  and the Details tab "Key facts" (`Match.svelte` — Server/Tickrate/Frames/
  Size/Imported/Parser/Voice) are the natural home for the new fields;
  `Library.svelte` columns are Map/Score/Rounds/Duration/Size/Imported/Status
  over `matchListSort` (`extracted_at` default).
- **Per-shot spine exists**: every game event, incl. `weapon_fire`, is stored
  in `generic_events` (name/tick/round/payload_json — payload is
  `userid, weapon, silenced` only; CS2.md "weapon_fire payload": no position,
  no angles, no ammo). Measured: **4,749 `weapon_fire` rows / 4,716
  real-period shots on the one imported FACEIT match** (~4.7k shots ≈ 10× a
  170-kill match). `player_stats.shots` counts them (gated on `realPeriod`).
- **Positions sidecar has NO aim/velocity data**: fixed `q16` layout
  `x i16, y i16, z i16, yaw u8, flags u8` = **8 B/player/frame, 64 Hz**
  (`internal/sidecar/sidecar.go`); pitch deliberately absent (CS2.md "Eye
  angles"), velocity absent. `state.bin` carries hp/armor/weapon/ammo/attack/
  money/helmet/reload — also no angles or velocity. Both layouts are frozen
  (pre-release: no versioned formats — a layout change breaks existing
  sidecars).

## Implementation path

### 1. Match metadata detection — **M** (≈3–5 days)

Per-field source classification — **H = header/import-time, D = derived
(query-time), U = possibly-absent (render "unknown")**:

| Field | Source | Class |
|---|---|---|
| framerate | `matches.frames / matches.playback_time_s` (both stored) — one expression, no new data | D |
| overtime / max rounds | `rounds` counted-round count > 24 + `matches.side_switches ≥ 2` (CS2.md MR12/MR3, `internal/rules`); optionally corroborated at extract via `events.OvertimeNumberChanged`. "Max rounds" (`mp_maxrounds`) is not stored — convar probe of `GameState.Rules().ConVars()` or format-derived (MR12 ⇒ 24) | D |
| ranked flag | `players.rank`/`rank_type` already stored → per-match flag (`rank_type > 0 && rank > 0` ⇒ ranked; 0/−1 ⇒ not ranked/unknown — **semantics need a CS2.md entry first**); `rank_update` events corroborate | D (U outside Valve MM) |
| demo source/provider | heuristic bundle on already-stored fields: `enc_messages > 0` ⇒ Valve-MM (encrypted chat, CS2.md), `is_pov` ⇒ POV recording, `client_name` = "SourceTV Demo" ⇒ GOTV/HLTV, `server_name` pattern (dev match: "FACEIT.com register to play here"), `.dem.info` sibling present ⇒ Valve `match730` pair. Store one `source` column (`valve_mm|faceit|gotv|pov|…|unknown`); demo-of-demo detection = research gap (flag unknown) | H/D (U) |
| played-at date | **no wall clock in the demo itself** — `CDemoFileHeader` and `CDemoFileInfo` carry no timestamp (verified against demoinfocs v6 `msg` defs). Only source found: `.dem.info` `MatchInfo.matchtime` (Valve GC demos; extend the existing `netKeyFromInfoFile` path to also unmarshal `CDataGCCStrike15V2_MatchInfo`). FACEIT/HLTV/POV ⇒ honest "unknown"; file-mtime fallback is a policy call (export-tooling owns ordering, see overlaps) | U (H only with `.dem.info`) |
| game mode | probe-first: (a) `GameState.Rules().ConVars()` (`mp_maxrounds`, `game_mode`-style cvars set via `svc_SetConVar`), (b) `msg.CSVCMsg_ServerInfo.GameSessionConfig.Gamemode` (string field, unverified in CS2 demos), (c) `.dem.info` `WatchableMatchInfo.GameType` (Valve only), (d) inference (roster size ⇒ wingman, `mp_roundtime`, rank presence). Note `m_pGameRules.m_pGameModeRules` is `Noop` in demoinfocs' test set — weak signal. Store `game_mode TEXT`, `unknown` when probes fail | U |
| share code | **not in demo data** — the 24-char `CSGO-…` token is GC/client-issued (in-client "match sharing codes", 30-day expiry, Valve MM only; decodes to matchId/outcomeId/tokenId). Possible reconstruction from `.dem.info` (`matchid` + `WatchableMatchInfo.ReservationId`) is **UNVERIFIED** and needs a real `match730` pair (none in the pool). v1: store empty + render "not available for this demo" | U |

- **Storage:** new nullable columns on `matches` (baseline `schema.sql` edit —
  `CREATE … IF NOT EXISTS` never alters existing DBs; pre-release policy = wipe
  & re-import, no migration) + `models.Match` + the ONE `matchColumns` list +
  `agg.build` fill. Additive columns only; no versioned anything.
- **Probes first (half the item):** one golden-pool diag test dumping
  `Rules().ConVars()`, `GameSessionConfig.Gamemode`, gamerules class name and
  (for the FACEIT match) server-name/`enc_messages` fingerprints; write the
  CS2.md entries (share code, played-at source, game-mode signals, rank_type
  values) — the AGENTS.md domain-knowledge rule makes those a prerequisite.
- **Surfacing:** Match Details "Key facts" rows (Played at / Source / Mode /
  Ranked / Framerate / Overtime) with explicit "unknown" rendering; header meta
  line only for high-confidence fields; report/JSON-envelope meta enrichment
  comes free through `models.Match` (export-formats expects it).
- **Degrade-by-design:** every U field renders `—`/"unknown" with a title
  explaining why (e.g. "no .dem.info companion — match time not recorded in
  the demo"), never 0, never a fabricated date.

### 2. Per-shot aim telemetry — **S** (1–2 days capture; creeps to M with a read surface)

- **Spine:** `generic_events` `weapon_fire` rows already exist per shot
  (4.7k/match). The aim data is not in the payload, so pair it at extract time
  in the existing `events.WeaponFire` handler (`extract/handlers.go` — today it
  only calls `a.shot` for `player_stats.shots`).
- **Per-field sources** (all read at dispatch on `e.Shooter`):
  - **yaw/pitch** — `Shooter.ViewDirectionX()/ViewDirectionY()` (eye angles,
    `m_angEyeAngles`; conventions pinned in CS2.md "Eye angles": X = yaw
    0..360, Y = pitch 270..90 with 270 = −90). NOT in the sidecar (pitch
    deliberately dropped); the `weapon_fire` event itself carries no angles.
  - **recoil index** — `Shooter.ActiveWeapon().RecoilIndex()` reads the
    weapon entity's `m_flRecoilIndex` (exists in demoinfocs; probe CS2 demo
    presence). Corroborating source: `msg.CMsgTEFireBullets.RecoilIndex` /
    `Extra.AimPunch` — the `GE_FireBulletsId` net message is registered as a
    creator (`s2_commands.go`) but demoinfocs dispatches no typed event for it;
    a custom net-message handler is the fallback probe.
  - **punch angles** — NOT exposed by demoinfocs (no `Player.AimPunch…`
    method; only sendtable comments reference `m_aimPunchAngle` /
    `m_pAimPunchServices.m_predictableBaseAngle`). Read the pawn property raw
    via `Entity.PropertyValue` or take `CMsgTEFireBullets.Extra.AimPunch` —
    **probe first; if absent, ship yaw/pitch/recoil/velocity and render punch
    as unknown** (honest metrics).
  - **velocity** — `Shooter.Velocity()` exists with a documented lag at
    `WeaponFire` handlers (demoinfocs doc: ~5 u/s POV, ~20 u/s older GOTV —
    one snapshot stale). The positions sidecar has NO velocity; the fallback
    is frame-diff of quantized positions (stats-advanced's plan) — do not
    duplicate that logic here.
- **Storage: a new `shots` table** (`match_id, tick, round, steam_id, weapon,
  yaw, pitch, recoil_index, punch_*, vel_*`, ~50 B × ~4.7k rows ≈ 240 KB/match)
  — NOT the sidecar: the fixed 8 B/player/frame `q16` positions layout must
  not change (replay-overlays finding; pre-release = no format versioning, and
  per-shot rows are event-shaped, not frame-shaped). `generic_events` payload
  is the wrong home (raw-payload contract, `agg.pairRaw` depends on it).
  Alternative if it must stay out of SQLite: a third sidecar stream pair in the
  match dir (`state.bin` pattern: presence = capability marker in `meta.json`).
- **Later refinement:** the `UserCmd` stream carries full subtick view angles
  (CS2.md: 2.24M rows on public HLTV demos, 92–98% within 5° of eye angles) —
  not extracted today; only worth it if eye angles at dispatch prove too coarse.
- **Consumers are out of scope here** (the roadmap marks it "later"): replay
  per-shot overlays, stats-advanced peek-vs-hold ("per-shot yaw/recoil would
  later strengthen peek detection"), lineups (throw angles). Ship capture +
  one read API; no UI beyond a probe/inspection affordance.

## Existing scaffolding to reuse

- **`.dem.info` plumbing** — `library.findInfoFile`/`netKeyFromInfoFile`;
  extend the single unmarshal to also read `matchtime`/`GameType`/`matchid`
  (one `proto.Unmarshal` into `msg.CDataGCCStrike15V2_MatchInfo`).
- **Header/meta capture path** — `CDemoFileHeader` handler → `headerInfo` →
  `metaInfo` → `agg.build` → `models.Match` → `matchColumns`/`SaveExtracted`
  (the ONE write path; add columns, don't fork the writer).
- **Query-time derivations** — `store.matchSummaryCols` (library list),
  `matchListSort` whitelist, `GetMatch`/`matchColumnsSQL`; new derived fields
  (framerate, OT) can be SELECT expressions first, stored only if a sort/filter
  needs them.
- **Per-shot extraction** — `events.WeaponFire` handler + `agg.shot` +
  `generic_events` pairing patterns (`agg.pairRaw` raw-payload pairing);
  frame-sampled sinks (`FrameDone` yaw sampling for the sidecar) show the
  angle-read idiom.
- **Frontend** — Match.svelte Details `<dl class="facts">` ("Key facts"),
  `fmt.js` (`fmtDate`, `fmt1`), `fmtDuration`, honest "—" fallbacks already in
  that panel; `cachedRead` for any new service method; `SortTh` if a library
  column/sort is added.

## Dependencies & overlaps

- **export-tooling (item 3, played-at ordering):** THEY own the `played_at`
  column's sort plumbing (`matchListSort["played_at"]`, Library `SortTh`,
  keyset NULL arms) — THIS unit owns the *value*. One writer per column; ship
  NULL-padded and fill in. Open owner decision they flagged: **demo in-game
  date (ours) vs last-opened-in-Spectra (theirs)** — the roadmap phrase
  "last-played time" reads like the former; must be settled before either
  writes it. Their JSON-envelope `meta` enrichment (export-formats) consumes
  whatever fields this unit detects.
- **stats-rating (rank history + trends):** consumes `players.rank/rank_type`
  semantics (same −1/0/positive question as our ranked flag) and played-at for
  ordering (today: `extracted_at`). De-conflict who writes the CS2.md
  rank-type entry; both must render rank 0 / rank_type ≤ 0 as "unknown".
- **replay-overlays:** the 8 B/player/frame positions layout is frozen —
  per-shot aim must be a separate table/stream (their explicit ask); eye-angle
  read idiom (`ViewDirectionX`) is theirs to keep canonical for frames.
- **stats-advanced:** future consumer of per-shot yaw/recoil (peek-vs-hold);
  their velocity-by-frame-diff plan is the canonical frame-derived velocity —
  per-shot velocity stays the dispatch-time `Player.Velocity()` read.
- **library:** import pipeline is where new columns/`.dem.info` data enter;
  `Enqueue`/`Reprocess`/cancel semantics untouched (new metadata arrives with
  the parse — re-import to backfill, per no-migration policy).
- **lineups:** throw-angle (`yaw`/`pitch` at `grenade_thrown`) wants the same
  aim snapshot shape — share the `shots`-style row design rather than a second
  angle schema.
- **localization:** new Key-facts labels are plain frontend strings → the
  `definitions.js`/i18n glossary later; DB values (source/mode enums) stay
  stable machine tokens.
- **voice:** no overlap beyond provider detection noting voice presence
  (`voice_presence.key_found` already exists).

## Risks & unknowns

- **Share code is probably not detectable from demo data** — it is a GC token
  (client/Steam tool, 30-day expiry, Valve-MM only); reconstruction from
  `.dem.info` ids is unverified and untestable locally (the pool has no
  `match730` pair, `enc_messages = 0`, no end-to-end MM demo — same gap CS2.md
  records for encrypted chat). Plan: render "not available"; only pursue
  reconstruction after obtaining a real Valve pair + CS2.md entry.
- **Played-at will be "unknown" for most demos** — no wall clock exists in the
  `.dem` (header/file-info verified); only `.dem.info matchtime` (Valve).
  File-mtime fallback changes semantics silently (copy-on-import) — needs the
  owner's call with export-tooling; do not ship a guessed date.
- **Game mode may reduce to inference** — the in-demo signals
  (`GameSessionConfig.Gamemode`, `Rules().ConVars()`) are unprobed in CS2
  demos; `m_pGameModeRules` is `Noop` in demoinfocs' test set. Wrong labels
  are worse than "unknown" — probe, then encode only high-confidence rules.
- **Rank/`rank_type` semantics unverified** (dev FACEIT match: −1 for humans)
  and near-zero outside Valve MM; the ranked flag must degrade to unknown and
  coordinate with stats-rating (one CS2.md entry, one owner).
- **Provider detection is heuristic** (server-name strings, `enc_messages`,
  `client_name`, POV flag) — new providers will misclassify; "demo-of-demo"
  detection has no identified signal at all. Store raw evidence beside the
  label so heuristics can be tightened without re-parsing.
- **Aim-punch availability is the one technical unknown in item 2** — if no
  pawn prop or `CMsgTEFireBullets` field is readable, ship the other four
  fields and mark punch unknown (never a fabricated zero).
- **Schema churn is policy-free but re-import-costly:** every new `matches`
  column touches `matchColumns` + `columns_schema_test.go` and only lands on
  fresh DBs (wipe/re-import, no migration) — fine pre-1.0, means old dev
  libraries show "unknown" until reprocessed.
- **CS2.md entries (share code, played-at, game-mode signals, rank_type,
  aim-punch prop) were NOT written here** (single-file constraint) — the
  implementing agent must append them per the AGENTS.md domain-knowledge rule
  before asserting any of these facts in code.
