package metrics

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// The subject-axis pins (metrics expansion §6.3/§6.5/§6.6/§6.8 — the
// plan's "every engine capability lands with its own refusal test"
// rule): anchor per declared subject, the profile-path refusal, the
// partition-column rule, the ref subject × subject containment, the
// emission shapes (GROUP key, team row address, per-subject
// denominators) and valuesFromPlan's subject-key mapping.

// mustCompile compiles expr at library scope with addr, failing the
// test on a refusal (the acceptance half of each pin).
func mustCompile(t *testing.T, expr string, addr Address) Plan {
	t.Helper()
	plan, perr := Compile(expr, "", "", addr)
	if perr != nil {
		t.Fatalf("Compile(%q, %+v): %v", expr, addr, perr.Message)
	}
	return plan
}

// refuse compiles and requires THE refusal message fragment (the
// refusal half — every capability gets one).
func refuse(t *testing.T, expr string, addr Address, wantMsg string) {
	t.Helper()
	_, perr := Compile(expr, "", "", addr)
	if perr == nil {
		t.Fatalf("Compile(%q, %+v) succeeded, want refusal containing %q", expr, addr, wantMsg)
	}
	if !strings.Contains(perr.Message, wantMsg) {
		t.Fatalf("Compile(%q, %+v) refusal = %q, want it to contain %q", expr, addr, perr.Message, wantMsg)
	}
}

// TestSubjectEmissionConditionsAndDenominators pins §6.4's humans-only
// generalization (population is about SOURCE ROWS, every subject alike)
// and §6.6's per-subject denominators, alongside the byte-stable player
// shapes the pre-subject tests already pin.
func TestSubjectEmissionConditionsAndDenominators(t *testing.T) {
	// match subject over a player-stamped lead: humans-only applies to
	// the source rows even though the GROUP key is the match.
	plan := mustCompile(t, "from player_stats: sum(kills)", Address{Subject: "match"})
	if !strings.Contains(plan.SQL, store.HumanOnlyBySteamID("player_stats.steam_id", "player_stats.match_id")) {
		t.Errorf("match-subject statement lost the humans-only source-row rule:\n%s", plan.SQL)
	}
	// match subject over a round-grain lead: no player column on the
	// rows → no addressing condition at all (no WHERE to write).
	plan = mustCompile(t, "from rounds: count()", Address{Subject: "match"})
	if strings.Contains(plan.SQL, "WHERE") {
		t.Errorf("round-grain match statement carries a WHERE it has no column for:\n%s", plan.SQL)
	}
	// team subject: team <> '' drops unknown-side rows beside
	// humans-only over the lead's player column when it has one.
	plan = mustCompile(t, "from round_economy: sum(equip_value)", Address{Subject: "team"})
	if !strings.Contains(plan.SQL, "WHERE team <> ''") {
		t.Errorf("team statement does not exclude the unknown-side key:\n%s", plan.SQL)
	}
	plan = mustCompile(t, "from round_player_sides: count()", Address{Subject: "team"})
	if !strings.Contains(plan.SQL, "team <> ''") ||
		!strings.Contains(plan.SQL, store.HumanOnlyBySteamID("round_player_sides.steam_id", "round_player_sides.match_id")) {
		t.Errorf("team statement over a player-stamped lead lost a condition:\n%s", plan.SQL)
	}

	// §6.6 denominators per subject.
	// match subject, library shape: the row's match (aliased — the lead
	// may BE the denominator table).
	denomMatch := mustCompileWithDenom(t, "from round_economy: sum(equip_value)", "rounds", Address{Subject: "match"})
	if !strings.Contains(denomMatch.SQL, "(SELECT COUNT(*) FROM rounds AS d WHERE d.match_id = round_economy.match_id)") {
		t.Errorf("match-subject denominator is not the row's match:\n%s", denomMatch.SQL)
	}
	// team subject: that TEAM's rounds in the row's match — the §5 team
	// stamp on round_player_sides, distinct round count, always
	// correlated (both teams share a match).
	denomTeam := mustCompileWithDenom(t, "from round_economy: sum(equip_value)", "rounds", Address{Subject: "team"})
	if !strings.Contains(denomTeam.SQL,
		"(SELECT COUNT(DISTINCT d.round) FROM round_player_sides AS d WHERE d.match_id = round_economy.match_id AND d.team = round_economy.team)") {
		t.Errorf("team-subject denominator is not the team's rounds:\n%s", denomTeam.SQL)
	}
	// team + matches denominator: the row's own match (a team value
	// spans exactly one match).
	denomTeamM := mustCompileWithDenom(t, "from round_economy: sum(equip_value)", "matches", Address{Subject: "team"})
	if !strings.Contains(denomTeamM.SQL, "(SELECT COUNT(*) FROM matches AS d WHERE d.match_id = round_economy.match_id)") {
		t.Errorf("team/matches denominator wrong:\n%s", denomTeamM.SQL)
	}
}

