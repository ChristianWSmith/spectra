package models

import "time"

// M3 (Deep Match Analytics) row vocabulary. These types flow between
// internal/store (persistence), internal/analytics (pure computation) and
// the frontend services; they live here because analytics imports store
// (Compute orchestration) so store cannot import analytics — models is the
// shared vocabulary both sides may depend on (package docs).

// AnalysisConfig is the single-row analysis_config: the versioned
// heuristic thresholds (plan M3 §3). RuleVersion bumps on every SetConfig.
type AnalysisConfig struct {
	TradeWindowS float64 `json:"tradeWindowS"`
	EcoFullBuy   int     `json:"ecoFullBuy"`
	EcoForce     int     `json:"ecoForce"`
	RuleVersion  int     `json:"ruleVersion"`
}

// RoundInfo is one round's summary for the analytics pass (read from the
// rounds table). Number includes warmup rounds; Warmup distinguishes them.
type RoundInfo struct {
	Number        int    `json:"number"`
	Winner        string `json:"winner"` // "ct" | "t" | ""
	Warmup        bool   `json:"warmup"`
	StartTick     int    `json:"startTick"`
	EndTick       int    `json:"endTick"`
	FreezeEndTick int    `json:"freezeEndTick"`
	EquipCT       int    `json:"equipCT"`
	EquipT        int    `json:"equipT"`
}

// RoundEconomyView is one side's economy sample for one round (the
// round_economy read shape the classification pass consumes).
type RoundEconomyView struct {
	Round           int    `json:"round"`
	Side            string `json:"side"`
	EquipValue      int    `json:"equipValue"`
	MoneySampledSum int    `json:"moneySampledSum"`
	MoneySamples    int    `json:"moneySamples"`
}

// PlayerRef is one match participant's identity for the analytics pass.
type PlayerRef struct {
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Side    string `json:"side"` // final side "ct" | "t" ("" unknown)
}

// RoundClassification is one round_classifications row: the stored buy-class
// label with its rule version and the REQUIRED human-readable explanation
// (plan M3 §2.1 — transparent rules).
type RoundClassification struct {
	MatchID     int64   `json:"matchId"`
	Round       int     `json:"round"`
	Label       string  `json:"label"` // pistol|eco|force|full|save (v1)
	Confidence  float64 `json:"confidence"`
	RuleVersion int     `json:"ruleVersion"`
	Explanation string  `json:"explanation"`
}

// PlayerRoundStat is one player_round_stats row: per-player-per-round combat
// facts including the KAST decomposition (plan M3 §2.9). MoneyStart/Equip/
// Spent are 0 in v1 — per-player purchase payloads are not extractable
// (item_equip carries no price; see store analytics notes).
type PlayerRoundStat struct {
	MatchID     int64  `json:"matchId"`
	Round       int    `json:"round"`
	SteamID     string `json:"steamId"`
	Name        string `json:"name"`
	Kills       int    `json:"kills"`
	Assists     int    `json:"assists"`
	Deaths      int    `json:"deaths"`
	Traded      bool   `json:"traded"`
	Survived    bool   `json:"survived"`
	KAST        bool   `json:"kast"`
	DMG         int    `json:"dmg"`
	UtilDmg     int    `json:"utilDmg"`
	MoneyStart  int    `json:"moneyStart"`
	Equip       int    `json:"equip"`
	Spent       int    `json:"spent"`
	RuleVersion int    `json:"ruleVersion"`
}

