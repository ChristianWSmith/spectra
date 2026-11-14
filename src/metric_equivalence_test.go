package main

import (
	"database/sql"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// W3 — THE "stored == computed" oracle (design §7's metric_equivalence_
// test, the eco_equivalence_test.go pattern): for a set of expressions,
// the rows the compute pass WRITES into metric_values must equal the
// rows a query-time evaluation (RunPreview) produces over the same
// data — match batch vs per-`match:<id>` runs, profile vs the "" run,
// denominators at both scopes, percentiles, a joined source, bots
// absent, no '' subjects, and a ref-composed value against an
// independent SQL hand-composition. If the pass's batched address mode
// or its row adapter ever drifts from the preview engine, this fails.

// eqKey is a stored/oracle row address: (match_id, subject). Profile
// rows live at match 0 (the career grain).
type eqKey struct {
	matchID int64
	steam   string
}

// eqVal is the value + sample size behind it.
type eqVal struct {
	value float64
	n     int
}

// The fixture roster for the synthetic bot/actor-less match.
const (
	eqHumanSID = "76561198000000011"
	eqBotSID   = "76561198000000099"
)

// newSeededFixture is the equivalence corpus: the committed synthetic
// library (metrics.LoadSeed — 3 ready matches × 8 players, hand-
// computable aggregates) PLUS a fourth ready match carrying a bot with
// its own events and an actor-less event, so the humans-only subject
// rule and `subject <> ”` are pinned against real rows — preview and
// stored must exclude them IDENTICALLY.
func newSeededFixture(t *testing.T) *depsFixture {
	t.Helper()
	f := newDepsFixture(t)
	db, err := sql.Open("sqlite", f.path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open seed conn: %v", err)
	}
	if err := metrics.LoadSeed(db); err != nil {
		_ = db.Close()
		t.Fatalf("LoadSeed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close seed conn: %v", err)
	}
	seedEquivalenceBotMatch(t, f.st)
	return f
}

// seedEquivalenceBotMatch stores a fourth ready match: one human with
// three damage events, one bot with two authored events, and one
// actor-less event (no attacker at all).
func seedEquivalenceBotMatch(t *testing.T, st *store.Store) {
	t.Helper()
	id, err := st.CreateMatchRow("/seed/botmatch.dem", "sha-equiv-bot", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/seed/botmatch.dem", SHA256: "sha-equiv-bot",
			Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct"},
			{SteamID: eqBotSID, Name: "BOT Neil", IsBot: true, Side: "t"},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct", RoundsPlayed: 1},
			{SteamID: eqBotSID, Name: "BOT Neil", Side: "t", RoundsPlayed: 1},
		},
	}
	for i := 0; i < 3; i++ {
		em.Events = append(em.Events, models.Event{
			Seq: i, Tick: 100 + i*10, Round: 1, Kind: "damage",
			Attacker: eqHumanSID, Victim: eqBotSID, Weapon: "ak47", Dmg: 10 * (i + 1),
		})
	}
	// Bot-authored events (subject rule must drop them everywhere) and
	// an actor-less event (`subject <> ''` must drop it — no '' subject
	// may ever become a stored value).
	em.Events = append(em.Events,
		models.Event{Seq: 3, Tick: 140, Round: 1, Kind: "damage", Attacker: eqBotSID, Victim: eqHumanSID, Weapon: "glock", Dmg: 5},
		models.Event{Seq: 4, Tick: 150, Round: 1, Kind: "kill", Attacker: eqBotSID, Victim: eqHumanSID, Weapon: "glock"},
		models.Event{Seq: 5, Tick: 160, Round: 1, Kind: "damage", Victim: eqHumanSID, Weapon: "world", Dmg: 1},
	)
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
}

// readyMatchIDs lists the library's ready matches — the match-scope
// units the preview oracle iterates.
func readyMatchIDs(t *testing.T, st *store.Store) []int64 {
	t.Helper()
	res, err := st.RunReadOnly(`SELECT id FROM matches WHERE status = 'ready' ORDER BY id`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("ready matches: %v", err)
	}
	var ids []int64
	for _, r := range res.Rows {
		ids = append(ids, r[0].(int64))
	}
	if len(ids) == 0 {
		t.Fatal("fixture has no ready matches")
	}
	return ids
}