// mustCompileWithDenom compiles with a denominator option (the refusal
// half stays with refuse elsewhere).
func mustCompileWithDenom(t *testing.T, expr, denom string, addr Address) Plan {
	t.Helper()
	plan, perr := Compile(expr, denom, "", addr)
	if perr != nil {
		t.Fatalf("Compile(%q, denom %q, %+v): %v", expr, denom, addr, perr.Message)
	}
	return plan
}

// TestValuesFromPlanSubjectMapping pins the pass's row-shape adapter:
// the stored subject_key/dim come from the plan's declared addressing —
// a match subject stores ” with its match address, a team subject its
// team key beside the match the shape carries, and a partitioned row
// carries its dim (a numeric row's value_key stays ” — the identity
// writer maps it only on an argmax plan, pinned in
// TestValuesFromPlanIdentityMapping).
func TestValuesFromPlanSubjectMapping(t *testing.T) {
	// match subject, batched: [mid, grp(=match), value, n] → subject_key ''.
	plan := Plan{Mode: ModeGrouped, MatchAddress: true, Subject: "match"}
	rows, err := valuesFromPlan(plan, [][]any{{int64(12), int64(12), float64(3), int64(7)}})
	if err != nil {
		t.Fatalf("valuesFromPlan(match): %v", err)
	}
	if len(rows) != 1 || rows[0].MatchID != 12 || rows[0].SubjectKey != "" || rows[0].Value != 3 || rows[0].N != 7 {
		t.Errorf("match row = %+v, want {MatchID 12 SubjectKey \"\" Value 3 N 7}", rows[0])
	}

	// team subject, batched: [mid, grp(team), value, n].
	plan = Plan{Mode: ModeGrouped, MatchAddress: true, Subject: "team"}
	rows, err = valuesFromPlan(plan, [][]any{{int64(4), "ct", float64(1.5), int64(2)}})
	if err != nil {
		t.Fatalf("valuesFromPlan(team): %v", err)
	}
	if len(rows) != 1 || rows[0].MatchID != 4 || rows[0].SubjectKey != "ct" {
		t.Errorf("team row = %+v, want {MatchID 4 SubjectKey ct}", rows[0])
	}

	// player subject with a partition: [grp, dim, value, n].
	plan = Plan{Mode: ModeGrouped, Subject: "player", Partition: "side"}
	rows, err = valuesFromPlan(plan, [][]any{{"76561198000000001", "ct", float64(9), int64(5)}})
	if err != nil {
		t.Fatalf("valuesFromPlan(partitioned): %v", err)
	}
	if len(rows) != 1 || rows[0].SubjectKey != "76561198000000001" || rows[0].Dim != "ct" || rows[0].ValueKey != "" {
		t.Errorf("partitioned row = %+v, want subject/dim mapped with ValueKey \"\"", rows[0])
	}

	// team subject without the match address cannot happen (emitMid is
	// forced) — the player profile shape stays subject-only at match 0.
	plan = Plan{Mode: ModeGrouped, Subject: "player"}
	rows, err = valuesFromPlan(plan, [][]any{{"76561198000000002", float64(1), int64(3)}})
	if err != nil {
		t.Fatalf("valuesFromPlan(player): %v", err)
	}
	if len(rows) != 1 || rows[0].MatchID != 0 || rows[0].SubjectKey != "76561198000000002" {
		t.Errorf("player row = %+v, want the unchanged career shape", rows[0])
	}
}

