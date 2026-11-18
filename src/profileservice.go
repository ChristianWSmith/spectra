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
// Go-computed ADR never reaches a view while player_career carries raw
// counts only.
type ProfileSummary struct {
	SteamID  string `json:"steamId"`
	Name     string `json:"name"`
	Matches  int    `json:"matches"`
	LastSeen string `json:"lastSeen"` // date of most recent match ("" if unknown)
}

// ProfileWeapon is weapon proficiency.
type ProfileWeapon struct {
	Weapon    string `json:"weapon"`
	Kills     int    `json:"kills"`
	Damage    int    `json:"damage"`
	Headshots int    `json:"headshots"`
}

// Profile is the full cross-match read model — the DESIGNED HYBRID
// (dogfooding design §3.5, completed by the inferred-conversion W3a
// swap): the raw/inferred and non-expressible stats (N2–N6 + raw) stay
// Go-rendered here, while every converted stat (ADR ± σ, K/D, HS%,
// KAST%, Trade rate, the Clutches count + its win share, the
// Opening-duels rate, avg enemies flashed, avg util damage) is
// deliberately ABSENT from this DTO — the profile reads them as stored
// metric rows through the canonical career read (the "Career metrics"
// panel), and the history's Assists/ADR/KAST cells read the match-scope
// rows (store.GetPlayerHistory).
type Profile struct {
	SteamID string                     `json:"steamId"`
	Name    string                     `json:"name"`
	Matches int                        `json:"matches"`
	Wins    int                        `json:"wins"`
	WinPct  float64                    `json:"winPct"`
	Weapons []ProfileWeapon            `json:"weapons"` // top by kills
	History []models.ProfileHistoryRow `json:"history"` // most recent first, ≤100
}

// The Sides and Maps tables no longer ride this DTO: they read their
// partitioned builtin rows (side_*/map_* seeds) through the canonical
// stored-value read in PlayerProfile.svelte — the Go folds that used to
// fill them (store.GetPlayerSideSplits, the history fold +
// store.GetPlayerMapADR) survive ONLY as the equivalence tests'
// oracles (internal/metrics/profile_splits_equivalence_test.go).

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
// mergeWeapons alongside kills and damage (the M7 gate's verdict —
// plan §7 M7 — keeps this fold until the weapon seeds' damage column
// resolves). The stats that converted to metrics
// (dogfooding design §3.5's nine — ADR ± σ, K/D, HS%, KAST%, Trade
// rate, clutch win share, avg enemies flashed, avg util damage — plus
// W3a's Clutches count and Opening-duels rate) are computed NOWHERE in
// this function any more: the profile reads them as stored rows through
// the canonical career read, and the history's Assists/ADR/KAST cells
// read the match-scope rows inside store.GetPlayerHistory.
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

	history, err := s.st.GetPlayerHistory(steamID)
	if err != nil {
		return Profile{}, err
	}
	p.History = history

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
// metric is the metric NAME — any match-scoped definition the trend
// picker can offer (an unknown name is an error; a profile-scope name
// resolves to an empty series, since the series is match-grain). Values
// are served at full precision — the frontend's fmt1/fmt2/round1 do the
// display rounding.
func (s *ProfileService) GetCareerTrend(steamID, metric string) ([]models.ProfileTrendPoint, error) {
	return s.st.GetTrend(steamID, metric)
}