// storedOracle reads a metric's stored rows straight from
// metric_values (W4 owns the canonical read — this test pins the DATA,
// so it reads the table itself through the pass's own write-handle
// runner) keyed by (match_id, subject).
func storedOracle(t *testing.T, st *store.Store, metricID int64) map[eqKey]eqVal {
	t.Helper()
	res, err := st.QueryWrite(t.Context(),
		`SELECT match_id, steam_id, value, n FROM metric_values WHERE metric_id = ? ORDER BY match_id, steam_id`,
		[]any{metricID}, 1000000)
	if err != nil {
		t.Fatalf("stored read: %v", err)
	}
	out := map[eqKey]eqVal{}
	for _, r := range res.Rows {
		key := eqKey{matchID: r[0].(int64), steam: r[1].(string)}
		if _, dup := out[key]; dup {
			t.Errorf("duplicate stored row for %+v (PK violated)", key)
		}
		out[key] = eqVal{value: toFloat64(r[2]), n: toInt(r[3])}
	}
	return out
}

// previewOracle runs the QUERY-TIME evaluation: match scope iterates
// every ready match through a scoped RunPreview (the pre-pass,
// single-match form), profile runs the "" library statement once. The
// result is the oracle the stored rows must match.
func previewOracle(t *testing.T, st *store.Store, def metrics.Def, scope string) map[eqKey]eqVal {
	t.Helper()
	out := map[eqKey]eqVal{}
	collect := func(matchID int64, pv metrics.Preview) {
		for _, r := range pv.Rows {
			key := eqKey{matchID: matchID, steam: r.Group}
			if _, dup := out[key]; dup {
				t.Errorf("duplicate oracle row for %+v", key)
			}
			out[key] = eqVal{value: r.Value, n: r.N}
		}
	}
	if scope == "profile" {
		pv, perr, err := metrics.RunPreview(st, def, "", 2000)
		if perr != nil {
			t.Fatalf("profile preview compile: %v", perr)
		}
		if err != nil {
			t.Fatalf("profile preview run: %v (sql: %s)", err, pv.SQL)
		}
		collect(0, pv)
		return out
	}
	for _, id := range readyMatchIDs(t, st) {
		pv, perr, err := metrics.RunPreview(st, def, fmt.Sprintf("match:%d", id), 2000)
		if perr != nil {
			t.Fatalf("scoped preview compile (match %d): %v", id, perr)
		}
		if err != nil {
			t.Fatalf("scoped preview run (match %d): %v (sql: %s)", id, err, pv.SQL)
		}
		collect(id, pv)
	}
	return out
}

