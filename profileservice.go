package main

import (
	"encoding/json"
	"errors"
	"math"
	"sort"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ProfileService serves cross-match player profiles (M3 §2.7): identity via
// SteamID64, career rollups from player_career + on-demand history from
// player_stats joins. Profiles are read models — rollups are maintained
// transactionally on import/delete and rebuilt explicitly on rule changes.

// ProfileSummary is one row of the player picker.
type ProfileSummary struct {
	SteamID  string  `json:"steamId"`
	Name     string  `json:"name"`
	Matches  int     `json:"matches"`
	LastSeen string  `json:"lastSeen"` // date of most recent match ("" if unknown)
	ADRAvg   float64 `json:"adrAvg"`
}

// ProfileMatchRow is one history entry.
type ProfileMatchRow struct {
	MatchID     int64   `json:"matchId"`
	ExtractedAt string  `json:"extractedAt"`
	Map         string  `json:"map"`
	Win         bool    `json:"win"`
	ScoreCT     int     `json:"scoreCT"`
	ScoreT      int     `json:"scoreT"`
	Side        string  `json:"side"`
	Kills       int     `json:"kills"`
	Deaths      int     `json:"deaths"`
	Assists     int     `json:"assists"`
	ADR         float64 `json:"adr"`
	KASTPct     float64 `json:"kastPct"`
}

// ProfileSide is the per-side split.
type ProfileSide struct {
	Side    string  `json:"side"` // ct|t
	Matches int     `json:"matches"`
	Wins    int     `json:"wins"`
	ADR     float64 `json:"adr"`
	KASTPct float64 `json:"kastPct"`
	KD      float64 `json:"kd"`
}

// ProfileMap is the per-map split.
type ProfileMap struct {
	Map     string  `json:"map"`
	Matches int     `json:"matches"`
	Wins    int     `json:"wins"`
	ADR     float64 `json:"adr"`
}

// ProfileWeapon is weapon proficiency.
type ProfileWeapon struct {
	Weapon    string `json:"weapon"`
	Kills     int    `json:"kills"`
	Damage    int    `json:"damage"`
	Headshots int    `json:"headshots"`
}

// Profile is the full cross-match read model.
type Profile struct {
	SteamID      string            `json:"steamId"`
	Name         string            `json:"name"`
	Matches      int               `json:"matches"`
	Wins         int               `json:"wins"`
	WinPct       float64           `json:"winPct"`
	ADRAvg       float64           `json:"adrAvg"`
	ADRStd       float64           `json:"adrStd"` // consistency (PRD §5.13)
	KD           float64           `json:"kd"`
	HSPct        float64           `json:"hsPct"`
	KASTPct      float64           `json:"kastPct"`
	OpeningRate  float64           `json:"openingRate"` // duel win rate
	TradeRate    float64           `json:"tradeRate"`
	Clutches     int               `json:"clutches"`
	ClutchWinPct float64           `json:"clutchWinPct"`
	Sides        []ProfileSide     `json:"sides"`
	Maps         []ProfileMap      `json:"maps"`
	Weapons      []ProfileWeapon   `json:"weapons"` // top by kills
	History      []ProfileMatchRow `json:"history"` // most recent first, ≤100
}

// TrendPoint is one sparkline point (GetCareerTrend).
type TrendPoint struct {
	MatchID int64   `json:"matchId"`
	Seq     int     `json:"seq"` // history index, oldest = 0
	Value   float64 `json:"value"`
}

// weaponTopLimit caps the profile's weapon proficiency list.
const weaponTopLimit = 10

// ProfileService — see doc comment above.
type ProfileService struct {
	st  *store.Store
	app *application.App
}

// GetProfile builds the full profile for one SteamID64. A player with no
// career row yields an empty profile (SteamID filled) rather than an error
// — the frontend shows an empty state. Per-weapon headshots are not
// extracted (player_stats carries only per-match totals), so
// ProfileWeapon.Headshots is 0 in v1 (documented).
func (s *ProfileService) GetProfile(steamID string) (Profile, error) {
	p := Profile{SteamID: steamID}

	career, err := s.st.GetCareer(steamID)
	if errors.Is(err, store.ErrNotFound) {
		return p, nil
	}
	if err != nil {
		return Profile{}, err
	}
	p.Name = career.Name
	p.Matches = career.Matches
	p.Wins = career.Wins
	if p.Matches > 0 {
		p.WinPct = 100 * float64(p.Wins) / float64(p.Matches)
	}
	p.ADRAvg = career.ADRAvg
	p.ADRStd = career.ADRStd
	p.KD = career.KD
	p.HSPct = career.HSPct
	p.KASTPct = career.KASTPct
	if career.Openings > 0 {
		p.OpeningRate = 100 * float64(career.OpenerWins) / float64(career.Openings)
	}
	p.Clutches = career.Clutches
	clutches, err := s.st.GetPlayerClutchStats(steamID)
	if err != nil {
		return Profile{}, err
	}
	if clutches.Played > 0 {
		p.ClutchWinPct = 100 * float64(clutches.Won) / float64(clutches.Played)
	}

	history, err := s.st.GetPlayerHistory(steamID)
	if err != nil {
		return Profile{}, err
	}
	// TradeRate over the career: trades / max(deaths, 1) from history sums
	// (career has no death column; history covers ≤100 matches — fine at
	// this library scale).
	deaths := 0
	sideAgg := map[string]*ProfileSide{}
	mapAgg := map[string]*ProfileMap{}
	for _, h := range history {
		deaths += h.Deaths
		side := sideAgg[h.Side]
		if side == nil {
			side = &ProfileSide{Side: h.Side}
			sideAgg[h.Side] = side
		}
		side.Matches++
		if h.Win {
			side.Wins++
		}
		side.ADR += h.ADR
		side.KASTPct += h.KASTPct
		m := mapAgg[h.Map]
		if m == nil {
			m = &ProfileMap{Map: h.Map}
			mapAgg[h.Map] = m
		}
		m.Matches++
		if h.Win {
			m.Wins++
		}
		m.ADR += h.ADR

		row := ProfileMatchRow{
			MatchID: h.MatchID, Map: h.Map, Win: h.Win, ScoreCT: h.ScoreCT, ScoreT: h.ScoreT,
			Side: h.Side, Kills: h.Kills, Deaths: h.Deaths, Assists: h.Assists,
			ADR: h.ADR, KASTPct: h.KASTPct,
		}
		if !h.ExtractedAt.IsZero() {
			row.ExtractedAt = h.ExtractedAt.Format(timeFormat)
		}
		p.History = append(p.History, row)
	}
	if deaths > 0 {
		p.TradeRate = float64(career.Trades) / float64(deaths)
	}
	for _, side := range sideAgg {
		if side.Matches > 0 {
			side.ADR /= float64(side.Matches)
			side.KASTPct /= float64(side.Matches)
		}
		p.Sides = append(p.Sides, *side)
	}
	sort.Slice(p.Sides, func(i, j int) bool { return p.Sides[i].Side < p.Sides[j].Side })
	for _, m := range mapAgg {
		if m.Matches > 0 {
			m.ADR /= float64(m.Matches)
		}
		p.Maps = append(p.Maps, *m)
	}
	sort.Slice(p.Maps, func(i, j int) bool {
		if p.Maps[i].Matches != p.Maps[j].Matches {
			return p.Maps[i].Matches > p.Maps[j].Matches
		}
		return p.Maps[i].Map < p.Maps[j].Map
	})

	weapons, err := s.st.GetPlayerWeaponJSONs(steamID)
	if err != nil {
		return Profile{}, err
	}
	p.Weapons = mergeWeapons(weapons)
	return p, nil
}

// mergeWeapons folds the per-match kills_by_weapon/damage_by_weapon JSON
// objects into one top-N list sorted by kills descending (ties: name).
func mergeWeapons(rows []models.ProfileWeaponJSONs) []ProfileWeapon {
	type aggT struct{ kills, dmg int }
	agg := map[string]*aggT{}
	merge := func(raw string, pick func(a *aggT) *int) {
		if raw == "" {
			return
		}
		var m map[string]int
		if json.Unmarshal([]byte(raw), &m) != nil {
			return
		}
		for weapon, n := range m {
			a := agg[weapon]
			if a == nil {
				a = &aggT{}
				agg[weapon] = a
			}
			*pick(a) += n
		}
	}
	for _, r := range rows {
		merge(r.KillsByWeapon, func(a *aggT) *int { return &a.kills })
		merge(r.DamageByWeapon, func(a *aggT) *int { return &a.dmg })
	}
	out := make([]ProfileWeapon, 0, len(agg))
	for weapon, a := range agg {
		out = append(out, ProfileWeapon{Weapon: weapon, Kills: a.kills, Damage: a.dmg})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kills != out[j].Kills {
			return out[i].Kills > out[j].Kills
		}
		if out[i].Damage != out[j].Damage {
			return out[i].Damage > out[j].Damage
		}
		return out[i].Weapon < out[j].Weapon
	})
	if len(out) > weaponTopLimit {
		out = out[:weaponTopLimit]
	}
	return out
}

// ListPlayers searches profile identities ("" = all, ordered by recency).
func (s *ProfileService) ListPlayers(query string) ([]ProfileSummary, error) {
	rows, err := s.st.ListPlayers(query)
	if err != nil {
		return nil, err
	}
	out := make([]ProfileSummary, len(rows))
	for i, r := range rows {
		out[i] = ProfileSummary{SteamID: r.SteamID, Name: r.Name, Matches: r.Matches, ADRAvg: r.ADRAvg}
		if !r.LastSeen.IsZero() {
			out[i].LastSeen = r.LastSeen.Format("2006-01-02")
		}
	}
	return out, nil
}

// GetCareerTrend returns a metric series across matches (oldest → newest).
// metric ∈ adr|kast|kd|hs.
func (s *ProfileService) GetCareerTrend(steamID, metric string) ([]TrendPoint, error) {
	rows, err := s.st.GetTrend(steamID, metric)
	if err != nil {
		return nil, err
	}
	out := make([]TrendPoint, len(rows))
	for i, r := range rows {
		out[i] = TrendPoint{MatchID: r.MatchID, Seq: r.Seq, Value: math.Round(r.Value*100) / 100}
	}
	return out, nil
}
