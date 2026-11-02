package main

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// AnalyticsService is the M3 control plane: analysis config/rules, the
// per-match derived views (economy, classifications, KAST rounds, clutches,
// engagements, utility, heatmaps), and saved filter presets. Heavy rows are
// computed by internal/analytics after import (worker stage "analyze") and
// read back through here.

// AnalysisConfig holds the versioned heuristic rules (analysis_config row).
// Changing thresholds bumps RuleVersion; stored rows keep the version they
// were computed with — recompute is always explicit (PRD §9.2).
type AnalysisConfig struct {
	TradeWindowS float64 `json:"tradeWindowS"` // trade/ opportunity window (default 5)
	EcoFullBuy   int     `json:"ecoFullBuy"`   // equip ≥ this = full buy (default 20000)
	EcoForce     int     `json:"ecoForce"`     // equip ≥ this = force (default 10000)
	RuleVersion  int     `json:"ruleVersion"`
}

// RoundEconomyRow is one round's economy + buy-classification view.
// ClassWhy* carries the explanation string (PRD: transparent rules);
// LossBonus*/Inferred* are reconstructed → fact/inference badge required.
type RoundEconomyRow struct {
	Round       int    `json:"round"`
	Winner      string `json:"winner"`
	Warmup      bool   `json:"warmup"`
	EquipCT     int    `json:"equipCT"`
	EquipT      int    `json:"equipT"`
	MoneyCT     int    `json:"moneyCT"`
	MoneyT      int    `json:"moneyT"`
	SpentCT     int    `json:"spentCT"`
	SpentT      int    `json:"spentT"`
	ClassCT     string `json:"classCT"` // pistol|anti-eco|eco|force|full|bonus|save|unknown
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
}

// RoundClassRow is the stored classification row (round_classifications).
type RoundClassRow struct {
	Round       int     `json:"round"`
	Label       string  `json:"label"`
	Confidence  float64 `json:"confidence"`
	RuleVersion int     `json:"ruleVersion"`
	Explanation string  `json:"explanation"`
}

// PlayerRoundRow is per-player-per-round stats incl. KAST
// (player_round_stats). KAST: kill/assist/trade-death/survived.
type PlayerRoundRow struct {
	Round      int    `json:"round"`
	SteamID    string `json:"steamId"`
	Name       string `json:"name"`
	Kills      int    `json:"kills"`
	Assists    int    `json:"assists"`
	Deaths     int    `json:"deaths"`
	Traded     bool   `json:"traded"`
	Survived   bool   `json:"survived"`
	KAST       bool   `json:"kast"`
	DMG        int    `json:"dmg"`
	MoneyStart int    `json:"moneyStart"`
	Equip      int    `json:"equip"`
	Spent      int    `json:"spent"`
	UtilDmg    int    `json:"utilDmg"`
}

// ClutchRow is a detected 1vN (clutch v2 — alive-count analysis, replaces
// the M1 survivor approximation). ReplayAnchorTick = start_tick for deep
// link.
type ClutchRow struct {
	ID           int64  `json:"id"`
	Round        int    `json:"round"`
	Size         int    `json:"size"` // 1vN → N
	SteamID      string `json:"steamId"`
	Name         string `json:"name"`
	StartTick    int    `json:"startTick"`
	EndTick      int    `json:"endTick"`
	BombState    string `json:"bombState"` // planted|carried|dropped|none
	HPLeft       int    `json:"hpLeft"`
	Equip        int    `json:"equip"`
	Won          bool   `json:"won"`
	KillTicks    string `json:"killTicks"` // JSON array of int
	ReplayAnchor int    `json:"replayAnchorTick"`
}

// EngagementRow is one detected engagement (kinds: opening|trade|untraded
// — the entry kind is deferred; player_stats.entry_kills from the
// extractor already carries per-player entry attribution).
type EngagementRow struct {
	Tick     int     `json:"tick"`
	Round    int     `json:"round"`
	Kind     string  `json:"kind"`
	ASteam   string  `json:"aSteam"`
	BSteam   string  `json:"bSteam"`
	AName    string  `json:"aName"`
	BName    string  `json:"bName"`
	Distance float64 `json:"distance"`
	WonBy    string  `json:"wonBy"`
}

