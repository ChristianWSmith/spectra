package analytics

// Equivalence characterization for the STORED trade-opportunity counts
// (match_trade_opps): analytics.Compute's derivation (tradeopps.go) must
// reproduce, number for number, the two RETIRED query-time SQL
// derivations kept below as reference oracles — legacy query-time
// derivation, retired 2026-11-12:
//
//   - legacyOppsSQL   was store.CountPlayerTradeOpportunities (the
//     profile's library-wide Trade-rate denominator — the O(library)
//     scan that measured 8.16 s @1k / 77.9 s @10k matches per profile
//     open and motivated storing the count);
//   - legacyMissedSQL was store.GetCombatStats' TradeOppMissed scalar
//     subquery (the Combat badge).
//
// This is the proof that moving the gate from read time to analyze time
// changed no number: every branch of the retired predicates is asserted
// stored == oracle at three radii (the 1000u default, a narrowed 200u,
// and 0 — the inclusive BETWEEN boundary on both ends), and a few
// hand-computed spot pins keep "both sides equally broken" from passing:
//
//   - in-range / exactly-at-the-radius / beyond-range / -1 sentinel /
//     missing key / malformed JSON / non-numeric / JSON true nearDist;
//   - victim-side vs attacker-side player, player with NO freeze-end
//     side sample (victim or candidate);
//   - a player already dead at/before the kill tick (round-scoped — a
//     death in an earlier round does not count against this one);
//   - untraded vs traded vs opening engagement rows (only 'untraded'
//     feeds missed) and the LIMIT-1 paired-kill join (duplicate kill
//     rows at one tick keep the FIRST row's nearDist);
//   - a kill whose rounds row does not exist — which is also how a
//     knife/warmup kill is rejected today (the extractor discards those
//     rounds at ingest, so their kills never reach events either) —,
//     teamkill, suicide, world kill, and the human-only write (the bot
//     earns opportunities in the oracle and stores none).

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// legacyOppsSQL is the RETIRED query-time derivation of one player's
// trade opportunities across the library (was
// store.CountPlayerTradeOpportunities — legacy query-time derivation,
// retired 2026-11-12). Verbatim reference oracle; params are
// sid, sid, sid, distance.
const legacyOppsSQL = `SELECT COUNT(*)
	 FROM events d
	 JOIN rounds rd ON rd.match_id = d.match_id AND rd.number = d.round
	 JOIN round_player_sides ks
	   ON ks.match_id = d.match_id AND ks.round = d.round AND ks.steam_id = d.attacker
	 JOIN round_player_sides vs
	   ON vs.match_id = d.match_id AND vs.round = d.round AND vs.steam_id = d.victim
	 WHERE d.kind = 'kill'
	   AND d.attacker <> '' AND d.attacker <> d.victim AND d.victim <> ?
	   AND ks.side IN ('ct','t') AND vs.side IN ('ct','t') AND ks.side <> vs.side
	   AND EXISTS (SELECT 1 FROM round_player_sides ps
	               WHERE ps.match_id = d.match_id AND ps.round = d.round
	                 AND ps.steam_id = ? AND ps.side = vs.side)
	   AND NOT EXISTS (SELECT 1 FROM events pd
	                   WHERE pd.match_id = d.match_id AND pd.round = d.round
	                     AND pd.kind = 'kill' AND pd.victim = ? AND pd.tick <= d.tick)
	   AND CASE WHEN json_valid(d.detail_json)
	            THEN json_extract(d.detail_json, '$.nearDist') END
	       BETWEEN 0 AND ?`

// legacyMissedSQL is the RETIRED query-time derivation of a match's
// "trade opportunities missed" per victim (was the scalar subquery in
// store.GetCombatStats — legacy query-time derivation, retired
// 2026-11-12). Verbatim reference oracle; params are matchID, distance.
const legacyMissedSQL = `SELECT e.b_steam, COUNT(*) FROM engagements e
	 WHERE e.match_id = ? AND e.kind = 'untraded' AND e.b_steam <> ''
	   AND (SELECT CASE WHEN json_valid(k.detail_json)
	                    THEN json_extract(k.detail_json, '$.nearDist') END
	        FROM events k
	        WHERE k.match_id = e.match_id AND k.kind = 'kill'
	          AND k.tick = e.tick AND k.attacker = e.a_steam
	          AND k.victim = e.b_steam
	        LIMIT 1) BETWEEN 0 AND ?
	 GROUP BY e.b_steam`

// tradeOppBotSteamID mirrors the synthetic 0xFF bot key shape
// (extract.isBotKey) — a 20-digit id that can never collide with a real
// SteamID64.
const tradeOppBotSteamID = "18374686479671623692"

