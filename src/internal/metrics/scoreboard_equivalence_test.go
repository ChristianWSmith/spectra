package metrics

import (
	"fmt"
	"math"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// Value-equivalence proof (design §3.4 acceptance): the seeded metric
// rows a converted scoreboard cell renders must equal the columns today's
// scoreboard serves — the semantic proof the conversion moves no number
// (apart from Q1's ruled zero-denominator edge). Two corpora, because
// they prove different halves:
//
//   - TestFixtureCorpusScoreboardEquivalence runs the committed corpus
//     (testdata/seed.sql) at the SCOREBOARD's grain (scope match:<id>):
//     kast == kastPerMatchSQL and hs_pct == the stored ps.hs_pct hold
//     exactly. adr's stored column cannot serve as its oracle THERE —
//     seed.sql's adr column is an independent hand-written gradient
//     (player_stats carries total_damage=100 while the column says 55),
//     so that corpus pins adr against extract's FORMULA — damage ÷ the
//     match's counted rounds (the seed carries it as the `rounds`
//     denominator) — and the stored-column adr proof runs on the
//     extract-shaped corpus below.
//   - TestExtractShapedScoreboardEquivalence builds the corpus extract
//     actually writes (ADR = total_damage ÷ the match's counted rounds —
//     extract/build.go; HSPct = 100·hs/k — extract/helpers.go pct) and
//     proves the stored-column seeds (adr, hs_pct, kast) equal the
//     columns GetScoreboard serves — plus the kd seed against the
//     store's FLOORED per-match spelling, where Q1's one
//     deliberate divergence lives (zero deaths: ratio's NULLIF → value 0
//     beside N, where the floor MAX(deaths, 1) → the kill count) — and
//     the kda seed (w13d's conversion) against the FLOORED arithmetic
//     GetScoreboard's retired `kda` alias used to serve
//     ((kills+assists)/MAX(deaths, 1)). The floored seed CLOSES Q1's
//     edge for KDA: max(sum(deaths), 1) floors the denominator exactly
//     like that spelling, so the zero-death subject agrees on both
//     sides instead of diverging.

// seedDef reads a schema-seeded builtin's DEFINITION (its statement) from
// the store — the SEED is what these tests prove, never a test-local copy.
func seedDef(t *testing.T, st *store.Store, name string) string {
	t.Helper()
	res, err := st.RunReadOnly(`SELECT expr FROM metrics WHERE name = ?`, []any{name}, 1, 5000)
	if err != nil {
		t.Fatalf("read seed %q: %v", name, err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("seed %q: %d rows, want 1", name, len(res.Rows))
	}
	return res.Rows[0][0].(string)
}

// previewAt runs one seeded statement at the given scope (the scoreboard's
// grain) and keys the rows by subject.
func previewAt(t *testing.T, st *store.Store, expr string, scope string) map[string]float64 {
	t.Helper()
	// One row per subject (no dims in these seeds).
	out := map[string]float64{}
	for _, r := range rawPreviewRows(t, st, expr, scope) {
		out[r.SubjectKey] = rawValue(r)
	}
	return out
}

// oracle runs one independent plain-SQL oracle over the store (the
// test's own query — no engine code involved).
func oracle(t *testing.T, st *store.Store, q string, args ...any) map[string]float64 {
	t.Helper()
	res, err := st.RunReadOnly(q, args, 500, 5000)
	if err != nil {
		t.Fatalf("oracle %q: %v", q, err)
	}
	out := map[string]float64{}
	for _, r := range res.Rows {
		out[r[0].(string)] = toFloat(r[1])
	}
	return out
}

// TestMissedTradesEquivalence is the W2a acceptance oracle for the
// Combat "Missed trades" column's seed (design §6.3): missed_trades ==
// GetCombatStats' TradeOppMissed rule — the stored per-match counts
// folded over the match's human roster, a missing row reading 0
// (analytics.go: SELECT steam_id, missed FROM match_trade_opps, then
// tradeOpp[sid] with the absent→0 fold). Originally two layers: the
// plain-SQL spelling of the rule and the Go fold itself. Layer 2 was
// dropped when W2b removed TradeOppMissed from models.CombatStat
// (adoption-means-migration — the Go side no longer exists to
// compare against); layer 1, the SQL rule, outlives the Go code and
// remains the whole oracle.
func TestMissedTradesEquivalence(t *testing.T) {
	st := seededStore(t)
	seed := seedDef(t, st, "missed_trades")
	for _, matchID := range []int64{1, 2, 3} {
		scope := "match:" + itoa(matchID)
		t.Run(scope, func(t *testing.T) {
			got := previewAt(t, st, seed, scope)
			// GetCombatStats' rule spelled in plain SQL: the human
			// roster (base query's INNER players join + is_bot = 0)
			// LEFT JOINed to the stored counts, missing → 0.
			// A roster player with no trade-opportunity row has no data:
			// the statement's SUM is NULL and the cell is a dash, not 0
			// The oracle keeps that NULL.
			res, err := st.RunReadOnly(
				`SELECT ps.steam_id, mo.missed
				 FROM player_stats ps
				 JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id
				 LEFT JOIN match_trade_opps mo ON mo.match_id = ps.match_id AND mo.steam_id = ps.steam_id
				 WHERE ps.match_id = ? AND p.is_bot = 0`,
				[]any{matchID}, 500, 5000)
			if err != nil {
				t.Fatalf("oracle: %v", err)
			}
			if len(res.Rows) == 0 {
				t.Fatal("oracle returned no roster rows")
			}
			if len(got) != len(res.Rows) {
				t.Errorf("preview rows = %d, roster rows = %d", len(got), len(res.Rows))
			}
			for _, r := range res.Rows {
				sid := r[0].(string)
				gotV, ok := got[sid]
				if !ok {
					t.Errorf("missed_trades: subject %s missing from the preview", sid)
					continue
				}
				if r[1] == nil {
					if !math.IsNaN(gotV) {
						t.Errorf("missed_trades[%s] = %v, want NULL (no trade-opportunity rows)", sid, gotV)
					}
					continue
				}
				if want := toFloat(r[1]); gotV != want {
					t.Errorf("missed_trades[%s] = %v, want GetCombatStats' TradeOppMissed rule %v", sid, gotV, want)
				}
			}
		})
	}
}

// itoa formats a match id for a scope string.
func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// TestCareerOpeningEquivalence is the opening-duel trio's acceptance
// oracle (design addendum I9): the three profile seeds equal the raw
// per-player sums over player_stats — openings =
// Σ(entry_kills + entry_deaths), opener_wins = Σ(entry_kills),
// each with the seed's own subject addressing (a non-empty `steam_id`
// beside the humans-only NOT EXISTS over players, computed here as an
// independent plain-SQL oracle instead of the career rollup whose
// derived columns the dual-write removal deleted) — and the rate equals
// the EXACT percentage the Opening duels card computed (profileservice's
// 100 × opener_wins / openings, guarded to plain 0 when a career has no
// duels — that field died with the card in W3a, which is why the formula
// is spelled here) — the number the conversion must not move.
func TestCareerOpeningEquivalence(t *testing.T) {
	st := seededStore(t)
	openings := careerPreview(t, st, seedDef(t, st, "career_openings"))
	wins := careerPreview(t, st, seedDef(t, st, "career_opener_wins"))
	rate := careerPreview(t, st, seedDef(t, st, "career_opening_rate"))
	if len(openings) != 8 || len(wins) != 8 || len(rate) != 8 {
		t.Fatalf("preview rows = %d/%d/%d, want 8 subjects each (%v/%v/%v)", len(openings), len(wins), len(rate), openings, wins, rate)
	}
	humansOnly := ` WHERE steam_id <> ''
		AND NOT EXISTS (SELECT 1 FROM players p
			WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)`
	wantOpen := oracle(t, st,
		`SELECT steam_id, SUM(entry_kills + entry_deaths) FROM player_stats`+humansOnly+
			` GROUP BY steam_id`)
	wantWins := oracle(t, st,
		`SELECT steam_id, SUM(entry_kills) FROM player_stats`+humansOnly+
			` GROUP BY steam_id`)

	for i := 1; i <= 8; i++ {
		sid := fmt.Sprintf("7656119800000000%d", i)
		if openings[sid] != wantOpen[sid] {
			t.Errorf("career_openings[%s] = %v, want SUM(entry_kills + entry_deaths) = %v",
				sid, openings[sid], wantOpen[sid])
		}
		if wins[sid] != wantWins[sid] {
			t.Errorf("career_opener_wins[%s] = %v, want SUM(entry_kills) = %v",
				sid, wins[sid], wantWins[sid])
		}
		// The card's own formula over the re-based numbers: its guard
		// shows plain 0 where the metric shows 0 beside N — the same
		// displayed number.
		wantPct := 0.0
		if wantOpen[sid] > 0 {
			wantPct = 100 * wantWins[sid] / wantOpen[sid]
		}
		if rate[sid]*100 != wantPct {
			t.Errorf("career_opening_rate[%s] ×100 = %v, want the Opening-duels card's %v", sid, rate[sid]*100, wantPct)
		}
	}
}

// TestUntradedDeathsEquivalence is the victim-side count's acceptance
// oracle (design addendum I20): the seed equals, subject for subject,
// the SQL the Combat tab's Untraded deaths column read before it
// converted (GetCombatStats' GROUP BY b_steam over the untraded
// engagements) at every fixture match — a victim-side subject with no
// untraded duel reads 0 from its own rows (never a missing row, never a
// fabricated one).
func TestUntradedDeathsEquivalence(t *testing.T) {
	st := seededStore(t)
	seed := seedDef(t, st, "untraded_deaths")
	for _, matchID := range []int64{1, 2, 3} {
		scope := "match:" + itoa(matchID)
		t.Run(scope, func(t *testing.T) {
			got := previewAt(t, st, seed, scope)
			want := oracle(t, st,
				`SELECT b_steam, COUNT(*) FROM engagements
				 WHERE match_id = ? AND kind = 'untraded' GROUP BY b_steam`,
				matchID)
			if len(want) != 4 {
				t.Fatalf("oracle victims = %d, want 4 (the match's untraded victims)", len(want))
			}
			if len(got) != 8 {
				t.Errorf("preview rows = %d, want 8 (every roster player has victim-side rows)", len(got))
			}
			for sid, n := range want {
				if got[sid] != n {
					t.Errorf("untraded_deaths[%s] = %v, want the GROUP BY b_steam count %v", sid, got[sid], n)
				}
			}
			for sid, v := range got {
				if _, victim := want[sid]; !victim && v != 0 {
					t.Errorf("victim-side subject %s = %v, want 0 (its duels carry no untraded row)", sid, v)
				}
			}
		})
	}
}
