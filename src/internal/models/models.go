// Package models is the normalized domain vocabulary shared by the
// extraction engine (internal/extract, which produces these values from a
// parsed demo), the store (internal/extract persists), and the frontend
// services (which return them over the Wails bindings as JSON). No
// demoinfocs or SQL type may leak across package boundaries — these are the
// only shapes that flow.
package models

import "time"

// Match lifecycle statuses (matches.status).
const (
	StatusQueued  = "queued"
	StatusParsing = "parsing"
	StatusReady   = "ready"
	StatusFailed  = "failed"
)

// Job lifecycle statuses (jobs.status).
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobDone      = "done"
	JobFailed    = "failed"
	JobCancelled = "cancelled"
)

// Job stages (jobs.stage) — the progress event's coarse position. The
// stage names the pipeline step the job is in; Job.Progress carries the
// job-WIDE position (see Job), so a stage's value range is fixed:
//
//	queued  0.00        claimed, nothing read yet (indeterminate)
//	hash    0.00 → 0.10 sha256 bytes read ÷ file size
//	copy    0.10 → 0.20 copy-on-import bytes written ÷ file size
//	decompress 0.20     zstd sniff — the byte counter starts over here
//	parse   0.20 → 0.90 stream bytes consumed ÷ file size (demoinfocs
//	                    pulls as it parses; frame totals are unknowable
//	                    mid-parse for CS2, frames only signal the end)
//	store   0.90        persisting the extract
//	analyze 0.95        post-import analytics pass
//	done    1.00
const (
	// StageHash is the sha256 pass over the source file (before any
	// match row exists — the synthetic Library rows key off it).
	StageHash = "hash"
	// StageCopy is copy-on-import: the raw demo landing in the managed
	// demo dir (skipped when the copy already exists, and never emitted
	// when the copy_on_import setting is off — hash 0.10 → decompress 0.20
	// then hand over with no copy stage in between).
	StageCopy       = "copy"
	StageQueued     = "queued"
	StageDecompress = "decompress"
	StageParse      = "parse"
	StageStore      = "store"
	// StageAnalyze is the post-import analytics pass (M3, library worker).
	StageAnalyze = "analyze"
	StageDone    = "done"
)

