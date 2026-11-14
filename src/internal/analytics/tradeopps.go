package analytics

import (
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Trade-opportunity counts: the two distance-derived per-player metrics
// of one match, stored in match_trade_opps by Compute (owner ruling
// 2026-11-12 — AGENTS.md "Analysis-rule derived values": every
// rules-derived value is STORED at analyze time; read-time thresholding
// of rule outputs is forbidden). This file is the ONE implementation of
// both predicates; store.GetCombatStats reads the stored numbers back
// (the library-wide SUM the profile's Trade rate card used to need left
// with that card's metric conversion in dogfooding W4).
//
// Both counts replicate, exactly, the two query-time SQL derivations
// retired on 2026-11-12 — kept verbatim as reference oracles in
// tradeopps_equivalence_test.go, which pins stored == oracle on
// synthetic fixtures:
//
//   - opps (the retired store.CountPlayerTradeOpportunities — an
//     O(library) scan per profile open, 8.16 s @1k / 77.9 s @10k
//     matches): for
//     each kill d of the match where
//       · d.kind = 'kill', attacker <> '' and attacker <> victim
//         (world kills and suicides excluded);
//       · d.round exists in rounds (every stored round is counted —
//         knife/warmup rounds are discarded at ingest);
//       · attacker AND victim both have a freeze-end side sample for
//         that round (round_player_sides EXISTS), both in {ct,t}, and
//         the two differ (enemy kill);
//       · d's OWN detail_json.nearDist is within [0, distance]
//         (HasNear && 0 <= near <= distance — BETWEEN is inclusive on
//         both ends, 0 and the exact radius included);
//     count d once for every HUMAN player P where
//       · P has a side sample that round EQUAL to the victim's side
//         (missing sample ≠ equal — a player without a sample never
//         counts; a player on the attacker's side never counts);
//       · P <> d.victim (the victim's own death is never his
//         opportunity);
//       · P was ALIVE at the death tick: no kill in THAT round has
//         victim = P and tick <= d.tick (round-scoped, as the SQL's
//         `pd.round = d.round` was — a death in an earlier round does
//         not make P unavailable in this one).
//
//   - missed (was GetCombatStats' TradeOppMissed subquery): for each
//     engagement of the match with kind = 'untraded' and b_steam <> '',
//     find the paired kill event — same tick, attacker = a_steam,
//     victim = b_steam, the FIRST such row in events.id order (the SQL's
//     LIMIT 1) — and count 1 for b_steam when that kill's nearDist is
//     within [0, distance]. Engagements are shared input (the pass that
//     wrote match_trade_opps' neighbors wrote them): a traded/opening
//     death never reaches this count.
//
// HUMANS ONLY: rows are written for is_bot = 0 players only. Both read
// surfaces drop bots anyway (GetCombatStats decision 5 — base rows are
// HumansOnly; profiles are human) — the retired queries computed a
// bot's count and then discarded it; it is simply not stored now
// (pinned by the equivalence test's bot case).
//
// Zero counts write no row (ReplaceTradeOpps is sparse): a match with
// nothing to count — a zero-round match, or every gate unmet — leaves no
// rows, and every read treats "no row" as 0.

// tradeOppCounts derives opps and missed per human player of one match
// under distance (cfg.TradeOppDistance, world units) — see the file
// comment for the exact predicates and their retired-SQL provenance.
// Input: the match's kills with their nearDist payloads (events.id
// order), its rounds, the freeze-end side samples, the just-computed
// engagements pass, and the roster.
func tradeOppCounts(
	kills []store.KillNearDist,
	rounds []models.RoundInfo,
	sides map[int]map[string]string,
	engs []models.Engagement,
	players []models.PlayerRef,
	distance int,
) (opps, missed map[string]int) {
	// The [0, distance] BETWEEN, inclusive on both ends (0 and the exact
	// radius count; HasNear covers the NULL cases — malformed payload,
	// missing key, non-numeric value).
	inRange := func(near float64, has bool) bool {
		return has && near >= 0 && near <= float64(distance)
	}

	humans := map[string]bool{}
	for _, p := range players {
		if !p.IsBot && p.SteamID != "" {
			humans[p.SteamID] = true
		}
	}

	// Counted rounds that EXIST (the retired SQL joined rounds — a kill
	// whose round row is absent never counted). Every stored round is
	// counted (the extractor discards knife/warmup rounds at ingest), so
	// the set is just the round numbers.
	counted := map[int]bool{}
	for _, r := range rounds {
		counted[r.Number] = true
	}

	// Deaths per player per round (round-scoped aliveness for the
	// `NOT EXISTS pd.tick <= d.tick` check — every kill row counts,
	// whatever its nearDist).
	deaths := map[string]map[int][]int{}
	for _, k := range kills {
		if k.Victim == "" {
			continue
		}
		byRound := deaths[k.Victim]
		if byRound == nil {
			byRound = map[int][]int{}
			deaths[k.Victim] = byRound
		}
		byRound[k.Round] = append(byRound[k.Round], k.Tick)
	}
	deadAt := func(sid string, round, tick int) bool {
		for _, t := range deaths[sid][round] {
			if t <= tick {
				return true
			}
		}
		return false
	}

	opps = map[string]int{}
	for _, k := range kills {
		if !counted[k.Round] || k.Attacker == "" || k.Attacker == k.Victim {
			continue
		}
		ks, okKS := sides[k.Round][k.Attacker]
		vs, okVS := sides[k.Round][k.Victim]
		if !okKS || !okVS || (ks != "ct" && ks != "t") || (vs != "ct" && vs != "t") || ks == vs {
			continue
		}
		if !inRange(k.Near, k.HasNear) {
			continue
		}
		for sid := range humans {
			if sid == k.Victim || sides[k.Round][sid] != vs || deadAt(sid, k.Round, k.Tick) {
				continue
			}
			opps[sid]++
		}
	}

	// The paired kill for an untraded engagement: first row in events.id
	// order per (tick, attacker, victim) — the retired subquery's LIMIT 1.
	type killKey struct {
		tick     int
		attacker string
		victim   string
	}
	firstKill := map[killKey]store.KillNearDist{}
	for _, k := range kills {
		key := killKey{k.Tick, k.Attacker, k.Victim}
		if _, ok := firstKill[key]; !ok {
			firstKill[key] = k
		}
	}
	missed = map[string]int{}
	for _, e := range engs {
		if e.Kind != KindUntraded || e.BSteam == "" || !humans[e.BSteam] {
			continue
		}
		if k, ok := firstKill[killKey{e.Tick, e.ASteam, e.BSteam}]; ok && inRange(k.Near, k.HasNear) {
			missed[e.BSteam]++
		}
	}
	return opps, missed
}