// UtilityRow is one grenade with position/impact detail (utility_events).
type UtilityRow struct {
	Tick        int     `json:"tick"`
	Round       int     `json:"round"`
	Thrower     string  `json:"thrower"`
	ThrowerName string  `json:"throwerName"`
	Kind        string  `json:"kind"` // he|flash|smoke|molotov|incendiary|decoy
	DetX        float64 `json:"detX"`
	DetY        float64 `json:"detY"`
	Damage      int     `json:"damage"`
	FlashMs     int     `json:"flashMsTotal"`
	Affected    string  `json:"affected"` // JSON array of steamIDs
	Site        string  `json:"site"`
}

// CombatStatRow is per-player engagement/damage deep-dive numbers
// (damage conversion, friendly fire, trade-opportunity heuristics —
// inferred rows need badges).
type CombatStatRow struct {
	SteamID        string  `json:"steamId"`
	Name           string  `json:"name"`
	DMGNoKill      int     `json:"dmgNoKill"`
	DMGConvPct     float64 `json:"dmgConvPct"`
	FFDamage       int     `json:"ffDamage"`
	EntryRate      float64 `json:"entryRate"`
	TradeRate      float64 `json:"tradeRate"`
	UntradedDeaths int     `json:"untradedDeaths"`
	TradeOppMissed int     `json:"tradeOppMissed"` // inferred (heuristic)
	KASTPct        float64 `json:"kastPct"`
}

// HeatmapFilter selects the sample population for a heatmap.
type HeatmapFilter struct {
	RoundFrom int    `json:"roundFrom"` // <0 = all
	RoundTo   int    `json:"roundTo"`   // <0 = all
	SteamID   string `json:"steamId"`   // "" = all players
	Team      string `json:"team"`      // "" | ct | t
}

// HeatmapGrid is a server-computed raster over the map-pack bounds
// (world units → grid cells; streamed from the sidecar, never fully loaded
// client-side).
type HeatmapGrid struct {
	Kind    string    `json:"kind"` // presence|kills|deaths|damage
	W       int       `json:"w"`
	H       int       `json:"h"`
	MinX    float64   `json:"minX"`
	MinY    float64   `json:"minY"`
	MaxX    float64   `json:"maxX"`
	MaxY    float64   `json:"maxY"`
	Max     float64   `json:"max"`
	Samples int       `json:"samples"`
	Cells   []float64 `json:"cells"` // row-major w*h, time-weighted (seconds) or counts
}

// SavedFilter is a named preset (saved_filters).
type SavedFilter struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Scope      string `json:"scope"` // "library" | "match"
	FilterJSON string `json:"filterJson"`
	CreatedAt  string `json:"createdAt"`
}

// heatmapGridSide is the raster resolution per axis (plan: 64×64).
const heatmapGridSide = 64

// heatmapPad is the world-unit padding added around the sampled extents.
const heatmapPad = 2.0

// AnalyticsService — see doc comment above.
type AnalyticsService struct {
	st  *store.Store
	app *application.App
}

// GetConfig returns the active analysis rules (defaults seeded on first use).
func (s *AnalyticsService) GetConfig() (AnalysisConfig, error) {
	c, err := s.st.GetConfig()
	if err != nil {
		return AnalysisConfig{}, err
	}
	return AnalysisConfig{TradeWindowS: c.TradeWindowS, EcoFullBuy: c.EcoFullBuy, EcoForce: c.EcoForce, RuleVersion: c.RuleVersion}, nil
}

