package metrics

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// The frozen v1 grammar in positive form — every example must parse and
// compile (whitelist + subject anchor + join rules) without error. There
// is no groupBy argument any more: every statement compiles subject-
// grouped (ModeGrouped) unless the FIRST aggregation is a percentile
// (ModePercentile, Go-partitioned per subject).
func TestParseAndCompileValid(t *testing.T) {
	// The task's canonical multi-aggregation example (doc.go header).
	const canonical = "from events: count() , sum(dmg) , avg(distance) , " +
		"ratio(count(headshot), count()) , stddev(dmg) , percentile(0.95, dmg) , " +
		"min(tick), max(tick)"
	cases := []struct {
		name, expr, denom, scope string
		mode                     PlanMode
	}{
		{"canonical multi-agg", canonical, "", "", ModeGrouped},
		{"filter count", "from events: count(where kind='kill' and headshot)", "", "", ModeGrouped},
		{"implicit truthiness", "from events: count(headshot)", "", "", ModeGrouped},
		{"sum with filter", "from player_stats: sum(where side='ct', total_damage)", "", "", ModeGrouped},
		{"avg dmg", "from player_round_stats: avg(dmg)", "", "", ModeGrouped},
		{"stddev", "from player_round_stats: stddev(dmg)", "", "", ModeGrouped},
		{"percentile", "from events: percentile(0.95, dmg)", "", "", ModePercentile},
		{"median sugar", "from events: median(dmg)", "", "", ModePercentile},
		{"percentile with filter", "from events: percentile(where kind='damage', 0.5, dmg)", "", "", ModePercentile},
		{"percentile first of many", "from events: percentile(0.5, dmg), avg(dmg), count()", "", "", ModePercentile},
		{"ratio nested filter", "from engagements: ratio(count(where kind='trade'), count(where kind='opening'))", "", "", ModeGrouped},
		{"denominator rate", "from player_round_stats: count(where deaths=1 and traded=0)", "rounds", "", ModeGrouped},
		{"matches denom", "from player_stats: count()", "matches", "", ModeGrouped},
		{"rounds denom on player_round_stats", "from player_round_stats: avg(kast)", "rounds", "", ModeGrouped},
		{"match scope", "from events: count()", "", "match:3", ModeGrouped},
		{"avg adr", "from player_stats: avg(adr)", "", "", ModeGrouped},
		{"operator set", "from events: count(where dmg >= 50 and dmg < 100 or not headshot)", "", "", ModeGrouped},
		{"not-equal + parens", "from player_stats: count(where not (side != 'ct'))", "", "", ModeGrouped},
		{"bool literals", "from events: count(where headshot = true)", "", "", ModeGrouped},
		{"negative number", "from events: count(where dmg > -1)", "", "", ModeGrouped},
		{"alias", "from events: count() AS total", "", "", ModeGrouped},
		{"semicolon-free provenance", "from events: count()", "", "", ModeGrouped},
		// Plugin manifest exprs (internal/plugin coordination contract).
		{"plugin plug_count", "from events: count()", "", "", ModeGrouped},
		{"plugin plug_dmg", "from events: sum(dmg)", "", "", ModeGrouped},
		// Multi-source joins (owner design (c)) — engine-derived ON. The
		// round-grain `rounds` stays legal as a JOIN PARTNER of an
		// anchored primary (criterion: what the OUTPUT is).
		{"joined acceptance ratio", "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))", "", "", ModeGrouped},
		{"n:1 join with round-grain partner", "from engagements, rounds: count()", "", "", ModeGrouped},
		{"join with secondary condition", "from engagements, rounds: count(where winner='ct')", "", "", ModeGrouped},
		{"percentile over join (day one)", "from player_stats, match_trade_opps: percentile(0.5, opps)", "", "", ModePercentile},
		{"join + scope", "from player_stats, match_trade_opps: count()", "", "match:3", ModeGrouped},
		{"join + denominator", "from player_stats, match_trade_opps: sum(trade_kills)", "rounds", "", ModeGrouped},
		{"reversed 1:1 pair (secondary value column allowed)", "from match_trade_opps, player_stats: sum(kills)", "", "", ModeGrouped},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := Compile(c.expr, c.denom, c.scope)
			if perr != nil {
				t.Fatalf("Compile(%q): %v", c.expr, perr)
			}
			if plan.Mode != c.mode {
				t.Errorf("mode = %v, want %v (sql: %s)", plan.Mode, c.mode, plan.SQL)
			}
			if strings.Contains(plan.SQL, ";") {
				t.Errorf("compiled SQL must be one statement: %s", plan.SQL)
			}
		})
	}
}