// TestSubjectAxisWhitelistPins pins the whitelist declarations the
// subject axis rests on (the TestSchemaConsistency pattern): the team
// anchor list IS exactly "every source whose column whitelist carries
// the team stamp", and the partition columns are real schema columns of
// their canonical carrier tables.
func TestSubjectAxisWhitelistPins(t *testing.T) {
	carryingTeam := map[string]bool{}
	for src, cols := range sourceColumns {
		if cols["team"] {
			carryingTeam[src] = true
		}
	}
	if len(carryingTeam) != len(teamSources) {
		t.Errorf("%d sources carry the team stamp, teamSources lists %d — same set required", len(carryingTeam), len(teamSources))
	}
	for _, src := range teamSources {
		if !carryingTeam[src] {
			t.Errorf("teamSources names %q, which carries no team column", src)
		}
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	schema, err := st.Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	haveTable := map[string]map[string]bool{}
	for _, tb := range schema {
		cols := map[string]bool{}
		for _, c := range tb.Columns {
			cols[c.Name] = true
		}
		haveTable[tb.Name] = cols
	}
	// The partition columns must exist where the grammar reads them.
	for partition, col := range partitionColumns {
		found := false
		for src := range sourceColumns {
			if sourceColumns[src][col] && haveTable[tableFor(src)] != nil && haveTable[tableFor(src)][col] {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("partition %q (column %q) has no source carrying it in the schema", partition, col)
		}
	}
	// Every team anchor source resolves to a real table carrying both
	// its anchor column and its whitelist (subset check for the stamps).
	for _, src := range teamSources {
		if !haveTable[tableFor(src)]["team"] {
			t.Errorf("team anchor source %q has no team column in the schema", src)
		}
	}
}

// player keeps its byte-stable refusal, match accepts a round-grain
// lead (every source carries match_id), team requires the stamped team
// column and refuses anything else with its own message.
func TestSubjectAnchors(t *testing.T) {
	// player: the pre-expansion rule and refusal text, unchanged.
	refuse(t, "from rounds: count()", Address{}, "not player-anchored")

	// match: a round-grain source is a LEGAL lead — grouped by the row's
	// match address (the grp column IS match_id; subject_key stores '').
	plan := mustCompile(t, "from rounds: count()", Address{Subject: "match"})
	if !strings.Contains(plan.SQL, "match_id AS grp") {
		t.Errorf("match-subject SQL does not group by the match address:\n%s", plan.SQL)
	}
	if plan.Subject != "match" || plan.MatchAddress {
		t.Errorf("plan = subject %q MatchAddress %v, want subject match with the preview shape (no mid column)", plan.Subject, plan.MatchAddress)
	}
	// The pass batch leads with the match address explicitly.
	batch, perr := CompilePassMatch("from rounds: count()", "", Address{Subject: "match"}, nil)
	if perr != nil {
		t.Fatalf("CompilePassMatch(match): %v", perr.Message)
	}
	if !batch.MatchAddress || !strings.Contains(batch.SQL, "match_id AS mid, match_id AS grp") ||
		!strings.Contains(batch.SQL, "GROUP BY mid, grp ORDER BY mid, grp") {
		t.Errorf("batched match-subject shape wrong:\n%s", batch.SQL)
	}
	// A match-grain round source may lead; a source without match_id
	// would refuse (none exists today — the message stays pinned).
	refuse(t, "from nope: count()", Address{Subject: "match"}, "unknown source table")

	// team: the stamped team column anchors; a source without it is
	// refused with the team-specific copy listing the team sources.
	teamPlan := mustCompile(t, "from round_economy: sum(equip_value)", Address{Subject: "team"})
	if !strings.Contains(teamPlan.SQL, "team AS grp") {
		t.Errorf("team-subject SQL does not group by the team key:\n%s", teamPlan.SQL)
	}
	if !teamPlan.MatchAddress {
		t.Error("team-subject plan must carry the match address (a team's key is (match, team))")
	}
	_, perr = Compile("from events: count()", "", "", Address{Subject: "team"})
	if perr == nil || !strings.Contains(perr.Message, "not team-anchored") ||
		!strings.Contains(perr.Message, "player_stats, round_economy, round_side_classes, round_player_sides") {
		t.Errorf("team refusal = %v, want the team anchor copy with its source list", perr)
	}
	refuse(t, "from rounds: count()", Address{Subject: "team"}, "not team-anchored")
}

// TestSubjectScopeMatrixRefusals pins the compile-time half of the §3.1
// matrix: profile scope is player-only (a match or team has no career),
// each with the same refusal message wherever a compile happens (save,
// preview, sweep, validation).
func TestSubjectScopeMatrixRefusals(t *testing.T) {
	for _, subject := range []string{"match", "team"} {
		_, perr := Compile("from rounds: count()", "", "",
			Address{Subject: subject, Profile: true})
		if perr == nil {
			t.Fatalf("profile compile with subject %q succeeded, want refusal", subject)
		}
		want := "profile scope is player-only: a " + subject + "-subject metric has no career"
		if !strings.Contains(perr.Message, want) {
			t.Errorf("profile/%s refusal = %q, want %q", subject, perr.Message, want)
		}
	}
	// The player career path stays legal (the existing shape).
	if _, perr := Compile("from player_stats: sum(kills)", "", "",
		Address{Subject: "player", Profile: true}); perr != nil {
		t.Errorf("profile player compile refused: %v", perr.Message)
	}
	// Vocabulary: unknown subject/partition values are friendly errors.
	refuse(t, "from events: count()", Address{Subject: "squad"}, "unknown subject")
	refuse(t, "from events: count()", Address{Partition: "floor"}, "unknown partition")
}

// TestPartitionColumnValidation pins §6.5: every source of a
// partitioned expression must carry the partition column (refusal names
// the first source missing it), and a legal partition joins the group
// shape as the dim column.
func TestPartitionColumnValidation(t *testing.T) {
	// side: player_stats carries it; events does not.
	refuse(t, "from events: count()", Address{Partition: "side"},
		"every source of a partitioned expression must carry the partition column")
	plan := mustCompile(t, "from player_stats: sum(total_damage)", Address{Partition: "side"})
	if !strings.Contains(plan.SQL, "side AS dim") ||
		!strings.Contains(plan.SQL, "GROUP BY grp, dim ORDER BY grp, dim") {
		t.Errorf("side partition did not join the group shape:\n%s", plan.SQL)
	}
	if plan.Partition != "side" {
		t.Errorf("plan.Partition = %q, want side", plan.Partition)
	}

	// map: only player_stats carries the stamp among sources — a second
	// source without it refuses (positioned on the offending source).
	refuse(t, "from player_stats, match_trade_opps: sum(kills)", Address{Partition: "map"},
		"which source \"match_trade_opps\" does not carry")
	mustCompile(t, "from player_stats: sum(total_damage)", Address{Partition: "map"})

	// weapon: events carries it; player_round_stats does not.
	mustCompile(t, "from events: count()", Address{Partition: "weapon"})
	refuse(t, "from player_round_stats: count()", Address{Partition: "weapon"},
		"every source of a partitioned expression must carry the partition column")

	// A partitioned PASS statement groups (mid,) grp, dim.
	batch, perr := CompilePassMatch("from events: count()", "", Address{Subject: "match", Partition: "weapon"}, nil)
	if perr != nil {
		t.Fatalf("CompilePassMatch(partitioned): %v", perr.Message)
	}
	if !strings.Contains(batch.SQL, "GROUP BY mid, grp, dim ORDER BY mid, grp, dim") {
		t.Errorf("batched partitioned group shape wrong:\n%s", batch.SQL)
	}
}

// TestRefSubjectContainment pins §6.8/§3.1 at compile time: a
// reference's subject must be contained by the reading metric's subject
// key — every ILLEGAL pair refuses with the join's own message, every
// legal pair emits the right subject_key key (match refs pin to ”,
// team refs to the dependent's team column, player refs to the player
// column as before).
func TestRefSubjectContainment(t *testing.T) {
	target := func(subject, scope string) map[string]RefTarget {
		return map[string]RefTarget{"upstream": {ID: 7, Scope: scope, Subject: subject, Version: 2, RuleVersion: 3}}
	}
	// Illegal pairs — one refusal each (plan §6's per-capability rule).
	illegal := []struct {
		expr  string
		dep   Address
		ref   string // subject of the ref
		scope string
	}{
		{"from events: metric('upstream')", Address{}, "team", "match"},                         // player reads team
		{"from rounds: metric('upstream')", Address{Subject: "match"}, "team", "match"},         // match reads team
		{"from rounds: metric('upstream')", Address{Subject: "match"}, "player", "match"},       // match reads player
		{"from round_economy: metric('upstream')", Address{Subject: "team"}, "player", "match"}, // team reads player
	}
	for _, c := range illegal {
		_, perr := CompileRefs(c.expr, "", "", c.dep, target(c.ref, c.scope))
		if perr == nil {
			t.Fatalf("CompileRefs(%q, dep %q, ref %q) succeeded, want refusal", c.expr, c.dep.Subject, c.ref)
		}
		depSubject := c.dep.Subject // "" normalizes to player at compile (Address.normalize)
		if depSubject == "" {
			depSubject = "player"
		}
		want := "metric 'upstream' is " + c.ref + "-subject and cannot be used inside a " + depSubject + "-subject metric"
		if !strings.Contains(perr.Message, want) {
			t.Errorf("refusal = %q, want %q", perr.Message, want)
		}
	}

	// Legal pairs — the emitted subject_key key per REF subject (the
	// join's key follows the referenced rows' stored key shape).
	legal := []struct {
		expr     string
		dep      Address
		ref      string
		scope    string
		wantKey  string
		wantRide string // match_id key expression
	}{
		// player → player: the primary's player column (the
		// byte-stable pre-expansion join).
		{"from events: metric('upstream')", Address{}, "player", "match",
			"md0.subject_key = events.attacker", "events.match_id"},
		// player → match: the dependent rides its own match; the match
		// rows' subject_key is ''.
		{"from events: metric('upstream')", Address{}, "match", "match",
			"md0.subject_key = ''", "events.match_id"},
		// match → match: same key, any lead.
		{"from rounds: metric('upstream')", Address{Subject: "match"}, "match", "match",
			"md0.subject_key = ''", "rounds.match_id"},
		// team → team: the dependent's team column.
		{"from round_economy: metric('upstream')", Address{Subject: "team"}, "team", "match",
			"md0.subject_key = round_economy.team", "round_economy.match_id"},
		// team → match: the team row pins its match and '' key.
		{"from round_economy: metric('upstream')", Address{Subject: "team"}, "match", "match",
			"md0.subject_key = ''", "round_economy.match_id"},
	}
	for _, c := range legal {
		plan, perr := CompileRefs(c.expr, "", "", c.dep, target(c.ref, c.scope))
		if perr != nil {
			t.Fatalf("CompileRefs(%q, dep %q, ref %q): %v", c.expr, c.dep.Subject, c.ref, perr.Message)
		}
		if !strings.Contains(plan.SQL, c.wantKey) {
			t.Errorf("dep %q ref %q: SQL lacks %q:\n%s", c.dep.Subject, c.ref, c.wantKey, plan.SQL)
		}
		if !strings.Contains(plan.SQL, "md0.match_id = "+c.wantRide) {
			t.Errorf("dep %q ref %q: SQL lacks ride %q:\n%s", c.dep.Subject, c.ref, "md0.match_id = "+c.wantRide, plan.SQL)
		}
	}
}
