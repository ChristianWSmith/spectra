package analytics

import (
	"github.com/ChristianWSmith/spectra/internal/models"
)

// utilWeapons maps damage-event weapon names to "utility damage" for the
// per-player-round util_dmg column.
var utilWeapons = map[string]bool{
	"HE Grenade":         true,
	"Molotov":            true,
	"Incendiary Grenade": true,
	"Smoke Grenade":      true,
	"Flashbang":          true,
	"Decoy Grenade":      true,
}

// PlayerRounds derives per-player-per-round stats incl. the KAST
// decomposition from a match's typed events:
//
//	K        kill credited to the player (kill event attacker; suicides
//	         and teamkills excluded)
//	A        assist (kill event assister, AssistedFlash excluded — the
//	         external-scoreboard convention)
//	S        survived — no death event for them in the round
//	T        traded — their death was answered: a teammate of theirs killed
//	         their killer within cfg.TradeWindowS after the death
//	kast     K || A || T || S
//
// DMG/UtilDmg aggregate damage events (attacker side; util = utility
// weapons). MoneyStart/Equip/Spent stay 0 in v1 (item_equip payloads carry
// no price — see package doc). Rows are emitted for EVERY player × every
// counted round (round ASC, players sorted by SteamID for stable output).
// sides carries the extractor's exact per-round side samples (nil for
// legacy matches — final-side parity applies there).
func PlayerRounds(events []models.Event, rounds []RoundInfo, players []PlayerRef, cfg Config, sides map[int]map[string]string) []PlayerRound {
	real := CountedRounds(rounds)
	if len(real) == 0 {
		return nil
	}
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		byRound[e.Round] = append(byRound[e.Round], e)
	}

	sorted := sortedPlayerRefs(players)
	team := teamOf(players)
	window := cfg.ticks(cfg.TradeWindowS)

	out := make([]PlayerRound, 0, len(real)*len(sorted))
	for _, r := range real {
		teamR := resolveRoundSides(sides, team, cfg, r.Number)
		roundEvents := byRound[r.Number]
		var kills, assists, deaths, dmg, utilDmg = map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
		deathTick := map[string]int{}   // victim → death tick
		killerOf := map[string]string{} // victim → killer
		for _, e := range roundEvents {
			switch e.Kind {
			case models.EventKill:
				kt, vt := teamR[e.Attacker], teamR[e.Victim]
				// Enemy kills only (suicides/teamkills excluded); an
				// unknown side is permissive — count it.
				if e.Attacker != "" && !sameSide(kt, vt) {
					kills[e.Attacker]++
				}
				// Assists: cross-team, non-flash (external convention).
				if e.Assister != "" && e.Assister != e.Victim &&
					!sameSide(vt, teamR[e.Assister]) && !e.AssistedFlash {
					assists[e.Assister]++
				}
				if e.Victim != "" {
					deaths[e.Victim]++
					deathTick[e.Victim] = e.Tick
					killerOf[e.Victim] = e.Attacker
				}
			case models.EventDamage:
				if e.Attacker != "" {
					dmg[e.Attacker] += e.Dmg
					if utilWeapons[e.Weapon] {
						utilDmg[e.Attacker] += e.Dmg
					}
				}
			}
		}
		// Trades: a death is traded when the victim's killer dies to one of
		// the victim's teammates within the trade window after the death.
		traded := map[string]bool{}
		for victim, dTick := range deathTick {
			killer := killerOf[victim]
			if killer == "" {
				continue
			}
			vTeam := teamR[victim]
			if vTeam == "" {
				continue
			}
			for _, e := range roundEvents {
				if e.Kind != models.EventKill || e.Tick <= dTick || e.Tick-dTick > window {
					continue
				}
				if e.Victim != killer || teamR[e.Attacker] != vTeam || e.Attacker == victim {
					continue
				}
				traded[victim] = true
				break
			}
		}
		for _, p := range sorted {
			if p.SteamID == "" {
				continue
			}
			k := kills[p.SteamID] > 0
			a := assists[p.SteamID] > 0
			s := deaths[p.SteamID] == 0
			t := traded[p.SteamID]
			out = append(out, PlayerRound{
				Round:       r.Number,
				SteamID:     p.SteamID,
				Name:        p.Name,
				Kills:       kills[p.SteamID],
				Assists:     assists[p.SteamID],
				Deaths:      deaths[p.SteamID],
				Traded:      t,
				Survived:    s,
				KAST:        k || a || t || s,
				DMG:         dmg[p.SteamID],
				UtilDmg:     utilDmg[p.SteamID],
				MoneyStart:  0, // v1 limitation: no per-player price data
				Equip:       0,
				Spent:       0,
				RuleVersion: cfg.RuleVersion,
			})
		}
	}
	return out
}
