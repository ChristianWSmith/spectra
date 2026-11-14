package models

import "time"

// M3 (Deep Match Analytics) row vocabulary. These types flow between
// internal/store (persistence), internal/analytics (pure computation) and
// the frontend services; they live here because analytics imports store
// (Compute orchestration) so store cannot import analytics — models is the
// shared vocabulary both sides may depend on (package docs).

// AnalysisConfig is the single-row analysis_config: the versioned
// heuristic thresholds. Every threshold here is an analysis-rule INPUT
// whose OUTPUTS are stored at analyze time — trade window →
// player_stats.trade_kills, eco thresholds → round_classifications +
// round_side_classes, trade-opp distance → match_trade_opps — so a save
// that changes a value bumps RuleVersion, the affected matches go behind
// and RecomputeAll rewrites their stored rows (AGENTS.md
// "Analysis-rule derived values": read-time thresholding of rule outputs
// is forbidden). RuleVersion bumps by one whenever SetConfig stores
// CHANGED values; saving identical values is a no-op (no bump — see
// AnalyticsService.SetConfig).
type AnalysisConfig struct {
	TradeWindowS float64 `json:"tradeWindowS"`
	EcoFullBuy   int     `json:"ecoFullBuy"`
	EcoForce     int     `json:"ecoForce"`
	// TradeOppDistance is the trade-opportunity radius in world units
	// (default 1000): an untraded death counts toward Combat's "Trade
	// opportunities missed" only when a living teammate of the victim was
	// within this distance of the KILLER at the death tick. The proximity
	// itself is measured once at extract time (config-independent, stored
	// on the kill event as detail_json.nearDist); this threshold is
	// applied at ANALYZE time by analytics.Compute — the counts are
	// stored per match in match_trade_opps, so a change bumps
	// rule_version → the match goes behind → RecomputeAll rewrites them
	// (owner, 2026-11-12: read-time thresholding of rule outputs is
	// forbidden — AGENTS.md "Analysis-rule derived values").
	TradeOppDistance int `json:"tradeOppDistance"`
	RuleVersion      int `json:"ruleVersion"`
}

// RoundInfo is one round's summary for the analytics pass (read from the
// rounds table). Number is the dense counted-round index: the extractor
// discards knife/warmup rounds at ingest, so every stored round is
// counted play (analytics.CountedRounds is a documented identity over
// this set).
type RoundInfo struct {
	Number        int    `json:"number"`
	Winner        string `json:"winner"` // "ct" | "t" | ""
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
	// IsBot is players.is_bot (extract's demoinfocs Player.IsBot). The
	// analytics pass keeps computing bot rows; the flag rides along so
	// the REPLAY roster can apply the replay exception (a bot is listed
	// only while it is filling in for a disconnected human — see
	// frontend lib/replay/playercard.js presentAt).
	IsBot bool `json:"isBot"`
}

// RoundClassification is one round_classifications row: the stored buy-class
// label with its rule version and the REQUIRED human-readable explanation
// (transparent rules).
type RoundClassification struct {
	MatchID     int64   `json:"matchId"`
	Round       int     `json:"round"`
	Label       string  `json:"label"` // pistol|eco|force|full|save (v1)
	Confidence  float64 `json:"confidence"`
	RuleVersion int     `json:"ruleVersion"`
	Explanation string  `json:"explanation"`
}

// RoundSideClass is one round_side_classes row: the STORED buy class of
// ONE side of one counted round, with the REQUIRED why string (transparent
// rules). Derived at analyze time from the run's config —
// analytics.Classify → store.ReplaceRoundSideClasses — and read back by
// store.GetEconomy; never re-classified at read time (AGENTS.md
// "Analysis-rule derived values": read-time thresholding of rule outputs
// is forbidden). Side is "ct" | "t".
type RoundSideClass struct {
	MatchID int64  `json:"matchId"`
	Round   int    `json:"round"`
	Side    string `json:"side"`
	Class   string `json:"class"` // pistol|eco|force|full|save (v1)
	Why     string `json:"why"`
}

// PlayerRoundStat is one player_round_stats row: per-player-per-round combat
// facts including the KAST decomposition. MoneyStart/Equip/
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
// (clutch v2). KillTicks is a JSON array of int ticks.
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