// Event kinds (events.kind). The timeline filter and round views key off
// these strings; keep them stable once shipped.
const (
	EventKill        = "kill"
	EventDamage      = "damage"
	EventBlind       = "blind"
	EventBombPlant   = "bomb_plant"
	EventBombDefuse  = "bomb_defuse"
	EventBombExplode = "bomb_explode"
	EventBombDrop    = "bomb_drop"
	EventBombPickup  = "bomb_pickup"
	// The plant/defuse ATTEMPT lifecycle — the entity-derived demoinfocs
	// mimic events (BombPlantBegin / BombPlantAborted / BombDefuseStart /
	// BombDefuseAborted): a begin/start OPENS an attempt the frontend
	// closes with the matching bomb_plant / bomb_defuse completion or the
	// *_abort cancel. No stat counts them (rings + cue points only), and
	// the raw bomb_beginplant / bomb_begindefuse game events still ride
	// generic_events — the *_abort cancels have NO raw counterpart, so
	// these typed rows are the ONLY cancel signal. Verified on the golden
	// pool (extract's TestDiagPlantDefuseSequences: 92 plant + 32 defuse
	// attempts, an abort never co-occurs with a completion).
	EventBombPlantBegin  = "bomb_plant_begin"
	EventBombPlantAbort  = "bomb_plant_abort"
	EventBombDefuseStart = "bomb_defuse_start"
	EventBombDefuseAbort = "bomb_defuse_abort"
	EventGrenadeThrow    = "grenade_throw"
	EventGrenade         = "grenade"
	// weapon_drop / weapon_pickup — dropped-gun and dropped-utility
	// evidence for the replay map's drop layer (ONE kind pair for guns
	// and util; detail_json `cat` carries the "gun"|"util" split from
	// the CANONICAL util set models.IsUtilityWeapon). A weapon_drop row
	// is inferred at events.Kill (primary → secondary → no gun, plus at
	// most one util: last-held → most expensive — extract.inferDeathDrops
	// owns the rule) and stores the victim's position at the kill tick;
	// a weapon_pickup row is the raw item_pickup event restricted to
	// gun/util items (the picker's position at that tick) — the
	// terminator the frontend evidence rule (lib/replay/drops.js) reads.
	// Raw game events for these kinds ride generic_events like every
	// other untyped source (the *_drop rows are inference, so they carry
	// no raw payload of their own).
	EventWeaponDrop   = "weapon_drop"
	EventWeaponPickup = "weapon_pickup"
	// EventGrenadeLand marks a grenade COMING TO REST (the decoy's
	// activation — decoy_started): the flight ends here and the noise
	// window starts; the EXPLOSION stays an EventGrenade row
	// (decoy_detonate → BaseGrenade.Explode, sfx remaps it to the HE
	// group). Deliberately NOT an EventGrenade: no stat counts a landing
	// (analytics/heatmap match EventGrenade exactly), and the replay's
	// scrubber must not put a det-marker on an activation.
	EventGrenadeLand = "grenade_land"
	// EventGrenadeBounce marks a grenade projectile BOUNCING off a
	// surface: a CMsgSosStartSoundEvent for one of the five grenade
	// bounce soundevents (HEGrenade.Bounce / Flashbang.Bounce /
	// SmokeGrenade.Bounce / Molotov.Bounce / IncGrenade.Bounce — no
	// decoy bounce exists), deduplicated per (source entity, tick, name)
	// because the game fires two SOS messages for most bounces (their
	// origins differ by <1 u; the first one wins). Row positions come
	// from packed_params — a bounce whose origin cannot be parsed is
	// SKIPPED, never stored without a guessed position (missing required
	// input ⇒ no row). Deliberately NOT an EventGrenade/EventGrenadeLand:
	// no stat or detonation/landing rule may count a bounce, and the
	// replay pairs throw → bounces → det by the projectile entity (the
	// `entity` key in detail_json, shared with grenade_throw/grenade).
	EventGrenadeBounce = "grenade_bounce"
	// EventExtinguish marks a fire being PUT OUT — the SOS
	// Molotov.Extinguish soundevent, the ONLY extinguish soundevent in the
	// install (no Incendiary variant: the same sound plays whether a
	// Molotov or an Incendiary fire dies, and in BOTH scenarios the owner
	// specified — smoke lands on a burning fire, or a firebomb lands
	// inside an active smoke and never ignites). Captured by extract's
	// third SOS wave (sos.go fireCueDefs) and played as an audio-only
	// replay cue (sfx.js fireCues) — deliberately claimed by NO landmark
	// CATEGORIES entry (owner: no feed visibility, 2026-11-12), so it is
	// fetched by the world draw set but never listed by the feed.
	EventExtinguish = "extinguish"
	// EventStartFailed marks a firebomb's AIR-BURST failure cue — the SOS
	// Molotov.StartFailed / IncGrenade.StartFailed soundevents (→
	// …_detonate_air_01.vsnd_c): the fire grenade blooms in the air and no
	// fire is emitted (owner ruling, 2026-11-12; corroborated by the asset
	// names and the Sept 29 2023 patch's in-air vs on-ground bloom
	// sounds). Audibly distinct from the extinguish cue; the row's weapon
	// ("Molotov" / "Incendiary Grenade" — from the soundevent name, never
	// guessed) selects which air-burst file plays. Captured and played
	// unconditionally: play what the demo recorded. Unclaimed like the
	// other cue kinds (no feed entry).
	EventStartFailed = "start_failed"
	// EventSmash marks a firebomb DETONATING (landing and breaking —
	// owner's term, 2026-11-12): the SOS Molotov.Smash / IncGrenade.Pop
	// soundevents — the only container-break sounds in their families
	// (no IncGrenade.Smash exists; Pop is the incendiary twin by family
	// elimination, flagged for the owner's by-ear verification). Both fire
	// 0× across the current 7-demo pool and are captured anyway (owner
	// decision: wire the dead capture, verify manually). Row weapon
	// ("Molotov" / "Incendiary Grenade" from the soundevent name) picks
	// which break file plays. Unclaimed: audio-only cue.
	EventSmash = "smash"
	// EventFadeOut marks Inferno.FadeOut — the fire fading out. It
	// co-fires at +0 from the SAME source entity as the extinguish cue at
	// suppressed landings (59/66 pool extinguish cues, 5/5 of the
	// land-in-no-fire cases) and also plays at every fire's death — so,
	// captured unconditionally, the replay plays it at fire expiry too
	// (what the demo recorded). Kept because the inventory DOES show it
	// firing at suppressed landings (the probe's carve-out). Unclaimed:
	// audio-only cue, no feed entry.
	EventFadeOut    = "fade_out"
	EventRoundStart = "round_start"
	EventRoundEnd   = "round_end"
	EventConnect    = "player_connect"
	EventDisconnect = "player_disconnect"
)

