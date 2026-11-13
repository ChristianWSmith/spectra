package metrics

import (
	"strings"
	"testing"
)

// Execution-level pins for the multi-source join extension (owner design
// (c)) over the committed seed corpus (testdata/seed.sql) and the bot
// store. Compile-shape fixtures live in metrics_test.go; the join-key
// criterion is pinned against the DDL in schema_consistency_test.go.
// Every run is subject-addressed (no groupBy argument): the rows are
// one per subject, so "grouped" and "ungrouped" are the same statement
// shape now — the population pins below are re-pinned UNCONDITIONAL.

// TestJoinedAcceptanceRatio is the acceptance expression end to end:
//
//	from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))
//
// no denominator, library-wide and match-scoped — one row per subject.
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

	pv, perr, err := RunPreview(st, Def{Expr: expr}, "", 100)
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
	scoped, perr, err := RunPreview(st, Def{Expr: expr}, "match:1", 100)
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
// level: count() over a join equals count() over the primary alone, PER
// SUBJECT (the secondary is unique on the derived key, so the LEFT join
// can never multiply a primary row). The seed is all-human, so the
// unconditional humans-only condition is a no-op here.
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
			joined := runValues(t, st, c.join)
			alone := runValues(t, st, c.primary)
			if len(joined) != len(alone) {
				t.Fatalf("subject counts: joined=%d alone=%d", len(joined), len(alone))
			}
			for g, want := range alone {
				if joined[g] != want {
					t.Errorf("subject %s: joined count %v, alone %v", g, joined[g], want)
				}
			}
			// The join must actually have executed.
			plan, perr := Compile(c.join, "", "")
			if perr != nil {
				t.Fatalf("compile: %v", perr)
			}
			if !strings.Contains(plan.SQL, "LEFT JOIN") {
				t.Errorf("compiled SQL has no join:\n%s", plan.SQL)
			}
		})
	}
}

// TestJoinedLeftJoinHonesty pins the sparse-secondary contract: every
// primary row survives the LEFT join (NULL secondary ⇒ SUM ⇒ NULLIF ⇒
// toFloat ⇒ Value 0 beside N), a stored opps = 0 row yields 0, and the
// percentile fetch carries the same join (day-one support) — one row per
// subject throughout.
func TestJoinedLeftJoinHonesty(t *testing.T) {
	st := seededStore(t)

	// Per-subject sum(opps) over the join: every player's 3
	// player_stats rows kept (LEFT); Heidi's absent secondary
	// contributes NULL (nothing added) → Value 0 beside N = 3.
	// Library total: 3 × (10+20+30+40+50+60+0) = 630.
	wantSums := []float64{30, 60, 90, 120, 150, 180, 0, 0}
	pv, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: sum(opps)"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("sum(opps): %v %v (sql: %s)", perr, err, pv.SQL)
	}
	if len(pv.Rows) != len(wantSums) {
		t.Fatalf("rows = %d, want %d (%+v)", len(pv.Rows), len(wantSums), pv.Rows)
	}
	total := 0.0
	for i, r := range pv.Rows {
		if r.Value != wantSums[i] || r.N != 3 {
			t.Errorf("row %d = value %v N %d, want %v / 3", i, r.Value, r.N, wantSums[i])
		}
		total += r.Value
	}
	if total != 630 {
		t.Errorf("per-subject sums total %v, want 630 (the whole-library sum)", total)
	}

	// Percentile over the join: the raw fetch carries the SAME join and
	// qualification, partitioned per subject. Subject i (≤6) has three
	// stored opps = 10i → median 10i, N 3; Grace's stored opps = 0 → 0,
	// N 3; Heidi's three NULLs are not numeric → value 0 with N 0 (the
	// missing-data indicator, never a fabricated sample).
	wantMedians := []float64{10, 20, 30, 40, 50, 60, 0, 0}
	wantN := []int{3, 3, 3, 3, 3, 3, 3, 0}
	pctl, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: percentile(0.5, opps)"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("percentile: %v %v (sql: %s)", perr, err, pctl.SQL)
	}
	if len(pctl.Rows) != len(wantMedians) {
		t.Fatalf("percentile rows = %d, want %d (%+v)", len(pctl.Rows), len(wantMedians), pctl.Rows)
	}
	for i, r := range pctl.Rows {
		if r.Value != wantMedians[i] || r.N != wantN[i] {
			t.Errorf("percentile row %d = %v N %d, want %v N %d", i, r.Value, r.N, wantMedians[i], wantN[i])
		}
	}
	if !strings.Contains(pctl.SQL, "LEFT JOIN match_trade_opps") {
		t.Errorf("percentile raw fetch lost the join:\n%s", pctl.SQL)
	}

	// Filtered percentile: the phase-2 WHERE qualifies the secondary's
	// column through the same resolver. opps >= 20 keeps only subjects
	// 2..6 (3×{20,…,60}) — Alice (10), Grace (0) and Heidi (NULL) drop
	// out entirely: a subject the statement produced no row for has no
	// partition (no row).
	filt, perr, err := RunPreview(st, Def{
		Expr: "from player_stats, match_trade_opps: percentile(where opps >= 20, 0.5, opps)",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("filtered percentile: %v %v (sql: %s)", perr, err, filt.SQL)
	}
	wantFilt := []float64{20, 30, 40, 50, 60}
	if len(filt.Rows) != len(wantFilt) {
		t.Fatalf("filtered percentile rows = %d, want %d (%+v)", len(filt.Rows), len(wantFilt), filt.Rows)
	}
	for i, r := range filt.Rows {
		if r.Value != wantFilt[i] || r.N != 3 {
			t.Errorf("filtered row %d = %v N %d, want %v N 3", i, r.Value, r.N, wantFilt[i])
		}
	}
	if !strings.Contains(filt.SQL, "match_trade_opps.opps >= ?") {
		t.Errorf("phase-2 filter not qualified on the secondary:\n%s", filt.SQL)
	}
}