// Engagement is one engagements row (kinds: opening|trade|traded|untraded
// — the entry kind is deferred; extractor entry_kills already covers
// per-player entry attribution).
type Engagement struct {
	MatchID  int64   `json:"matchId"`
	Seq      int     `json:"seq"`
	Tick     int     `json:"tick"`
	Round    int     `json:"round"`
	Kind     string  `json:"kind"`
	ASteam   string  `json:"aSteam"` // all kinds: killer (a = actor)
	AName    string  `json:"aName"`
	BSteam   string  `json:"bSteam"` // victim
	BName    string  `json:"bName"`
	Distance float64 `json:"distance"`
	WonBy    string  `json:"wonBy"` // team of the killer ("ct"|"t")
}

// UtilityEvent is one utility_events row: a grenade throw paired with its
// nearest same-thrower/same-kind detonation. DetX/DetY are
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
// rows. TradeOppMissed is inferred — a gated subset of the untraded
// deaths (the kill event's detail_json.nearDist within the configured
// trade-opportunity distance, gated at analyze time and stored in
// match_trade_opps — see the store.GetCombatStats notes) — and
// needs a UI badge. The former EntryRate/TradeRate/KASTPct fields are
// gone (dogfooding W2): the Combat tab reads the entry_rate /
// trade_rate_deaths / kast builtin metric rows instead.
type CombatStat struct {
	SteamID        string  `json:"steamId"`
	Name           string  `json:"name"`
	DMGNoKill      int     `json:"dmgNoKill"`
	DMGConvPct     float64 `json:"dmgConvPct"`
	FFDamage       int     `json:"ffDamage"`
	UntradedDeaths int     `json:"untradedDeaths"`
	TradeOppMissed int     `json:"tradeOppMissed"` // inferred heuristic
}

// EconomyRow is the raw per-round economy view (rounds ⋈ round_economy ⋈
// round_classifications ⋈ round_side_classes) with loss-bonus
// reconstruction applied. ClassCT/ClassT/ClassWhy* are the STORED per-side
// classes (round_side_classes — written by analytics.Compute at analyze
// time and read verbatim by store.GetEconomy; "" = no stored row = an
// unanalyzed/pre-change match, never a read-time re-classification — the
// UI renders that as its honest "unknown" chip). PistolRound derives from
// the STORED round label (round_classifications.label = "pistol" — the
// round chips' own label, so the two can never disagree). Everything else
// is complete on return. Money* is the sampled freeze-end money sum;
// Spent* is the side's real per-round buy spend (round_economy.spent — Σ
// over the side's players of the delta in the cumulative money-spent
// counter between freeze-time ends; see extract.agg.freezeEnd).
// FreePistol* carries
// round_economy.free_pistol_value — the side's held free spawn-issued
// default-pistol value at that freeze end (granted, not bought): they
// count INSIDE Equip*, so net worth = Equip* + Money* (frontend
// lib/econ.js; CS2.md "Free spawn-issued default pistol"). Per-player
// player_round_stats.spent stays 0 in v1
// (item_equip payloads carry no spend — analytics notes).
type EconomyRow struct {
	Round        int    `json:"round"`
	Winner       string `json:"winner"`
	EquipCT      int    `json:"equipCT"`
	EquipT       int    `json:"equipT"`
	MoneyCT      int    `json:"moneyCT"`
	MoneyT       int    `json:"moneyT"`
	SpentCT      int    `json:"spentCT"`
	SpentT       int    `json:"spentT"`
	FreePistolCT int    `json:"freePistolCT"`
	FreePistolT  int    `json:"freePistolT"`
	ClassCT      string `json:"classCT"`
	ClassT       string `json:"classT"`
	ClassWhyCT   string `json:"classWhyCT"`
	ClassWhyT    string `json:"classWhyT"`
	LossBonusCT  int    `json:"lossBonusCT"`
	LossBonusT   int    `json:"lossBonusT"`
	InferredCT   bool   `json:"inferredCT"`
	InferredT    bool   `json:"inferredT"`
	WonCT        bool   `json:"wonCT"`
	WonT         bool   `json:"wonT"`
	PistolRound  bool   `json:"pistolRound"`
	RuleVersion  int    `json:"ruleVersion"`
	// Label/Explanation are the stored round-level classification
	// (round_classifications), "" when the round has no stored row.
	Label       string `json:"label"`
	Explanation string `json:"explanation"`
}

// CareerRow is one player_career rollup — rebuildable from
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
}