// Negative cases: every failure must be a positioned *ParseError (the
// ExprError contract) and must never reach execution.
func TestParseAndCompileInvalid(t *testing.T) {
	cases := []struct {
		name, expr, denom, scope string
		wantMsg                  string
		wantPos                  bool // expect Pos > 0
	}{
		{"empty", "", "", "", "empty expression", false},
		{"missing from", "count()", "", "", "expected \"from <table>:\"", false},
		{"unknown source", "from sqlite_master: count()", "", "", "unknown source table", true},
		{"no colon", "from events count()", "", "", "expected \":\"", true},
		{"unknown op", "from events: mode(dmg)", "", "", "unknown aggregation", true},
		{"unknown column", "from events: sum(nope)", "", "", "unknown column", true},
		{"unknown cond column", "from events: count(where nope = 1)", "", "", "unknown column", true},
		{"cross-source column", "from engagements: count(where dmg > 0)", "", "", "unknown column", true},
		{"bad percentile p", "from events: percentile(1.5, dmg)", "", "", "must be in [0,1]", true},
		{"bad denominator", "from player_stats: count()", "roundss", "", "unknown denominator", false},
		{"nested ratio", "from events: ratio(ratio(count(), count()), count())", "", "", "cannot be nested", true},
		{"nested percentile in ratio", "from events: ratio(percentile(0.5, dmg), count())", "", "", "cannot be nested", true},
		{"bad scope", "from events: count()", "", "match:abc", "invalid scope", false},
		{"bad scope prefix", "from events: count()", "", "match=3", "invalid scope", false},
		{"unterminated string", "from events: count(where kind='kill)", "", "", "unterminated string", true},
		{"missing comma", "from events: count() count()", "", "", "expected \",\"", true},
		{"keyword as column", "from events: sum(and)", "", "", "keyword", true},
		{"dangling operator", "from events: count(where dmg >)", "", "", "expected a column or literal", true},
		{"empty agg list", "from events:", "", "", "expected aggregation", true},
		{"ratio missing arg", "from events: ratio(count())", "", "", "expected \",\"", true},
		// Multi-source joins — malformed lists, key criterion, ambiguity,
		// value-column rule (owner design (c)).
		{"unknown second source", "from events, sqlite_master: count()", "", "", "unknown source table", true},
		{"duplicate source", "from events, events: count()", "", "", "duplicate source", true},
		{"missing source after comma", "from events, : count()", "", "", "expected source table name", true},
		{"ambiguous column across sources", "from player_stats, match_trade_opps: sum(match_id)", "", "", "ambiguous column", true},
		{"non-unique secondary", "from engagements, events: count()", "", "", "not unique", true},
		{"secondary value column under n:1", "from engagements, rounds: sum(duration_s)", "", "", "not 1:1", true},
		{"retired player_rounds denominator", "from player_stats: count()", "player_rounds", "", "valid: rounds, matches", false},
		// Player-relativity (the anchor): a primary without a subject is
		// rejected right after the source check — the exact copy and
		// position are pinned by TestAnchorValidation.
		{"round-grain primary", "from rounds: count()", "", "", "not player-anchored", true},
		{"side-grain primary", "from round_economy: sum(equip_value)", "", "", "not player-anchored", true},
		{"round-grain primary of a join", "from rounds, events: count()", "", "", "not player-anchored", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, perr := Compile(c.expr, c.denom, c.scope)
			if perr == nil {
				t.Fatalf("Compile(%q) succeeded, want error containing %q", c.expr, c.wantMsg)
			}
			if !strings.Contains(perr.Message, c.wantMsg) {
				t.Errorf("message = %q, want substring %q", perr.Message, c.wantMsg)
			}
			if c.wantPos && perr.Pos <= 0 {
				t.Errorf("Pos = %d, want > 0", perr.Pos)
			}
		})
	}
}