// Sound-event kinds (sound_events.kind) — the classification of one player
// sound heard as a CMsgSosStartSoundEvent (footsteps, landings, jumps, fall
// damage). Extracted from the SOS NAME, never guessed (the material/team
// tokens ride beside them on the row). Keep them stable once shipped.
const (
	// SoundStep is a walking/running footstep: `<CT|T>_<Material>.StepLeft`
	// (the surfaceproperties walkleft/walkright vocabulary).
	SoundStep = "step"
	// SoundLand is a landing: `Land_<Material>.StepLeft`, `Land.Thud` and
	// `Default.Land`.
	SoundLand = "land"
	// SoundJump is a jump: `Gear.JumpLand.CT/.T` and `Default.WalkJump`.
	SoundJump = "jump"
	// SoundFall is fall damage: `Player.DamageFall*`.
	SoundFall = "fall"
)

// Match is the header/lifecycle row for one imported demo (matches table).
// Zero Status means "ready" for extract-produced values.
type Match struct {
	ID             int64     `json:"id"`
	Path           string    `json:"path"`
	SHA256         string    `json:"sha256"`
	Size           int64     `json:"size"`
	Map            string    `json:"map"`
	PatchVersion   int       `json:"patchVersion"`
	TickRate       float64   `json:"tickRate"`
	DurationTicks  int       `json:"durationTicks"`
	PlaybackTimeS  float64   `json:"playbackTimeS"`
	Frames         int       `json:"frames"`
	ServerName     string    `json:"serverName"`
	ClientName     string    `json:"clientName"`
	GameDir        string    `json:"gameDir"`
	NetProto       string    `json:"netProto"`
	IsPOV          bool      `json:"isPov"`
	RealRounds     int       `json:"realRounds"`
	ScoreCT        int       `json:"scoreCT"`
	ScoreT         int       `json:"scoreT"`
	HalfCT         int       `json:"halfCT"`
	HalfT          int       `json:"halfT"`
	SideSwitches   int       `json:"sideSwitches"`
	EntityClasses  int       `json:"entityClasses"`
	EndEntityCount int       `json:"endEntityCount"`
	ParserVersion  string    `json:"parserVersion"`
	ExtractedAt    time.Time `json:"extractedAt"`
	ParseMS        int64     `json:"parseMs"`
	WarningsCount  int       `json:"warningsCount"`
	Status         string    `json:"status"`
	Error          string    `json:"error"`
	// Position sidecar mirror (matches.sample_rate / position_frames): 0
	// when the match has no sidecar. The sidecar meta.json is the source
	// of truth when present.
	SampleRate     int `json:"sampleRate"`
	PositionFrames int `json:"positionFrames"`
	// EncryptedMessages counts svc_EncryptedData net-messages seen during
	// the parse (M4): encrypted chat is demoinfocs-internal (decrypted inner
	// messages dispatch as normal chat events when ParseOptions.NetKey is
	// set), so this counter plus voice_presence.key_found are the only
	// provenance the UI has for the "chat possibly encrypted" lock chip.
	EncryptedMessages int `json:"encryptedMessages"`
	// CopyState is the fs-derived demo-copy state ("copied" | "external" |
	// "missing" — library.CopyState*). SERVICE-OWNED: the store never
	// fills it; MatchService.GetMatch stamps it from Importer.CopyState
	// (see the same field on MatchSummary).
	CopyState string `json:"copyState"`
}