// tradeOppFixture is a synthetic extract covering every branch of the
// retired predicates (see the file comment). Round 1 is the main matrix
// (alice "100" ct never fires a shot; bob "200" t is the killer), round
// 3 is counted but alice has NO side sample there, round 99 has a kill
// with no rounds row, and so do the round-0/round-2 kills (a
// knife/warmup round has no row either — the extract discard makes its
// kills unreachable in production, and the missing row is what rejects
// them here).
func tradeOppFixture() *models.ExtractedMatch {
	k := func(tick, round int, attacker, victim, detail string) models.Event {
		return models.Event{
			Tick: tick, Round: round, Kind: models.EventKill,
			Attacker: attacker, Victim: victim, DetailJSON: detail,
		}
	}
	return &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/tradeopps-equiv.dem", SHA256: "sha-tradeopps-equiv", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 4,
			ScoreCT: 3, ScoreT: 1, ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: true},
			{SteamID: "300", Name: "carl", Side: "ct", FinalStatePresent: true},
			{SteamID: "400", Name: "dave", Side: "ct", FinalStatePresent: true},
			{SteamID: "500", Name: "zed", Side: "ct", FinalStatePresent: true},  // no round-1 sample
			{SteamID: "600", Name: "ghost", Side: "t", FinalStatePresent: true}, // no round-1 sample
			{SteamID: "700", Name: "rae", Side: "t", FinalStatePresent: true},   // attacker-side player
			{SteamID: "800", Name: "fin", Side: "ct", FinalStatePresent: true},
			{SteamID: "900", Name: "nova", Side: "ct", FinalStatePresent: true},
			{SteamID: "910", Name: "nova2", Side: "ct", FinalStatePresent: true},
			{SteamID: tradeOppBotSteamID, Name: "bot", Side: "ct", IsBot: true, FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "alice", RoundsPlayed: 3},
			{SteamID: "200", Side: "t", Name: "bob", RoundsPlayed: 3},
			{SteamID: "300", Side: "ct", Name: "carl", RoundsPlayed: 3},
			{SteamID: "400", Side: "ct", Name: "dave", RoundsPlayed: 3},
			{SteamID: "500", Side: "ct", Name: "zed", RoundsPlayed: 3},
			{SteamID: "600", Side: "t", Name: "ghost", RoundsPlayed: 3},
			{SteamID: "700", Side: "t", Name: "rae", RoundsPlayed: 3},
			{SteamID: "800", Side: "ct", Name: "fin", RoundsPlayed: 3},
			{SteamID: "900", Side: "ct", Name: "nova", RoundsPlayed: 3},
			{SteamID: "910", Side: "ct", Name: "nova2", RoundsPlayed: 3},
			{SteamID: tradeOppBotSteamID, Side: "ct", Name: "bot", RoundsPlayed: 3},
		},
		Rounds: []models.Round{
			{Number: 1, Winner: "ct", StartTick: 64, EndTick: 7200, FreezeEndTick: 64},
			{Number: 3, Winner: "t", StartTick: 8400, EndTick: 15000, FreezeEndTick: 8464},
		},
		RoundSides: []models.RoundPlayerSide{
			// Rounds 0 and 2 have side samples but NO rounds row (they
			// stand in for discarded knife/warmup rounds): only the
			// missing round row can reject the kills below — the
			// oracle's rounds JOIN and tradeOppCounts' counted set both
			// drop them.
			{Round: 0, SteamID: "100", Side: "ct"},
			{Round: 0, SteamID: "200", Side: "t"},
			{Round: 0, SteamID: "300", Side: "ct"},
			// Round 1 (the matrix): alice/carl/dave/fin/nova/nova2/bot on
			// ct, bob/rae on t. zed ("500") and ghost ("600") are
			// DELIBERATELY absent — unknown side never counts.
			{Round: 1, SteamID: "100", Side: "ct"},
			{Round: 1, SteamID: "200", Side: "t"},
			{Round: 1, SteamID: "300", Side: "ct"},
			{Round: 1, SteamID: "400", Side: "ct"},
			{Round: 1, SteamID: "700", Side: "t"},
			{Round: 1, SteamID: "800", Side: "ct"},
			{Round: 1, SteamID: "900", Side: "ct"},
			{Round: 1, SteamID: "910", Side: "ct"},
			{Round: 1, SteamID: tradeOppBotSteamID, Side: "ct"},
			// Rounds 0/2 (standing in for discarded knife/warmup rounds):
			// sides known, only the missing round row rejects the kills.
			{Round: 2, SteamID: "100", Side: "ct"},
			{Round: 2, SteamID: "200", Side: "t"},
			{Round: 2, SteamID: "300", Side: "ct"},
			// Round 3 (counted): ONLY bob and carl have samples — alice
			// (and everyone else) can never earn an opportunity here.
			{Round: 3, SteamID: "200", Side: "t"},
			{Round: 3, SteamID: "300", Side: "ct"},
		},
		Events: []models.Event{
			// Round 1 — main matrix (alice candidates unless noted):
			k(100, 1, "200", "300", `{"nearDist":150}`),              // in range: +1 @1000/@200
			k(200, 1, "200", "400", `{"nearDist":500}`),              // beyond 200: +1 @1000 only
			k(300, 1, "200", "800", `{"nearDist":150}`),              // in range; carl+dave already dead here
			k(400, 1, "200", "600", `{"nearDist":150}`),              // VICTIM has no side sample → nobody
			k(500, 1, "700", "200", `{"nearDist":150}`),              // TEAMKILL (ks == vs) → nobody
			k(600, 1, "700", "700", `{"nearDist":150}`),              // SUICIDE (attacker == victim) → nobody
			k(650, 1, "200", tradeOppBotSteamID, `{"nearDist":150}`), // bot victim; alice +1; bot's own opps (oracle-only)
			k(700, 1, "200", "500", `{"nearDist":150}`),              // VICTIM has no side sample → nobody
			k(800, 1, "200", "900", `{"nearDist":200}`),              // EXACT radius: +1 @1000/@200 (BETWEEN is inclusive)
			k(900, 1, "200", "910", `{"nearDist":0}`),                // zero radius: +1 at EVERY gate incl. 0
			k(950, 1, "200", "100", `{"nearDist":150}`),              // alice is the VICTIM (and dead from here on)
			// Duplicate kill row, same (tick, attacker, victim) as the
			// first: opps counts EACH row with its own nearDist (+1
			// @1000 for alice), while missed's paired join keeps the
			// FIRST row in events.id order (LIMIT 1 → 150, never 500).
			k(100, 1, "200", "300", `{"nearDist":500}`),
			// Payload branches (all on an in-range-shaped victim):
			k(305, 1, "200", "900", `{not json`),          // malformed → json_valid → never counted
			k(306, 1, "200", "910", `{"killer":"x"}`),     // missing key → never counted
			k(307, 1, "200", "800", `{"nearDist":-1}`),    // -1 sentinel → below 0 → never counted
			k(308, 1, "200", "900", `{"nearDist":"150"}`), // TEXT → never satisfies BETWEEN
			k(309, 1, "200", "910", `{"nearDist":true}`),  // json_extract renders true as 1 → counted like 1
			k(310, 1, "200", "800", ""),                   // empty payload → json_valid('') = 0 → never counted
			// A kill with NO rounds row (round 99) never counts.
			k(9999, 99, "200", "300", `{"nearDist":150}`),
			// Rounds 0 and 2 stand in for discarded knife/warmup rounds:
			// sides known, only the missing round row rejects them.
			k(5, 0, "200", "300", `{"nearDist":150}`),
			k(7700, 2, "200", "300", `{"nearDist":150}`),
			// Round 3: alice has no side sample here (round-scoped
			// candidacy), and a fresh in-range teammate death nobody can
			// claim (only bob/carl have samples).
			k(9000, 3, "200", "300", `{"nearDist":150}`),
		},
	}
}

