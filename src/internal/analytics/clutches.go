package analytics

import (
	"encoding/json"
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/rules"
)

// clutchInst is one in-flight 1vN instance (solo SteamID is the map key).
type clutchInst struct {
	team    string
	size    int // opponents alive when the instance started
	start   int // tick of the kill that made them solo
	hp0     int // the solo's HP at start — sampled (seedHP), never assumed 100
	kills   []int
	dmgTook int // damage the solo took strictly after start
}

// Clutches detects 1vN clutches by walking each counted round's events
// and maintaining per-team alive sets (clutch v2). sides carries the extractor's
// exact per-round side samples; a round without them has no player with a
// known side, so no clutch instance starts there.
//
// An instance starts the moment a side transitions INTO exactly one alive
// player while the opposing side still has ≥ 1 alive: start = the tick of
// the kill that made them solo, size = opponents alive at that moment.
// Instances are tracked per solo player, so sequential transitions (a 2v1
// whose survivor is joined by nothing, or a 2v1 that becomes a 1v1 on the
// other side) each yield their own record. An instance resolves when the
// solo dies (lost) or the last opponent dies (won); instances still open
// at round end take the round winner as their outcome (bomb/timeout edges).
// HPLeft is the solo's remaining HP when the clutch resolved: the
// game-sampled victim-health of the last player_hurt at/before the
// resolve tick (HP changes only through player_hurt, so the value is
// exact — Compute stamps detail_json onto the typed event copies via
// store.GetHurtHealthDetails), falling back to damage arithmetic for
// rows without that detail, with a DEAD solo reading 0 (never clamped
// up to 1). Still a reconstruction rather than an HP sample AT the
// resolve event (no such event exists) — badge. BombState is read from
// bomb events up to the start tick (planted|carried|dropped). KillTicks
// is the JSON array of the solo's kills after the start; ReplayAnchor =
// StartTick.
func Clutches(events []models.Event, rounds []RoundInfo, players []PlayerRef, sides map[int]map[string]string) []Clutch {
	real := CountedRounds(rounds)
	if len(real) == 0 {
		return nil
	}
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		byRound[e.Round] = append(byRound[e.Round], e)
	}
	names := nameOf(players)

	var out []Clutch
	for _, r := range real {
		teamR := resolveRoundSides(sides, r.Number)
		alive := map[string]bool{}
		for _, p := range players {
			if p.SteamID != "" && (teamR[p.SteamID] == "ct" || teamR[p.SteamID] == "t") {
				alive[p.SteamID] = true
			}
		}
		active := map[string]*clutchInst{}
		roundEvents := byRound[r.Number]

		resolve := func(solo string, ac *clutchInst, endTick int, won, dead bool) {
			killTicks, _ := json.Marshal(ac.kills)
			hp := ac.hp0 - ac.dmgTook // fixture fallback: arithmetic over
			// damage rows that carry no health detail
			if h, ok := lastHurt(roundEvents, solo, endTick); ok {
				if v, ok := hurtHealth(h); ok {
					hp = v // sampled truth — HP changes only on player_hurt
				}
			}
			if dead {
				hp = 0 // a dead solo has no HP left — never clamped up to 1
			} else if hp < 1 {
				hp = 1 // alive implies ≥ 1 (safety vs overkill rounding)
			} else if hp > 100 {
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
				// Post-start damage on an active solo feeds HPLeft;
				// same-tick hits are in seedHP instead (tick ≤ start),
				// so every point counts exactly once.
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
					resolve(e.Victim, ac, e.Tick, false, true)
				}
				delete(alive, e.Victim)
				// Any remaining solo whose opponents are now all dead won.
				for solo, ac := range active {
					if opp, _ := countAlive(alive, teamR, rules.OtherSide(ac.team)); opp == 0 {
						resolve(solo, ac, e.Tick, true, false)
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
					active[solo] = &clutchInst{team: side, size: opp, start: e.Tick, hp0: seedHP(roundEvents, solo, e.Tick)}
				}
			}
		}
		// Still open at round end: the round winner decides the outcome
		// (the solo is alive — a dead one resolved at their own death).
		for solo, ac := range active {
			won := r.Winner != "" && r.Winner == ac.team
			resolve(solo, ac, r.EndTick, won, false)
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

// lastHurt returns the player_hurt on solo with the greatest tick at or
// before tick (a later seq wins a same-tick tie) — the row whose
// detail_json.health is the victim's exact remaining health after that
// hit. HP changes only through player_hurt (no regeneration), so that
// value is the victim's health for the whole window (hit, tick].
func lastHurt(roundEvents []models.Event, solo string, tick int) (models.Event, bool) {
	var best models.Event
	found := false
	for i := range roundEvents {
		e := roundEvents[i]
		if e.Kind != models.EventDamage || e.Victim != solo || e.Tick > tick {
			continue
		}
		if !found || e.Tick >= best.Tick {
			best, found = e, true
		}
	}
	return best, found
}

// seedHP reports the solo's health at the clutch's start tick: the
// sampled victim-health of the last player_hurt at/before it (the game's
// own value — full health when untouched), or, for rows without that
// detail (synthetic fixtures), 100 − the pre-start damage. Hits AT the
// start tick land here — dmgTook accumulates strictly tick > start — so
// every point of damage is counted exactly once.
func seedHP(roundEvents []models.Event, solo string, start int) int {
	if h, ok := lastHurt(roundEvents, solo, start); ok {
		if hp, ok := hurtHealth(h); ok {
			return hp
		}
		pre := 0
		for i := range roundEvents {
			e := roundEvents[i]
			if e.Kind == models.EventDamage && e.Victim == solo && e.Tick <= start {
				pre += e.Dmg
			}
		}
		return 100 - pre
	}
	return 100 // untouched this round — rounds reset HP to 100
}

// hurtHealth reads the victim's remaining health the extractor stored on
// a player_hurt event (detail_json.health); false when the row carries
// no parseable detail (synthetic fixtures).
func hurtHealth(e models.Event) (int, bool) {
	if e.DetailJSON == "" {
		return 0, false
	}
	var d struct {
		Health *int `json:"health"`
	}
	if err := json.Unmarshal([]byte(e.DetailJSON), &d); err != nil || d.Health == nil {
		return 0, false
	}
	return *d.Health, true
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