// Clutch is one clutches row: a 1vN detected by alive-count analysis
// (plan M3 §2.6 — clutch v2). KillTicks is a JSON array of int ticks.
type Clutch struct {
	MatchID      int64  `json:"matchId"`
	Round        int    `json:"round"`
	Size         int    `json:"size"` // 1vN → N (opponents alive at start)
	SteamID      string `json:"steamId"`
	Name         string `json:"name"`
	StartTick    int    `json:"startTick"` // last-teammate death tick
	EndTick      int    `json:"endTick"`   // resolution tick (round end fallback)
	BombState    string `json:"bombState"` // planted|carried|dropped|none
	HPLeft       int    `json:"hpLeft"`    // reconstructed (see analytics clutch notes)
	Equip        int    `json:"equip"`
	Won          bool   `json:"won"`
	KillTicks    string `json:"killTicks"`    // JSON array of int
	ReplayAnchor int    `json:"replayAnchor"` // = StartTick
}

// Engagement is one engagements row (kinds: opening|trade|untraded — the
// entry kind is deferred; extractor entry_kills already covers per-player
// entry attribution, plan M3 §2.3).
type Engagement struct {
	MatchID  int64   `json:"matchId"`
	Seq      int     `json:"seq"`
	Tick     int     `json:"tick"`
	Round    int     `json:"round"`
	Kind     string  `json:"kind"`
	ASteam   string  `json:"aSteam"` // opening/trade: killer; untraded: killer
	AName    string  `json:"aName"`
	BSteam   string  `json:"bSteam"` // victim
	BName    string  `json:"bName"`
	Distance float64 `json:"distance"`
	WonBy    string  `json:"wonBy"` // team of the killer ("ct"|"t")
}

// UtilityEvent is one utility_events row: a grenade throw paired with its
// nearest same-thrower/same-kind detonation (plan M3 §2.4). DetX/DetY are
// nil when the detonation had no position. Affected is a JSON array of
// victim SteamID strings.
type UtilityEvent struct {
	MatchID       int64    `json:"matchId"`
	Seq           int      `json:"seq"`
	Tick          int      `json:"tick"` // detonation tick (throw tick when unpaired)
	Round         int      `json:"round"`
	Thrower       string   `json:"thrower"`
	ThrowerName   string   `json:"throwerName"`
	Kind          string   `json:"kind"` // he|flash|smoke|molotov|incendiary|decoy
	DetX          *float64 `json:"detX,omitempty"`
	DetY          *float64 `json:"detY,omitempty"`
	Damage        int      `json:"damage"`
	FlashMs       int      `json:"flashMsTotal"`
	Affected      string   `json:"affected"` // JSON array of steamIDs
	Site          string   `json:"site"`
	TrajectoryRef string   `json:"trajectoryRef"`
}

// CombatStat is one per-player combat deep-dive row derived from stored
// analytics rows (plan M3 §2.3). TradeOppMissed is inferred (= untraded
// deaths; see analytics CombatStats notes) and needs a UI badge.
type CombatStat struct {
	SteamID        string  `json:"steamId"`
	Name           string  `json:"name"`
	DMGNoKill      int     `json:"dmgNoKill"`
	DMGConvPct     float64 `json:"dmgConvPct"`
	FFDamage       int     `json:"ffDamage"`
	EntryRate      float64 `json:"entryRate"`
	TradeRate      float64 `json:"tradeRate"`
	UntradedDeaths int     `json:"untradedDeaths"`
	TradeOppMissed int     `json:"tradeOppMissed"` // inferred heuristic
	KASTPct        float64 `json:"kastPct"`
}

