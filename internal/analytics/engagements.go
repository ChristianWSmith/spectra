package analytics

import (
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Engagement kinds produced by v1. The entry kind is
// DEFERRED: extractor player_stats.entry_kills already carries per-player
// entry attribution, and a position-based "committed onto site" rule needs
// map packs the pure pass does not own (documented re-scope).
const (
	KindOpening  = "opening"
	KindTrade    = "trade"
	KindUntraded = "untraded"
)

// Engagements detects per-round engagement events:
//
//	opening   the round's first kill (a = killer, b = victim)
//	trade     a kill by a player whose TEAMMATE died ≤ cfg.TradeWindowS
//	          before it (same window rule as the M1 extractor)
//	untraded  a death NOT answered: no teammate of the victim killed the
//	          victim's killer within cfg.TradeWindowS after the death
//	          (a = killer, b = victim)
//
// One kill can yield multiple rows (kinds are independent detections: the
// first kill can also be untraded later classified per victim, a trade
// kill's victim can themselves go untraded). Warmup rounds are skipped;
// kills with an unknown-side killer or victim are skipped (team
// attribution uses the final sides — events carry no team column).
//
// The rounds parameter exists beyond the sketch API to make warmup
// filtering possible (events carry no warmup flag).
func Engagements(events []models.Event, rounds []RoundInfo, cfg Config, players []PlayerRef) []Engagement {
	real := nonWarmupRounds(rounds)
	if len(real) == 0 {
		return nil
	}
	realSet := map[int]bool{}
	for _, r := range real {
		realSet[r.Number] = true
	}
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		if realSet[e.Round] {
			byRound[e.Round] = append(byRound[e.Round], e)
		}
	}
	team := teamOf(players)
	names := nameOf(players)
	window := cfg.ticks(cfg.TradeWindowS)

	type deathRec struct {
		tick int
		side string // side of the DEATH's victim
	}

	var out []Engagement
	emit := func(e models.Event, kind, aSteam, bSteam, wonBy string) {
		out = append(out, Engagement{
			Tick:     e.Tick,
			Round:    e.Round,
			Kind:     kind,
			ASteam:   aSteam,
			AName:    names[aSteam],
			BSteam:   bSteam,
			BName:    names[bSteam],
			Distance: e.Distance,
			WonBy:    wonBy,
		})
	}

	for _, r := range real {
		teamR := sideMapForRound(team, cfg, r.Number)
		roundEvents := byRound[r.Number]
		var deaths []deathRec
		firstKillDone := false
		for _, e := range roundEvents {
			// Suicides (attacker == victim) are not engagements.
			if e.Kind != models.EventKill || e.Victim == "" || e.Attacker == "" || e.Attacker == e.Victim {
				continue
			}
			kt, vt := teamR[e.Attacker], teamR[e.Victim]
			if kt == "" || vt == "" {
				continue
			}
			if !firstKillDone {
				firstKillDone = true
				emit(e, KindOpening, e.Attacker, e.Victim, kt)
			}
			// Trade: the killer's teammate died within the window before
			// this kill.
			isTrade := false
			for _, d := range deaths {
				if d.side == kt && e.Tick-d.tick <= window {
					isTrade = true
					break
				}
			}
			if isTrade {
				emit(e, KindTrade, e.Attacker, e.Victim, kt)
			}
			// Untraded: no teammate of the victim killed the killer within
			// the window after this death.
			untraded := true
			for _, later := range roundEvents {
				if later.Kind != models.EventKill || later.Tick <= e.Tick || later.Tick-e.Tick > window {
					continue
				}
				if later.Victim == e.Attacker && teamR[later.Attacker] == vt {
					untraded = false
					break
				}
			}
			if untraded {
				emit(e, KindUntraded, e.Attacker, e.Victim, kt)
			}
			deaths = append(deaths, deathRec{tick: e.Tick, side: vt})
		}
	}
	// Stable order: round, tick, kind.
	kindOrder := map[string]int{KindOpening: 0, KindTrade: 1, KindUntraded: 2}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Round != out[j].Round {
			return out[i].Round < out[j].Round
		}
		if out[i].Tick != out[j].Tick {
			return out[i].Tick < out[j].Tick
		}
		return kindOrder[out[i].Kind] < kindOrder[out[j].Kind]
	})
	return out
}