// closeEnough compares float values at a relative epsilon — the batched
// and scoped statements aggregate the same row sets but may reach them
// in different orders, so bit-equality is not promised (summation order
// is the only possible drift; the values themselves are exact integers
// in these fixtures, which the epsilon still catches drift on).
func closeEnough(a, b float64) bool {
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

// compareOracles pins stored == computed: identical key sets, equal
// sample sizes, equal values.
func compareOracles(t *testing.T, name string, stored, want map[eqKey]eqVal) {
	t.Helper()
	for k, w := range want {
		g, ok := stored[k]
		if !ok {
			t.Errorf("%s: stored row MISSING for %+v (oracle: value %v n %d)", name, k, w.value, w.n)
			continue
		}
		if g.n != w.n {
			t.Errorf("%s[%+v].n = %d, want %d (oracle)", name, k, g.n, w.n)
		}
		if !closeEnough(g.value, w.value) {
			t.Errorf("%s[%+v].value = %v, want %v (oracle)", name, k, g.value, w.value)
		}
	}
	for k, g := range stored {
		if _, ok := want[k]; !ok {
			t.Errorf("%s: EXTRA stored row %+v (value %v n %d) — not produced by the preview", name, k, g.value, g.n)
		}
	}
	if len(want) == 0 {
		t.Errorf("%s: oracle is empty — fixture broken, test proves nothing", name)
	}
}

// TestMetricEquivalenceStoredEqualsPreview is the wave's centerpiece:
// every case SAVES a definition, runs the compute pass, and asserts the
// stored metric_values rows equal the query-time evaluation row for
// row. The case table covers both scopes × denominators × the joined
// source × percentile — i.e. every branch of the pass-only address
// mode (batched GROUP BY match_id, subject + the row-correlated match
// denominator) against the preview's single-match and library forms.
func TestMetricEquivalenceStoredEqualsPreview(t *testing.T) {
	f := newSeededFixture(t)
	cases := []struct {
		name  string
		expr  string
		denom string
		scope string
	}{
		{"eq01_count_match", "from events: count()", "", "match"},
		{"eq02_count_rounds_match", "from events: count()", "rounds", "match"},
		{"eq03_sum_matches_profile", "from player_stats: sum(kills)", "matches", "profile"},
		{"eq04_joined_trade_match", "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))", "", "match"},
		{"eq05_p95_match", "from events: percentile(0.95, dmg)", "", "match"},
		{"eq06_median_dmg_profile", "from events: median(dmg)", "", "profile"},
		{"eq07_count_profile", "from events: count()", "", "profile"},
		{"eq08_count_rounds_profile", "from events: count()", "rounds", "profile"},
		{"eq09_p100_rounds_profile", "from events: percentile(1.0, dmg)", "rounds", "profile"},
		{"eq10_filtered_match", "from events: count(where kind='kill')", "", "match"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := f.save(t, models.MetricRow{Name: tc.name, Expr: tc.expr, Scope: tc.scope, Denominator: tc.denom})
			res, err := f.svc.runSweep(t.Context(), nil)
			if err != nil {
				t.Fatalf("sweep: %v", err)
			}
			if len(res.Failed) > 0 || len(res.Skipped) > 0 {
				t.Fatalf("sweep failures=%v skipped=%v (a broken definition must not slip through)", res.Failed, res.Skipped)
			}
			stored := storedOracle(t, f.st, m.ID)
			want := previewOracle(t, f.st, metrics.Def{Expr: tc.expr, Denominator: tc.denom}, tc.scope)
			compareOracles(t, tc.name, stored, want)

			// Row-key hygiene (design §3): subjects are never '', bots
			// never become values, and the grain matches the scope —
			// match rows keyed match_id > 0, career rows at 0.
			for k := range stored {
				if k.steam == "" {
					t.Errorf("%s: stored '' subject at match %d (subject <> '' must hold)", tc.name, k.matchID)
				}
				if k.steam == eqBotSID {
					t.Errorf("%s: stored a BOT subject %s (humans-only is unconditional)", tc.name, k.steam)
				}
				switch tc.scope {
				case "profile":
					if k.matchID != 0 {
						t.Errorf("%s: profile row at match_id %d, want 0 (career grain)", tc.name, k.matchID)
					}
				default:
					if k.matchID <= 0 {
						t.Errorf("%s: match row at match_id %d, want > 0", tc.name, k.matchID)
					}
				}
			}

			// The predicate agrees with the write: after a successful
			// sweep the metric is NOT behind (fresh rows cover every
			// ready unit).
			cfg, err := f.st.GetConfig()
			if err != nil {
				t.Fatalf("GetConfig: %v", err)
			}
			coverage, err := f.st.MetricCoverage(cfg.RuleVersion)
			if err != nil {
				t.Fatalf("MetricCoverage: %v", err)
			}
			for _, c := range coverage {
				if c.MetricID == m.ID && c.Behind {
					t.Errorf("%s: still behind after a full sweep (fresh_rows=%d)", tc.name, c.FreshRows)
				}
			}
		})
	}
}