// TestTradeOppStoredMatchesLegacyQuery runs Compute under three radii
// and pins stored == retired-query oracle for both metrics on every
// roster player, plus the deliberate human-only divergence for the bot.
func TestTradeOppStoredMatchesLegacyQuery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "equivalence.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	id, err := st.CreateMatchRow("/d/tradeopps-equiv.dem", "sha-tradeopps-equiv", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, tradeOppFixture()); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	refs, err := st.GetPlayerRefs(id)
	if err != nil {
		t.Fatalf("GetPlayerRefs: %v", err)
	}

	// Second connection to the SAME file for the oracle SQL — the store
	// holds a single connection (pattern: compute_stamp_test's forced
	// mid-pass failure).
	db2, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("oracle connection: %v", err)
	}
	t.Cleanup(func() { _ = db2.Close() })

	oracleOpps := func(sid string, distance int) int {
		t.Helper()
		var n int
		if err := db2.QueryRow(legacyOppsSQL, sid, sid, sid, distance).Scan(&n); err != nil {
			t.Fatalf("legacyOppsSQL(%q, %d): %v", sid, distance, err)
		}
		return n
	}
	oracleMissed := func(distance int) map[string]int {
		t.Helper()
		rows, err := db2.Query(legacyMissedSQL, id, distance)
		if err != nil {
			t.Fatalf("legacyMissedSQL(%d): %v", distance, err)
		}
		defer rows.Close()
		out := map[string]int{}
		for rows.Next() {
			var sid string
			var n int
			if err := rows.Scan(&sid, &n); err != nil {
				t.Fatalf("legacyMissedSQL scan: %v", err)
			}
			out[sid] = n
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("legacyMissedSQL rows: %v", err)
		}
		return out
	}

	radii := []struct {
		name     string
		distance int
		// Hand-computed spot pins (see the fixture comments): alice's
		// opps and dave's missed at this radius — the oracle equality
		// alone could pass if both sides shared a bug.
		aliceOpps  int
		daveMissed int
	}{
		{name: "default 1000u", distance: 1000, aliceOpps: 8, daveMissed: 1},
		{name: "narrow 200u", distance: 200, aliceOpps: 6, daveMissed: 0},
		{name: "zero 0u", distance: 0, aliceOpps: 1, daveMissed: 0},
	}
	for _, tc := range radii {
		t.Run(tc.name, func(t *testing.T) {
			// Production shape: the config row and the Compute cfg carry
			// the same radius (RecomputeAnalysis reads GetConfig →
			// ConfigFrom).
			if _, err := st.SetConfig(models.AnalysisConfig{
				TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
				TradeOppDistance: tc.distance, RuleVersion: 1,
			}); err != nil {
				t.Fatalf("SetConfig(%d): %v", tc.distance, err)
			}
			cfg := ConfigFrom(models.AnalysisConfig{
				TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
				TradeOppDistance: tc.distance, RuleVersion: 1,
			}, 0)
			if err := Compute(st, id, cfg); err != nil {
				t.Fatalf("Compute(@%d): %v", tc.distance, err)
			}

			// --- opps: stored SUM == legacy oracle, per roster player.
			var botOracle int
			for _, p := range refs {
				want := oracleOpps(p.SteamID, tc.distance)
				got, err := st.CountPlayerTradeOpportunities(p.SteamID)
				if err != nil {
					t.Fatalf("CountPlayerTradeOpportunities(%q): %v", p.SteamID, err)
				}
				if p.IsBot {
					// Deliberate divergence (human-only writes): the
					// oracle counts the bot's opportunities, the stored
					// table must not — both read surfaces drop bots
					// anyway.
					botOracle = want
					if got != 0 {
						t.Errorf("bot stored opps = %d, want 0 (match_trade_opps is humans-only)", got)
					}
					continue
				}
				if got != want {
					t.Errorf("player %s opps: stored = %d, legacy oracle = %d (must be equal)", p.SteamID, got, want)
				}
			}
			// The bot's opportunities are all > 0u kills (it dies at t=650,
			// before the zero-radius kill), so the divergence is only
			// observable above 0 — pin the fixture strength there.
			if tc.distance > 0 && botOracle == 0 {
				t.Fatalf("fixture weak: the bot earns no opportunities in the oracle at %du", tc.distance)
			}
			if n, err := st.CountPlayerTradeOpportunities("999"); err != nil || n != 0 {
				t.Errorf("unknown player = %d, %v, want 0, nil", n, err)
			}

			// --- missed: stored GetCombatStats == legacy oracle, per
			// human base row (bots never reach the base rows — decision
			// 5 — while the oracle may list them; assert the fixture's
			// bot divergence explicitly).
			want := oracleMissed(tc.distance)
			got, err := st.GetCombatStats(id)
			if err != nil {
				t.Fatalf("GetCombatStats: %v", err)
			}
			byID := map[string]models.CombatStat{}
			for _, r := range got {
				byID[r.SteamID] = r
				if want[r.SteamID] != r.TradeOppMissed {
					t.Errorf("player %s missed: stored = %d, legacy oracle = %d (must be equal)",
						r.SteamID, r.TradeOppMissed, want[r.SteamID])
				}
			}
			if _, ok := byID[tradeOppBotSteamID]; ok {
				t.Error("bot reached the GetCombatStats base rows (decision 5 violated)")
			}
			if tc.distance >= 150 && want[tradeOppBotSteamID] == 0 {
				t.Fatalf("fixture weak: the bot's untraded in-range death never reaches the oracle at %du", tc.distance)
			}
			// Spot pins (hand-computed from the fixture): alice's OPPS
			// walk every branch (t100 orig+dup, t200, t300, t650, t800
			// exact-radius, t900 zero-radius, t309 JSON-true→1 = 8 @1000;
			// @200 drops the 500u dup and t200 = 6; @0 keeps only t900),
			// and dave's 500u death sits exactly on the narrow gate.
			if got, _ := st.CountPlayerTradeOpportunities("100"); got != tc.aliceOpps {
				t.Errorf("alice opps = %d, want %d (hand-computed)", got, tc.aliceOpps)
			}
			if got := byID["400"].TradeOppMissed; got != tc.daveMissed {
				t.Errorf("dave missed = %d, want %d (500u death vs the %du radius)", got, tc.daveMissed, tc.distance)
			}
		})
	}
}