// TestAnchorValidation pins the player-relativity rejection VERBATIM
// (design §3 error copy) and its position (Spec.SourcePos): the message
// the owner ruled on is the message that ships, and the player-source
// list in it is the literal the design carries (TestSchemaConsistency
// pins that list to sourceSubject's keys).
func TestAnchorValidation(t *testing.T) {
	const wantList = "events, engagements, player_stats, player_round_stats, clutches, chat, utility_events, match_trade_opps"
	cases := []struct{ name, expr, primary string }{
		{"rounds primary", "from rounds: count()", "rounds"},
		{"round_economy primary", "from round_economy: sum(equip_value)", "round_economy"},
		{"round-grain primary of a join", "from rounds, events: count()", "rounds"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec, perr := Parse(c.expr)
			if perr != nil {
				t.Fatalf("parse: %v", perr)
			}
			_, perr = Compile(c.expr, "", "")
			if perr == nil {
				t.Fatalf("Compile(%q) succeeded, want anchor rejection", c.expr)
			}
			want := fmt.Sprintf(
				"expression is not player-anchored: primary source %q has no player subject — a metric's value must be per player (player sources: %s; round-grain sources can only join a player-anchored expression)",
				c.primary, wantList)
			if perr.Message != want {
				t.Errorf("message =\n%s\nwant\n%s", perr.Message, want)
			}
			if perr.Pos != spec.SourcePos {
				t.Errorf("Pos = %d, want the source clause at %d", perr.Pos, spec.SourcePos)
			}
		})
	}
	// PRIMARY-OWNS: a round-grain source stays legal as the join PARTNER
	// of an anchored primary wherever joinKey allows (the rule
	// partitions by what the OUTPUT is, not by a source whitelist).
	if _, perr := Compile("from engagements, rounds: count()", "", ""); perr != nil {
		t.Errorf("round-grain join partner rejected: %v", perr)
	}
}

// TestSubjectAddressingEmitted pins the emission every statement shares:
// `subject <> ”` beside THE humans-only condition, on the primary's
// subject column, qualified when the statement joins — phase1 and the
// percentile phase2 fetch alike (no second spelling).
func TestSubjectAddressingEmitted(t *testing.T) {
	cases := []struct {
		name, expr, scope string
		wantSubj          string
		wantHuman         string
	}{
		{"single-source aggregate", "from events: count()", "", "attacker <> ''", "p.steam_id = events.attacker"},
		{"joined primary", "from player_stats, match_trade_opps: count()", "", "player_stats.steam_id <> ''", "p.steam_id = player_stats.steam_id"},
		{"match scope keeps both", "from events: count()", "match:7", "attacker <> ''", "p.steam_id = events.attacker"},
		{"percentile fetch", "from events: percentile(0.5, dmg)", "", "attacker <> ''", "p.steam_id = events.attacker"},
		{"thrower subject", "from utility_events: count()", "", "thrower <> ''", "p.steam_id = utility_events.thrower"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := Compile(c.expr, "", c.scope)
			if perr != nil {
				t.Fatalf("compile: %v", perr)
			}
			for _, want := range []string{c.wantSubj, c.wantHuman} {
				if !strings.Contains(plan.SQL, want) {
					t.Errorf("SQL missing %q:\n%s", want, plan.SQL)
				}
			}
		})
	}
	// A mixed plan carries the condition in BOTH statements (the phase-2
	// fetch and its phase-1 companion).
	plan, perr := Compile("from events: percentile(0.5, dmg), count()", "", "")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	for _, sql := range []string{plan.SQL, plan.Secondary} {
		if !strings.Contains(sql, "attacker <> ''") {
			t.Errorf("statement missing the subject condition:\n%s", sql)
		}
	}
}