// TestMetricEquivalenceRefComposed pins ref-composed values against an
// independent SQL hand-composition: the dependent's stored value must
// be sum(dmg)/count over exactly the rows its upstream's stored count
// covers — which also proves the TOPO order (the upstream committed
// first, or the INNER join would have dropped every dependent row).
func TestMetricEquivalenceRefComposed(t *testing.T) {
	f := newSeededFixture(t)
	up := f.save(t, models.MetricRow{Name: "eqref_up", Expr: "from events: count()"})
	dep := f.save(t, models.MetricRow{Name: "eqref_dep", Expr: "from events: ratio(sum(dmg), metric('eqref_up'))"})

	res, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if len(res.Failed) > 0 || len(res.Skipped) > 0 {
		t.Fatalf("sweep failures=%v skipped=%v", res.Failed, res.Skipped)
	}

	// The upstream itself is equivalent (its rows are what the ref join
	// reads).
	upStored := storedOracle(t, f.st, up.ID)
	upWant := previewOracle(t, f.st, metrics.Def{Expr: "from events: count()"}, "match")
	compareOracles(t, "eqref_up", upStored, upWant)

	// Hand-composition for the dependent: one independent SQL over the
	// raw events, mirroring the engine's subject conditions exactly
	// (subject <> '' beside the humans-only lookup on the subject).
	res2, err := f.st.QueryWrite(t.Context(), `
		SELECT match_id, attacker,
			1.0*SUM(dmg)/COUNT(*), COUNT(*)
		FROM events
		WHERE attacker <> ''
		  AND NOT EXISTS (SELECT 1 FROM players p
			WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)
		GROUP BY match_id, attacker`, nil, 1000000)
	if err != nil {
		t.Fatalf("oracle SQL: %v", err)
	}
	want := map[eqKey]eqVal{}
	for _, r := range res2.Rows {
		want[eqKey{matchID: r[0].(int64), steam: r[1].(string)}] = eqVal{value: toFloat64(r[2]), n: toInt(r[3])}
	}
	stored := storedOracle(t, f.st, dep.ID)
	compareOracles(t, "eqref_dep", stored, want)
	if len(want) == 0 {
		t.Fatal("hand-composed oracle is empty — fixture broken")
	}

	// Chain/closure in the other direction: with the upstream's rows
	// REMOVED (phase 1 state), the metric is behind and the NEXT sweep
	// must recompute BOTH — the dependent joins the work list through
	// the forward closure (its own stamps still look live!) and lands
	// equal to the oracle again. The INNER drop for a FAILED upstream
	// (rows absent, never 0) is pinned by
	// TestSweepSkipsDependentsOfFailedUpstream in metricpass_test.go.
	if err := f.st.ClearMetricValues(up.ID); err != nil {
		t.Fatalf("clear upstream: %v", err)
	}
	cfg, err := f.st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	coverage, err := f.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	upBehind, depBehind := false, false
	for _, c := range coverage {
		switch c.MetricID {
		case up.ID:
			upBehind = c.Behind
		case dep.ID:
			depBehind = c.Behind
		}
	}
	if !upBehind {
		t.Error("upstream with cleared rows = not behind, want behind (the direct predicate)")
	}
	if depBehind {
		// The DEPENDENT's own rows are untouched and live-stamped: the
		// direct predicate says fresh — the closure clause lives in the
		// sweep, which is what must pull it along.
		t.Error("dependent's own predicate = behind, want not-behind (chain is the sweep's closure, not the row predicate)")
	}
	res3, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if len(res3.Failed) > 0 || len(res3.Skipped) > 0 {
		t.Fatalf("second sweep failures=%v skipped=%v", res3.Failed, res3.Skipped)
	}
	touched := false
	for _, id := range res3.Attempted {
		if id == dep.ID {
			touched = true
		}
	}
	if !touched {
		t.Error("dependent not in the second sweep's work list (forward closure of the behind upstream)")
	}
	restored := storedOracle(t, f.st, dep.ID)
	compareOracles(t, "eqref_dep after upstream restore", restored, want)
}

// toFloat64 / toInt coerce a write-handle cell (the pass's own
// normalizer output: int64/float64/string/nil).
func toFloat64(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case nil:
		return 0
	case string:
		var f float64
		if _, err := fmt.Sscanf(t, "%g", &f); err == nil {
			return f
		}
		return 0
	}
	return 0
}

func toInt(v any) int {
	switch t := v.(type) {
	case int64:
		return int(t)
	case float64:
		return int(t)
	}
	return 0
}
