package metrics

import (
	"strings"
	"testing"
)

// Execution-level pins for the multi-source join extension (owner design
// (c)) over the committed seed corpus (testdata/seed.sql) and the bot
// store. Compile-shape fixtures live in metrics_test.go; the join-key
// criterion is pinned against the DDL in schema_consistency_test.go.

// TestJoinedAcceptanceRatio is the acceptance expression end to end:
//
//	from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))
//
// groupBy player, no denominator, library-wide and match-scoped.
//
// Seed math (testdata/seed.sql): per player i (1..8) the library has 3
// player_stats rows (one per match) with trade_kills = i each, so
// sum(trade_kills) = 3i. match_trade_opps carries opps = 10i per match
// for i ≤ 6 (library sum 30i), Grace (i=7) a stored opps = 0 row, and
// Heidi (i=8) NO row at all. Ratio = 3i/30i = 0.1 for i ≤ 6; Grace hits
// NULLIF(0) and Heidi NULL⇒NULLIF⇒NULL, both surfacing as Value 0.
func TestJoinedAcceptanceRatio(t *testing.T) {
	st := seededStore(t)
	const expr = "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))"

	pv, perr, err := RunPreview(st, Def{Expr: expr, GroupBy: "player"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v (sql: %s)", perr, err, pv.SQL)
	}
	wantVals := []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}
	wantLabels := "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi"
	if len(pv.Rows) != len(wantVals) {
		t.Fatalf("rows = %d, want %d (%+v)", len(pv.Rows), len(wantVals), pv.Rows)
	}
	for i, r := range pv.Rows {
		if r.Value != wantVals[i] {
			t.Errorf("row %d (%s) value = %v, want %v", i, r.Label, r.Value, wantVals[i])
		}
		if r.N != 3 {
			t.Errorf("row %d (%s) N = %d, want 3 (one player_stats row per match)", i, r.Label, r.N)
		}
	}
	var labels []string
	for _, r := range pv.Rows {
		labels = append(labels, r.Label)
	}
	if got := joinComma(labels); got != wantLabels {
		t.Errorf("labels = %q, want %q", got, wantLabels)
	}

	// Engine-derived shape: LEFT join on both key columns.
	wantJoin := "LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id " +
		"AND player_stats.steam_id = match_trade_opps.steam_id"
	if !strings.Contains(pv.SQL, wantJoin) {
		t.Errorf("SQL missing join %q:\n%s", wantJoin, pv.SQL)
	}

	// Scoped to one match: sum(trade_kills) = i, sum(opps) = 10i — the
	// same ratios at N = 1 (scope binds on the primary only).
	scoped, perr, err := RunPreview(st, Def{Expr: expr, GroupBy: "player"}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped preview: %v %v", perr, err)
	}
	if len(scoped.Rows) != len(wantVals) {
		t.Fatalf("scoped rows = %d, want %d", len(scoped.Rows), len(wantVals))
	}
	for i, r := range scoped.Rows {
		if r.Value != wantVals[i] {
			t.Errorf("scoped row %d value = %v, want %v", i, r.Value, wantVals[i])
		}
		if r.N != 1 {
			t.Errorf("scoped row %d N = %d, want 1", i, r.N)
		}
	}
}