// ProfileHistoryRow is one match-history entry for a player profile.
// ADR and KASTPct are the STORED match-scope metric values (design
// §3.5's D13 — the same `adr`/`kast` rows the profile's trend reads,
// never the query-time SQL arithmetic they replaced): nil means the
// match has no FRESH row for that metric, and the profile renders the
// honest "—" in that cell (never a fabricated 0, never a
// fallback-to-Go recomputation).
//
// Side is the player's FINAL side (player_stats.side — the side the
// end-of-demo roster shows, and the input WinFor needs: the final score
// names each side's team, so only the final side maps score → result).
// StartSide is the side the player OPENED the match on — the freeze-end
// sample of their first counted round (round_player_sides ⋈ rounds,
// lowest number — every stored round is counted); "" when the match
// carries no sample (never guessed — the profile renders it as "—").
type ProfileHistoryRow struct {
	MatchID     int64     `json:"matchId"`
	ExtractedAt time.Time `json:"extractedAt"`
	Map         string    `json:"map"`
	Win         bool      `json:"win"`
	ScoreCT     int       `json:"scoreCT"`
	ScoreT      int       `json:"scoreT"`
	Side        string    `json:"side"`      // final side (drives Win)
	StartSide   string    `json:"startSide"` // starting side ("" = unknown)
	Kills       int       `json:"kills"`
	Deaths      int       `json:"deaths"`
	Assists     int       `json:"assists"`
	ADR         *float64  `json:"adr"`     // stored `adr` metric row; nil = no fresh row
	KASTPct     *float64  `json:"kastPct"` // stored `kast` metric row (0..100); nil = no fresh row
}

// ProfileSideSplit is one side's per-ROUND rollup across a player's
// matches (store.GetPlayerSideSplits) — the profile's Sides card. It is
// a per-round split, not per match: players switch sides at halftime, so
// every counted round contributes to exactly one side's row (unlike
// ProfileHistoryRow.Side, which is one final side per match). ADR is the
// HP-capped per-round damage summed and divided by rounds
// (player_round_stats.dmg); KASTPct is 100 × mean(player_round_stats.kast)
// over these rounds; Wins counts rounds this side's team won.
type ProfileSideSplit struct {
	Side    string  `json:"side"` // ct|t
	Rounds  int     `json:"rounds"`
	Wins    int     `json:"wins"`
	Kills   int     `json:"kills"`
	Deaths  int     `json:"deaths"`
	ADR     float64 `json:"adr"`
	KASTPct float64 `json:"kastPct"`
}

// WinFor reports whether side won the match with the given final score —
// the ONE Go implementation of the win predicate (a tie is not a win; an
// unknown side never wins). Its SQL twin lives in store.RebuildCareer's
// career rollup (`SUM(CASE WHEN (ps.side = 'ct' AND m.score_ct > m.score_t)
// OR (ps.side = 't' AND m.score_t > m.score_ct) …`) — keep the two in sync.
func WinFor(side string, scoreCT, scoreT int) bool {
	return (side == "ct" && scoreCT > scoreT) || (side == "t" && scoreT > scoreCT)
}

// ProfileTrendPoint is one career sparkline point (GetTrend) — the
// point carries everything its tooltip renders: Patch is the demo
// header's flattened CS2 PatchVersion (0 = unknown, never "patch 0") and
// ExtractedAt is the match's IMPORT time (CS2 demos carry no played-at
// date) — the GetTrend tiebreaker inside a patch, and the honest date
// behind the tooltip's "Imported" label (self-contained: points older
// than GetPlayerHistory's 100-row window still date correctly).
type ProfileTrendPoint struct {
	MatchID     int64     `json:"matchId"`
	Seq         int       `json:"seq"` // position in GetTrend's row order (patch order), oldest = 0
	Value       float64   `json:"value"`
	Patch       int       `json:"patch"`       // flattened PatchVersion (x.y.z.w, dots removed; 0 = unknown)
	ExtractedAt time.Time `json:"extractedAt"` // import time — the within-patch tiebreaker
}

// SavedFilterRow is one saved_filters preset row.
type SavedFilterRow struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Scope      string    `json:"scope"` // "library" | "match"
	FilterJSON string    `json:"filterJson"`
	CreatedAt  time.Time `json:"createdAt"`
}

// ProfileWeaponJSONs is one match's weapon breakdown JSON triplet (merge
// in the caller — see ProfileService.GetProfile). HeadshotsByWeapon is
// derived from the stored kill events (not an extract column), with the
// same eligibility as kills_by_weapon — see store.GetPlayerWeaponJSONs.
type ProfileWeaponJSONs struct {
	KillsByWeapon     string `json:"killsByWeapon"`
	DamageByWeapon    string `json:"damageByWeapon"`
	HeadshotsByWeapon string `json:"headshotsByWeapon"`
}