// SetConfig stores new rules (bumps rule_version). Does NOT recompute —
// call RecomputeAnalysis per match explicitly.
func (s *AnalyticsService) SetConfig(c AnalysisConfig) (AnalysisConfig, error) {
	if c.TradeWindowS <= 0 {
		return AnalysisConfig{}, errors.New("analytics: tradeWindowS must be > 0")
	}
	if c.EcoForce <= 0 || c.EcoFullBuy <= 0 {
		return AnalysisConfig{}, errors.New("analytics: eco thresholds must be > 0")
	}
	if c.EcoForce > c.EcoFullBuy {
		return AnalysisConfig{}, errors.New("analytics: ecoForce must be ≤ ecoFullBuy")
	}
	cur, err := s.st.GetConfig()
	if err != nil {
		return AnalysisConfig{}, err
	}
	saved, err := s.st.SetConfig(models.AnalysisConfig{
		TradeWindowS: c.TradeWindowS,
		EcoFullBuy:   c.EcoFullBuy,
		EcoForce:     c.EcoForce,
		RuleVersion:  cur.RuleVersion + 1, // input RuleVersion ignored — always bump
	})
	if err != nil {
		return AnalysisConfig{}, err
	}
	return AnalysisConfig{TradeWindowS: saved.TradeWindowS, EcoFullBuy: saved.EcoFullBuy, EcoForce: saved.EcoForce, RuleVersion: saved.RuleVersion}, nil
}

// RecomputeAnalysis re-runs classification + analytics for one match under
// the current rules and refreshes career rollups.
func (s *AnalyticsService) RecomputeAnalysis(matchID int64) error {
	c, err := s.st.GetConfig()
	if err != nil {
		return err
	}
	return analytics.Compute(s.st, matchID, analytics.Config{
		TradeWindowS: c.TradeWindowS,
		EcoFullBuy:   c.EcoFullBuy,
		EcoForce:     c.EcoForce,
		RuleVersion:  c.RuleVersion,
	})
}

// GetEconomy returns per-round economy + buy classes (warmup rounds
// excluded). Loss bonus is reconstructed (inferred — UI badge); per-side
// classes are completed here via the shared analytics rules.
func (s *AnalyticsService) GetEconomy(matchID int64) ([]RoundEconomyRow, error) {
	rows, err := s.st.GetEconomy(matchID)
	if err != nil {
		return nil, err
	}
	cfg, err := s.st.GetConfig()
	if err != nil {
		return nil, err
	}
	rows = analytics.EconomyRows(rows, analytics.Config{
		TradeWindowS: cfg.TradeWindowS, EcoFullBuy: cfg.EcoFullBuy,
		EcoForce: cfg.EcoForce, RuleVersion: cfg.RuleVersion,
	})
	out := make([]RoundEconomyRow, len(rows))
	for i, r := range rows {
		out[i] = RoundEconomyRow{
			Round: r.Round, Winner: r.Winner, Warmup: r.Warmup,
			EquipCT: r.EquipCT, EquipT: r.EquipT, MoneyCT: r.MoneyCT, MoneyT: r.MoneyT,
			SpentCT: r.SpentCT, SpentT: r.SpentT, ClassCT: r.ClassCT, ClassT: r.ClassT,
			ClassWhyCT: r.ClassWhyCT, ClassWhyT: r.ClassWhyT,
			LossBonusCT: r.LossBonusCT, LossBonusT: r.LossBonusT,
			InferredCT: r.InferredCT, InferredT: r.InferredT,
			WonCT: r.WonCT, WonT: r.WonT, PistolRound: r.PistolRound, RuleVersion: r.RuleVersion,
		}
	}
	return out, nil
}

// GetRoundClasses returns stored classifications.
func (s *AnalyticsService) GetRoundClasses(matchID int64) ([]RoundClassRow, error) {
	rows, err := s.st.GetRoundClasses(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]RoundClassRow, len(rows))
	for i, r := range rows {
		out[i] = RoundClassRow{Round: r.Round, Label: r.Label, Confidence: r.Confidence, RuleVersion: r.RuleVersion, Explanation: r.Explanation}
	}
	return out, nil
}