// Team is one side's summary for a match (teams table).
type Team struct {
	Side       string `json:"side"` // "ct" | "t"
	Name       string `json:"name"`
	Flag       string `json:"flag"`
	Score      int    `json:"score"`
	MoneySpent int    `json:"moneySpent"`
	EquipTotal int    `json:"equipTotal"`
}

// Player is identity/final-state data for one participant (players table).
// SteamID is the string form of the SteamID64 — the stable join key.
// FinalStatePresent records whether this row appeared in the final-state
// snapshot (provenance: rows false survived only via event-derived data —
// PRD §6.1, M1 risk "disappearing players").
type Player struct {
	MatchID           int64  `json:"matchId"`
	SteamID           string `json:"steamId"`
	Name              string `json:"name"`
	IsBot             bool   `json:"isBot"`
	Side              string `json:"side"` // "ct" | "t" (final side)
	ClanTag           string `json:"clanTag"`
	CrosshairCode     string `json:"crosshairCode"`
	Rank              int    `json:"rank"`
	RankType          int    `json:"rankType"`
	Wins              int    `json:"wins"`
	Ping              int    `json:"ping"`
	FinalAlive        bool   `json:"finalAlive"`
	FinalStatePresent bool   `json:"finalStatePresent"`
}

// PlayerStats is one player's aggregate for one match (player_stats table).
// Every field is computed by the extractor from events/final state; ratios
// like ADR/HS% are stored precomputed so reads never re-derive them.
type PlayerStats struct {
	MatchID int64  `json:"matchId"`
	SteamID string `json:"steamId"`
	Side    string `json:"side"`
	Name    string `json:"name"` // denormalized for display convenience
	Kills   int    `json:"kills"`
	Deaths  int    `json:"deaths"`
	Assists int    `json:"assists"`
	// FlashAssists are AssistedFlash assists, split out of Assists —
	// external scoreboards exclude them from the assist column (the game's
	// own m_iAssists includes them; see models.Round/CS2 knowledge).
	FlashAssists    int     `json:"flashAssists"`
	Headshots       int     `json:"headshots"`
	Teamkills       int     `json:"teamkills"`
	Suicides        int     `json:"suicides"`
	MVPs            int     `json:"mvps"`
	Score           int     `json:"score"`
	TotalDamage     int     `json:"totalDamage"`
	DamageTaken     int     `json:"damageTaken"`
	Shots           int     `json:"shots"`
	Hits            int     `json:"hits"`
	ADR             float64 `json:"adr"`
	HSPct           float64 `json:"hsPct"`
	RoundsPlayed    int     `json:"roundsPlayed"`
	EntryKills      int     `json:"entryKills"`
	EntryDeaths     int     `json:"entryDeaths"`
	OpeningKills    int     `json:"openingKills"`
	OpeningDeaths   int     `json:"openingDeaths"`
	TradeKills      int     `json:"tradeKills"`
	BestStreak      int     `json:"bestStreak"`
	TwoK            int     `json:"twoK"`
	ThreeK          int     `json:"threeK"`
	FourK           int     `json:"fourK"`
	FiveK           int     `json:"fiveK"`
	UtilityDamage   int     `json:"utilityDamage"`
	EnemiesFlashed  int     `json:"enemiesFlashed"`
	FlashedTimes    int     `json:"flashedTimes"`
	BombPlants      int     `json:"bombPlants"`
	BombDefuses     int     `json:"bombDefuses"`
	MoneySpentTotal int     `json:"moneySpentTotal"`
	KillsByWeapon   string  `json:"killsByWeapon"`  // JSON object weapon→count
	DamageByWeapon  string  `json:"damageByWeapon"` // JSON object weapon→damage
}