// TestDenominatorEmitsByScope pins the denominator rule (one rule, two
// units): match scope counts the MATCH's units as a scalar (unchanged),
// library/profile scope counts the subject's CAREER units correlated on
// the subject.
func TestDenominatorEmitsByScope(t *testing.T) {
	cases := []struct {
		name, expr, denom, scope string
		want                     string
	}{
		{"match scope: the match's rounds", "from player_stats: count()", "rounds", "match:3",
			"(SELECT COUNT(*) FROM rounds WHERE match_id = ?)"},
		{"match scope: the match's matches", "from player_stats: count()", "matches", "match:3",
			"(SELECT COUNT(*) FROM matches WHERE match_id = ?)"},
		{"profile scope: the subject's career rounds", "from player_stats: count()", "rounds", "",
			"(SELECT COUNT(*) FROM player_round_stats AS d WHERE d.steam_id = player_stats.steam_id)"},
		{"profile scope: the subject's career matches", "from player_stats: count()", "matches", "",
			"(SELECT COUNT(*) FROM player_stats AS d WHERE d.steam_id = player_stats.steam_id)"},
		{"profile scope from another primary", "from events: count()", "matches", "",
			"(SELECT COUNT(*) FROM player_stats AS d WHERE d.steam_id = events.attacker)"},
		{"profile scope: career table == the primary's table (the alias keeps it unambiguous)",
			"from player_round_stats: count()", "rounds", "",
			"(SELECT COUNT(*) FROM player_round_stats AS d WHERE d.steam_id = player_round_stats.steam_id)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := Compile(c.expr, c.denom, c.scope)
			if perr != nil {
				t.Fatalf("compile: %v", perr)
			}
			if !strings.Contains(plan.SQL, c.want) {
				t.Errorf("SQL missing %q:\n%s", c.want, plan.SQL)
			}
			if !plan.HasDenom {
				t.Error("plan.HasDenom = false, want true")
			}
			// The denominator wraps the FIRST value column.
			if !strings.Contains(plan.SQL, "1.0*(") || !strings.Contains(plan.SQL, "NULLIF((") {
				t.Errorf("value not wrapped by the denominator:\n%s", plan.SQL)
			}
		})
	}
}

// bobID is the second human of the percentile partition fixture (the
// aliceID/botSteamID pair lives in bot_group_test.go).
const bobID = "76561198000000002"

// pctlStore builds a two-match store whose two humans carry hand-computed
// dmg samples — the partition fixture for TestPercentilePartitionsBySubject
// (the library, match-1 and match-2 medians all differ per subject).
func pctlStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "pctl.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// match 1: alice 10,20,30 · bob 0,100 — match 2: alice 40,60 · bob 10,10,10
	type shot struct {
		match            int
		attacker, victim string
		dmg              int
	}
	shots := []shot{
		{1, aliceID, bobID, 10}, {1, aliceID, bobID, 20}, {1, aliceID, bobID, 30},
		{1, bobID, aliceID, 0}, {1, bobID, aliceID, 100},
		{2, aliceID, bobID, 40}, {2, aliceID, bobID, 60},
		{2, bobID, aliceID, 10}, {2, bobID, aliceID, 10}, {2, bobID, aliceID, 10},
	}
	for _, m := range []int{1, 2} {
		id, err := st.CreateMatchRow(fmt.Sprintf("/d/pctl%d.dem", m), fmt.Sprintf("sha-pctl%d", m), 1)
		if err != nil {
			t.Fatalf("CreateMatchRow: %v", err)
		}
		em := &models.ExtractedMatch{
			Match: models.Match{
				Path: fmt.Sprintf("/d/pctl%d.dem", m), SHA256: fmt.Sprintf("sha-pctl%d", m),
				Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now(),
			},
			Players: []models.Player{
				{SteamID: aliceID, Name: "alice", Side: "ct"},
				{SteamID: bobID, Name: "bob", Side: "t"},
			},
			PlayerStats: []models.PlayerStats{
				{SteamID: aliceID, Name: "alice", Side: "ct", RoundsPlayed: 1},
				{SteamID: bobID, Name: "bob", Side: "t", RoundsPlayed: 1},
			},
		}
		for i, s := range shots {
			if s.match != m {
				continue
			}
			em.Events = append(em.Events, models.Event{
				Seq: i, Tick: 100 + i, Round: 1, Kind: "damage",
				Attacker: s.attacker, Victim: s.victim, Weapon: "ak47", Dmg: s.dmg,
			})
		}
		if err := st.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted: %v", err)
		}
	}
	return st
}