// GetPlayerRounds returns per-round rows for one player ("" = all players).
func (s *AnalyticsService) GetPlayerRounds(matchID int64, steamID string) ([]PlayerRoundRow, error) {
	rows, err := s.st.GetPlayerRounds(matchID, steamID)
	if err != nil {
		return nil, err
	}
	out := make([]PlayerRoundRow, len(rows))
	for i, r := range rows {
		out[i] = PlayerRoundRow{
			Round: r.Round, SteamID: r.SteamID, Name: r.Name, Kills: r.Kills,
			Assists: r.Assists, Deaths: r.Deaths, Traded: r.Traded, Survived: r.Survived,
			KAST: r.KAST, DMG: r.DMG, MoneyStart: r.MoneyStart, Equip: r.Equip,
			Spent: r.Spent, UtilDmg: r.UtilDmg,
		}
	}
	return out, nil
}

// GetClutches returns clutch v2 records.
func (s *AnalyticsService) GetClutches(matchID int64) ([]ClutchRow, error) {
	rows, err := s.st.GetClutches(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]ClutchRow, len(rows))
	for i, r := range rows {
		out[i] = ClutchRow{
			ID: int64(i + 1), Round: r.Round, Size: r.Size, SteamID: r.SteamID, Name: r.Name,
			StartTick: r.StartTick, EndTick: r.EndTick, BombState: r.BombState, HPLeft: r.HPLeft,
			Equip: r.Equip, Won: r.Won, KillTicks: r.KillTicks, ReplayAnchor: r.ReplayAnchor,
		}
	}
	return out, nil
}

// GetEngagements returns detected engagements; kind "" = all.
func (s *AnalyticsService) GetEngagements(matchID int64, kind string) ([]EngagementRow, error) {
	rows, err := s.st.GetEngagements(matchID, kind)
	if err != nil {
		return nil, err
	}
	out := make([]EngagementRow, len(rows))
	for i, r := range rows {
		out[i] = EngagementRow{
			Tick: r.Tick, Round: r.Round, Kind: r.Kind, ASteam: r.ASteam, BSteam: r.BSteam,
			AName: r.AName, BName: r.BName, Distance: r.Distance, WonBy: r.WonBy,
		}
	}
	return out, nil
}

// GetUtility returns per-grenade rows.
func (s *AnalyticsService) GetUtility(matchID int64) ([]UtilityRow, error) {
	rows, err := s.st.GetUtility(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]UtilityRow, len(rows))
	for i, r := range rows {
		u := UtilityRow{
			Tick: r.Tick, Round: r.Round, Thrower: r.Thrower, ThrowerName: r.ThrowerName,
			Kind: r.Kind, Damage: r.Damage, FlashMs: r.FlashMs, Affected: r.Affected, Site: r.Site,
		}
		if r.DetX != nil {
			u.DetX = *r.DetX
		}
		if r.DetY != nil {
			u.DetY = *r.DetY
		}
		out[i] = u
	}
	return out, nil
}

// GetCombatStats returns per-player engagement/damage deep-dive rows
// (computed from stored rows; TradeOppMissed is inferred — UI badge).
func (s *AnalyticsService) GetCombatStats(matchID int64) ([]CombatStatRow, error) {
	rows, err := s.st.GetCombatStats(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]CombatStatRow, len(rows))
	for i, r := range rows {
		out[i] = CombatStatRow{
			SteamID: r.SteamID, Name: r.Name, DMGNoKill: r.DMGNoKill, DMGConvPct: r.DMGConvPct,
			FFDamage: r.FFDamage, EntryRate: r.EntryRate, TradeRate: r.TradeRate,
			UntradedDeaths: r.UntradedDeaths, TradeOppMissed: r.TradeOppMissed, KASTPct: r.KASTPct,
		}
	}
	return out, nil
}

