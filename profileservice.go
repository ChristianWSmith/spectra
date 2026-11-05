package main

import (
	"encoding/json"
	"errors"
	"sort"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ProfileService serves cross-match player profiles (M3 §2.7): identity via
// SteamID64, career rollups from player_career + on-demand history from
// player_stats joins. Profiles are read models — rollups are maintained
// transactionally on import/delete and rebuilt explicitly on rule changes.

// ProfileSummary is one row of the player picker. KEPT twin (models.
// CareerSummary is field-identical but its LastSeen is time.Time): this
// LastSeen is a display-ready "" | YYYY-MM-DD short date the picker and
// command palette render raw — time.Time would JSON-marshal the zero
// value as "0001-01-01T00:00:00Z" (indistinguishable from a real value
// for those readers) and add a time-of-day they don't want.
type ProfileSummary struct {
	SteamID  string  `json:"steamId"`
	Name     string  `json:"name"`
	Matches  int     `json:"matches"`
	LastSeen string  `json:"lastSeen"` // date of most recent match ("" if unknown)
	ADRAvg   float64 `json:"adrAvg"`
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
	SteamID      string                     `json:"steamId"`
	Name         string                     `json:"name"`
	Matches      int                        `json:"matches"`
	Wins         int                        `json:"wins"`
	WinPct       float64                    `json:"winPct"`
	ADRAvg       float64                    `json:"adrAvg"`
	ADRStd       float64                    `json:"adrStd"` // consistency (PRD §5.13)
	KD           float64                    `json:"kd"`
	HSPct        float64                    `json:"hsPct"`
	KASTPct      float64                    `json:"kastPct"`
	OpeningRate  float64                    `json:"openingRate"` // duel win rate, 0..100
	TradeRate    float64                    `json:"tradeRate"`   // 0..100 percent (see GetProfile)
	Clutches     int                        `json:"clutches"`
	ClutchWinPct float64                    `json:"clutchWinPct"`
	Sides        []ProfileSide              `json:"sides"`
	Maps         []ProfileMap               `json:"maps"`
	Weapons      []ProfileWeapon            `json:"weapons"` // top by kills
	History      []models.ProfileHistoryRow `json:"history"` // most recent first, ≤100
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
// — the frontend shows an empty state. Per-weapon headshots come from the
// stored kill events (store.GetPlayerWeaponJSONs), folded per weapon by
// mergeWeapons alongside kills and damage.
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
	// TradeRate over the career: 100 × trades / max(deaths, 1) from history
	// sums (career has no death column; history covers ≤100 matches — fine
	// at this library scale). Percent scale: 0..100 like OpeningRate above
	// and every other *Pct/*Rate field on this DTO — the value fmtPercent
	// renders directly (the Combat tab's Trade% follows the same rule in
	// store.GetCombatStats; pinned by TestGetProfileTradeRatePercent).
	deaths := 0
	sideAgg := map[string]*ProfileSide{}
	// Per-side kill/death pools for ProfileSide.KD — the same rows the
	// side's Matches/Wins/ADR/KAST aggregates come from.
	sideKills := map[string]int{}
	sideDeaths := map[string]int{}
	mapAgg := map[string]*ProfileMap{}
	for _, h := range history {
		deaths += h.Deaths
		side := sideAgg[h.Side]
		if side == nil {
			side = &ProfileSide{Side: h.Side}
			sideAgg[h.Side] = side
		}
		side.Matches++
		sideKills[h.Side] += h.Kills
		sideDeaths[h.Side] += h.Deaths
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
	}
	p.History = history
	if deaths > 0 {
		p.TradeRate = 100 * float64(career.Trades) / float64(deaths)
	}
	for _, side := range sideAgg {
		if side.Matches > 0 {
			side.ADR /= float64(side.Matches)
			side.KASTPct /= float64(side.Matches)
		}
		// KD uses the career rollup's pooled shape (kdCareerSQL):
		// SUM(kills) / MAX(SUM(deaths), 1) over these history rows — a
		// zero-death side counts every kill (same floor, no NaN).
		side.KD = float64(sideKills[side.Side]) / float64(max(sideDeaths[side.Side], 1))
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

// mergeWeapons folds the per-match kills_by_weapon/damage_by_weapon and
// headshots_by_weapon JSON objects into one top-N list sorted by kills
// descending (ties: name).
func mergeWeapons(rows []models.ProfileWeaponJSONs) []ProfileWeapon {
	type aggT struct{ kills, dmg, hs int }
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
		merge(r.HeadshotsByWeapon, func(a *aggT) *int { return &a.hs })
	}
	out := make([]ProfileWeapon, 0, len(agg))
	for weapon, a := range agg {
		out = append(out, ProfileWeapon{Weapon: weapon, Kills: a.kills, Damage: a.dmg, Headshots: a.hs})
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
// metric ∈ adr|kast|kd|hs. Values are served at full precision — the
// frontend's fmt1/fmt2/round1 do the display rounding.
func (s *ProfileService) GetCareerTrend(steamID, metric string) ([]models.ProfileTrendPoint, error) {
	return s.st.GetTrend(steamID, metric)
}