// EconomyRow is the raw per-round economy view (rounds ⋈ round_economy ⋈
// round_classifications) with loss-bonus reconstruction applied. ClassCT/
// ClassT/ClassWhy* are left empty by the store and filled by the caller via
// analytics.BuyClass (the store cannot import analytics — cycle); everything
// else is complete on return. Money* is the sampled money sum; Spent* is 0
// in v1 (no per-round spend data — see analytics notes).
type EconomyRow struct {
	Round       int    `json:"round"`
	Winner      string `json:"winner"`
	Warmup      bool   `json:"warmup"`
	EquipCT     int    `json:"equipCT"`
	EquipT      int    `json:"equipT"`
	MoneyCT     int    `json:"moneyCT"`
	MoneyT      int    `json:"moneyT"`
	SpentCT     int    `json:"spentCT"`
	SpentT      int    `json:"spentT"`
	ClassCT     string `json:"classCT"`
	ClassT      string `json:"classT"`
	ClassWhyCT  string `json:"classWhyCT"`
	ClassWhyT   string `json:"classWhyT"`
	LossBonusCT int    `json:"lossBonusCT"`
	LossBonusT  int    `json:"lossBonusT"`
	InferredCT  bool   `json:"inferredCT"`
	InferredT   bool   `json:"inferredT"`
	WonCT       bool   `json:"wonCT"`
	WonT        bool   `json:"wonT"`
	PistolRound bool   `json:"pistolRound"`
	RuleVersion int    `json:"ruleVersion"`
	// Label/Explanation are the stored round-level classification
	// (round_classifications), "" when the round has no stored row.
	Label       string `json:"label"`
	Explanation string `json:"explanation"`
}

// CareerRow is one player_career rollup (plan M3 §2.7) — rebuildable from
// player_stats ⋈ matches + player_round_stats + clutches.
type CareerRow struct {
	SteamID    string    `json:"steamId"`
	Name       string    `json:"name"`
	Matches    int       `json:"matches"`
	Wins       int       `json:"wins"`
	ADRAvg     float64   `json:"adrAvg"`
	ADRStd     float64   `json:"adrStd"` // population stddev of per-match ADR
	KD         float64   `json:"kd"`
	HSPct      float64   `json:"hsPct"`
	KASTPct    float64   `json:"kastPct"`
	Openings   int       `json:"openings"`   // opening duels participated
	OpenerWins int       `json:"openerWins"` // opening kills
	Trades     int       `json:"trades"`
	Clutches   int       `json:"clutches"` // clutch records (any outcome)
	UpdatedAt  time.Time `json:"updatedAt"`
}

// CareerSummary is one player-picker row (ListPlayers).
type CareerSummary struct {
	SteamID  string    `json:"steamId"`
	Name     string    `json:"name"`
	Matches  int       `json:"matches"`
	LastSeen time.Time `json:"lastSeen"`
	ADRAvg   float64   `json:"adrAvg"`
}

// ProfileHistoryRow is one match-history entry for a player profile.
// KASTPct is the average over player_round_stats for the match (0 when the
// match predates the analytics pass).
type ProfileHistoryRow struct {
	MatchID     int64     `json:"matchId"`
	ExtractedAt time.Time `json:"extractedAt"`
	Map         string    `json:"map"`
	Win         bool      `json:"win"`
	ScoreCT     int       `json:"scoreCT"`
	ScoreT      int       `json:"scoreT"`
	Side        string    `json:"side"`
	Kills       int       `json:"kills"`
	Deaths      int       `json:"deaths"`
	Assists     int       `json:"assists"`
	ADR         float64   `json:"adr"`
	KASTPct     float64   `json:"kastPct"`
}

// ProfileTrendPoint is one career sparkline point (GetTrend).
type ProfileTrendPoint struct {
	MatchID int64   `json:"matchId"`
	Seq     int     `json:"seq"` // history index, oldest = 0
	Value   float64 `json:"value"`
}

// SavedFilterRow is one saved_filters preset row.
type SavedFilterRow struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Scope      string    `json:"scope"` // "library" | "match"
	FilterJSON string    `json:"filterJson"`
	CreatedAt  time.Time `json:"createdAt"`
}

// ProfileClutchCounts aggregates one player's clutch records (played/won).
type ProfileClutchCounts struct {
	Played int `json:"played"`
	Won    int `json:"won"`
}

// ProfileWeaponJSONs is one match's weapon breakdown JSON pair (merge in
// the caller — see ProfileService.GetProfile).
type ProfileWeaponJSONs struct {
	KillsByWeapon  string `json:"killsByWeapon"`
	DamageByWeapon string `json:"damageByWeapon"`
}
