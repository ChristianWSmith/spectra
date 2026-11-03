package analytics

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/rules"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Compute runs the full analytics pass for one match: read rounds /
// economy / players / events from the store, derive the M3 rows under cfg,
// replace the per-match derived tables (one transaction each) and rebuild
// the player_career rollup (orchestration; the career rebuild
// is the cheap full-aggregate path — see store.RebuildCareer).
//
// player_stats.trade_kills is rewritten here from the same engagements
// pass (KindTrade per killer), so the frozen extractor column (import-time
// 5 s default) becomes cfg-aware for every consumer — the scoreboard
// Trade column, career trades, profile trade rate and the successful_trades
// metric — without touching their SQL.
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
	events, err := st.GetEvents(models.EventFilter{MatchID: matchID, Round: -1, Limit: store.MaxEventLimit})
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
			Weapon: er.Weapon, Headshot: er.Headshot, AssistedFlash: er.AssistedFlash,
			Distance: er.Distance, Dmg: er.Dmg, Site: er.Site,
			PosX: er.PosX, PosY: er.PosY, PosZ: er.PosZ,
		}
	}
	// Exact per-round sides from the extractor's freeze-end samples (new
	// imports); legacy matches fall back to RecoverSides + parity.
	sides, err := st.GetRoundPlayerSides(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load round sides: %w", err)
	}
	// Recover missing final sides from the enemy graph (players absent
	// from the final-state snapshot have Side "" in the store).
	players = RecoverSides(evs, rounds, players)
	// Legacy parity fallback: sides flip for rounds before the first
	// second-half round. The boundary index comes from the canonical
	// helper (rules.FlipIndexes — ceiling division; floor landed one
	// round early: with 23 counted rounds the second half starts at
	// index 12, not 11).
	if m.SideSwitches > 0 {
		real := CountedRounds(rounds)
		if flips := rules.FlipIndexes(len(real), m.SideSwitches); len(flips) > 0 {
			cfg.HalfSwitchRound = real[flips[0]].Number
		}
	}

	classes := Classify(eco, rounds, cfg)
	prs := PlayerRounds(evs, rounds, players, cfg, sides)
	clutches := Clutches(evs, rounds, players, cfg, sides)
	engs := Engagements(evs, rounds, cfg, players, sides)
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
	// The ONE trade-window rule's output: count the same engagements pass
	// (KindTrade per killer) into player_stats.trade_kills. Runs BEFORE
	// RebuildCareer so the career rollup aggregates the fresh column; the
	// extractor's import-time 5 s default is the seed this overwrites.
	tradeKills := map[string]int{}
	for _, e := range engs {
		if e.Kind == KindTrade {
			tradeKills[e.ASteam]++
		}
	}
	if err := st.ReplaceTradeKills(matchID, tradeKills); err != nil {
		return fmt.Errorf("analytics: replace trade kills: %w", err)
	}
	if err := st.ReplaceUtility(matchID, utils); err != nil {
		return err
	}
	if err := st.RebuildCareer(); err != nil {
		return fmt.Errorf("analytics: rebuild career: %w", err)
	}
	return nil
}
