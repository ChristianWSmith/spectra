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
//	opening   the round's first kill (a = killer, b = victim; suicides
//	          excluded)
//	trade     a kill whose VICTIM is the player who killed one of the
//	          killer's teammates ≤ cfg.TradeWindowS earlier (the strict
//	          HLTV rule — mirrors KAST "T" and the extractor's
//	          player_stats.trade_kills). Only ENEMY kills participate:
//	          teamkills neither anchor a trade nor count as one (the
//	          extractor's gate — a teamkill death writes no trade
//	          record there).
//	untraded  a death NOT answered: no teammate of the victim killed the
//	          victim's killer within cfg.TradeWindowS after the death
//	          (a = killer, b = victim)
//
// The KindTrade row is THE trade-window rule (one owner):
// analytics.Compute derives player_stats.trade_kills from these rows, so
// the scoreboard Trade column, career trades, profile trade rate and the
// successful_trades metric all follow cfg.TradeWindowS too.
// One kill can yield multiple rows (kinds are independent detections: the
// first kill can also be untraded later classified per victim, a trade
// kill's victim can themselves go untraded). Warmup and pregame rounds are
// skipped; kills with an unknown-side killer or victim are skipped (team
// attribution uses the per-round sides — sides carries the extractor's
// exact samples, nil for legacy matches where final-side parity applies).
func Engagements(events []models.Event, rounds []RoundInfo, cfg Config, players []PlayerRef, sides map[int]map[string]string) []Engagement {
	real := CountedRounds(rounds)
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
		tick      int
		side      string // side of the DEATH's victim
		killerKey string // who killed them (the trade target)
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
		teamR := resolveRoundSides(sides, team, cfg, r.Number)
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
			// Trade: the victim is the player who killed one of the
			// killer's teammates within the window (strict HLTV rule).
			// Enemy kills only — a teamkill never answers a death (the
			// extractor writes no trade record for one).
			isTrade := false
			if kt != vt {
				for _, d := range deaths {
					if d.killerKey == e.Victim && d.side == kt && e.Tick-d.tick <= window {
						isTrade = true
						break
					}
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
			// Anchor records feed ONLY trade detection: an enemy kill
			// (teamkills/suicides excluded) whose victim may later be
			// traded.
			if kt != vt {
				deaths = append(deaths, deathRec{tick: e.Tick, side: vt, killerKey: e.Attacker})
			}
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