// TestJoinedFanOutIdentity is the mechanical fan-out guard at execution
// level: count() over a join equals count() over the primary alone (the
// secondary is unique on the derived key, so the LEFT join can never
// multiply a primary row). The seed is all-human, so the mixed-population
// humans-only condition is a no-op here.
func TestJoinedFanOutIdentity(t *testing.T) {
	st := seededStore(t)
	cases := []struct {
		name    string
		join    string
		primary string
	}{
		{"acceptance pair", "from player_stats, match_trade_opps: count()", "from player_stats: count()"},
		{"n:1 pair", "from engagements, rounds: count()", "from engagements: count()"},
		{"player-round grain", "from player_round_stats, match_trade_opps: count()", "from player_round_stats: count()"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			joined := runValues(t, st, c.join, "")
			alone := runValues(t, st, c.primary, "")
			if len(joined) != 1 || len(alone) != 1 {
				t.Fatalf("rows: joined=%v alone=%v", joined, alone)
			}
			if joined[""] != alone[""] {
				t.Errorf("count over join = %v, count over primary alone = %v", joined[""], alone[""])
			}
			// The join must actually have executed.
			plan, perr := Compile(c.join, "", "", "")
			if perr != nil {
				t.Fatalf("compile: %v", perr)
			}
			if !strings.Contains(plan.SQL, "LEFT JOIN") {
				t.Errorf("compiled SQL has no join:\n%s", plan.SQL)
			}
		})
	}

	// Grouped identity: same groups, same per-group N.
	joined := runValues(t, st, "from player_stats, match_trade_opps: count()", "player")
	alone := runValues(t, st, "from player_stats: count()", "player")
	if len(joined) != len(alone) {
		t.Fatalf("group counts: joined=%d alone=%d", len(joined), len(alone))
	}
	for g, want := range alone {
		if joined[g] != want {
			t.Errorf("group %s: joined count %v, alone %v", g, joined[g], want)
		}
	}
}

// TestJoinedLeftJoinHonesty pins the sparse-secondary contract: every
// primary row survives the LEFT join (NULL secondary ⇒ SUM ⇒ NULLIF ⇒
// toFloat ⇒ Value 0 beside N), a stored opps = 0 row yields 0, and the
// percentile fetch carries the same join (day-one support).
func TestJoinedLeftJoinHonesty(t *testing.T) {
	st := seededStore(t)

	// Ungrouped sum(opps) over the join: 24 player_stats rows kept
	// (LEFT), Heidi's absent secondary contributes NULL (nothing added):
	// 3 × (10+20+30+40+50+60+0) = 630, N = 24.
	pv, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: sum(opps)"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("sum(opps): %v %v (sql: %s)", perr, err, pv.SQL)
	}
	if len(pv.Rows) != 1 || pv.Rows[0].Value != 630 || pv.Rows[0].N != 24 {
		t.Fatalf("sum(opps) = %+v, want single row 630 / N 24", pv.Rows)
	}

	// Grouped honesty rows: Grace's STORED opps = 0 row and Heidi's
	// ABSENT row both surface as Value 0 with N > 0 (never a missing row).
	grouped, perr, err := RunPreview(st, Def{
		Expr: "from player_stats, match_trade_opps: sum(opps)", GroupBy: "player",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("grouped sum(opps): %v %v", perr, err)
	}
	if len(grouped.Rows) != 8 {
		t.Fatalf("groups = %d, want 8", len(grouped.Rows))
	}
	// ORDER BY grp ASC → …, Grace (7th), Heidi (8th).
	for _, idx := range []int{6, 7} {
		r := grouped.Rows[idx]
		if r.Value != 0 || r.N != 3 {
			t.Errorf("row %d = value %v N %d, want 0 / 3", idx, r.Value, r.N)
		}
	}

	// Percentile over the join: the raw fetch carries the SAME join and
	// qualification. Values = the 21 stored opps (Heidi's 3 NULLs are not
	// numeric → excluded): 3×{0,10,…,60}, median at index 10 → 30.
	pctl, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: percentile(0.5, opps)"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("percentile: %v %v (sql: %s)", perr, err, pctl.SQL)
	}
	if len(pctl.Rows) != 1 || pctl.Rows[0].Value != 30 || pctl.Rows[0].N != 21 {
		t.Fatalf("percentile over join = %+v, want single row 30 / N 21", pctl.Rows)
	}
	if !strings.Contains(pctl.SQL, "LEFT JOIN match_trade_opps") {
		t.Errorf("percentile raw fetch lost the join:\n%s", pctl.SQL)
	}

	// Filtered percentile: the phase-2 WHERE qualifies the secondary's
	// column through the same resolver. opps >= 20 keeps 3×{20,…,60} = 15
	// values; median at index 7 → 40.
	filt, perr, err := RunPreview(st, Def{
		Expr: "from player_stats, match_trade_opps: percentile(where opps >= 20, 0.5, opps)",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("filtered percentile: %v %v (sql: %s)", perr, err, filt.SQL)
	}
	if len(filt.Rows) != 1 || filt.Rows[0].Value != 40 || filt.Rows[0].N != 15 {
		t.Fatalf("filtered percentile over join = %+v, want single row 40 / N 15", filt.Rows)
	}
	if !strings.Contains(filt.SQL, "match_trade_opps.opps >= ?") {
		t.Errorf("phase-2 filter not qualified on the secondary:\n%s", filt.SQL)
	}
}