// Round is one round's summary (rounds table). Number is the extractor's
// dense, counted-round index (first-half pistol = 1): knife/warmup/
// post-match rounds are discarded at ingest (extract.agg.roundStart), so
// every stored row is counted play. MVP/MVPReason are best-effort: some
// demos never emit round-MVP data (the golden demo does not) — empty
// means "absent", not zero.
type Round struct {
	MatchID         int64   `json:"matchId"`
	Number          int     `json:"number"`
	Winner          string  `json:"winner"` // "ct" | "t" | "" (unresolved)
	Reason          string  `json:"reason"` // CTWin | TerroristsWin | BombDefused | TargetBombed | …
	DurationS       float64 `json:"durationS"`
	StartTick       int     `json:"startTick"`
	EndTick         int     `json:"endTick"`
	MVP             string  `json:"mvp"` // SteamID64, may be empty
	MVPReason       string  `json:"mvpReason"`
	EquipCT         int     `json:"equipCT"`
	EquipT          int     `json:"equipT"`
	BombSite        string  `json:"bombSite"` // "A" | "B" | ""
	FreezeEndTick   int     `json:"freezeEndTick"`
	FirstKillSteam  string  `json:"firstKillSteam"`
	FirstDeathSteam string  `json:"firstDeathSteam"`
}

// RoundEconomy is one side's economy sample for one round
// (round_economy table). Side is "ct" | "t".
// Spent is the side's real per-round spend: Σ over its players of the
// delta in the live cumulative money-spent counter
// (m_pInGameMoneyServices.m_iTotalCashSpent) between this round's
// freeze time end and the previous one (extract.agg.freezeEnd) — money
// spent on buys, not equipment value.
// FreePistolValue is the side's held free spawn-issued default-pistol
// value at the same freeze end (extract.freeSpawnPistolValue): granted,
// not bought — they count inside equipment value, so net worth includes
// them (CS2.md "Free spawn-issued default pistol").
type RoundEconomy struct {
	MatchID         int64  `json:"matchId"`
	Round           int    `json:"round"`
	Side            string `json:"side"`
	EquipValue      int    `json:"equipValue"`
	MoneySampledSum int    `json:"moneySampledSum"`
	MoneySamples    int    `json:"moneySamples"`
	Spent           int    `json:"spent"`
	FreePistolValue int    `json:"freePistolValue"`
}

