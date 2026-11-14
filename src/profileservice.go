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
//
// Deliberately NO ADR field (dogfooding W4): the picker and the
// suggestion rows read the stored `career_adr` metric rows through
// services.careerAdrRows — the canonical career read — so a
// Go-computed ADR never reaches a view while player_career.adr_avg is
// written-only (Q4's dual-write).
type ProfileSummary struct {
	SteamID  string `json:"steamId"`
	Name     string `json:"name"`
	Matches  int    `json:"matches"`
	LastSeen string `json:"lastSeen"` // date of most recent match ("" if unknown)
}

// ProfileSide is the player's per-ROUND split by side (players switch
// sides at halftime, so this is rounds played on CT vs T — never a
// per-match side; see store.GetPlayerSideSplits).
type ProfileSide struct {
	Side        string  `json:"side"` // ct|t
	Rounds      int     `json:"rounds"`
	RoundWinPct float64 `json:"roundWinPct"` // rounds won on this side, 0..100
	ADR         float64 `json:"adr"`
	KASTPct     float64 `json:"kastPct"`
	KD          float64 `json:"kd"`
}

// ProfileMap is the per-map split. ADR is the mean of the match-history
// rows' STORED `adr` metric values for that map — nil when no match on
// the map carries a fresh row (the profile renders "—"), never a
// fabricated 0.
type ProfileMap struct {
	Map     string   `json:"map"`
	Matches int      `json:"matches"`
	Wins    int      `json:"wins"`
	ADR     *float64 `json:"adr"`
}

// ProfileWeapon is weapon proficiency.
type ProfileWeapon struct {
	Weapon    string `json:"weapon"`
	Kills     int    `json:"kills"`
	Damage    int    `json:"damage"`
	Headshots int    `json:"headshots"`
}

// Profile is the full cross-match read model — the DESIGNED HYBRID
// (dogfooding design §3.5): the raw/inferred and non-expressible stats
// (N2–N6 + raw) stay Go-rendered here, while the nine converted stats
// (ADR ± σ, K/D, HS%, KAST%, Trade rate, clutch win share, avg enemies
// flashed, avg util damage) are deliberately ABSENT from this DTO — the
// profile reads them as stored metric rows through the canonical career
// read (the "Career metrics" panel), and the history's ADR/KAST cells
// read the match-scope rows (store.GetPlayerHistory).
type Profile struct {
	SteamID     string                     `json:"steamId"`
	Name        string                     `json:"name"`
	Matches     int                        `json:"matches"`
	Wins        int                        `json:"wins"`
	WinPct      float64                    `json:"winPct"`
	OpeningRate float64                    `json:"openingRate"` // duel win rate, 0..100
	Clutches    int                        `json:"clutches"`
	Sides       []ProfileSide              `json:"sides"`
	Maps        []ProfileMap               `json:"maps"`
	Weapons     []ProfileWeapon            `json:"weapons"` // top by kills
	History     []models.ProfileHistoryRow `json:"history"` // most recent first, ≤100
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
// mergeWeapons alongside kills and damage; the per-ROUND side splits come
// from store.GetPlayerSideSplits. The nine stats that converted to
// metrics (dogfooding design §3.5 — ADR ± σ, K/D, HS%, KAST%, Trade
// rate, clutch win share, avg enemies flashed, avg util damage) are
// computed NOWHERE in this function any more: the profile reads them as
// stored rows through the canonical career read, and the history's
// ADR/KAST cells read the match-scope rows inside store.GetPlayerHistory.
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
	if career.Openings > 0 {
		p.OpeningRate = 100 * float64(career.OpenerWins) / float64(career.Openings)
	}
	p.Clutches = career.Clutches

	history, err := s.st.GetPlayerHistory(steamID)
	if err != nil {
		return Profile{}, err
	}
	p.History = history

	// Per-ROUND side splits: players switch sides at halftime, so the
	// Sides card compares rounds played on CT vs T (never one row per
	// match side — that mixed both halves into a single label).
	splits, err := s.st.GetPlayerSideSplits(steamID)
	if err != nil {
		return Profile{}, err
	}
	for _, sp := range splits {
		winPct := 0.0
		if sp.Rounds > 0 {
			winPct = 100 * float64(sp.Wins) / float64(sp.Rounds)
		}
		p.Sides = append(p.Sides, ProfileSide{
			Side:        sp.Side,
			Rounds:      sp.Rounds,
			RoundWinPct: winPct,
			ADR:         sp.ADR,
			KASTPct:     sp.KASTPct,
			// KD uses the career rollup's pooled shape (kdCareerSQL):
			// SUM(kills) / MAX(SUM(deaths), 1) over these rounds — a
			// zero-death side counts every kill (same floor, no NaN).
			KD: float64(sp.Kills) / float64(max(sp.Deaths, 1)),
		})
	}

	// Per-map fold over the history. The ADR column is the mean of the
	// history rows' STORED `adr` metric values — a row with no fresh
	// metric row contributes nothing (and a map whose rows all lack one
	// keeps ADR nil → "—"), so the divisor is the number of rows that
	// actually carried a value, never the raw match count.
	type mapAggT struct {
		ProfileMap
		adrSum float64
		adrN   int
	}
	mapAgg := map[string]*mapAggT{}
	for _, h := range history {
		m := mapAgg[h.Map]
		if m == nil {
			m = &mapAggT{ProfileMap: ProfileMap{Map: h.Map}}
			mapAgg[h.Map] = m
		}
		m.Matches++
		if h.Win {
			m.Wins++
		}
		if h.ADR != nil {
			m.adrSum += *h.ADR
			m.adrN++
		}
	}
	for _, m := range mapAgg {
		if m.adrN > 0 {
			adr := m.adrSum / float64(m.adrN)
			m.ADR = &adr
		}
		p.Maps = append(p.Maps, m.ProfileMap)
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
// The rows carry identity + recency only: the ADR the picker/suggestions
// render comes from the stored `career_adr` metric rows (the frontend's
// canonical career read), never from this Go path.
func (s *ProfileService) ListPlayers(query string) ([]ProfileSummary, error) {
	rows, err := s.st.ListPlayers(query)
	if err != nil {
		return nil, err
	}
	out := make([]ProfileSummary, len(rows))
	for i, r := range rows {
		out[i] = ProfileSummary{SteamID: r.SteamID, Name: r.Name, Matches: r.Matches}
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
