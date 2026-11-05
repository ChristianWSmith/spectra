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

// Job stages (jobs.stage) — the progress event's coarse position.
const (
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
	EventKill         = "kill"
	EventDamage       = "damage"
	EventBlind        = "blind"
	EventBombPlant    = "bomb_plant"
	EventBombDefuse   = "bomb_defuse"
	EventBombExplode  = "bomb_explode"
	EventBombDrop     = "bomb_drop"
	EventBombPickup   = "bomb_pickup"
	EventGrenadeThrow = "grenade_throw"
	EventGrenade      = "grenade"
	EventRoundStart   = "round_start"
	EventRoundEnd     = "round_end"
	EventConnect      = "player_connect"
	EventDisconnect   = "player_disconnect"
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
	WarmupRounds   int       `json:"warmupRounds"`
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
	// Position sidecar mirror (matches.position_* / sample_rate): 0 when the
	// match has no sidecar (pre-M2 imports). The sidecar meta.json is the
	// source of truth when present.
	PositionFormat int `json:"positionFormat"`
	SampleRate     int `json:"sampleRate"`
	PositionFrames int `json:"positionFrames"`
	// EncryptedMessages counts svc_EncryptedData net-messages seen during
	// the parse (M4): encrypted chat is demoinfocs-internal (decrypted inner
	// messages dispatch as normal chat events when ParseOptions.NetKey is
	// set), so this counter plus voice_presence.key_found are the only
	// provenance the UI has for the "chat possibly encrypted" lock chip.
	EncryptedMessages int `json:"encryptedMessages"`
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
	FlashesPopped   int     `json:"flashesPopped"`
	FlashedTimes    int     `json:"flashedTimes"`
	BombPlants      int     `json:"bombPlants"`
	BombDefuses     int     `json:"bombDefuses"`
	MoneySpentTotal int     `json:"moneySpentTotal"`
	KillsByWeapon   string  `json:"killsByWeapon"`  // JSON object weapon→count
	DamageByWeapon  string  `json:"damageByWeapon"` // JSON object weapon→damage
}

// Round is one round's summary (rounds table). Number is the extractor's
// chronological index (warmup and pregame rounds included — Warmup and
// Pregame distinguish them; neither counts toward Match.RealRounds or any
// stat). MVP/MVPReason are best-effort: some demos never emit round-MVP data
// (the golden demo does not) — empty means "absent", not zero.
type Round struct {
	MatchID   int64   `json:"matchId"`
	Number    int     `json:"number"`
	Winner    string  `json:"winner"` // "ct" | "t" | "" (warmup/none)
	Reason    string  `json:"reason"` // CTWin | TerroristsWin | BombDefused | TargetBombed | …
	DurationS float64 `json:"durationS"`
	StartTick int     `json:"startTick"`
	EndTick   int     `json:"endTick"`
	Warmup    bool    `json:"warmup"`
	// Pregame marks a pre-match (knife) round: runs with warmup=false and
	// the match started but GamePhase()==Pregame; the scoreboard resets
	// afterwards (golden demo round 1). Excluded from stats like Warmup.
	Pregame         bool   `json:"pregame"`
	MVP             string `json:"mvp"` // SteamID64, may be empty
	MVPReason       string `json:"mvpReason"`
	EquipCT         int    `json:"equipCT"`
	EquipT          int    `json:"equipT"`
	BombSite        string `json:"bombSite"` // "A" | "B" | ""
	FreezeEndTick   int    `json:"freezeEndTick"`
	FirstKillSteam  string `json:"firstKillSteam"`
	FirstDeathSteam string `json:"firstDeathSteam"`
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
// not bought, so net worth subtracts it (CS2.md "Free spawn-issued
// default pistol").
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
	// Decrypted marks a chat row recovered from svc_EncryptedData via the
	// .dem.info GC key. v1 always stores 0: decryption happens inside
	// demoinfocs during the parse (the inner messages dispatch as ordinary
	// chat events with no origin provenance), so the extractor cannot
	// honestly distinguish decrypted rows from plaintext ones — see
	// presence.key_found + Match.EncryptedMessages for the real state.
	// Set only if an extractor-side provenance signal ever exists.
	Decrypted bool `json:"decrypted"`
}

// Job is one import/reprocess unit (jobs table). Progress is 0..1 within
// the current Stage.
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
	Warnings      []string          `json:"warnings"`
}