// Event is one normalized typed event (events table). Seq is insertion
// order, assigned by the store. DetailJSON carries the extractor's derived
// detail; RawJSON the original game-event payload (PRD: never silently
// discard). Attacker/Victim/Assister are SteamID64 strings ("" if none).
// PosX/PosY/PosZ are the position the source event exposes — victim/hit
// position for damage/kill, throw position for grenade_throw, detonation
// position for grenade, bomb-entity position for bomb plant/defuse/explode
// — nil when the source lacks a position. AttackerPos* is the attacker's
// position at the source event (kill events — the "where the killer was"
// half of the kills heatmap; nil when the source lacks it).
type Event struct {
	Seq           int      `json:"seq"`
	Tick          int      `json:"tick"`
	Round         int      `json:"round"`
	Kind          string   `json:"kind"`
	Attacker      string   `json:"attacker"`
	Victim        string   `json:"victim"`
	Assister      string   `json:"assister"`
	Weapon        string   `json:"weapon"`
	Headshot      bool     `json:"headshot"`
	Wallbang      bool     `json:"wallbang"`
	Noscope       bool     `json:"noscope"`
	ThroughSmoke  bool     `json:"throughSmoke"`
	AttackerBlind bool     `json:"attackerBlind"`
	AssistedFlash bool     `json:"assistedFlash"`
	Distance      float64  `json:"distance"`
	Hitgroup      string   `json:"hitgroup"`
	Dmg           int      `json:"dmg"`
	Site          string   `json:"site"`
	DetailJSON    string   `json:"detailJson"`
	RawJSON       string   `json:"rawJson"`
	PosX          *float64 `json:"posX,omitempty"`
	PosY          *float64 `json:"posY,omitempty"`
	PosZ          *float64 `json:"posZ,omitempty"`
	AttackerPosX  *float64 `json:"attackerPosX,omitempty"`
	AttackerPosY  *float64 `json:"attackerPosY,omitempty"`
	AttackerPosZ  *float64 `json:"attackerPosZ,omitempty"`
	// AttackerInAir is the player_death payload's `attackerinair` (the
	// attacker was midair). demoinfocs' events.Kill has NO MidAir field
	// and dispatches BEFORE the raw GenericGameEvent, so the extractor
	// derives it from the paired payload at flush time (agg.flushRaw) —
	// absent payload ⇒ false, never guessed.
	AttackerInAir bool `json:"attackerInAir"`
}

// GenericEvent is one raw game-event (generic_events table) — the histogram
// + payload viewer source. RowID is the SQLite rowid (generic_events has no
// primary key; it is the stable record identity for landmark selection).
// Who/Label are service-side display fields built by the ONE generic-event
// labeler (eventlabels.go) — the ConVar/team payload parsing lives there,
// never in a second copy.
type GenericEvent struct {
	MatchID     int64  `json:"matchId"`
	RowID       int64  `json:"rowId"`
	Name        string `json:"name"`
	Tick        int    `json:"tick"`
	Round       int    `json:"round"`
	PayloadJSON string `json:"payloadJson"`
	Who         string `json:"who,omitempty"`
	Label       string `json:"label,omitempty"`
}

// Chat is one chat/system line (chat table).
type Chat struct {
	MatchID int64  `json:"matchId"`
	Tick    int    `json:"tick"`
	Round   int    `json:"round"`
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Text    string `json:"text"`
	Kind    string `json:"kind"` // "chat" | "system" | "saytext"
	// Channel is the chat channel of a row: "all" (reads [ALL]) or
	// "team" (the speaker's SIDE at that round — [T]/[CT]); "" for
	// system rows (kind "system"/"saytext") and unknown channels — a
	// missing channel never gets a guessed bracket downstream.
	Channel string `json:"channel"`
	// Decrypted marks a chat row recovered from svc_EncryptedData via the
	// .dem.info GC key. v1 always stores 0: decryption happens inside
	// demoinfocs during the parse (the inner messages dispatch as ordinary
	// chat events with no origin provenance), so the extractor cannot
	// honestly distinguish decrypted rows from plaintext ones — see
	// presence.key_found + Match.EncryptedMessages for the real state.
	// Set only if an extractor-side provenance signal ever exists.
	Decrypted bool `json:"decrypted"`
}