// GetHeatmap computes a raster for kind presence|kills|deaths|damage.
// presence streams the M2 sidecar; kills use the attacker's position (where
// the killer was), deaths/damage the victim's/hit position. Filters are
// applied server-side:
// presence by round range via the tick↔round spans + steam/team via the
// slot table; events by round, attacker (kills) or victim
// (deaths/damage) and their team's final side. Bounds come from the
// sampled extents + 2u pad; the grid is 64×64 with per-axis cell sizes;
// presence cells are dwell seconds (1/sample-rate per frame per player),
// event cells are counts.
func (s *AnalyticsService) GetHeatmap(matchID int64, kind string, f HeatmapFilter) (HeatmapGrid, error) {
	switch kind {
	case "presence", "kills", "deaths", "damage":
	default:
		return HeatmapGrid{}, fmt.Errorf("analytics: unknown heatmap kind %q", kind)
	}
	rounds, err := s.st.GetRounds(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	players, err := s.st.GetPlayerRefs(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	// Team filters need real sides: recover the final sides of players
	// absent from the final-state snapshot (same inference as the analytics
	// pass — see analytics.RecoverSides).
	ers, err := s.st.GetEvents(models.EventFilter{MatchID: matchID, Kind: models.EventKill, Round: -1, Limit: 50000})
	if err != nil {
		return HeatmapGrid{}, err
	}
	kills := make([]models.Event, len(ers))
	for i, er := range ers {
		kills[i] = models.Event{Seq: er.Seq, Tick: er.Tick, Round: er.Round, Kind: er.Kind, Attacker: er.Attacker, Victim: er.Victim}
	}
	roundInfos := make([]models.RoundInfo, len(rounds))
	for i, r := range rounds {
		roundInfos[i] = models.RoundInfo{Number: r.Number, Winner: r.Winner, Warmup: r.Warmup,
			Pregame: r.Pregame, StartTick: r.StartTick, EndTick: r.EndTick, FreezeEndTick: r.FreezeEndTick}
	}
	players = analytics.RecoverSides(kills, roundInfos, players)
	side := map[string]string{}
	for _, p := range players {
		side[p.SteamID] = p.Side
	}
	// Exact per-round sides when the extractor persisted them (new
	// imports); legacy matches fall back to final-side parity with the
	// first second-half round — ceiling division locates the boundary
	// (floor landed one round early).
	exact, err := s.st.GetRoundPlayerSides(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	halfSwitch := 0
	if m, err := s.st.GetMatch(matchID); err == nil && m.SideSwitches > 0 {
		real := analytics.CountedRounds(roundInfos)
		if idx := (len(real) + m.SideSwitches) / (m.SideSwitches + 1); idx > 0 && idx < len(real) {
			halfSwitch = real[idx].Number
		}
	}
	sideAt := func(steamID string, round int) string {
		if m, ok := exact[round]; ok && m[steamID] != "" {
			return m[steamID]
		}
		s := side[steamID]
		if halfSwitch > 0 && round < halfSwitch && (s == "ct" || s == "t") {
			if s == "ct" {
				return "t"
			}
			return "ct"
		}
		return s
	}
	if kind == "presence" {
		return s.heatmapPresence(matchID, f, rounds, sideAt)
	}
	return s.heatmapEvents(matchID, kind, f, sideAt)
}

// heatmapPresence streams the whole sidecar stream and accumulates
// time-weighted dwell per cell.
func (s *AnalyticsService) heatmapPresence(matchID int64, f HeatmapFilter, rounds []models.RoundRow, sideAt func(string, int) string) (HeatmapGrid, error) {
	rd, err := sidecar.Open(filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10)))
	if err != nil {
		return HeatmapGrid{}, fmt.Errorf("analytics: heatmap presence: %w", err)
	}
	raw, err := rd.ReadRange(0, 0)
	if err != nil {
		return HeatmapGrid{}, fmt.Errorf("analytics: heatmap presence: %w", err)
	}
	meta := rd.Meta()
	frames, err := sidecar.DecodeFrames(raw, meta.Players)
	if err != nil {
		return HeatmapGrid{}, fmt.Errorf("analytics: heatmap presence: %w", err)
	}
	sampleRate := meta.SampleRate
	if sampleRate <= 0 {
		sampleRate = sidecar.SampleRate
	}
	dt := 1.0 / float64(sampleRate)

	keep := func(steamID string, round int) bool {
		if f.SteamID != "" && steamID != f.SteamID {
			return false
		}
		if f.Team != "" && sideAt(steamID, round) != f.Team {
			return false
		}
		return true
	}
	inRoundRange := func(round int) bool {
		if f.RoundFrom >= 0 && round < f.RoundFrom {
			return false
		}
		if f.RoundTo >= 0 && round > f.RoundTo {
			return false
		}
		return true
	}
	roundAt := func(tick int) (int, bool) {
		for _, r := range rounds {
			if tick >= r.StartTick && tick <= r.EndTick {
				return r.Number, true
			}
		}
		return 0, false
	}

	// Sampled extents (every 8th frame) for the bounds, +pad.
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for i, fr := range frames {
		if i%8 != 0 {
			continue
		}
		rn, ok := roundAt(fr.Tick)
		if !ok || !inRoundRange(rn) {
			continue
		}
		for _, p := range fr.Players {
			sid := strconv.FormatUint(p.SteamID, 10)
			if !keep(sid, rn) {
				continue
			}
			minX, minY = math.Min(minX, p.X), math.Min(minY, p.Y)
			maxX, maxY = math.Max(maxX, p.X), math.Max(maxY, p.Y)
		}
	}
	if math.IsInf(minX, 1) {
		return HeatmapGrid{Kind: "presence", W: heatmapGridSide, H: heatmapGridSide,
			Cells: make([]float64, heatmapGridSide*heatmapGridSide)}, nil
	}
	minX, minY, maxX, maxY = minX-heatmapPad, minY-heatmapPad, maxX+heatmapPad, maxY+heatmapPad
	cellW := (maxX - minX) / heatmapGridSide
	cellH := (maxY - minY) / heatmapGridSide
	if cellW <= 0 {
		cellW = 1
	}
	if cellH <= 0 {
		cellH = 1
	}
	cells := make([]float64, heatmapGridSide*heatmapGridSide)
	samples := 0
	for _, fr := range frames {
		rn, ok := roundAt(fr.Tick)
		if !ok || !inRoundRange(rn) {
			continue
		}
		for _, p := range fr.Players {
			sid := strconv.FormatUint(p.SteamID, 10)
			if !keep(sid, rn) {
				continue
			}
			cx := int((p.X - minX) / cellW)
			cy := int((p.Y - minY) / cellH)
			if cx < 0 || cx >= heatmapGridSide || cy < 0 || cy >= heatmapGridSide {
				continue
			}
			cells[cy*heatmapGridSide+cx] += dt
			samples++
		}
	}
	return HeatmapGrid{
		Kind: "presence", W: heatmapGridSide, H: heatmapGridSide,
		MinX: minX, MinY: minY, MaxX: maxX, MaxY: maxY,
		Max: maxCell(cells), Samples: samples, Cells: cells,
	}, nil
}

// heatmapEvents rasterizes kill/death/damage event positions: kills plot
// the ATTACKER's position (where the killer was — events.apos_*), deaths
// and damage plot the VICTIM's position (where the player fell / the
// hitpoint — events.pos_*). The SteamID filter applies to the attacker on
// kills and to the victim on deaths/damage; legacy imports without stored
// attacker positions fall back to the victim position.
func (s *AnalyticsService) heatmapEvents(matchID int64, kind string, f HeatmapFilter, sideAt func(string, int) string) (HeatmapGrid, error) {
	eventKind := map[string]string{"kills": models.EventKill, "deaths": models.EventKill, "damage": models.EventDamage}[kind]
	rows, err := s.st.GetEvents(models.EventFilter{MatchID: matchID, Kind: eventKind, Round: -1, Limit: 50000})
	if err != nil {
		return HeatmapGrid{}, err
	}
	type sample struct{ x, y float64 }
	var samples []sample
	for _, e := range rows {
		if f.RoundFrom >= 0 && e.Round < f.RoundFrom {
			continue
		}
		if f.RoundTo >= 0 && e.Round > f.RoundTo {
			continue
		}
		party := e.Victim // deaths/damage: victim; kills: attacker position, filter on attacker
		if kind == "kills" {
			party = e.Attacker
		}
		if f.SteamID != "" && party != f.SteamID {
			continue
		}
		if f.Team != "" && sideAt(party, e.Round) != f.Team {
			continue
		}
		x, y := e.PosX, e.PosY
		if kind == "kills" && e.AttackerPosX != nil && e.AttackerPosY != nil {
			x, y = e.AttackerPosX, e.AttackerPosY
		}
		if x == nil || y == nil {
			continue
		}
		samples = append(samples, sample{x: *x, y: *y})
	}
	if len(samples) == 0 {
		return HeatmapGrid{Kind: kind, W: heatmapGridSide, H: heatmapGridSide,
			Cells: make([]float64, heatmapGridSide*heatmapGridSide)}, nil
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, sm := range samples {
		minX, minY = math.Min(minX, sm.x), math.Min(minY, sm.y)
		maxX, maxY = math.Max(maxX, sm.x), math.Max(maxY, sm.y)
	}
	minX, minY, maxX, maxY = minX-heatmapPad, minY-heatmapPad, maxX+heatmapPad, maxY+heatmapPad
	cellW := (maxX - minX) / heatmapGridSide
	cellH := (maxY - minY) / heatmapGridSide
	if cellW <= 0 {
		cellW = 1
	}
	if cellH <= 0 {
		cellH = 1
	}
	cells := make([]float64, heatmapGridSide*heatmapGridSide)
	for _, sm := range samples {
		cx := int((sm.x - minX) / cellW)
		cy := int((sm.y - minY) / cellH)
		if cx < 0 || cx >= heatmapGridSide || cy < 0 || cy >= heatmapGridSide {
			continue
		}
		cells[cy*heatmapGridSide+cx]++
	}
	return HeatmapGrid{
		Kind: kind, W: heatmapGridSide, H: heatmapGridSide,
		MinX: minX, MinY: minY, MaxX: maxX, MaxY: maxY,
		Max: maxCell(cells), Samples: len(samples), Cells: cells,
	}, nil
}

// maxCell returns the largest value in a raster.
func maxCell(cells []float64) float64 {
	m := 0.0
	for _, v := range cells {
		if v > m {
			m = v
		}
	}
	return m
}

// Saved filters.
func (s *AnalyticsService) ListSavedFilters() ([]SavedFilter, error) {
	rows, err := s.st.ListSavedFilters()
	if err != nil {
		return nil, err
	}
	out := make([]SavedFilter, len(rows))
	for i, r := range rows {
		out[i] = SavedFilter{ID: r.ID, Name: r.Name, Scope: r.Scope, FilterJSON: r.FilterJSON, CreatedAt: r.CreatedAt.Format("2006-01-02T15:04:05Z07:00")}
	}
	return out, nil
}

func (s *AnalyticsService) SaveFilter(name, scope, filterJSON string) (SavedFilter, error) {
	if name == "" {
		return SavedFilter{}, errors.New("analytics: filter name is required")
	}
	r, err := s.st.CreateSavedFilter(name, scope, filterJSON)
	if err != nil {
		return SavedFilter{}, err
	}
	return SavedFilter{ID: r.ID, Name: r.Name, Scope: r.Scope, FilterJSON: r.FilterJSON, CreatedAt: r.CreatedAt.Format("2006-01-02T15:04:05Z07:00")}, nil
}

func (s *AnalyticsService) DeleteSavedFilter(id int64) error { return s.st.DeleteSavedFilter(id) }
