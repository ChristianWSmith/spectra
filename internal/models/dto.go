package models

import "time"

// MatchSummary is one row of the library list (denormalized read model —
// includes both team names so the list shows the matchup without joins in
// the frontend).
type MatchSummary struct {
	ID          int64     `json:"id"`
	Path        string    `json:"path"`
	Map         string    `json:"map"`
	Size        int64     `json:"size"`
	ScoreCT     int       `json:"scoreCT"`
	ScoreT      int       `json:"scoreT"`
	CTName      string    `json:"ctName"`
	TName       string    `json:"tName"`
	RealRounds  int       `json:"realRounds"`
	DurationS   float64   `json:"durationS"`
	ExtractedAt time.Time `json:"extractedAt"`
	Status      string    `json:"status"`
	Error       string    `json:"error"`
	SHA256      string    `json:"sha256"`
}

// PlayerStatsRow is scoreboard output: stats joined with identity + the
// player's final-side. SortKey addresses either table's columns (the store
// whitelists it — never interpolate user input).
type PlayerStatsRow struct {
	SteamID           string  `json:"steamId"`
	Name              string  `json:"name"`
	IsBot             bool    `json:"isBot"`
	Side              string  `json:"side"`
	FinalStatePresent bool    `json:"finalStatePresent"` // provenance: false = absent from final snapshot (PRD §6.1)
	RoundsPlayed      int     `json:"roundsPlayed"`
	Kills             int     `json:"kills"`
	Deaths            int     `json:"deaths"`
	Assists           int     `json:"assists"`
	FlashAssists      int     `json:"flashAssists"`
	Headshots         int     `json:"headshots"`
	HSPct             float64 `json:"hsPct"`
	ADR               float64 `json:"adr"`
	KD                float64 `json:"kd"`
	KDA               float64 `json:"kda"`
	TotalDamage       int     `json:"totalDamage"`
	DamageTaken       int     `json:"damageTaken"`
	EntryKills        int     `json:"entryKills"`
	EntryDeaths       int     `json:"entryDeaths"`
	OpeningKills      int     `json:"openingKills"`
	OpeningDeaths     int     `json:"openingDeaths"`
	TradeKills        int     `json:"tradeKills"`
	BestStreak        int     `json:"bestStreak"`
	ThreeK            int     `json:"threeK"`
	FourK             int     `json:"fourK"`
	FiveK             int     `json:"fiveK"`
	UtilityDamage     int     `json:"utilityDamage"`
	FlashesPopped     int     `json:"flashesPopped"`
	FlashedTimes      int     `json:"flashedTimes"`
	BombPlants        int     `json:"bombPlants"`
	BombDefuses       int     `json:"bombDefuses"`
	MVPs              int     `json:"mvps"`
	Score             int     `json:"score"`
	Teamkills         int     `json:"teamkills"`
	Suicides          int     `json:"suicides"`
	MoneySpent        int     `json:"moneySpent"`
	KillsByWeapon     string  `json:"killsByWeapon"`
	DamageByWeapon    string  `json:"damageByWeapon"`
}

// RoundRow is the round-browser row (round joined with display names).
type RoundRow struct {
	Number          int     `json:"number"`
	Winner          string  `json:"winner"`
	Reason          string  `json:"reason"`
	DurationS       float64 `json:"durationS"`
	Warmup          bool    `json:"warmup"`
	Pregame         bool    `json:"pregame"`
	BombSite        string  `json:"bombSite"`
	MVP             string  `json:"mvp"`
	MVPName         string  `json:"mvpName"`
	MVPReason       string  `json:"mvpReason"`
	EquipCT         int     `json:"equipCT"`
	EquipT          int     `json:"equipT"`
	Kills           int     `json:"kills"`
	FirstKillSteam  string  `json:"firstKillSteam"`
	FirstKillName   string  `json:"firstKillName"`
	FirstDeathSteam string  `json:"firstDeathSteam"`
	FirstDeathName  string  `json:"firstDeathName"`
	StartTick       int     `json:"startTick"`
	EndTick         int     `json:"endTick"`
	FreezeEndTick   int     `json:"freezeEndTick"`
}

// RoundDetail is the round drill-down: the round + its economy + its
// kill-feed (typed events), + chat lines that happened in the round.
type RoundDetail struct {
	Round   RoundRow       `json:"round"`
	Economy []RoundEconomy `json:"economy"`
	Events  []EventRow     `json:"events"`
	Chat    []ChatRow      `json:"chat"`
}

// EventRow is one timeline row — typed columns only, no payloads (fetch
// EventDetail on click so a 50 k-event filter stays cheap on the wire).
// PosX/PosY/PosZ mirror events.pos_* (nil when the event has no position);
// EventDetail embeds this row so it carries the same fields.
type EventRow struct {
	ID            int64    `json:"id"`
	Seq           int      `json:"seq"`
	Tick          int      `json:"tick"`
	Round         int      `json:"round"`
	Kind          string   `json:"kind"`
	Attacker      string   `json:"attacker"`
	AttackerName  string   `json:"attackerName"`
	Victim        string   `json:"victim"`
	VictimName    string   `json:"victimName"`
	Assister      string   `json:"assister"`
	AssisterName  string   `json:"assisterName"`
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
	PosX          *float64 `json:"posX,omitempty"`
	PosY          *float64 `json:"posY,omitempty"`
	PosZ          *float64 `json:"posZ,omitempty"`
}

// EventDetail is one event with its JSON payloads (detail pane).
type EventDetail struct {
	EventRow
	DetailJSON string `json:"detailJson"`
	RawJSON    string `json:"rawJson"`
}

// EventFilter selects timeline rows. Round < 0 = all rounds; Kind "" = all
// kinds; SteamID matches attacker OR victim. Offset/Limit paginate (Limit
// <= 0 means "no limit" — the store still applies a hard cap).
type EventFilter struct {
	MatchID int64  `json:"matchId"`
	Round   int    `json:"round"`
	Kind    string `json:"kind"`
	SteamID string `json:"steamId"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
	// M3 advanced filters. Zero/""/nil = unconstrained.
	// TickTo/DmgMax/DistanceMax: <= 0 means open-ended (never clamp to 0).
	Weapon       string  `json:"weapon,omitempty"`
	TickFrom     int     `json:"tickFrom,omitempty"`
	TickTo       int     `json:"tickTo,omitempty"`
	DmgMin       int     `json:"dmgMin,omitempty"`
	DmgMax       int     `json:"dmgMax,omitempty"`
	DistanceMax  float64 `json:"distanceMax,omitempty"`
	HeadshotOnly bool    `json:"headshotOnly,omitempty"`
	BBox         *BBox   `json:"bbox,omitempty"` // world-space position filter
}

// BBox is a world-coordinate rectangle (event pos must fall inside).
type BBox struct {
	MinX float64 `json:"minX"`
	MinY float64 `json:"minY"`
	MaxX float64 `json:"maxX"`
	MaxY float64 `json:"maxY"`
}

// ChatRow is one chat line with display name (chat table join players).
// Decrypted marks a row recovered from svc_EncryptedData via the .dem.info
// key — v1 always stores false (see models.Chat for the provenance note).
type ChatRow struct {
	ID        int64  `json:"id"`
	Tick      int    `json:"tick"`
	Round     int    `json:"round"`
	SteamID   string `json:"steamId"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	Kind      string `json:"kind"`
	Decrypted bool   `json:"decrypted"`
}

// NameCount is one histogram bucket (generic event name → occurrences).
type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