// SoundEvent is one player sound row (sound_events table): a footstep,
// landing, jump or fall-damage sound a player pawn made, read from a
// CMsgSosStartSoundEvent during the parse. The SOS NAME carries the
// surface data (CS2 puts the material in the event name), so no VPK or
// surfaceproperties read is needed at import time — imports must work
// without CS2 installed.
//
// SteamID is the attributed participant's SteamID64 string — the SAME
// join key every other row uses (extract.playerKey; a bot keeps its
// synthetic 0xFF-prefixed key — this is an event-shaped read, bots are
// never dropped here). Attribution goes source entity → player pawn →
// m_hController → participant; a message whose source is -1 or resolves
// to no participant is SKIPPED — identity is never guessed. Material is
// the name's surface token exactly as the game spells it ("" when the
// name carries none: Gear.JumpLand.*, Default.WalkJump,
// Player.DamageFall*, Land.Thud, Default.Land); TeamPrefix is "ct"/"t"
// when the name carries a team prefix (CT_/T_/Gear.JumpLand.CT), else
// "" — the repo's lowercase side vocabulary. Kind is
// models.SoundStep/SoundLand/SoundJump/SoundFall.
type SoundEvent struct {
	MatchID    int64  `json:"matchId"`
	Tick       int    `json:"tick"`
	Round      int    `json:"round"`
	SteamID    string `json:"steamId"`
	Kind       string `json:"kind"`
	Material   string `json:"material"`
	TeamPrefix string `json:"teamPrefix"`
	SOSName    string `json:"sosName"`
}

// SoundEventPresence is the match-level "does this match carry player
// sound data" summary: Total is every sound_events row of the match
// (0 = none — the UI's footstep-data signal), ByKind the per-kind split
// (kinds with no rows are absent from the map, never a fabricated 0).
type SoundEventPresence struct {
	MatchID int64          `json:"matchId"`
	Total   int            `json:"total"`
	ByKind  map[string]int `json:"byKind"`
}

// Job is one import/reprocess unit (jobs table). Progress is 0..1 over
// the WHOLE job — job-wide, monotone, NOT per-stage (the Library's
// StatusChip renders it as one bar from 0 to 100%): 0 means "no determinate
// point yet" and the UI draws an indeterminate bar for it, never 0%.
// The per-stage value ranges live with the stage constants above; the
// emitter that writes them is internal/library's progress reporter.
type Job struct {
	ID         int64      `json:"id"`
	Kind       string     `json:"kind"` // "import" | "reprocess"
	Path       string     `json:"path"`
	Status     string     `json:"status"`
	Progress   float64    `json:"progress"`
	Stage      string     `json:"stage"`
	Error      string     `json:"error"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	MatchID    int64      `json:"matchId"` // 0 until the job has a match row
}

// RoundPlayerSide is one player's side in one round (round_player_sides) —
// the extractor's freeze-end sample. Side is a per-round FACT, not a player
// identity: teams switch sides at halftime and between the knife round and
// the pistol, and the end-of-demo roster snapshot is unreliable (golden
// demo: 3/10 players present).
type RoundPlayerSide struct {
	MatchID int64  `json:"matchId"`
	Round   int    `json:"round"`
	SteamID string `json:"steamId"`
	Side    string `json:"side"` // "ct" | "t"
}

// ExtractedMatch is the complete extract output for one demo — the single
// value internal/extract produces and internal/store persists in one
// transaction. Match fields filled here: everything except ID/Status/Error
// (the store joins it onto the existing lifecycle row).
type ExtractedMatch struct {
	Match         Match             `json:"match"`
	Teams         []Team            `json:"teams"`
	Players       []Player          `json:"players"`
	PlayerStats   []PlayerStats     `json:"playerStats"`
	Rounds        []Round           `json:"rounds"`
	RoundEconomy  []RoundEconomy    `json:"roundEconomy"`
	RoundSides    []RoundPlayerSide `json:"roundSides"`
	Events        []Event           `json:"events"`
	GenericEvents []GenericEvent    `json:"genericEvents"`
	Chat          []Chat            `json:"chat"`
	// SoundEvents are the player sounds (footsteps/lands/jumps/fall
	// damage) read from CMsgSosStartSoundEvent — persisted to the
	// sound_events table by SaveExtracted like every other child.
	SoundEvents []SoundEvent `json:"soundEvents"`
	Warnings    []string     `json:"warnings"`
}
