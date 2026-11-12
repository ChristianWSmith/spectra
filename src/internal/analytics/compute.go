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
// player_stats.trade_kills is rewritten here from the same engagements
// pass (KindTrade per killer), so the frozen extractor column (import-time
// 5 s default) becomes cfg-aware for every consumer — the scoreboard
// Trade column, career trades, profile trade rate and the successful_trades
// metric — without touching their SQL. match_trade_opps (the two
// distance-derived trade-opportunity counts, tradeopps.go) is written the
// same way: cfg.TradeOppDistance is applied HERE, at analyze time, and
// read back by store.GetCombatStats / store.CountPlayerTradeOpportunities.
//
// RULE STAMP: a successful pass ends by writing cfg.RuleVersion to
// matches.analyzed_rule_version (store.SetMatchRuleVersion — the one
// writer), and the zero-round no-op below stamps too: a match computed
// under this version is never left "behind". A FAILED pass never stamps —
// the previous stamp (0 = never) stays, so the match remains behind and
// retryable. The stamp is written LAST, after the career rebuild, so a
// stamped match means the whole pass committed.
//
// cfg.TickRate is filled from the match row when unset/<= 0. A match with
// no extracted rounds is a no-op (not an error). Errors name the failing
// stage.
func Compute(st *store.Store, matchID int64, cfg Config) error {
	return compute(st, matchID, cfg, true)
}

// ComputeForBatch is Compute's bulk twin: identical reads, derives,
// replaces and rule stamp, but it does NOT rebuild player_career — the
// caller rebuilds career ONCE after the whole batch instead, because a
// RebuildCareer is a full-library rollup (16-34 s per rebuild at 1,000
// matches — see the schema.sql Tier-1 index note; N per-match rebuilds
// would make a bulk re-run quadratic in library size).
//
// A caller MUST arrange that deferred final rebuild
// (AnalyticsService.RecomputeAll wires it through
// recomputeRunner.submitBatch, which runs it inside the compute slot
// after the batch's last member); skipping it leaves player_career stale
// until the next Compute (an import or a single recompute) or a match
// delete rebuilds it. A batch member whose own pass succeeds IS stamped
// even if the batch's deferred rebuild later fails (that failure rides
// the last member's analysis-done event) — the stamp asserts the match's
// own rows, not the cross-match rollup.
func ComputeForBatch(st *store.Store, matchID int64, cfg Config) error {
	return compute(st, matchID, cfg, false)
}

// compute is the shared body of Compute / ComputeForBatch; the
// rebuildCareer flag is the ONE difference between them (see the two
// wrappers' docs).
func compute(st *store.Store, matchID int64, cfg Config, rebuildCareer bool) error {
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
	events, err := st.GetEvents(models.EventFilter{MatchID: matchID, Limit: store.MaxEventLimit})
	if err != nil {
		return fmt.Errorf("analytics: load events: %w", err)
	}
	players, err := st.GetPlayerRefs(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load players: %w", err)
	}
	// EventRow → Event (the typed columns only — payloads stay in SQLite;
	// models.EventFromRow is the one conversion).
	evs := make([]models.Event, len(events))
	for i, er := range events {
		evs[i] = models.EventFromRow(er)
	}
	// Blind payloads are the ONE exception, read narrowly (kind='blind'
	// only, keyed by seq): utility_events.flash_ms needs the extractor's
	// flashDurationMs, which EventRow deliberately never carries.
	blindDetails, err := st.GetBlindFlashDetails(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load blind details: %w", err)
	}
	// player_hurt payloads are the second narrow read (same reason, same
	// boundary): the clutch HPLeft reconstruction needs the game's
	// sampled victim health (detail_json.health) — stamped onto the
	// typed copies below so Clutches reads one shape (detail_json) in
	// production and in tests alike.
	hurtDetails, err := st.GetHurtHealthDetails(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load hurt details: %w", err)
	}
	for i, er := range events {
		if det, ok := hurtDetails[er.Seq]; ok {
			evs[i].DetailJSON = det
		}
	}
	// Exact per-round sides from the extractor's freeze-end samples; a
	// round without stored sides produces no side-derived rows.
	sides, err := st.GetRoundPlayerSides(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load round sides: %w", err)
	}

	classes := Classify(eco, rounds, cfg)
	prs := PlayerRounds(evs, rounds, players, cfg, sides)
	clutches := Clutches(evs, rounds, players, sides)
	engs := Engagements(evs, rounds, cfg, players, sides)
	utils := Utility(evs, players, cfg, blindDetails)

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
	// Trade-opportunity counts — the ONE writer of match_trade_opps
	// (AGENTS.md "Analysis-rule derived values": every rules-derived
	// value is STORED at analyze time; this file's tradeopps.go is the
	// single predicate implementation, replacing two query-time
	// json_extract gates). Both counts gate on cfg.TradeOppDistance, so
	// a distance change bumps rule_version (SetConfig) → the match goes
	// behind → RecomputeAll rewrites these rows under the new radius.
	// Runs in Compute AND ComputeForBatch (shared body) and BEFORE the
	// career rebuild like every other per-match write. The targeted
	// nearDist read is the narrow payload side channel (kill payloads;
	// models.EventRow stays payload-free). Each table's transaction
	// commits independently — a failed pass never stamps (RULE STAMP
	// note above), so the next run rewrites every table; no cross-table
	// rollback exists or is needed.
	kills, err := st.GetKillNearDists(matchID)
	if err != nil {
		return fmt.Errorf("analytics: load kill near dists: %w", err)
	}
	opps, missed := tradeOppCounts(kills, rounds, sides, engs, players, cfg.TradeOppDistance)
	if err := st.ReplaceTradeOpps(matchID, opps, missed); err != nil {
		return fmt.Errorf("analytics: replace trade opps: %w", err)
	}
	if err := st.ReplaceUtility(matchID, utils); err != nil {
		return err
	}
	if rebuildCareer {
		if err := st.RebuildCareer(); err != nil {
			return fmt.Errorf("analytics: rebuild career: %w", err)
		}
	}
	// The stamp lands last (see the RULE STAMP note): only a pass that
	// reached here — every replace committed, and the career rebuild when
	// this path owns it — claims the rule version.
	if err := st.SetMatchRuleVersion(matchID, cfg.RuleVersion); err != nil {
		return fmt.Errorf("analytics: stamp rule version: %w", err)
	}
	return nil
}