// TestJoinedScope pins scope binding on joins: match:<id> qualifies the
// primary's match_id (an unqualified match_id would be ambiguous across
// the sources) and yields one row per subject of THAT match; an
// unknown-but-valid scope has no subject rows at all (no row the
// statement produced, no row in the preview).
func TestJoinedScope(t *testing.T) {
	st := seededStore(t)

	pv, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: count()"}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped: %v %v (sql: %s)", perr, err, pv.SQL)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("scoped rows = %d, want 8 (one per subject) (%+v)", len(pv.Rows), pv.Rows)
	}
	total := 0
	for _, r := range pv.Rows {
		if r.Value != 1 || r.N != 1 {
			t.Errorf("scoped row %s = %v N %d, want 1 / 1 (one player_stats row per player)", r.Group, r.Value, r.N)
		}
		total += int(r.Value)
	}
	if total != 8 {
		t.Errorf("scoped counts total %d, want 8", total)
	}
	if !strings.Contains(pv.SQL, "WHERE player_stats.match_id = ?") {
		t.Errorf("scope not qualified on the primary:\n%s", pv.SQL)
	}

	empty, perr, err := RunPreview(st, Def{Expr: "from player_stats, match_trade_opps: count()"}, "match:99", 100)
	if perr != nil || err != nil {
		t.Fatalf("empty scope compile/run: %v %v", perr, err)
	}
	if len(empty.Rows) != 0 {
		t.Fatalf("empty-scope preview = %+v, want no rows", empty.Rows)
	}
}

// TestJoinedPopulationAlignment pins the population rule under subject
// addressing: EVERY statement applies humans-only to its subject
// (unconditionally — the mixed-population special case and the
// player-group case collapsed into the one condition, and the former
// "ungrouped records what happened, bots included" boundary is retired
// with them). The bot store carries one human (alice) and one bot in
// player_stats/events; no match_trade_opps rows exist (analytics never
// writes bots — the bot's secondary values would be NULL anyway).
func TestJoinedPopulationAlignment(t *testing.T) {
	st := botStore(t)

	// Joined source set: the bot's player_stats row is dropped through
	// the primary's subject — the only surviving subject is alice.
	grouped, perr, err := RunPreview(st, Def{
		Expr: "from player_stats, match_trade_opps: count()",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("joined: %v %v", perr, err)
	}
	if len(grouped.Rows) != 1 || grouped.Rows[0].Group != aliceID || grouped.Rows[0].Value != 1 {
		t.Fatalf("joined count = %+v, want only alice at 1 (bot dropped)", grouped.Rows)
	}

	// Single-source: the same unconditional rule (the event-shaped
	// "bots stay" exception is gone — an aggregate records human-subject
	// rows only).
	single, perr, err := RunPreview(st, Def{Expr: "from player_stats: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("single-source: %v %v", perr, err)
	}
	if len(single.Rows) != 1 || single.Rows[0].Value != 1 {
		t.Fatalf("single-source count = %+v, want 1 (human only)", single.Rows)
	}

	// All-players source set (events + rounds, both popAllPlayers):
	// unconditional humans-only applies just the same — the bot's kill
	// never becomes a value.
	allPlayers, perr, err := RunPreview(st, Def{Expr: "from events, rounds: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("all-players join: %v %v", perr, err)
	}
	if len(allPlayers.Rows) != 1 || allPlayers.Rows[0].Value != 1 {
		t.Fatalf("all-players join count = %+v, want 1 (human only)", allPlayers.Rows)
	}
}
