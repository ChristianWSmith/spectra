package analytics

import (
	"encoding/json"
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// clutchInst is one in-flight 1vN instance (solo SteamID is the map key).
type clutchInst struct {
	team    string
	size    int // opponents alive when the instance started
	start   int // tick of the kill that made them solo
	kills   []int
	dmgTook int
}

// Clutches detects 1vN clutches by walking each counted round's events
// and maintaining per-team alive sets (clutch v2, replacing
// the M1 sole-survivor approximation). sides carries the extractor's
// exact per-round side samples (nil for legacy matches — cfg's
// HalfSwitchRound parity applies there; see package doc).
//
// An instance starts the moment a side transitions INTO exactly one alive
// player while the opposing side still has ≥ 1 alive: start = the tick of
// the kill that made them solo, size = opponents alive at that moment.
// Instances are tracked per solo player, so sequential transitions (a 2v1
// whose survivor is joined by nothing, or a 2v1 that becomes a 1v1 on the
// other side) each yield their own record. An instance resolves when the
// solo dies (lost) or the last opponent dies (won); instances still open
// at round end take the round winner as their outcome (bomb/timeout edges).
// HPLeft is reconstructed: 100 − damage the solo took after the start
// (damage events, clamped ≥ 1; 100 when untouched) — a reconstruction, not
// a sampled HP value (badge). BombState is read from bomb events
// up to the start tick (planted|carried|dropped). KillTicks is the JSON
// array of the solo's kills after the start; ReplayAnchor = StartTick.
func Clutches(events []models.Event, rounds []RoundInfo, players []PlayerRef, cfg Config, sides map[int]map[string]string) []Clutch {
	real := CountedRounds(rounds)
	if len(real) == 0 {
		return nil
	}
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		byRound[e.Round] = append(byRound[e.Round], e)
	}
	team := teamOf(players)
	names := nameOf(players)

	var out []Clutch
	for _, r := range real {
		teamR := resolveRoundSides(sides, team, cfg, r.Number)
		alive := map[string]bool{}
		for _, p := range players {
			if p.SteamID != "" && (teamR[p.SteamID] == "ct" || teamR[p.SteamID] == "t") {
				alive[p.SteamID] = true
			}
		}
		active := map[string]*clutchInst{}
		roundEvents := byRound[r.Number]

		resolve := func(solo string, ac *clutchInst, endTick int, won bool) {
			killTicks, _ := json.Marshal(ac.kills)
			hp := 100 - ac.dmgTook
			if hp < 1 {
				hp = 1
			}
			if hp > 100 {
				hp = 100
			}
			out = append(out, Clutch{
				Round:        r.Number,
				Size:         ac.size,
				SteamID:      solo,
				Name:         names[solo],
				StartTick:    ac.start,
				EndTick:      endTick,
				BombState:    bombStateAt(roundEvents, ac.start),
				HPLeft:       hp,
				Equip:        equipFor(r, ac.team),
				Won:          won,
				KillTicks:    string(killTicks),
				ReplayAnchor: ac.start,
			})
			delete(active, solo)
		}

		for _, e := range roundEvents {
			switch e.Kind {
			case models.EventDamage:
				// Post-start damage on an active solo feeds HPLeft.
				if ac, ok := active[e.Victim]; ok && e.Tick > ac.start {
					ac.dmgTook += e.Dmg
				}
			case models.EventKill:
				if e.Victim == "" {
					continue
				}
				// Solo's kill after their start.
				if ac, ok := active[e.Attacker]; ok && e.Tick > ac.start {
					ac.kills = append(ac.kills, e.Tick)
				}
				// The solo died → instance lost.
				if ac, ok := active[e.Victim]; ok {
					resolve(e.Victim, ac, e.Tick, false)
				}
				delete(alive, e.Victim)
				// Any remaining solo whose opponents are now all dead won.
				for solo, ac := range active {
					if opp, _ := countAlive(alive, teamR, otherTeam(ac.team)); opp == 0 {
						resolve(solo, ac, e.Tick, true)
					}
				}
				// New solo transitions (both sides evaluated).
				for _, side := range []string{"ct", "t"} {
					n, opp := countAlive(alive, teamR, side)
					if n != 1 || opp < 1 {
						continue
					}
					solo := onlyAliveOn(alive, teamR, side)
					if solo == "" {
						continue
					}
					if _, tracked := active[solo]; tracked {
						continue
					}
					active[solo] = &clutchInst{team: side, size: opp, start: e.Tick}
				}
			}
		}
		// Still open at round end: the round winner decides the outcome.
		for solo, ac := range active {
			won := r.Winner != "" && r.Winner == ac.team
			resolve(solo, ac, r.EndTick, won)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Round != out[j].Round {
			return out[i].Round < out[j].Round
		}
		if out[i].StartTick != out[j].StartTick {
			return out[i].StartTick < out[j].StartTick
		}
		return out[i].Size > out[j].Size
	})
	return out
}

// countAlive returns (alive on side, alive off side) among players with a
// known team.
func countAlive(alive map[string]bool, team map[string]string, side string) (int, int) {
	var n, opp int
	for sid := range alive {
		if !alive[sid] {
			continue
		}
		if team[sid] == side {
			n++
		} else {
			opp++
		}
	}
	return n, opp
}

// onlyAliveOn returns the sole alive player on side ("" when not exactly
// one).
func onlyAliveOn(alive map[string]bool, team map[string]string, side string) string {
	found := ""
	n := 0
	for sid := range alive {
		if alive[sid] && team[sid] == side {
			found = sid
			n++
		}
	}
	if n == 1 {
		return found
	}
	return ""
}

// bombStateAt reports the bomb state at tick t from the round's bomb
// events: planted while a plant ≤ t has not yet exploded/been defused;
// dropped when the last bomb event ≤ t is a drop (with no later pickup);
// none after the plant resolved before t; carried otherwise.
func bombStateAt(events []models.Event, t int) string {
	plant, drop, pickup, end := -1, -1, -1, -1
	for _, e := range events {
		if e.Tick > t {
			continue
		}
		switch e.Kind {
		case models.EventBombPlant:
			plant = e.Tick
		case models.EventBombDrop:
			drop = e.Tick
		case models.EventBombPickup:
			pickup = e.Tick
		case models.EventBombExplode, models.EventBombDefuse:
			end = e.Tick
		}
	}
	if plant >= 0 {
		if end < 0 {
			return "planted" // planted, not yet resolved at t
		}
		return "none" // exploded/defused before t
	}
	if drop >= 0 && drop > pickup {
		return "dropped"
	}
	return "carried"
}

// equipFor returns the solo's team equipment value for the round.
func equipFor(r RoundInfo, side string) int {
	switch side {
	case "ct":
		return r.EquipCT
	case "t":
		return r.EquipT
	}
	return 0
}
