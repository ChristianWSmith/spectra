package analytics

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Compute runs the full analytics pass for one match: read rounds /
// economy / players / events from the store, derive the M3 rows under cfg,
// replace the per-match derived tables (one transaction each) and rebuild
// the player_career rollup (orchestration; the career rebuild
// is the cheap full-aggregate path — see store.RebuildCareer).
//
// cfg.TickRate is filled from the match row when unset/<= 0. A match with
// no extracted rounds is a no-op (not an error). Errors name the failing
// stage.
func Compute(st *store.Store, matchID int64, cfg Config) error {
	m, err := st.GetMatch(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load match %d: %w", matchID, err)
	}
	if cfg.TickRate <= 0 {
		cfg.TickRate = m.TickRate
	}
	rounds, err := st.GetRoundInfos(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load rounds: %w", err)
	}
	eco, err := st.GetRoundEconomyViews(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load economy: %w", err)
	}
	events, err := st.GetEvents(models.EventFilter{MatchID: matchID, Round: -1, Limit: 100000})
	if err != nil {
		return fmt.Errorf("analytics: load events: %w", err)
	}
	players, err := st.GetPlayerRefs(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load players: %w", err)
	}
	// EventRow → Event (the typed columns only — payloads stay in SQLite).
	evs := make([]models.Event, len(events))
	for i, er := range events {
		evs[i] = models.Event{
			Seq: er.Seq, Tick: er.Tick, Round: er.Round, Kind: er.Kind,
			Attacker: er.Attacker, Victim: er.Victim, Assister: er.Assister,
			Weapon: er.Weapon, Headshot: er.Headshot, Distance: er.Distance,
			Dmg: er.Dmg, Site: er.Site, PosX: er.PosX, PosY: er.PosY, PosZ: er.PosZ,
		}
	}
	// Recover missing final sides from the enemy graph (players absent
	// from the final-state snapshot have Side "" in the store).
	players = RecoverSides(evs, rounds, players)
	// Side-switch parity: sides flip for rounds before the first
	// second-half round (MR12: 12 rounds per half; OT not special-cased).
	if m.SideSwitches > 0 {
		real := nonWarmupRounds(rounds)
		idx := len(real) / (m.SideSwitches + 1)
		if idx > 0 && idx < len(real) {
			cfg.HalfSwitchRound = real[idx].Number
		}
	}

	classes := Classify(eco, rounds, cfg)
	prs := PlayerRounds(evs, rounds, players, cfg)
	clutches := Clutches(evs, rounds, players, cfg)
	engs := Engagements(evs, rounds, cfg, players)
	utils := Utility(evs, players, cfg)

	// Replace* take matchID as their own argument (rows stay unstamped —
	// the MatchID column is written from the parameter).
	if err := st.ReplaceRoundClassifications(matchID, classes); err != nil {
		return err
	}
	if err := st.ReplacePlayerRounds(matchID, prs); err != nil {
		return err
	}
	if err := st.ReplaceClutches(matchID, clutches); err != nil {
		return err
	}
	if err := st.ReplaceEngagements(matchID, engs); err != nil {
		return err
	}
	if err := st.ReplaceUtility(matchID, utils); err != nil {
		return err
	}
	if err := st.RebuildCareer(); err != nil {
		return fmt.Errorf("analytics: rebuild career: %w", err)
	}
	return nil
}
