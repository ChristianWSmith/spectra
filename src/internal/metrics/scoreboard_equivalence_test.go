package metrics

import (
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
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
//     store's FLOORED per-match spelling (kdPerMatchSQL, test-only since
//     dogfooding W4 removed the scoreboard's kd column), where Q1's one
//     deliberate divergence lives (zero deaths: ratio's NULLIF → value 0
//     beside N, where the floor MAX(deaths, 1) → the kill count) — and
//     the kda seed (w13d's conversion) against the FLOORED arithmetic
//     GetScoreboard's retired `kda` alias used to serve
//     ((kills+assists)/MAX(deaths, 1)). The floored seed CLOSES Q1's
//     edge for KDA: max(sum(deaths), 1) floors the denominator exactly
//     like that spelling, so the zero-death subject agrees on both
//     sides instead of diverging.

// seedDef reads a schema-seeded builtin's DEFINITION (expression +
// denominator) from the store — the SEED is what these tests prove,
// never a test-local copy of it. The denominator is part of the proof:
// the `rounds` seeds only produce their values when the row's own
// denominator rides along.
func seedDef(t *testing.T, st *store.Store, name string) Def {
	t.Helper()
	res, err := st.RunReadOnly(`SELECT expr, denominator FROM metrics WHERE name = ?`, []any{name}, 1, 5000)
	if err != nil {
		t.Fatalf("read seed %q: %v", name, err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("seed %q: %d rows, want 1", name, len(res.Rows))
	}
	return Def{Expr: res.Rows[0][0].(string), Denominator: res.Rows[0][1].(string)}
}

// previewAt runs one seeded definition at the given scope (the
// scoreboard's grain) and keys the rows by subject.
func previewAt(t *testing.T, st *store.Store, def Def, scope string) map[string]float64 {
	t.Helper()
	if IsRawSQL(def.Expr) {
		// Raw seeds (ruling 22) run through the raw path; sugar has no
		// preview for them. One row per subject (no dims in these seeds).
		out := map[string]float64{}
		for _, r := range rawPreviewRows(t, st, def.Expr, scope) {
			out[r.SubjectKey] = rawValue(r)
		}
		return out
	}
	pv, perr, err := RunPreview(t.Context(), st, def, scope, 500)
	if perr != nil {
		t.Fatalf("parse %q: %v", def.Expr, perr)
	}
	if err != nil {
		t.Fatalf("run %q (scope %q): %v (sql: %s)", def.Expr, scope, err, pv.SQL)
	}
	out := make(map[string]float64, len(pv.Rows))
	for _, r := range pv.Rows {
		out[r.Group] = r.Value
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

// TestFixtureCorpusScoreboardEquivalence: on the committed fixture
// corpus, at per-match (scoreboard) scope —
//
//	kast  × 100 == kastPerMatchSQL (store/queries.go: the same
//	                100.0 × AVG(player_round_stats.kast) per match),
//	hs_pct × 100 == the stored ps.hs_pct column,
//	adr         == extract's formula (damage ÷ the match's counted
//	                rounds — the seed's `rounds` denominator;
//	                extract/build.go).
func TestFixtureCorpusScoreboardEquivalence(t *testing.T) {
	st := seededStore(t)
	kastDef := seedDef(t, st, "kast")
	hsDef := seedDef(t, st, "hs_pct")
	adrDef := seedDef(t, st, "adr")

	for _, matchID := range []int64{1, 2, 3} {
		scope := "match:" + itoa(matchID)
		t.Run(scope, func(t *testing.T) {
			// kast: metric (0..1 fraction) × 100 vs the store's
			// per-match KAST% spelling — this is the number the
			// scoreboard's KAST% column showed via combat stats.
			kast := previewAt(t, st, kastDef, scope)
			kastSQL := oracle(t, st,
				`SELECT steam_id, 100.0 * AVG(kast) FROM player_round_stats WHERE match_id = ? GROUP BY steam_id`,
				matchID)
			if len(kast) == 0 {
				t.Fatal("kast preview returned no rows")
			}
			for sid, v := range kastSQL {
				got, ok := kast[sid]
				if !ok {
					t.Errorf("kast: subject %s missing from the preview", sid)
					continue
				}
				if got*100 != v {
					t.Errorf("kast[%s] ×100 = %v, want kastPerMatchSQL %v", sid, got*100, v)
				}
			}

			// hs_pct: metric × 100 vs the stored column the
			// scoreboard's HS% cell served.
			hs := previewAt(t, st, hsDef, scope)
			stored := oracle(t, st,
				`SELECT steam_id, hs_pct FROM player_stats WHERE match_id = ?`,
				matchID)
			if len(hs) != len(stored) {
				t.Errorf("hs_pct preview rows = %d, stored rows = %d", len(hs), len(stored))
			}
			for sid, v := range stored {
				got, ok := hs[sid]
				if !ok {
					t.Errorf("hs_pct: subject %s missing from the preview", sid)
					continue
				}
				if got*100 != v {
					t.Errorf("hs_pct[%s] ×100 = %v, want stored hs_pct %v", sid, got*100, v)
				}
			}

			// adr: the corpus's stored adr column is NOT extract-shaped
			// (see the file header) — pin the seed against extract's
			// FORMULA, which is the identity extract itself guarantees:
			// damage ÷ the match's counted rounds (the seed's `rounds`
			// denominator over the fixture's 24 stored rounds per
			// match), never damage ÷ the rounds the player played.
			adr := previewAt(t, st, adrDef, scope)
			formula := oracle(t, st,
				`SELECT steam_id, 1.0 * SUM(total_damage) / NULLIF((SELECT COUNT(*) FROM rounds WHERE match_id = ?), 0)
				 FROM player_stats WHERE match_id = ? GROUP BY steam_id`,
				matchID, matchID)
			if len(adr) != len(formula) {
				t.Errorf("adr preview rows = %d, formula rows = %d", len(adr), len(formula))
			}
			for sid, v := range formula {
				got, ok := adr[sid]
				if !ok {
					t.Errorf("adr: subject %s missing from the preview", sid)
					continue
				}
				if got != v {
					t.Errorf("adr[%s] = %v, want extract's formula %v", sid, got, v)
				}
			}
		})
	}
}

// TestExtractShapedScoreboardEquivalence: on the corpus the EXTRACTOR
// writes (ADR/HSPct computed exactly as internal/extract computes them
// for a real demo), every scoreboard seed equals the column
// GetScoreboard serves — the stored-column proof the design's
// acceptance asks for (adr == stored ps.adr, hs_pct == stored hs_pct,
// kast == kastPerMatchSQL) — kd carries Q1's one ruled divergence, and
// kda (w13d) equals the retired floored arithmetic exactly, the
// zero-death subject included.
func TestExtractShapedScoreboardEquivalence(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "equivalence.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() {
		_ = st.CloseRO()
		_ = st.Close()
	})
	id, err := st.CreateMatchRow("/d/equivalence.dem", "sha-equivalence", 4096)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}

	// extractADR / extractHSPct are internal/extract's formulas
	// (build.go — ADR = total_damage ÷ THE MATCH'S COUNTED ROUNDS,
	// never ÷ the rounds the player played; helpers.go pct — HS% =
	// 100 · headshots / kills, 0 kills → 0), applied here so the
	// fixture's stored columns are EXACTLY what a real import writes:
	// that is the corpus's whole point. The match's round count comes
	// from the rounds rows this corpus saves below — the same rows the
	// seed's match-scope `rounds` denominator counts.
	matchRounds := 24
	extractADR := func(ps models.PlayerStats) float64 {
		if matchRounds == 0 {
			return 0
		}
		return float64(ps.TotalDamage) / float64(matchRounds)
	}
	extractHSPct := func(ps models.PlayerStats) float64 {
		if ps.Kills == 0 {
			return 0
		}
		return 100 * float64(ps.Headshots) / float64(ps.Kills)
	}

	players := []models.Player{
		{SteamID: "100", Name: "alice", Side: "ct"},
		{SteamID: "200", Name: "bob", Side: "t"},
		{SteamID: "300", Name: "carol", Side: "ct"}, // zero deaths — Q1's kd edge; the kda floor's agreement
	}
	base := []models.PlayerStats{
		{SteamID: "100", Side: "ct", Name: "alice", Kills: 10, Deaths: 2, Assists: 4, Headshots: 5, TotalDamage: 1320, RoundsPlayed: 24},
		{SteamID: "200", Side: "t", Name: "bob", Kills: 8, Deaths: 3, Assists: 2, Headshots: 3, TotalDamage: 960, RoundsPlayed: 24},
		{SteamID: "300", Side: "ct", Name: "carol", Kills: 7, Deaths: 0, Assists: 1, Headshots: 0, TotalDamage: 480, RoundsPlayed: 16}, // late join: 16 of the match's 24 rounds — the ADR divergence row
	}
	stats := make([]models.PlayerStats, len(base))
	for i, ps := range base {
		ps.ADR = extractADR(ps)
		ps.HSPct = extractHSPct(ps)
		stats[i] = ps
	}
	// The match's counted rounds — the seed's match-scope `rounds`
	// denominator counts THESE rows (over an empty rounds table the
	// denominator NULLs every subject to 0 beside N, which is exactly
	// the false pass this corpus must not produce), and extractADR
	// divides by the same count: carol's late-join case below reads
	// 480/24 = 20 from BOTH sides because of it.
	rounds := make([]models.Round, 0, matchRounds)
	for r := 1; r <= matchRounds; r++ {
		rounds = append(rounds, models.Round{Number: r})
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/equivalence.dem", SHA256: "sha-equivalence", Size: 4096,
			Map: "de_equivalence", TickRate: 64, ExtractedAt: time.Now(),
		},
		Players:     players,
		PlayerStats: stats,
		Rounds:      rounds,
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// KAST rows: alice 12/24, bob 6/24, carol 0/16 → 0.5 / 0.25 / 0.
	var prs []models.PlayerRoundStat
	for r := 1; r <= 24; r++ {
		prs = append(prs, models.PlayerRoundStat{Round: r, SteamID: "100", Name: "alice", KAST: r <= 12})
		prs = append(prs, models.PlayerRoundStat{Round: r, SteamID: "200", Name: "bob", KAST: r <= 6})
	}
	for r := 1; r <= 16; r++ {
		prs = append(prs, models.PlayerRoundStat{Round: r, SteamID: "300", Name: "carol"})
	}
	if err := st.ReplacePlayerRounds(id, prs); err != nil {
		t.Fatalf("ReplacePlayerRounds: %v", err)
	}

	board, err := st.GetScoreboard(id, "kills", true)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	byID := map[string]models.PlayerStatsRow{}
	for _, row := range board {
		byID[row.SteamID] = row
	}
	if len(byID) != 3 {
		t.Fatalf("scoreboard rows = %d, want 3", len(byID))
	}
	scope := "match:" + itoa(id)

	// adr metric == the stored ps.adr column GetScoreboard serves.
	adr := previewAt(t, st, seedDef(t, st, "adr"), scope)
	for _, row := range board {
		got, ok := adr[row.SteamID]
		if !ok {
			t.Errorf("adr: subject %s missing from the preview", row.SteamID)
			continue
		}
		if got != row.ADR {
			t.Errorf("adr[%s] = %v, want stored ps.adr %v (the scoreboard's ADR cell)", row.SteamID, got, row.ADR)
		}
	}
	// carol is the synthetic late-join case the real library lacks: she
	// played only 16 of the match's 24 rounds (RoundsPlayed 16) but
	// dealt 480 damage. Since the flip both sides divide by THE MATCH's
	// counted rounds — 480/24 = 20, pinned exactly here so a shared
	// regression to ÷ rounds_played (480/16 = 30) fails even though the
	// metric and the column would still agree with each other.
	if adr["300"] != 20 || byID["300"].ADR != 20 {
		t.Errorf("carol adr = metric %v vs stored ps.adr %v, want 20 on both sides (480 ÷ the match's 24 rounds)",
			adr["300"], byID["300"].ADR)
	}

	// hs_pct metric × 100 == the stored ps.hs_pct column (read
	// directly: the scoreboard DTO dropped the zero-reader passthroughs
	// on 2026-11-18 — the column itself still backs the seed).
	hs := previewAt(t, st, seedDef(t, st, "hs_pct"), scope)
	hsStored := oracle(t, st,
		`SELECT steam_id, hs_pct FROM player_stats WHERE match_id = ?`,
		id)
	if len(hsStored) != 3 {
		t.Fatalf("stored hs_pct rows = %d, want 3 (the roster)", len(hsStored))
	}
	for sid, want := range hsStored {
		got, ok := hs[sid]
		if !ok {
			t.Errorf("hs_pct: subject %s missing from the preview", sid)
			continue
		}
		if got*100 != want {
			t.Errorf("hs_pct[%s] ×100 = %v, want stored ps.hs_pct %v (the scoreboard's HS%% cell)", sid, got*100, want)
		}
	}

	// kast metric × 100 == kastPerMatchSQL (store/queries.go: the
	// per-match100.0 × AVG(player_round_stats.kast) the KAST% column
	// was sourced from before it converted).
	kast := previewAt(t, st, seedDef(t, st, "kast"), scope)
	kastSQL := oracle(t, st,
		`SELECT steam_id, 100.0 * AVG(kast) FROM player_round_stats WHERE match_id = ? GROUP BY steam_id`,
		id)
	for sid, want := range kastSQL {
		got, ok := kast[sid]
		if !ok {
			t.Errorf("kast: subject %s missing from the preview", sid)
			continue
		}
		if got*100 != want {
			t.Errorf("kast[%s] ×100 = %v, want kastPerMatchSQL %v", sid, got*100, want)
		}
	}

	// kd: equal wherever deaths > 0 (the metric's ratio and the store's
	// floored per-match spelling agree exactly), and Q1's RULED
	// divergence on the zero-death subject — the metric shows value 0
	// beside N (ratio's NULLIF, the honest no-denominator) where the
	// floor shows the kill count (7 / MAX(0,1) = 7). Both spellings are
	// deliberate; this pin keeps them from silently converging. The
	// floored spelling IS store.kdPerMatchSQL (unexported): it left
	// production with the report read-back in dogfooding W4 and is
	// spelled inline here the same way the kast oracle above is — the
	// const itself survives as the store package tests' reference
	// oracle (metric_series_read_test.go).
	kd := previewAt(t, st, seedDef(t, st, "kd"), scope)
	floored := oracle(t, st,
		`SELECT steam_id, CAST(kills AS REAL) / MAX(deaths, 1)
		 FROM player_stats WHERE match_id = ?`,
		id)
	if kd["100"] != floored["100"] || kd["200"] != floored["200"] {
		t.Errorf("kd = %v/%v, want the floored spelling %v/%v (deaths > 0 must agree)",
			kd["100"], kd["200"], floored["100"], floored["200"])
	}
	// Zero deaths: the ratio's NULLIF makes the statement's value NULL,
	// which is no data (ruling 23): a dash, not 0. The floored spelling
	// still gives 7 (MAX(deaths,1)) — Q1's ruled edge.
	if !math.IsNaN(kd["300"]) || floored["300"] != 7 {
		t.Errorf("zero-death kd = metric %v vs floored %v, want NULL (NULLIF, ruling 23) vs 7 (MAX(deaths,1)) — Q1's ruled edge",
			kd["300"], floored["300"])
	}

	// kda (w13d's conversion): the seeded metric equals the FLOORED
	// arithmetic GetScoreboard's retired `kda` alias used to serve —
	// (kills+assists)/MAX(deaths, 1), spelled here as the independent
	// oracle the old Go SELECT computed — subject for subject, INCLUDING
	// the zero-death subject: the seed's scalar max(sum(deaths), 1)
	// floors exactly like the retired spelling, so Q1's kd divergence
	// does NOT repeat (that is the whole point of the floored seed).
	kda := previewAt(t, st, seedDef(t, st, "kda"), scope)
	flooredKDA := oracle(t, st,
		`SELECT steam_id, CAST(kills + assists AS REAL) / MAX(deaths, 1)
		 FROM player_stats WHERE match_id = ?`,
		id)
	if len(flooredKDA) != 3 {
		t.Fatalf("kda oracle rows = %d, want 3 (the roster)", len(flooredKDA))
	}
	for sid, want := range flooredKDA {
		got, ok := kda[sid]
		if !ok {
			t.Errorf("kda: subject %s missing from the preview", sid)
			continue
		}
		if got != want {
			t.Errorf("kda[%s] = %v, want the retired (kills+assists)/MAX(deaths,1) spelling %v", sid, got, want)
		}
	}
	// The zero-death subject, explicit: carol's 7 kills + 1 assist over
	// MAX(0,1) = 1 → 8 from BOTH sides (never a NULLIF dash).
	if kda["300"] != 8 || flooredKDA["300"] != 8 {
		t.Errorf("zero-death kda = metric %v vs the floored spelling %v, want 8 on both sides (the floor closes Q1's edge for KDA)",
			kda["300"], flooredKDA["300"])
	}
}

// TestStoredColumnSeedsEquivalence: the eleven stored-column seeds the
// W2a scoreboard swap converts equal, subject for subject, the stored
// player_stats column every converted cell rendered from (design §6.3
// tier 1 — the semantic proof that no displayed number moves): A, 2K–5K,
// Open K, Trade and Streak left SCORE_COLS for metric columns over these
// very columns (Open D joined them as its own pinned column in w13d).
// The scoreboard DTO dropped its zero-reader passthrough fields on
// 2026-11-18, so each column is read directly here — the columns stay
// (they back the seeds and the SQL console) and the equality they pin
// is unchanged.
func TestStoredColumnSeedsEquivalence(t *testing.T) {
	st := seededStore(t)
	cols := []struct {
		seed string
		col  string
	}{
		{"assists", "assists"},
		{"flash_assists", "flash_assists"},
		{"enemies_flashed", "enemies_flashed"},
		{"entry_kills", "entry_kills"},
		{"entry_deaths", "entry_deaths"},
		{"best_streak", "best_streak"},
		{"two_k", "two_k"},
		{"three_k", "three_k"},
		{"four_k", "four_k"},
		{"five_k", "five_k"},
		{"trade_kills", "trade_kills"},
	}
	for _, matchID := range []int64{1, 2, 3} {
		scope := "match:" + itoa(matchID)
		t.Run(scope, func(t *testing.T) {
			for _, col := range cols {
				got := previewAt(t, st, seedDef(t, st, col.seed), scope)
				stored := oracle(t, st,
					`SELECT steam_id, `+col.col+` FROM player_stats WHERE match_id = ?`,
					matchID)
				if len(stored) == 0 {
					t.Fatalf("stored %s rows = 0", col.col)
				}
				if len(got) != len(stored) {
					t.Errorf("%s: preview rows = %d, stored rows = %d", col.seed, len(got), len(stored))
				}
				for sid, want := range stored {
					v, ok := got[sid]
					if !ok {
						t.Errorf("%s: subject %s missing from the preview", col.seed, sid)
						continue
					}
					if v != want {
						t.Errorf("%s[%s] = %v, want the stored column %v (the scoreboard cell it converts)",
							col.seed, sid, v, want)
					}
				}
			}
		})
	}
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
			// (dogfood/PLAN.md ruling 23). The oracle keeps that NULL.
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

// TestCareerClutchesEquivalence is the profile Clutches card's
// acceptance oracle (design §6.3): career_clutches == the raw clutch
// count over the library, computed here as an INDEPENDENT plain-SQL
// oracle over the clutches table instead of reading the career rollup
// (whose derived columns the career dual-write removal deleted). The
// oracle applies the seed's own semantics: the `career_clutches` expr is
// `from clutches: count()` and every statement is subject-addressed by
// the engine — a non-empty `steam_id` beside the humans-only NOT EXISTS
// over players (store.HumanOnlyBySteamID's spelling, match-scoped). The
// committed corpus is clutchless (an empty primary table yields no
// preview rows, the same treatment the fixtures give
// career_clutch_win_rate), so this one INSERTS clutches first: a player
// with clutches gets the same count from both sides, and a player
// without them keeps 0 AND no metric row — the profile's honest "—",
// never a fabricated 0.
func TestCareerClutchesEquivalence(t *testing.T) {
	st := seededStore(t)
	inserted := map[int64][]models.Clutch{
		1: {
			{Round: 5, Size: 1, SteamID: "76561198000000001", Name: "Alice", StartTick: 100, Won: true},
			{Round: 9, Size: 2, SteamID: "76561198000000001", Name: "Alice", StartTick: 200, Won: false},
		},
		2: {
			{Round: 3, Size: 1, SteamID: "76561198000000003", Name: "Carol", StartTick: 300, Won: true},
		},
		3: {
			{Round: 12, Size: 3, SteamID: "76561198000000005", Name: "Eve", StartTick: 400, Won: true},
			{Round: 16, Size: 1, SteamID: "76561198000000008", Name: "Heidi", StartTick: 500, Won: false},
		},
	}
	for matchID, rows := range inserted {
		if err := st.ReplaceClutches(matchID, rows); err != nil {
			t.Fatalf("ReplaceClutches(%d): %v", matchID, err)
		}
	}

	want := oracle(t, st,
		`SELECT c.steam_id, COUNT(*) FROM clutches c
		 WHERE c.steam_id <> ''
		   AND NOT EXISTS (SELECT 1 FROM players p
			WHERE p.match_id = c.match_id AND p.steam_id = c.steam_id AND p.is_bot = 1)
		 GROUP BY c.steam_id`)
	got := previewAt(t, st, seedDef(t, st, "career_clutches"), "")
	for i := 1; i <= 8; i++ {
		sid := fmt.Sprintf("7656119800000000%d", i)
		// want[sid] is 0 for every subject with no clutch rows.
		if got[sid] != want[sid] {
			t.Errorf("career_clutches[%s] = %v, want the raw clutch count %v", sid, got[sid], want[sid])
		}
		if want[sid] == 0 {
			if _, ok := got[sid]; ok {
				t.Errorf("career_clutches[%s] = %v, want NO row (a clutchless player renders —)",
					sid, got[sid])
			}
		} else if _, ok := got[sid]; !ok {
			t.Errorf("career_clutches: subject %s missing from the preview", sid)
		}
	}
}

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
	openings := previewAt(t, st, seedDef(t, st, "career_openings"), "")
	wins := previewAt(t, st, seedDef(t, st, "career_opener_wins"), "")
	rate := previewAt(t, st, seedDef(t, st, "career_opening_rate"), "")
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