// TestJoinedScope pins scope binding on joins: match:<id> qualifies the
// primary's match_id (an unqualified match_id would be ambiguous across
// the sources), and an unknown-but-valid scope yields the single 0/N row
// (the existing missing-data pattern).
func TestJoinedScope(t *testing.T) {
	st := seededStore(t)

	pv, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: count()"}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped: %v %v (sql: %s)", perr, err, pv.SQL)
	}
	if len(pv.Rows) != 1 || pv.Rows[0].Value != 8 || pv.Rows[0].N != 8 {
		t.Fatalf("scoped count = %+v, want single row 8 / 8", pv.Rows)
	}
	if !strings.Contains(pv.SQL, "WHERE player_stats.match_id = ?") {
		t.Errorf("scope not qualified on the primary:\n%s", pv.SQL)
	}

	empty, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: count()"}, "match:99", 100)
	if perr != nil || err != nil {
		t.Fatalf("empty scope compile/run: %v %v", perr, err)
	}
	if len(empty.Rows) != 1 || empty.Rows[0].Value != 0 || empty.Rows[0].N != 0 {
		t.Fatalf("empty-scope preview = %+v, want single row 0/0", empty.Rows)
	}
}

// TestJoinedPopulationAlignment pins the owner ruling on mixed-population
// source sets (the change bot_group_test.go's header reserved): a
// multi-source expression whose sources mix populations applies HumanOnly
// to the primary's player column REGARDLESS of grouping. The bot store
// carries one human (alice) and one bot in player_stats/events; no
// match_trade_opps rows exist (analytics never writes bots — the bot's
// secondary values would be NULL anyway).
func TestJoinedPopulationAlignment(t *testing.T) {
	st := botStore(t)

	// Grouped: bot groups are dropped through the primary's player column.
	grouped, perr, err := RunPreview(st, Def{
		Expr: "from player_stats, match_trade_opps: count()", GroupBy: "player",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("grouped: %v %v", perr, err)
	}
	if len(grouped.Rows) != 1 || grouped.Rows[0].Group != aliceID {
		t.Fatalf("grouped joined = %+v, want only alice (bot group dropped)", grouped.Rows)
	}

	// Ungrouped: the numerator is human-only too — the bot's player_stats
	// row survives the LEFT join with NULL secondary values, then the
	// humans-only condition drops it.
	plain, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("plain: %v %v", perr, err)
	}
	if len(plain.Rows) != 1 || plain.Rows[0].Value != 1 {
		t.Fatalf("ungrouped mixed-population count = %+v, want 1 (human only)", plain.Rows)
	}

	// Single-source boundary stays put (bot_group_test.go pins it): an
	// ungrouped single-source count still records bot rows.
	single, perr, err := RunPreview(st, Def{Expr: "from player_stats: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("single-source: %v %v", perr, err)
	}
	if len(single.Rows) != 1 || single.Rows[0].Value != 2 {
		t.Fatalf("ungrouped single-source count = %+v, want 2 (bots included)", single.Rows)
	}

	// All-sources-all-players multi-source keeps the single-source rule:
	// ungrouped still counts bot rows (events + rounds, both all-players;
	// the seed store has no rounds rows — the LEFT join yields NULL, which
	// does not drop the primary rows).
	allPlayers, perr, err := RunPreview(st, Def{Expr: "from events, rounds: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("all-players join: %v %v", perr, err)
	}
	if len(allPlayers.Rows) != 1 || allPlayers.Rows[0].Value != 2 {
		t.Fatalf("ungrouped all-players join count = %+v, want 2 (bots included)", allPlayers.Rows)
	}
}
