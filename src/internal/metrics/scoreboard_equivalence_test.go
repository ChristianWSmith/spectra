package metrics

import (
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
//     (player_stats carries total_damage=100, rounds_played=24 →
//     extract's formula gives 4.17 while the column says 55), so that
//     corpus pins adr against extract's FORMULA instead, and the
//     stored-column adr proof runs on the extract-shaped corpus below.
//   - TestExtractShapedScoreboardEquivalence builds the corpus extract
//     actually writes (ADR = total_damage/rounds_played — extract/
//     build.go:117-119; HSPct = 100·hs/k — extract/helpers.go pct) and
//     proves the stored-column seeds (adr, hs_pct, kast) equal the
//     columns GetScoreboard serves — plus the kd seed against the
//     store's FLOORED per-match spelling (kdPerMatchSQL, test-only since
//     dogfooding W4 removed the scoreboard's kd column), where Q1's one
//     deliberate divergence lives (zero deaths: ratio's NULLIF → value 0
//     beside N, where the floor MAX(deaths, 1) → the kill count).

// seedExpr reads a schema-seeded builtin's expression from the store —
// the SEED is what these tests prove, never a test-local copy of it.
func seedExpr(t *testing.T, st *store.Store, name string) string {
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

// previewAt runs one seeded expression at the given scope (the
// scoreboard's grain) and keys the rows by subject.
func previewAt(t *testing.T, st *store.Store, expr, scope string) map[string]float64 {
	t.Helper()
	pv, perr, err := RunPreview(st, Def{Expr: expr}, scope, 500)
	if perr != nil {
		t.Fatalf("parse %q: %v", expr, perr)
	}
	if err != nil {
		t.Fatalf("run %q (scope %q): %v (sql: %s)", expr, scope, err, pv.SQL)
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
//	adr         == extract's stored-column formula
//	                (total_damage / rounds_played — build.go:117-119).
func TestFixtureCorpusScoreboardEquivalence(t *testing.T) {
	st := seededStore(t)
	kastExpr := seedExpr(t, st, "kast")
	hsExpr := seedExpr(t, st, "hs_pct")
	adrExpr := seedExpr(t, st, "adr")

	for _, matchID := range []int64{1, 2, 3} {
		scope := "match:" + itoa(matchID)
		t.Run(scope, func(t *testing.T) {
			// kast: metric (0..1 fraction) × 100 vs the store's
			// per-match KAST% spelling — this is the number the
			// scoreboard's KAST% column showed via combat stats.
			kast := previewAt(t, st, kastExpr, scope)
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
			hs := previewAt(t, st, hsExpr, scope)
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
			// FORMULA, which is the identity extract itself guarantees.
			adr := previewAt(t, st, adrExpr, scope)
			formula := oracle(t, st,
				`SELECT steam_id, 1.0 * SUM(total_damage) / NULLIF(SUM(rounds_played), 0)
				 FROM player_stats WHERE match_id = ? GROUP BY steam_id`,
				matchID)
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
// kast == kastPerMatchSQL) — and kd carries Q1's one ruled divergence.
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
	// (build.go:117-119 — ADR = total_damage / rounds_played;
	// helpers.go pct — HS% = 100 · headshots / kills, 0 kills → 0),
	// applied here so the fixture's stored columns are EXACTLY what a
	// real import writes: that is the corpus's whole point.
	extractADR := func(ps models.PlayerStats) float64 {
		if ps.RoundsPlayed == 0 {
			return 0
		}
		return float64(ps.TotalDamage) / float64(ps.RoundsPlayed)
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
		{SteamID: "300", Name: "carol", Side: "ct"}, // zero deaths — Q1's edge
	}
	base := []models.PlayerStats{
		{SteamID: "100", Side: "ct", Name: "alice", Kills: 10, Deaths: 2, Assists: 4, Headshots: 5, TotalDamage: 1320, RoundsPlayed: 24},
		{SteamID: "200", Side: "t", Name: "bob", Kills: 8, Deaths: 3, Assists: 2, Headshots: 3, TotalDamage: 960, RoundsPlayed: 24},
		{SteamID: "300", Side: "ct", Name: "carol", Kills: 7, Deaths: 0, Assists: 1, Headshots: 0, TotalDamage: 480, RoundsPlayed: 16},
	}
	stats := make([]models.PlayerStats, len(base))
	for i, ps := range base {
		ps.ADR = extractADR(ps)
		ps.HSPct = extractHSPct(ps)
		stats[i] = ps
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/equivalence.dem", SHA256: "sha-equivalence", Size: 4096,
			Map: "de_equivalence", TickRate: 64, ExtractedAt: time.Now(),
		},
		Players:     players,
		PlayerStats: stats,
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
	adr := previewAt(t, st, seedExpr(t, st, "adr"), scope)
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

	// hs_pct metric × 100 == the stored ps.hs_pct column.
	hs := previewAt(t, st, seedExpr(t, st, "hs_pct"), scope)
	for _, row := range board {
		got, ok := hs[row.SteamID]
		if !ok {
			t.Errorf("hs_pct: subject %s missing from the preview", row.SteamID)
			continue
		}
		if got*100 != row.HSPct {
			t.Errorf("hs_pct[%s] ×100 = %v, want stored ps.hs_pct %v (the scoreboard's HS%% cell)", row.SteamID, got*100, row.HSPct)
		}
	}

	// kast metric × 100 == kastPerMatchSQL (store/queries.go: the
	// per-match100.0 × AVG(player_round_stats.kast) the KAST% column
	// was sourced from before it converted).
	kast := previewAt(t, st, seedExpr(t, st, "kast"), scope)
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
	kd := previewAt(t, st, seedExpr(t, st, "kd"), scope)
	floored := oracle(t, st,
		`SELECT steam_id, CAST(kills AS REAL) / MAX(deaths, 1)
		 FROM player_stats WHERE match_id = ?`,
		id)
	if kd["100"] != floored["100"] || kd["200"] != floored["200"] {
		t.Errorf("kd = %v/%v, want the floored spelling %v/%v (deaths > 0 must agree)",
			kd["100"], kd["200"], floored["100"], floored["200"])
	}
	if kd["300"] != 0 || floored["300"] != 7 {
		t.Errorf("zero-death kd = metric %v vs floored %v, want 0 (NULLIF) vs 7 (MAX(deaths,1)) — Q1's ruled edge",
			kd["300"], floored["300"])
	}
}

// itoa formats a match id for a scope string.
func itoa(v int64) string { return strconv.FormatInt(v, 10) }