// TestPercentilePartitionsBySubject replaces the retired
// percentile-requires-groupBy cases: a percentile is the p-quantile of
// THE SUBJECT's rows in scope, Go-partitioned by the fetch's address
// ("" scope → per subject, match scope → per subject within the match).
// Every expected value is hand-computed from pctlStore's samples.
func TestPercentilePartitionsBySubject(t *testing.T) {
	st := pctlStore(t)
	const expr = "from events: percentile(0.5, dmg)"
	cases := []struct {
		name, scope string
		groups      []string
		wantVals    []float64
		wantN       []int
	}{
		// alice [10,20,30,40,60] → 30 · bob [0,10,10,10,100] → 10.
		{"library partitions by subject", "", []string{aliceID, bobID}, []float64{30, 10}, []int{5, 5}},
		// match 1: alice [10,20,30] → 20 · bob [0,100] → 50.
		{"match scope partitions its own subjects", "match:1", []string{aliceID, bobID}, []float64{20, 50}, []int{3, 2}},
		// match 2: alice [40,60] → 50 · bob [10,10,10] → 10.
		{"second match partitions differently", "match:2", []string{aliceID, bobID}, []float64{50, 10}, []int{2, 3}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pv, perr, err := RunPreview(st, Def{Expr: expr}, c.scope, 100)
			if perr != nil || err != nil {
				t.Fatalf("preview: %v %v (sql %s)", perr, err, pv.SQL)
			}
			if len(pv.Rows) != len(c.wantVals) {
				t.Fatalf("rows = %d, want %d (%+v)", len(pv.Rows), len(c.wantVals), pv.Rows)
			}
			for i, r := range pv.Rows {
				if r.Group != c.groups[i] {
					t.Errorf("row %d group = %q, want %q (the subject is the address)", i, r.Group, c.groups[i])
				}
				if r.Value != c.wantVals[i] {
					t.Errorf("row %d (%s) value = %v, want %v", i, r.Group, r.Value, c.wantVals[i])
				}
				if r.N != c.wantN[i] {
					t.Errorf("row %d (%s) N = %d, want %d (the subject's own sample)", i, r.Group, r.N, c.wantN[i])
				}
			}
		})
	}
}

// Validate mirrors Compile's checks without producing a plan (builder
// live-check path) — the anchor included, so drafts error like saves.
func TestValidate(t *testing.T) {
	if perr := Validate("from events: count()"); perr != nil {
		t.Fatalf("valid expr rejected: %v", perr)
	}
	if perr := Validate("from events: sum(dmg)"); perr != nil {
		t.Fatalf("valid expr rejected: %v", perr)
	}
	if perr := Validate("from events: sum(whatever)"); perr == nil {
		t.Fatal("unknown column accepted by Validate")
	}
	perr := Validate("from rounds: count()")
	if perr == nil || !strings.Contains(perr.Message, "not player-anchored") {
		t.Fatalf("round-grain primary accepted by Validate: %v", perr)
	}
}

// Scope parsing boundaries.
func TestParseScope(t *testing.T) {
	if id, perr := ParseScope(""); perr != nil || id != 0 {
		t.Errorf("empty scope → (%d, %v), want (0, nil)", id, perr)
	}
	if id, perr := ParseScope("match:42"); perr != nil || id != 42 {
		t.Errorf("match:42 → (%d, %v), want (42, nil)", id, perr)
	}
	for _, bad := range []string{"match:0", "match:-1", "match:", "x:1", "42"} {
		if _, perr := ParseScope(bad); perr == nil {
			t.Errorf("ParseScope(%q) accepted", bad)
		}
	}
}

// Compiled SQL is fully parameterized: no string/number literal from the
// expression survives into the statement text (identifiers come only from
// the whitelists). The only string literal in the text is the engine's
// own `subject <> ”`.
func TestCompiledSQLIsParameterized(t *testing.T) {
	plan, perr := Compile("from events: count(where kind='kill' and dmg >= 50)", "", "match:7")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	for _, forbidden := range []string{"'kill'", "50", "7"} {
		if strings.Contains(plan.SQL, forbidden) {
			t.Errorf("SQL leaks literal %q: %s", forbidden, plan.SQL)
		}
	}
	if len(plan.Args) != 3 { // 'kill', 50, match id
		t.Errorf("args = %v, want 3 binds", plan.Args)
	}
	if plan.Args[0] != "kill" || plan.Args[1] != float64(50) || plan.Args[2] != int64(7) {
		t.Errorf("args = %v, want [kill 50 7]", plan.Args)
	}
}

// TestJoinedSQLIsParameterized extends the parameterization/injection
// property to joined plans: no literal from the expression survives into
// the statement text, binds keep textual order (condition literals
// before the scope id — joins contribute no binds), there is no
// statement separator, and only the expression's own whitelisted tables
// appear in the FROM/JOIN positions.
func TestJoinedSQLIsParameterized(t *testing.T) {
	const expr = "from player_stats, match_trade_opps: count(where kills > 5 and opps >= 10)"
	plan, perr := Compile(expr, "", "match:7")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	// The engine's own `subject <> ''` carries the only quotes in the
	// statement text — they are a fixed literal, never user text.
	for _, forbidden := range []string{"5", "10", "7", ";"} {
		if strings.Contains(plan.SQL, forbidden) {
			t.Errorf("SQL leaks %q: %s", forbidden, plan.SQL)
		}
	}
	if len(plan.Args) != 3 { // kills > 5, opps >= 10, match id (textual order)
		t.Errorf("args = %v, want 3 binds", plan.Args)
	}
	if plan.Args[0] != float64(5) || plan.Args[1] != float64(10) || plan.Args[2] != int64(7) {
		t.Errorf("args = %v, want [5 10 7]", plan.Args)
	}
	// The engine-chosen shape: primary first, LEFT JOIN secondary on the
	// derived key, scope bound on the primary.
	wantJoin := "FROM player_stats LEFT JOIN match_trade_opps ON " +
		"player_stats.match_id = match_trade_opps.match_id AND " +
		"player_stats.steam_id = match_trade_opps.steam_id"
	if !strings.Contains(plan.SQL, wantJoin) {
		t.Errorf("SQL missing join shape %q:\n%s", wantJoin, plan.SQL)
	}
	if !strings.Contains(plan.SQL, "WHERE player_stats.match_id = ?") {
		t.Errorf("scope not bound on the primary:\n%s", plan.SQL)
	}
	// Only whitelisted tables in FROM/JOIN positions: every other known
	// source must not appear anywhere in the statement.
	for _, src := range sources {
		if src == "player_stats" || src == "match_trade_opps" {
			continue
		}
		if strings.Contains(plan.SQL, src) {
			t.Errorf("SQL mentions non-source table %q: %s", src, plan.SQL)
		}
	}
}
