package store

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// metricColumnsContract is the coordination contract with
// platform_store.go (its metricsTableDDL must stay column-compatible).
// The pragma order below IS the schema.sql column order — drift breaks
// the plugin writer's explicit INSERT list.
//
// NO-HISTORY ruling (stored-metrics owner ruling, 2026-11-13): definitions
// are ONE current row — this list must gain NO shadow/last-expression
// column, no history table's worth of copies. A future "keep the old
// expression" column (or any other definition-history column) is a
// CONTRACT VIOLATION and must fail this test; computed values keep only
// their current generation (metric_values), never definitions.
var metricColumnsContract = []string{
	"id", "name", "title", "short_name", "expr", "scope", "subject", "partition", "format", "doc", "origin",
	"plugin_id", "touched", "version", "created_at", "held",
}

// schemaSeededBuiltins is the schema.sql seed's per-row contract: every
// builtin's scope, format and short_name (design §3.0's candidates→
// seeds table, grown by the 42-row inferred set — 67 match / 20
// profile after the 2026-11-17 plan §7 M3 re-pin (+2 match:
// dmg_no_kill, kill_conversion), the owner Option A extension
// (+16 match +6 profile raw count seeds, 2026-11-17) and the
// subject-axis addendum (+3 match +1 profile — plan §8 (M8/M4 rows),
// 2026-11-17: the first non-player subjects, pinned by
// nonPlayerSubjects below) and the identity addendum (+5 match,
// format=identity — plan §8 (M1 identity row), 2026-11-17: 92
// builtins / 72 match + 20 profile) and the partition addendum
// (+5 side +5 map profile rows — plan §8 (M5/M6 rows), 2026-11-17: 102
// builtins / 72 match + 30 profile) and the weapon addendum (+2
// profile, partition='weapon' — plan §8 (M7 row) behind the M7 gate,
// 2026-11-17: 104 builtins / 72 match + 32 profile) and the grammar
// addendum (+2 match — plan §8 (M8 rows), 2026-11-17: 106 builtins /
// 74 match + 32 profile, the two deferred M8 rows over the next()
// window and diff()) and the M7 weapon-damage flip (+1 profile —
// plan §8 (M7 row), 2026-11-18: 107 builtins / 74 match + 33 profile,
// the capped_dmg ingest stamp closed the gate and the damage column
// migrated) and the view-aggregate relocation addendum (+2 match,
// ME8 exception audit, 2026-11-18: 109 builtins / 76 match +
// 33 profile — the force card's team count pairs, cited to the
// view-aggregate rule); short_name is
// written only where a
// header is width-constrained, so trade_rate and most inferred rows
// ship ”). The
// fixture VALUES/exprs live in internal/metrics' fixture test; this map
// is the store-side pin that every row lands with the shape the seed
// declares.
var schemaSeededBuiltins = map[string]struct{ scope, format, shortName string }{
	// match scope (48) — trade_rate + the scoreboard/Combat conversions
	// (w13d added kda, the scoreboard's KDA conversion; plan §7 M3
	// added dmg_no_kill + kill_conversion).
	"trade_rate":        {"match", "percent", ""},
	"adr":               {"match", "float1", "ADR"},
	"entry_rate":        {"match", "percent", "Entry%"},
	"hs_pct":            {"match", "percent", "HS%"},
	"kast":              {"match", "percent", "KAST%"},
	"kd":                {"match", "float2", "K/D"},
	"trade_rate_deaths": {"match", "percent", "Trade%"},
	"kda":               {"match", "float2", "KDA"},
	// profile scope (13) — the career set, inert until W3 switches the
	// profile surface to it.
	"career_adr":                 {"profile", "float1", "ADR"},
	"career_adr_sigma":           {"profile", "float1", "ADR σ"},
	"career_avg_enemies_flashed": {"profile", "float1", "Flash"},
	"career_avg_util_damage":     {"profile", "float1", "Util"},
	"career_clutch_win_rate":     {"profile", "percent", "CW%"},
	"career_hs_pct":              {"profile", "percent", "HS%"},
	"career_kast":                {"profile", "percent", "KAST%"},
	"career_kd":                  {"profile", "float2", "K/D"},
	"career_trade_rate":          {"profile", "percent", "Trade%"},
	// inferred set — match scope (27): the stored per-match stats; only
	// the nine width-constrained scoreboard columns ship a short_name.
	"assists":            {"match", "int", "A"},
	"flash_assists":      {"match", "int", ""},
	"enemies_flashed":    {"match", "int", ""},
	"entry_kills":        {"match", "int", "Open K"},
	"entry_deaths":       {"match", "int", "Open D"},
	"best_streak":        {"match", "int", "Streak"},
	"two_k":              {"match", "int", "2K"},
	"three_k":            {"match", "int", "3K"},
	"four_k":             {"match", "int", "4K"},
	"five_k":             {"match", "int", "5K"},
	"rounds_with_assist": {"match", "int", ""},
	"rounds_traded":      {"match", "int", ""},
	"trade_kills":        {"match", "int", "Trade"},
	"missed_trades":      {"match", "int", ""},
	"eng_opening":        {"match", "int", ""},
	"eng_trade":          {"match", "int", ""},
	"eng_traded":         {"match", "int", ""},
	"eng_untraded":       {"match", "int", ""},
	"clutches":           {"match", "int", ""},
	"clutch_win_rate":    {"match", "percent", ""},
	"clutch_avg_size":    {"match", "float1", ""},
	"clutch_avg_hp":      {"match", "float1", ""},
	"clutch_avg_equip":   {"match", "currency", ""},
	"util_nades":         {"match", "int", ""},
	"util_dmg":           {"match", "int", ""},
	"util_flash_ms":      {"match", "int", ""},
	"weapon_drops":       {"match", "int", ""},
	// inferred set — profile scope (1).
	"career_clutches": {"profile", "int", ""},
	// inferred set — T2 (10): counts over the stored round/side labels.
	"round_label_eco":   {"match", "int", ""},
	"round_label_force": {"match", "int", ""},
	"round_label_full":  {"match", "int", ""},
	"round_label_save":  {"match", "int", ""},
	"pistol_rounds":     {"match", "int", ""},
	"side_class_eco":    {"match", "int", ""},
	"side_class_force":  {"match", "int", ""},
	"side_class_full":   {"match", "int", ""},
	"side_class_save":   {"match", "int", ""},
	"side_class_pistol": {"match", "int", ""},
	// addendum — the victim-side duel count (1, match) and the
	// opening-duel trio (3, profile).
	"untraded_deaths":     {"match", "int", ""},
	"career_opening_rate": {"profile", "percent", ""},
	"career_openings":     {"profile", "int", ""},
	"career_opener_wins":  {"profile", "int", ""},
	// addendum — the M3 combat-damage conversions (2, match): plan
	// §7 M3/§8's 2026-11-17 re-pin (61 builtins / 48 match + 13
	// profile). Friendly fire never became a seed — its tombstone is
	// combat_equivalence_test.go's header.
	"dmg_no_kill":     {"match", "int", ""},
	"kill_conversion": {"match", "percent", ""},
	// addendum — the Option A count addendum (22: 16 match raw-count
	// rows + 6 profile) — owner Option A extension, 2026-11-17 (at that
	// re-pin: 83 builtins / 64 match + 19 profile). The
	// opening_kills/opening_deaths twins were retired with their
	// columns on 2026-11-18 (they duplicated entry_kills/entry_deaths —
	// one first-blood branch in extract); wins stays plan-owned (Phase 3's
	// `won` stamp); score stays unseeded (game-internal composite).
	"kills":               {"match", "int", "K"},
	"deaths":              {"match", "int", "D"},
	"mvps":                {"match", "int", "MVPs"},
	"total_damage":        {"match", "int", "DMG"},
	"utility_damage":      {"match", "int", "Util"},
	"headshots":           {"match", "int", ""},
	"teamkills":           {"match", "int", ""},
	"suicides":            {"match", "int", ""},
	"damage_taken":        {"match", "int", ""},
	"shots":               {"match", "int", ""},
	"hits":                {"match", "int", ""},
	"rounds_played":       {"match", "int", ""},
	"flashed_times":       {"match", "int", ""},
	"bomb_plants":         {"match", "int", ""},
	"bomb_defuses":        {"match", "int", ""},
	"money_spent_total":   {"match", "int", ""},
	"career_kills":        {"profile", "int", ""},
	"career_deaths":       {"profile", "int", ""},
	"career_assists":      {"profile", "int", ""},
	"career_mvps":         {"profile", "int", ""},
	"career_total_damage": {"profile", "int", ""},
	"career_matches":      {"profile", "int", ""},
	// addendum — the subject-axis rows (4: 3 match + 1 profile) —
	// plan §8 (M8/M4 rows), 2026-11-17 (87 builtins / 67 match +
	// 20 profile). The plan's other two M8 rows (pistol_hold,
	// avg_equip_gap) were reported NOT expressible in the grammar
	// here; they land in the grammar addendum below.
	"lost_equip":          {"match", "currency", ""},
	"team_force_win_rate": {"match", "percent", ""},
	"team_lost_equip":     {"match", "currency", ""},
	"win_pct":             {"profile", "percent", ""},
	// addendum — the M1 identity rows (5, match, format=identity) —
	// plan §8 (M1 identity row), 2026-11-17 (92 builtins / 72 match +
	// 20 profile): argmax over the M1 stat, subject pinned by
	// nonPlayerSubjects below.
	"top_fragger": {"match", "identity", ""},
	"best_adr":    {"match", "identity", ""},
	"most_util":   {"match", "identity", ""},
	"entry_opens": {"match", "identity", ""},
	"most_mvps":   {"match", "identity", ""},
	// addendum — the partition rows (10 + 2, profile, partition written
	// explicitly) — plan §8 (M5/M6 rows) and §8 (M7 row) behind the M7
	// gate, 2026-11-17 (104 builtins / 72 match + 32 profile): the
	// Sides, Maps and (kills/headshots) Weapons tables' stored twins,
	// every one player-subject with a side/map/weapon partition.
	"side_rounds":  {"profile", "int", ""},
	"side_win_pct": {"profile", "percent", ""},
	"side_adr":     {"profile", "float1", ""},
	"side_kast":    {"profile", "percent", ""},
	"side_kd":      {"profile", "float2", ""},
	"map_matches":  {"profile", "int", ""},
	"map_wins":     {"profile", "int", ""},
	"map_win_pct":  {"profile", "percent", ""},
	"map_adr":      {"profile", "float1", ""},
	"map_kd":       {"profile", "float2", ""},
	// addendum — the M7 weapon rows (3, profile, partition='weapon') —
	// plan §8 (M7 row), 2026-11-17: the two columns the golden gate
	// proved exactly equal to the fold; the damage column escalated,
	// then FLIPPED 2026-11-18 — the capped_dmg ingest stamp closed the
	// gate (107 builtins / 74 match + 33 profile), so all three ship.
	"weapon_kills":     {"profile", "int", ""},
	"weapon_damage":    {"profile", "int", ""},
	"weapon_headshots": {"profile", "int", ""},
	// addendum — the grammar rows (2, match) — plan §8 (M8 rows),
	// 2026-11-17 (106 builtins / 74 match + 32 profile at that point;
	// the 2026-11-18 M7 weapon-damage flip re-pins 107 / 74 + 33):
	// the two M8
	// rows Phase 4 deferred as inexpressible, over the next() round
	// window and the diff() row difference.
	"pistol_hold":   {"match", "percent", ""},
	"avg_equip_gap": {"match", "currency", ""},
	// addendum — the view-aggregate relocation rows (2, match scope,
	// subject=team) — ME8 exception audit, 2026-11-18 (109 builtins /
	// 76 match + 33 profile): the force card's per-team won/total
	// count pairs, subject pinned by nonPlayerSubjects below.
	"team_force_wins":   {"match", "int", ""},
	"team_force_rounds": {"match", "int", ""},
	// addendum — the raw-SQL fold seeds (33, match scope, subject=player
	// or match). Each row is pinned here like the
	// sugar seeds; the statements run through the raw dispatch (raw_seed_test.go).
	"raw_rounds_played":         {"match", "int", ""},
	"raw_kills_by_weapon":       {"match", "int", ""},
	"raw_round_kills":           {"match", "int", ""},
	"raw_round_assists":         {"match", "int", ""},
	"raw_round_deaths":          {"match", "int", ""},
	"raw_round_survived":        {"match", "int", ""},
	"raw_round_dmg":             {"match", "int", ""},
	"raw_round_util_dmg":        {"match", "int", ""},
	"raw_round_won":             {"match", "int", ""},
	"raw_round_duration_s":      {"match", "float2", ""},
	"alive_count":               {"match", "int", ""},
	"clutch":                    {"match", "int", ""},
	"raw_round_econ_series":     {"match", "currency", ""},
	"raw_round_side_deaths":     {"match", "int", ""},
	"raw_round_side_util_dmg":   {"match", "int", ""},
	"raw_round_side_blind_ms":   {"match", "int", ""},
	"raw_round_side_money_mean": {"match", "currency", ""},
	"raw_round_util_summary":    {"match", "int", ""},
	// addendum — round-grain deaths per player:
	// the Economy view reads it through the round read, keyed by the side.
	"raw_player_round_deaths": {"match", "int", ""},
	// per-match inputs of the per-player profile metrics (ruling 48): one
	// row per player per match, the splits carry the map/side/weapon dim.
	"match_won":              {"match", "int", ""},
	"match_trade_opps":       {"match", "int", ""},
	"match_clutch_wins":      {"match", "int", ""},
	"match_kast_flags":       {"match", "int", ""},
	"match_rounds":           {"match", "int", ""},
	"match_map_won":          {"match", "int", ""},
	"match_map_rounds":       {"match", "int", ""},
	"match_map_damage":       {"match", "int", ""},
	"match_map_kills":        {"match", "int", ""},
	"match_map_deaths":       {"match", "int", ""},
	"match_side_rounds":      {"match", "int", ""},
	"match_side_won":         {"match", "int", ""},
	"match_side_kast":        {"match", "int", ""},
	"match_side_kills":       {"match", "int", ""},
	"match_side_deaths":      {"match", "int", ""},
	"match_side_dmg":         {"match", "int", ""},
	"match_weapon_kills":     {"match", "int", ""},
	"match_weapon_headshots": {"match", "int", ""},
	"match_weapon_damage":    {"match", "int", ""},
}

// nonPlayerSubjects is the subject-axis pin beside the shape map: the
// seed's DECLARED subject per builtin — every row not named here is a
// player-subject row (the DDL default), asserted for ALL builtins in
// TestMetricsSchemaFreshOpen. plan §8 (M8/M4 rows), 2026-11-17; the
// five identity rows (plan §8 M1, same day) are match-subject too.
var nonPlayerSubjects = map[string]string{
	"lost_equip":                "match",
	"team_force_win_rate":       "team",
	"team_lost_equip":           "team",
	"top_fragger":               "match",
	"best_adr":                  "match",
	"most_util":                 "match",
	"entry_opens":               "match",
	"most_mvps":                 "match",
	"pistol_hold":               "match", // plan §8 (M8 rows), 2026-11-17
	"avg_equip_gap":             "match", // plan §8 (M8 rows), 2026-11-17
	"team_force_wins":           "team",  // ME8 exception audit, 2026-11-18
	"team_force_rounds":         "team",  // ME8 exception audit, 2026-11-18
	"raw_round_duration_s":      "match", // F2 raw seed: per match round, no player subject
	"alive_count":               "team",  // alive-count situation family: subject = side
	"raw_round_econ_series":     "team",  // B7 round-grain series: subject = side
	"raw_round_side_deaths":     "team",  // B7 round-grain series: subject = side
	"raw_round_side_util_dmg":   "team",  // B7 round-grain series: subject = side
	"raw_round_side_blind_ms":   "team",  // B7 round-grain series: subject = side
	"raw_round_side_money_mean": "team",  // B7 round-grain series: subject = side
	"raw_round_util_summary":    "match", // B7 per-round utility summary: no side subject
}

// TestMetricsSchemaFreshOpen: a fresh Open creates the M5 tables and
// seeds the ninety-two builtin metrics (the Option A extension, the
// subject-axis addendum and the identity addendum on top of the
// sixty-one re-pin — plan §8, 2026-11-17); a second Open re-applies the
// baseline as a no-op — the seed INSERT is idempotent, so no builtin
// rows are duplicated (and the 76 rows added after the original seed —
// the 42-row inferred set, w13d's kda, the M3 combat-damage pair, the
// owner Option A count addendum's 22, the subject-axis addendum's 4
// and the identity addendum's 5, 2026-11-17 — are exactly the ones an
// older seed reaches through the same OR IGNORE) —
// and the metrics column contract plus the
// builtin set still hold.
func TestMetricsSchemaFreshOpen(t *testing.T) {
	s, path := openFileStore(t)
	for _, table := range []string{"metrics", "metric_values", "metric_deps", "query_history", "saved_queries"} {
		var name string
		if err := s.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s missing on fresh Open: %v", table, err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() {
		_ = s2.CloseRO()
		_ = s2.Close()
	})

	for _, table := range []string{"metrics", "metric_values", "metric_deps", "query_history", "saved_queries"} {
		var name string
		if err := s2.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s missing after reopen: %v", table, err)
		}
	}

	// Column contract (platform_store.go coordination).
	rows, err := s2.db.Query(`SELECT name FROM pragma_table_info('metrics')`)
	if err != nil {
		t.Fatalf("pragma_table_info: %v", err)
	}
	var got []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, n)
	}
	rows.Close()
	if len(got) != len(metricColumnsContract) {
		t.Fatalf("metrics columns = %v, want %v", got, metricColumnsContract)
	}
	for i, n := range got {
		if n != metricColumnsContract[i] {
			t.Errorf("metrics column %d = %q, want %q", i, n, metricColumnsContract[i])
		}
	}

	// The one-hundred-nine builtins, name + doc present — still exactly
	// one hundred nine AFTER the reopen, so the baseline's seed did not
	// duplicate rows (values validated by internal/metrics fixture
	// tests). Scope split
	// (76 match / 33 profile after the 2026-11-18 view-aggregate
	// relocation re-pin — ME8 exception audit; the M7 weapon-damage
	// flip had re-pinned 74 / 33, the grammar addendum
	// 74 / 32, the weapon addendum
	// 72 / 32, the partition addendum
	// re-pinned 72 / 30, the identity addendum
	// re-pinned 72 / 20, the subject-axis 67 / 20, Option A 64 / 19,
	// M3 48 / 13)
	// and short_name/format are PER-SEED asserts
	// (the old blanket "all match / all short_name empty" held only when
	// there was one row — design §3.4's pin table).
	list, err := s2.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(list) != len(schemaSeededBuiltins) {
		t.Fatalf("builtin count after reopen = %d, want %d (no duplicate seed rows)",
			len(list), len(schemaSeededBuiltins))
	}
	want := map[string]bool{}
	for name := range schemaSeededBuiltins {
		want[name] = true
	}
	for _, m := range list {
		if m.Origin != "builtin" {
			t.Errorf("metric %q origin = %q, want builtin", m.Name, m.Origin)
		}
		seeded, ok := schemaSeededBuiltins[m.Name]
		if !ok {
			t.Errorf("unexpected builtin %q", m.Name)
			continue
		}
		if !want[m.Name] {
			t.Errorf("unexpected builtin %q", m.Name)
		}
		if m.Doc == "" {
			t.Errorf("builtin %q has empty doc", m.Name)
		}
		if m.ShortName != seeded.shortName {
			t.Errorf("builtin %q short_name = %q, want %q",
				m.Name, m.ShortName, seeded.shortName)
		}
		if m.Scope != seeded.scope {
			t.Errorf("builtin %q scope = %q, want %q (the seed writes the per-row scope — 76 match / 33 profile)",
				m.Name, m.Scope, seeded.scope)
		}
		wantSubject := "player"
		if subj, ok := nonPlayerSubjects[m.Name]; ok {
			wantSubject = subj
		}
		if m.Subject != wantSubject {
			t.Errorf("builtin %q subject = %q, want %q (the seed's addressing — plan §8 (M8/M4 rows), 2026-11-17)",
				m.Name, m.Subject, wantSubject)
		}
		if m.Format != seeded.format {
			t.Errorf("builtin %q format = %q, want %q", m.Name, m.Format, seeded.format)
		}
		if m.Version != 1 {
			t.Errorf("builtin %q version = %d, want 1 (the seed omits the column — DEFAULT 1)", m.Name, m.Version)
		}
		// Builtins are raw SQL: one SELECT.
		if !strings.HasPrefix(m.Expr, "SELECT ") && !strings.HasPrefix(m.Expr, "WITH ") {
			t.Errorf("builtin %q expr %q is not a raw SELECT or WITH", m.Name, m.Expr)
		}
	}
}

// TestMetricCRUD covers create/list ordering/uniqueness/update
// protection/delete protection — the API surface metricservice wraps.
func TestMetricCRUD(t *testing.T) {
	s := openMem(t)

	created, err := s.CreateMetric(models.MetricRow{
		Name: "my_rate", Title: "My rate", ShortName: "MR", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events",
		Scope: "profile", Format: "int", Doc: "d", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if created.ID == 0 || created.CreatedAt.IsZero() {
		t.Fatalf("created row = %+v, want id + created_at set", created)
	}
	if created.ShortName != "MR" {
		t.Fatalf("created short_name = %q, want %q (round-trip through the new column)", created.ShortName, "MR")
	}
	if created.Scope != "profile" {
		t.Fatalf("created scope = %q, want %q (round-trip through the new column — not the DEFAULT)", created.Scope, "profile")
	}
	if created.Version != 1 {
		t.Fatalf("created version = %d, want 1 (INSERT omits the column — DEFAULT 1)", created.Version)
	}

	// Uniqueness across ALL origins: colliding with a builtin is rejected
	// with the friendly message (SaveMetric's builtin-collision rule).
	if _, err := s.CreateMetric(models.MetricRow{Name: "trade_rate", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("builtin-name collision err = %v, want friendly uniqueness error", err)
	}
	if _, err := s.CreateMetric(models.MetricRow{Name: "my_rate", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate-name err = %v, want friendly uniqueness error", err)
	}

	// List: builtins first (all one-hundred-four schema-seeded rows), then
	// user rows.
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(all) != len(schemaSeededBuiltins)+1 {
		t.Fatalf("list len = %d, want %d (146 builtins + my_rate)", len(all), len(schemaSeededBuiltins)+1)
	}
	for i, m := range all[:len(schemaSeededBuiltins)] {
		if m.Origin != "builtin" {
			t.Fatalf("list position %d = %s/%s, want the builtin group first", i, m.Origin, m.Name)
		}
	}
	if last := all[len(all)-1]; last.Name != "my_rate" || last.Origin != "user" {
		t.Fatalf("list order wrong: last = %s/%s, want user/my_rate", last.Origin, last.Name)
	}

	// Update user metric (scope is written through; version is NOT bumped
	// by the store in W1 — the semantic-edit bump lands with the
	// save-side cascade wave).
	updated, err := s.UpdateMetric(models.MetricRow{
		ID: created.ID, Name: "my_rate", Title: "Renamed", ShortName: "MR2", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id",
		Scope: "match", Origin: "user",
	})
	if err != nil {
		t.Fatalf("UpdateMetric: %v", err)
	}
	if updated.Title != "Renamed" || updated.Expr != "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id" || updated.ShortName != "MR2" {
		t.Fatalf("updated = %+v", updated)
	}
	if updated.Scope != "match" {
		t.Fatalf("updated scope = %q, want match (UPDATE writes scope through)", updated.Scope)
	}
	if updated.Version != 1 {
		t.Fatalf("updated version = %d, want 1 (no bump on update in W1)", updated.Version)
	}

	// Builtin + plugin rows are immutable through Update/Delete.
	var builtinID int64
	for _, m := range all {
		if m.Origin == "builtin" {
			builtinID = m.ID
			break
		}
	}
	if _, err := s.UpdateMetric(models.MetricRow{ID: builtinID, Name: "x", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"}); err == nil || !strings.Contains(err.Error(), "cannot be modified") {
		t.Errorf("builtin update err = %v, want immutability error", err)
	}
	if err := s.DeleteMetric(builtinID); err == nil || !strings.Contains(err.Error(), "cannot be deleted") {
		t.Errorf("builtin delete err = %v, want protection error", err)
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{{Name: "plug_a", Title: "A", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"}}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	var pluginMetric models.MetricRow
	for _, m := range mustList(t, s) {
		if m.Origin == "plugin" {
			pluginMetric = m
		}
	}
	if pluginMetric.ID == 0 {
		t.Fatal("plugin metric row missing from ListMetrics")
	}
	if pluginMetric.ShortName != "" {
		t.Errorf("plugin metric short_name = %q, want empty (ReplacePluginMetrics omits the column — DEFAULT '')", pluginMetric.ShortName)
	}
	if pluginMetric.Scope != "match" {
		t.Errorf("plugin metric scope = %q, want match (plugin manifests carry no scope yet — the INSERT omits the column, DEFAULT 'match')", pluginMetric.Scope)
	}
	if pluginMetric.Version != 1 {
		t.Errorf("plugin metric version = %d, want 1 (the INSERT omits the column — DEFAULT 1)", pluginMetric.Version)
	}
	if _, err := s.UpdateMetric(models.MetricRow{ID: pluginMetric.ID, Name: "hijack", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"}); err == nil || !strings.Contains(err.Error(), "cannot be modified") {
		t.Errorf("plugin update err = %v, want immutability error", err)
	}
	// Plugin rows ARE deletable via the generic path (host re-seeds on enable).
	if err := s.DeleteMetric(pluginMetric.ID); err != nil {
		t.Errorf("plugin delete: %v", err)
	}

	// Delete user metric; unknown id → ErrNotFound.
	if err := s.DeleteMetric(created.ID); err != nil {
		t.Fatalf("DeleteMetric: %v", err)
	}
	if _, err := s.GetMetric(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetMetric after delete = %v, want ErrNotFound", err)
	}
	if err := s.DeleteMetric(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteMetric(unknown) = %v, want ErrNotFound", err)
	}
	if err := s.DeleteMetric(builtinID); err == nil {
		t.Error("builtin still deletable after user delete")
	}
}

func mustList(t *testing.T, s *Store) []models.MetricRow {
	t.Helper()
	rows, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	return rows
}

// --- ListMetricsPage (the Builder list's keyset "Load more" window) ---------

// seedUserMetric creates a user metric (title defaults to the name) and
// returns its id.
func seedUserMetric(t *testing.T, s *Store, name, title string) int64 {
	t.Helper()
	if title == "" {
		title = name
	}
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: title, Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m.ID
}

// metricRowsRef reads the unbounded ListMetrics list — the reference
// every window walk is compared against (same canonical order).
func metricRowsRef(t *testing.T, s *Store) []models.MetricRow {
	t.Helper()
	return mustList(t, s)
}

// metricIDs is the rows' ids in order.
func metricIDs(rows []models.MetricRow) []int64 {
	ids := make([]int64, 0, len(rows))
	for _, m := range rows {
		ids = append(ids, m.ID)
	}
	return ids
}

// walkMetricPage drains every window from afterID for query under the
// origin/scope/denominator/format filters, returning each window's row
// count and the concatenated rows in order. Fails on a runaway loop (a
// cursor that never advances would spin).
func walkMetricPage(t *testing.T, s *Store, query string, originFilter string, scopeFilter string, subjectFilter string, formatFilter string, afterID int64, limit int) (sizes []int, rows []models.MetricRow) {
	t.Helper()
	seen := 0
	for {
		page, err := s.ListMetricsPage(query, originFilter, scopeFilter, subjectFilter, formatFilter, afterID, limit)
		if err != nil {
			t.Fatalf("ListMetricsPage(query=%q, origin=%q, scope=%q, format=%q, after=%d): %v", query, originFilter, scopeFilter, formatFilter, afterID, err)
		}
		sizes = append(sizes, len(page.Rows))
		rows = append(rows, page.Rows...)
		if !page.HasNext {
			return sizes, rows
		}
		if len(page.Rows) == 0 {
			t.Fatalf("window after=%d reported HasNext with no rows", afterID)
		}
		afterID = page.Rows[len(page.Rows)-1].ID
		if seen++; seen > 1000 {
			t.Fatalf("paging did not terminate after 1000 windows")
		}
	}
}

// originRank mirrors metricOriginRank for the contiguity assertion.
func originRank(origin string) int {
	switch origin {
	case "builtin":
		return 0
	case "user":
		return 1
	default:
		return 2
	}
}

// filterMetricRef is ListMetricsPage's search predicate as the Go-side
// reference (LIKE over name/title, ASCII case-insensitive) — the filtered
// list every filtered walk is compared against.
func filterMetricRef(rows []models.MetricRow, query string) []models.MetricRow {
	q := strings.ToLower(query)
	var out []models.MetricRow
	for _, m := range rows {
		if strings.Contains(strings.ToLower(m.Name), q) || strings.Contains(strings.ToLower(m.Title), q) {
			out = append(out, m)
		}
	}
	return out
}

// TestListMetricsPageWindowsTileListOrder: 342 definitions (109
// schema-seeded builtins + 230 user + 3 plugin — the 109 is the
// 2026-11-18 view-aggregate relocation, ME8 exception audit; the M7
// weapon-damage flip had pinned 107) must
// tile into 100/100/100/40 windows that concatenate to ListMetrics' exact order, every
// id exactly once, with each origin group CONTIGUOUS across window
// boundaries — the Builder renders its Builtins/Yours/Plugins headers
// from those runs, so a boundary splitting a group must not reorder rows.
func TestListMetricsPageWindowsTileListOrder(t *testing.T) {
	s := openMem(t)
	for i := range 230 {
		seedUserMetric(t, s, fmt.Sprintf("u%03d_metric", i), "")
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_a", Title: "Plugin A", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
		{Name: "plug_b", Title: "Plugin B", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
		{Name: "plug_c", Title: "Plugin C", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}

	ref := metricRowsRef(t, s)
	if len(ref) != 380 {
		t.Fatalf("reference list = %d rows, want 380 (147 builtins + 230 user + 3 plugin)", len(ref))
	}
	sizes, got := walkMetricPage(t, s, "", "", "", "", "", 0, ListMetricsPageSize)
	if len(sizes) != 4 || sizes[0] != 100 || sizes[1] != 100 || sizes[2] != 100 || sizes[3] != 80 {
		t.Errorf("window sizes = %v, want [100 100 100 80]", sizes)
	}
	if !sameIDs(metricIDs(got), metricIDs(ref)) {
		t.Errorf("paged ids diverge from the ListMetrics reference order")
	}
	seen := map[int64]int{}
	for _, m := range got {
		seen[m.ID]++
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("id %d appeared %d times across windows", id, n)
		}
	}

	// Group-ordered walk: ranks never decrease, so each origin is exactly
	// one contiguous run (the view's header suppression rule).
	prev := -1
	for _, m := range got {
		r := originRank(m.Origin)
		if r < prev {
			t.Fatalf("origin %q (id %d) reopened an earlier group — the walk must stay group-ordered", m.Origin, m.ID)
		}
		prev = r
	}
}

// TestListMetricsPageWindowBoundaries pins the exact boundary: with the
// partition addendum the builtin group ALONE exceeds one window (plan
// §8 (M5/M6 rows), 2026-11-17 re-pin — 102 seeds), so "exactly fills a
// window" now comes from the MINE partition (100 user rows) with HasNext
// false (the limit+1 probe found no row), 101 rows splits 100/1 with
// HasNext flipping correctly, and limit 0 selects the default window
// size even when the unfiltered list holds more.
func TestListMetricsPageWindowBoundaries(t *testing.T) {
	s := openMem(t)
	for i := range 100 {
		seedUserMetric(t, s, fmt.Sprintf("b%03d", i), "")
	}

	// limit 0 → the default window size (100 rows), never "all rows":
	// 109 builtins + 100 users exist, the window still stops at 100.
	page, err := s.ListMetricsPage("", "", "", "", "", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage: %v", err)
	}
	if len(page.Rows) != 100 || !page.HasNext {
		t.Errorf("limit 0 over 209 rows → %d rows, HasNext=%v; want 100, true", len(page.Rows), page.HasNext)
	}

	// Exactly one window: the mine partition totals 100 rows.
	page, err = s.ListMetricsPage("", "user,plugin", "", "", "", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine): %v", err)
	}
	if len(page.Rows) != 100 || page.HasNext {
		t.Errorf("100 mine rows → %d rows, HasNext=%v; want 100, false", len(page.Rows), page.HasNext)
	}

	// The 101st mine row: the first window now reports a successor.
	seedUserMetric(t, s, "b100", "")
	ref := metricIDs(originFilterMetricRef(metricRowsRef(t, s), "user,plugin"))
	if len(ref) != 101 {
		t.Fatalf("mine reference = %d rows, want 101", len(ref))
	}
	first, err := s.ListMetricsPage("", "user,plugin", "", "", "", 0, ListMetricsPageSize)
	if err != nil {
		t.Fatalf("ListMetricsPage(first): %v", err)
	}
	if len(first.Rows) != 100 || !first.HasNext {
		t.Fatalf("101 mine rows → first window %d rows, HasNext=%v; want 100, true", len(first.Rows), first.HasNext)
	}
	if !sameIDs(metricIDs(first.Rows), ref[:100]) {
		t.Errorf("first window = %v…, want the first 100 mine ids", metricIDs(first.Rows)[:3])
	}
	cursor := first.Rows[len(first.Rows)-1].ID
	second, err := s.ListMetricsPage("", "user,plugin", "", "", "", cursor, ListMetricsPageSize)
	if err != nil {
		t.Fatalf("ListMetricsPage(second): %v", err)
	}
	if len(second.Rows) != 1 || second.HasNext {
		t.Errorf("101 mine rows → second window %d rows, HasNext=%v; want 1, false", len(second.Rows), second.HasNext)
	}
	if !sameIDs(metricIDs(second.Rows), ref[100:]) {
		t.Errorf("second window = %v, want the final mine id %v", metricIDs(second.Rows), ref[100:])
	}
}

// TestListMetricsPageCursorPositions covers a cursor into the middle of
// the list, a cursor at the very last row (empty window, HasNext false,
// non-nil rows — never an error), and a cursor row that no longer exists
// (ErrNotFound, never a silently mis-placed page).
func TestListMetricsPageCursorPositions(t *testing.T) {
	s := openMem(t)
	for i := range 250 {
		seedUserMetric(t, s, fmt.Sprintf("c%03d", i), "")
	}
	ref := metricIDs(metricRowsRef(t, s)) // 109 builtins + 250 users

	// Cursor at the 100th row in order → the remaining 297 (the window
	// limit must clear the remainder: 397 > 147 builtins + 250 users − 100).
	page, err := s.ListMetricsPage("", "", "", "", "", ref[99], 300)
	if err != nil {
		t.Fatalf("ListMetricsPage(mid): %v", err)
	}
	if len(page.Rows) != 297 || page.HasNext {
		t.Errorf("mid cursor → %d rows, HasNext=%v; want 297, false", len(page.Rows), page.HasNext)
	}
	if !sameIDs(metricIDs(page.Rows), ref[100:]) {
		t.Errorf("mid cursor rows = %v…, want the 297 ids after the cursor", metricIDs(page.Rows)[:3])
	}

	// Cursor at the last row → an empty window, no successor.
	last := ref[len(ref)-1]
	page, err = s.ListMetricsPage("", "", "", "", "", last, 200)
	if err != nil {
		t.Fatalf("ListMetricsPage(end): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("end cursor → %d rows, HasNext=%v; want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("empty window rows = nil, want an empty (non-nil) slice for the JSON []")
	}

	// A cursor row that was deleted → ErrNotFound.
	if _, err := s.ListMetricsPage("", "", "", "", "", 999999, 200); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing cursor err = %v, want store.ErrNotFound", err)
	}
}

// TestListMetricsPageSearch pins the server-side filter: a
// case-insensitive LIKE over name AND title (the store.ListPlayers
// spelling), applied in the SAME WHERE as the cursor so a filtered walk
// tiles the filtered reference exactly; an empty query is the unfiltered
// list, and a query matching nothing is an empty non-nil window.
func TestListMetricsPageSearch(t *testing.T) {
	s := openMem(t)
	seedUserMetric(t, s, "kd_ratio", "K/D ratio")
	seedUserMetric(t, s, "adr_per_round", "ADR per round")
	seedUserMetric(t, s, "win_rate", "Win rate")
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_kd", Title: "Plugin K/D", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s)

	// Name substring, ASCII case-insensitive: "adr" and "ADR" hit the
	// SAME seven rows — the six builtins whose name/title carries the
	// substring (adr, best_adr — the M1 identity seed — career_adr,
	// career_adr_sigma — the dogfooding set landed with W2 — and the
	// side_adr/map_adr partition twins — plan §8 (M5/M6 rows)) plus the
	// user's adr_per_round — in the canonical
	// group order (builtins name-ASC, then user).
	for _, q := range []string{"adr", "ADR"} {
		page, err := s.ListMetricsPage(q, "", "", "", "", 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(%q): %v", q, err)
		}
		if len(page.Rows) != 7 || page.HasNext {
			t.Errorf("query %q → %d rows (HasNext=%v), want 7 (6 builtins + adr_per_round)",
				q, len(page.Rows), page.HasNext)
			continue
		}
		if page.Rows[0].Name != "adr" {
			t.Errorf("query %q first row = %q, want the builtin adr (builtins sort first)", q, page.Rows[0].Name)
		}
		if want := metricIDs(filterMetricRef(ref, q)); !sameIDs(metricIDs(page.Rows), want) {
			t.Errorf("query %q ids = %v, want the filtered reference %v", q, metricIDs(page.Rows), want)
		}
	}

	// Title-only substring: "K/D" appears in no name, but in six
	// titles — the four K/D builtins (career_kd, kd, side_kd, map_kd —
	// name-ASC), the user's "K/D ratio" then the plugin's "Plugin K/D"
	// (the canonical group order still holds).
	page, err := s.ListMetricsPage("K/D", "", "", "", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(K/D): %v", err)
	}
	if got := metricIDs(page.Rows); len(got) != 6 || page.HasNext {
		t.Fatalf("title query → %d rows (HasNext=%v), want 6", len(got), page.HasNext)
	} else if want := metricIDs(filterMetricRef(ref, "K/D")); !sameIDs(got, want) {
		t.Errorf("title query ids = %v, want %v", got, want)
	}

	// The filtered walk (windows of 1) tiles the filtered reference
	// exactly — the cursor resolves inside the filtered set too.
	sizes, walked := walkMetricPage(t, s, "k/d", "", "", "", "", 0, 1)
	want := filterMetricRef(ref, "k/d")
	if len(sizes) != len(want) {
		t.Errorf("filtered walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("filtered walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// No match: an empty (non-nil) window, no successor.
	page, err = s.ListMetricsPage("zz_no_such_metric", "", "", "", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(no match): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("no-match query → %d rows (HasNext=%v), want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("no-match window rows = nil, want an empty (non-nil) slice for the JSON []")
	}

	// Empty query = the whole unfiltered list.
	page, err = s.ListMetricsPage("", "", "", "", "", 0, 1000)
	if err != nil {
		t.Fatalf("ListMetricsPage(empty): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(ref)) {
		t.Errorf("empty-query window = %v…, want the full reference order", metricIDs(page.Rows)[:3])
	}
}

// originFilterMetricRef applies ListMetricsPage's origin filter as the
// Go-side reference — the SAME subset semantics the SQL spells ("" =
// all, "none" = empty, anything else the canonical comma-subset of
// builtin/user/plugin — a row passes iff its origin is one of the
// tokens) — derived here independently of the store's WHERE builder, so
// every filtered walk below is compared against a list the test computed
// for itself.
func originFilterMetricRef(rows []models.MetricRow, filter string) []models.MetricRow {
	switch filter {
	case "":
		return rows
	case "none":
		return []models.MetricRow{}
	}
	tokens := strings.Split(filter, ",")
	var out []models.MetricRow
	for _, m := range rows {
		for _, tok := range tokens {
			if m.Origin == tok {
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// TestListMetricsPageOriginFilter pins the origin SUBSET filter —
// the server-side predicate behind the Builder's Built-in / Custom /
// Plugin checkboxes: each filter value selects exactly its checked set
// (a client-side filter over a page window would be wrong, so the
// subset is asserted over KEYSET WINDOWS too), "none" (all boxes off)
// is a legal empty read with a non-nil window, and an unknown word —
// the retired complement "mine" included — is rejected before any SQL.
func TestListMetricsPageOriginFilter(t *testing.T) {
	s := openMem(t)
	for i := range 5 {
		seedUserMetric(t, s, fmt.Sprintf("u%d_metric", i), "")
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_a", Title: "Plugin A", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
		{Name: "plug_b", Title: "Plugin B", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s) // 109 builtins + 5 user + 2 plugin
	if len(ref) != 154 {
		t.Fatalf("reference = %d rows, want 154 (147 builtins + 5 user + 2 plugin)", len(ref))
	}

	// Every filter value in ONE window: exactly its checked set, in the
	// canonical order, with no successor beyond it — every one of the
	// three boxes' eight states.
	for _, filter := range []string{"", "builtin", "user", "plugin", "builtin,user", "builtin,plugin", "user,plugin", "none"} {
		want := originFilterMetricRef(ref, filter)
		page, err := s.ListMetricsPage("", filter, "", "", "", 0, 200)
		if err != nil {
			t.Fatalf("ListMetricsPage(origin=%q): %v", filter, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("origin=%q window = %v, want the partition ids %v", filter, metricIDs(page.Rows), metricIDs(want))
		}
		if page.HasNext {
			t.Errorf("origin=%q reported HasNext for its %d rows in one window", filter, len(want))
		}
		if filter == "none" && page.Rows == nil {
			t.Error("both-off window rows = nil, want an empty (non-nil) slice for the JSON []")
		}
	}

	// The subset holds ACROSS keyset windows: "user,plugin" in windows
	// of 2 tiles the non-builtin reference exactly — sizes, order, no
	// duplicates — and no builtin row ever leaks into the window.
	sizes, got := walkMetricPage(t, s, "", "user,plugin", "", "", "", 0, 2)
	wantMine := originFilterMetricRef(ref, "user,plugin") // 7 rows → [2 2 2 1]
	if len(sizes) != 4 || sizes[0] != 2 || sizes[1] != 2 || sizes[2] != 2 || sizes[3] != 1 {
		t.Errorf("user,plugin window sizes = %v, want [2 2 2 1]", sizes)
	}
	if !sameIDs(metricIDs(got), metricIDs(wantMine)) {
		t.Errorf("user,plugin walk ids = %v, want %v", metricIDs(got), metricIDs(wantMine))
	}
	for _, m := range got {
		if m.Origin == "builtin" {
			t.Errorf("builtin %q leaked into a user,plugin window", m.Name)
		}
	}

	// Unknown filter value: rejected before any SQL (no window). The
	// retired complement word "mine" is an unknown token now (the
	// vocabulary is exactly the three origins' subsets), and a
	// known-but-reordered subset is non-canonical, like format's.
	for _, word := range []string{"everything", "mine", "plugin,user"} {
		if _, err := s.ListMetricsPage("", word, "", "", "", 0, 100); err == nil ||
			!strings.Contains(err.Error(), fmt.Sprintf(`unknown origin filter %q`, word)) {
			t.Errorf("origin=%q err = %v, want the friendly pre-SQL rejection", word, err)
		}
	}
}

// TestListMetricsPageOriginFilterSearchAndCursor pins the filter
// COMPOSING with the search (both ride the SAME WHERE — a query that
// matches a builtin AND a user row is partitioned, never unioned) and
// with the cursor (a cursor row OUTSIDE the filtered set still resolves
// to its stored key, so a walk starting from it continues exactly; the
// Builder itself resets to cursor 0 on every toggle).
func TestListMetricsPageOriginFilterSearchAndCursor(t *testing.T) {
	s := openMem(t)
	seedUserMetric(t, s, "my_trade_rate", "My trade rate")
	seedUserMetric(t, s, "adr_per_round", "ADR per round")
	ref := metricRowsRef(t, s) // 109 builtins (incl. trade_rate + career_trade_rate) + 2 users

	// "trade rate" matches TWO builtin titles and the user's title — one term spanning both sides of the
	// partition.
	hit := filterMetricRef(ref, "trade rate")
	if len(hit) != 3 {
		t.Fatalf(`query fixture: "trade rate" matched %d rows, want 3 (2 builtins + user)`, len(hit))
	}
	for _, tc := range []struct {
		filter string
		want   int
	}{
		{"", 3}, {"builtin", 2}, {"user,plugin", 1}, {"user", 1}, {"plugin", 0}, {"none", 0},
	} {
		page, err := s.ListMetricsPage("trade rate", tc.filter, "", "", "", 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(q, origin=%q): %v", tc.filter, err)
		}
		want := originFilterMetricRef(hit, tc.filter)
		if len(page.Rows) != tc.want || !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("q+origin=%q → %d rows (%v), want %d (%v)",
				tc.filter, len(page.Rows), metricIDs(page.Rows), tc.want, metricIDs(want))
		}
	}
	// Case-insensitive on BOTH sides: an upper-case term partitions the
	// same way (SQLite LIKE's ASCII folding).
	page, err := s.ListMetricsPage("TRADE RATE", "user,plugin", "", "", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(upper, mine): %v", err)
	}
	if wantIDs := metricIDs(originFilterMetricRef(hit, "user,plugin")); !sameIDs(metricIDs(page.Rows), wantIDs) {
		t.Errorf("upper-case q+mine = %v, want %v", metricIDs(page.Rows), wantIDs)
	}

	// The composed filtered walk (windows of 1) tiles the composed
	// reference exactly — filter AND search inside one WHERE.
	sizes, walked := walkMetricPage(t, s, "trade rate", "user,plugin", "", "", "", 0, 1)
	want := originFilterMetricRef(hit, "user,plugin")
	if len(sizes) != len(want) {
		t.Errorf("composed walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("composed walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// CURSOR outside the filtered set: the builtin row is the cursor of
	// a "user,plugin" walk — it resolves to its stored (rank, name) and every
	// mine row sorts after it, so the walk returns the whole mine side
	// (never an error, never the builtin itself).
	var builtinID int64
	for _, m := range ref {
		if m.Origin == "builtin" {
			builtinID = m.ID
		}
	}
	page, err = s.ListMetricsPage("", "user,plugin", "", "", "", builtinID, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, builtin cursor): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(originFilterMetricRef(ref, "user,plugin"))) {
		t.Errorf("mine walk from a builtin cursor = %v, want the whole mine side", metricIDs(page.Rows))
	}

	// A cursor on the FIRST mine row continues after it (the mid-list
	// cursor, mine side): only the row that follows survives.
	mine := originFilterMetricRef(ref, "user,plugin")
	page, err = s.ListMetricsPage("", "user,plugin", "", "", "", mine[0].ID, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, mid cursor): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(mine[1:])) {
		t.Errorf("mine walk after %d = %v, want %v", mine[0].ID, metricIDs(page.Rows), metricIDs(mine[1:]))
	}
}

// seedScopedMetric creates a user metric with an explicit scope AND
// denominator (seedUserMetric's row is always scope 'match' with no
// denominator) and returns its id.
func seedScopedMetric(t *testing.T, s *Store, name, scope string) int64 {
	t.Helper()
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: name, Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Origin: "user",
		Scope: scope,
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m.ID
}

// scopeFilterMetricRef applies ListMetricsPage's scope filter as the
// Go-side reference — the SAME partition the SQL spells ("" = both,
// "match"/"profile" = that side, "none" = empty) — derived here
// independently of the store's WHERE builder (the originFilterMetricRef
// pattern).
func scopeFilterMetricRef(rows []models.MetricRow, filter string) []models.MetricRow {
	switch filter {
	case "match", "profile":
		var out []models.MetricRow
		for _, m := range rows {
			if m.Scope == filter {
				out = append(out, m)
			}
		}
		return out
	case "none":
		return []models.MetricRow{}
	default:
		return rows
	}
}

// TestListMetricsPageScopeFilter pins the scope partition — the
// server-side predicate behind the Builder's Match / Profile toggles:
// each value selects exactly its side (a client-side filter over a page
// window would be wrong, so the partition is asserted over KEYSET
// WINDOWS too), "none" (both toggles off) is a legal empty read with a
// non-nil window — the same shape as origin's — and an unknown value is
// rejected before any SQL.
func TestListMetricsPageScopeFilter(t *testing.T) {
	s := openMem(t)
	seedScopedMetric(t, s, "user_match_rate", "match")
	seedScopedMetric(t, s, "user_career_rate", "profile")
	ref := metricRowsRef(t, s)
	// The fixture carries BOTH scopes: the schema-seeded builtins ship
	// match and profile rows, and the two users add one of each — so a
	// scope word that selected nothing would fail here.
	for _, scope := range []string{"match", "profile"} {
		if len(scopeFilterMetricRef(ref, scope)) == 0 {
			t.Fatalf("fixture has no %s-scoped row (reference = %d rows)", scope, len(ref))
		}
	}

	// Every filter value in ONE window: exactly its partition, in the
	// canonical order, with no successor beyond it.
	for _, filter := range []string{"", "match", "profile", "none"} {
		want := scopeFilterMetricRef(ref, filter)
		page, err := s.ListMetricsPage("", "", filter, "", "", 0, 500)
		if err != nil {
			t.Fatalf("ListMetricsPage(scope=%q): %v", filter, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("scope=%q window = %v, want the partition ids %v", filter, metricIDs(page.Rows), metricIDs(want))
		}
		if page.HasNext {
			t.Errorf("scope=%q reported HasNext for its %d rows in one window", filter, len(want))
		}
		if filter == "none" && page.Rows == nil {
			t.Error("both-off window rows = nil, want an empty (non-nil) slice for the JSON []")
		}
	}

	// The partition holds ACROSS keyset windows: "profile" in windows of
	// 3 tiles the profile reference exactly — sizes, order, no
	// duplicates, and no match-scoped row ever leaks in.
	wantProfile := scopeFilterMetricRef(ref, "profile")
	sizes, got := walkMetricPage(t, s, "", "", "profile", "", "", 0, 3)
	if len(sizes) != (len(wantProfile)+2)/3 {
		t.Errorf("profile window sizes = %v (%d windows), want %d windows of 3 over %d rows",
			sizes, len(sizes), (len(wantProfile)+2)/3, len(wantProfile))
	}
	if !sameIDs(metricIDs(got), metricIDs(wantProfile)) {
		t.Errorf("profile walk ids = %v, want %v", metricIDs(got), metricIDs(wantProfile))
	}
	for _, m := range got {
		if m.Scope != "profile" {
			t.Errorf("%s (scope %q) leaked into a profile window", m.Name, m.Scope)
		}
	}

	// Unknown filter value: rejected before any SQL (no window).
	if _, err := s.ListMetricsPage("", "", "career", "", "", 0, 100); err == nil ||
		!strings.Contains(err.Error(), `unknown scope filter "career"`) {
		t.Errorf("unknown scope filter err = %v, want the friendly pre-SQL rejection", err)
	}
}

// TestListMetricsPageAllFiltersCompose pins the three pairs AND the
// search riding the SAME WHERE clause: every combination in one window
// equals the reference list filtered independently by each predicate
// (a union, a client-side slice or a dropped arg would diverge), the
// composed walk still tiles the composed list under a keyset cursor, and
// an all-both-off window is an empty NON-nil read (each group's all-off
// now spells an empty set — origin/scope "none" and the denominator
// group's "empty", pinned above).
func TestListMetricsPageAllFiltersCompose(t *testing.T) {
	s := openMem(t)
	seedScopedMetric(t, s, "mine_rounds_match", "match")
	seedScopedMetric(t, s, "mine_rounds_profile", "profile")
	seedScopedMetric(t, s, "mine_plain_match", "match")
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_plain", Title: "Plugin plain", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s)

	combos := []struct {
		origin, scope string
	}{
		{"", ""},
		{"user,plugin", ""},
		{"builtin", ""},
		{"", "match"},
		{"", "profile"},
		{"", ""},
		{"", ""},
		{"", ""},
		{"user,plugin", "profile"},
		{"user,plugin", "match"},
		{"builtin", "profile"},
		{"none", ""},
		{"", "profile"},
		// Reading B's subset words (2026-11-16): the empty checked set
		// and a two-token subset riding the same composed WHERE.
		{"", ""},
		{"user,plugin", ""},
		{"", "match"},
	}
	for _, tc := range combos {
		want := scopeFilterMetricRef(originFilterMetricRef(ref, tc.origin), tc.scope)
		page, err := s.ListMetricsPage("", tc.origin, tc.scope, "", "", 0, 500)
		if err != nil {
			t.Fatalf("ListMetricsPage(origin=%q, scope=%q): %v", tc.origin, tc.scope, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("(origin=%q, scope=%q) → %v, want %v",
				tc.origin, tc.scope, metricIDs(page.Rows), metricIDs(want))
		}
	}

	// SEARCH composes with all three pairs (one term spanning scopes,
	// denominators and origins), case-insensitively.
	seedScopedMetric(t, s, "trade_share", "profile")
	ref = metricRowsRef(t, s)
	hit := filterMetricRef(ref, "trade")
	if len(hit) < 3 {
		t.Fatalf(`query fixture: "trade" matched %d rows, want at least 3`, len(hit))
	}
	want := scopeFilterMetricRef(originFilterMetricRef(hit, "user,plugin"), "profile")
	page, err := s.ListMetricsPage("TRADE", "user,plugin", "profile", "", "", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(TRADE, mine, profile, rounds): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
		t.Errorf("composed search window = %v, want %v", metricIDs(page.Rows), metricIDs(want))
	}
	if len(want) == 0 {
		t.Fatal("composed fixture matched nothing — the composition assertion would be vacuous")
	}

	// The composed walk (windows of 1) tiles the composed reference
	// exactly — four narrowings inside one WHERE, cursor included.
	sizes, walked := walkMetricPage(t, s, "trade", "user,plugin", "profile", "", "", 0, 1)
	if len(sizes) != len(want) {
		t.Errorf("composed walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("composed walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// A cursor OUTSIDE every filtered set still resolves to its stored
	// key (the Builder itself resets to cursor 0 on a toggle).
	var builtinID int64
	for _, m := range ref {
		if m.Origin == "builtin" {
			builtinID = m.ID
			break
		}
	}
	page, err = s.ListMetricsPage("", "user,plugin", "match", "", "", builtinID, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, match, rounds, builtin cursor): %v", err)
	}
	want = scopeFilterMetricRef(originFilterMetricRef(ref, "user,plugin"), "match")
	if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
		t.Errorf("filtered walk from a builtin cursor = %v, want %v", metricIDs(page.Rows), metricIDs(want))
	}

	// Both source toggles off AND both scopes off: an empty, non-nil
	// window — the one read where the empty set is the right answer.
	page, err = s.ListMetricsPage("", "none", "none", "", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(origin=none, scope=none): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("both pairs off → %d rows (HasNext=%v), want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("empty window rows = nil, want an empty (non-nil) slice for the JSON []")
	}
}

// --- the Type group's format filter -----------------------------------------

// seedTypedMetric creates a user metric carrying a format, scope and
// denominator together (format "auto" spelled as the column's ” —
// metricFormatTokens' vocabulary) — the fixture builder for the format
// filter's partition and composition tests.
func seedTypedMetric(t *testing.T, s *Store, name, format, scope string) int64 {
	t.Helper()
	if format == "auto" {
		format = ""
	}
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: name, Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Origin: "user",
		Format: format, Scope: scope,
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m.ID
}

// formatFilterMetricRef applies ListMetricsPage's format filter as the
// Go-side reference — the SAME subset the SQL spells ("" = every
// format, "none" = the empty set, otherwise the checked tokens with
// "auto" naming the ” rows) — derived here independently of the
// store's WHERE builder (the originFilterMetricRef pattern).
func formatFilterMetricRef(rows []models.MetricRow, filter string) []models.MetricRow {
	switch filter {
	case "none":
		return []models.MetricRow{}
	case "":
		return rows
	default:
		want := map[string]bool{}
		for _, tok := range strings.Split(filter, ",") {
			want[tok] = true
		}
		var out []models.MetricRow
		for _, m := range rows {
			tok := m.Format
			if tok == "" {
				tok = "auto"
			}
			if want[tok] {
				out = append(out, m)
			}
		}
		return out
	}
}

// TestListMetricsPageFormatFilter pins the Type group's format subset —
// the server-side predicate behind the Builder's seven format checkboxes:
// each word selects exactly its subset of the format column (a
// client-side filter over a page window would drop rows at the window
// edges, so the subset is asserted over KEYSET WINDOWS too), the
// canonical vocabulary and subset order are the store's (an unknown
// token, an empty segment, a duplicate or a reordered word is rejected
// before any SQL), "auto" is the ” bucket (never a literal 'auto'
// string), all-on and the full seven-token subset cover the SAME
// offered rows (identity joined the vocabulary — metrics Phase 7,
// 2026-11-18: the Builder Type group's Identity box; the seeds'
// format=identity rows are filterable like every other), and "none"
// (every box off) is
// a legal empty read with a non-nil
// window — the origin/scope shape, not the denominator rule's.
func TestListMetricsPageFormatFilter(t *testing.T) {
	s := openMem(t)
	// One seeded row per format token beside the schema-seeded builtins
	// (percent/float1/float2) — reachability is derived from the
	// reference below, never pinned to a count (W1's reseeds grow the
	// catalog without touching this test).
	for _, tok := range []string{"auto", "int", "float1", "float2", "percent", "currency", "identity"} {
		seedTypedMetric(t, s, "fmt_"+tok, tok, "match")
	}
	ref := metricRowsRef(t, s)

	// The vocabulary itself: THE canonical enum order every accepted
	// subset word is composed in (the rejections below depend on it).
	if got, want := strings.Join(metricFormatTokens, ","), "auto,int,float1,float2,percent,currency,identity"; got != want {
		t.Fatalf("metricFormatTokens = %q, want %q", got, want)
	}
	// Every token has at least one row, so no word below is vacuous.
	for _, tok := range metricFormatTokens {
		if len(formatFilterMetricRef(ref, tok)) == 0 {
			t.Fatalf("fixture has no %s row (reference = %d rows)", tok, len(ref))
		}
	}

	// Every filter word in ONE window: exactly its subset, in the
	// canonical order, no successor beyond it.
	for _, w := range []string{
		"", "none",
		"auto", "int", "float1", "float2", "percent", "currency",
		"auto,int", "auto,percent", "float1,percent,currency",
		"auto,int,float1,float2,percent,currency",
	} {
		want := formatFilterMetricRef(ref, w)
		page, err := s.ListMetricsPage("", "", "", "", w, 0, 500)
		if err != nil {
			t.Fatalf("ListMetricsPage(format=%q): %v", w, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("format=%q window = %v, want the subset ids %v", w, metricIDs(page.Rows), metricIDs(want))
		}
		if page.HasNext {
			t.Errorf("format=%q reported HasNext for its %d rows in one window", w, len(want))
		}
		if w == "none" && page.Rows == nil {
			t.Error("all-off window rows = nil, want an empty (non-nil) slice for the JSON []")
		}
	}

	// ALL-ON == THE SEVEN OFFERED TOKENS (identity joined the Type
	// group — metrics Phase 7, 2026-11-18): no predicate and the full
	// seven-token subset select the same window — the whole reference
	// (the popover's all-checked word is "", so this is what makes the
	// default first render unfiltered).
	allOn, err := s.ListMetricsPage("", "", "", "", "", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(format=): %v", err)
	}
	allSeven, err := s.ListMetricsPage("", "", "", "", "auto,int,float1,float2,percent,currency,identity", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(format=all seven): %v", err)
	}
	if !sameIDs(metricIDs(allOn.Rows), metricIDs(allSeven.Rows)) {
		t.Errorf("all-on window = %v, want the full seven-token subset %v", metricIDs(allOn.Rows), metricIDs(allSeven.Rows))
	}
	if !sameIDs(metricIDs(allOn.Rows), metricIDs(ref)) {
		t.Errorf("all-on window = %v…, want the whole reference order", metricIDs(allOn.Rows)[:min(3, len(allOn.Rows))])
	}
	// ONE BOX OFF (Identity): the six-token word drops exactly the
	// identity rows — before Phase 7 these rows were unreachable by
	// any accepted word at all.
	sixOff, err := s.ListMetricsPage("", "", "", "", "auto,int,float1,float2,percent,currency", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(format six): %v", err)
	}
	wantSix := make([]models.MetricRow, 0, len(allOn.Rows))
	identityRows := 0
	for _, m := range allOn.Rows {
		if m.Format == "identity" {
			identityRows++
			continue
		}
		wantSix = append(wantSix, m)
	}
	if identityRows == 0 {
		t.Fatal("the fixture carries no identity-format row (the M1 seeds or fmt_identity)")
	}
	if !sameIDs(metricIDs(sixOff.Rows), metricIDs(wantSix)) {
		t.Errorf("six-token window = %v, want the non-identity ids %v", metricIDs(sixOff.Rows), metricIDs(wantSix))
	}
	// The OFFERED vocabulary (every accepted token): every row sits in
	// it since identity landed — the filter covers the whole catalog.
	offered := func(m models.MetricRow) bool {
		tok := m.Format
		if tok == "" {
			tok = "auto"
		}
		return slices.Contains(metricFormatTokens, tok)
	}
	offeredRows := make([]models.MetricRow, 0, len(allOn.Rows))
	for _, m := range allOn.Rows {
		if offered(m) {
			offeredRows = append(offeredRows, m)
		}
	}
	if !sameIDs(metricIDs(offeredRows), metricIDs(allOn.Rows)) {
		t.Errorf("offered-format rows = %v…, want every all-on row (identity is offered now)", metricIDs(offeredRows)[:min(3, len(offeredRows))])
	}

	// THE AUTO BUCKET: the "auto" word selects exactly the '' rows (the
	// format column's empty value), and a word WITHOUT "auto" drops
	// every one of them.
	auto, err := s.ListMetricsPage("", "", "", "", "auto", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(format=auto): %v", err)
	}
	if len(auto.Rows) == 0 {
		t.Fatal("auto window is empty — the fixture carries no ''-format row")
	}
	for _, m := range auto.Rows {
		if m.Format != "" {
			t.Errorf("auto bucket kept %s (format %q) — it must be the '' rows", m.Name, m.Format)
		}
	}
	withoutAuto, err := s.ListMetricsPage("", "", "", "", "int,float1,float2,percent,currency", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(format without auto): %v", err)
	}
	for _, m := range withoutAuto.Rows {
		if m.Format == "" {
			t.Errorf("word without auto kept the ''-format row %s", m.Name)
		}
	}

	// SUBSET MATH: the seven single-token windows are DISJOINT and
	// together cover every row (each row carries exactly one format,
	// identity included since metrics Phase 7), so the
	// subset filter is a partition of the whole catalog.
	var tiled []int64
	seen := map[int64]int{}
	for _, tok := range metricFormatTokens {
		page, err := s.ListMetricsPage("", "", "", "", tok, 0, 500)
		if err != nil {
			t.Fatalf("ListMetricsPage(format=%q): %v", tok, err)
		}
		for _, id := range metricIDs(page.Rows) {
			seen[id]++
		}
		tiled = append(tiled, metricIDs(page.Rows)...)
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("id %d appeared in %d single-token windows, want exactly 1", id, n)
		}
	}
	wantIDs := metricIDs(offeredRows)
	slices.Sort(tiled)
	slices.Sort(wantIDs)
	if !slices.Equal(tiled, wantIDs) {
		t.Errorf("single-token windows cover %d ids, want the offered reference (%d)", len(tiled), len(wantIDs))
	}

	// The partition holds ACROSS keyset windows: "percent" in windows of
	// 3 tiles the percent reference exactly — sizes, order, no
	// duplicates, and no other-format row ever leaks in.
	wantPercent := formatFilterMetricRef(ref, "percent")
	sizes, got := walkMetricPage(t, s, "", "", "", "", "percent", 0, 3)
	if len(sizes) != (len(wantPercent)+2)/3 {
		t.Errorf("percent window sizes = %v (%d windows), want %d windows of 3 over %d rows",
			sizes, len(sizes), (len(wantPercent)+2)/3, len(wantPercent))
	}
	if !sameIDs(metricIDs(got), metricIDs(wantPercent)) {
		t.Errorf("percent walk ids = %v, want %v", metricIDs(got), metricIDs(wantPercent))
	}
	for _, m := range got {
		if m.Format != "percent" {
			t.Errorf("%s (format %q) leaked into a percent window", m.Name, m.Format)
		}
	}

	// A cursor OUTSIDE the format subset (a float1 builtin's id on a
	// percent-only walk) still resolves to its stored key, so the walk
	// continues from that row's position exactly — membership is the
	// predicate's business, never the cursor's.
	var float1ID int64
	for _, m := range ref {
		if m.Format == "float1" {
			float1ID = m.ID
			break
		}
	}
	if float1ID == 0 {
		t.Fatal("fixture carries no float1 row for the outside-cursor case")
	}
	idx := slices.IndexFunc(ref, func(m models.MetricRow) bool { return m.ID == float1ID })
	page, err := s.ListMetricsPage("", "", "", "", "percent", float1ID, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(percent, float1 cursor): %v", err)
	}
	wantAfter := formatFilterMetricRef(ref[idx+1:], "percent")
	if !sameIDs(metricIDs(page.Rows), metricIDs(wantAfter)) {
		t.Errorf("percent walk from an outside cursor = %v, want %v", metricIDs(page.Rows), metricIDs(wantAfter))
	}

	// Unknown token / unknown word shape: rejected before any SQL (no
	// window), with the origin/scope/denominator rejection copy. The
	// list covers a bogus token, case, whitespace, empty segments,
	// duplicates and a known-but-REORDERED word (canonical means order).
	for _, w := range []string{
		"huge", "Int", " auto", "AUTO",
		"auto,", ",int", "int,", "int,,float1",
		"auto,auto", "int,auto", "percent,int", "auto,int,",
		"none,auto",
	} {
		if _, err := s.ListMetricsPage("", "", "", "", w, 0, 100); err == nil ||
			!strings.Contains(err.Error(), fmt.Sprintf("unknown format filter %q", w)) {
			t.Errorf("format filter %q: err = %v, want the friendly pre-SQL rejection", w, err)
		}
	}
}

// TestListMetricsPageFormatFilterComposes pins the format subset riding
// the SAME WHERE as the other three pairs AND the search: every
// combination in one window equals the reference list filtered
// independently by each predicate (a union, a client-side slice or a
// dropped arg would diverge), a format-composed search still narrows in
// ONE call, and the composed walk tiles the composed list under the
// keyset cursor.
func TestListMetricsPageFormatFilterComposes(t *testing.T) {
	s := openMem(t)
	seedTypedMetric(t, s, "mine_auto_rounds", "auto", "match")
	seedTypedMetric(t, s, "mine_int_match", "int", "match")
	seedTypedMetric(t, s, "mine_pct_profile", "percent", "profile")
	seedTypedMetric(t, s, "trade_auto", "auto", "match")
	seedTypedMetric(t, s, "trade_pct", "percent", "profile")
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_auto", Title: "Plugin auto", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s)

	combos := []struct {
		origin, scope, format string
	}{
		{"", "", ""},
		{"user,plugin", "", "auto,int"},
		{"user,plugin", "match", "auto"},
		{"", "profile", "percent"},
		{"user,plugin", "", "float1"},
		{"none", "", "auto"},
		{"user,plugin", "", "none"},
		{"builtin", "", "percent"},
		{"user,plugin", "match", "auto,int,float1,float2,percent,currency"},
		{"", "", "auto,percent"},
	}
	for _, tc := range combos {
		want := formatFilterMetricRef(
			scopeFilterMetricRef(originFilterMetricRef(ref, tc.origin), tc.scope),
			tc.format,
		)
		page, err := s.ListMetricsPage("", tc.origin, tc.scope, "", tc.format, 0, 500)
		if err != nil {
			t.Fatalf("ListMetricsPage(origin=%q, scope=%q, format=%q): %v", tc.origin, tc.scope, tc.format, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("(origin=%q, scope=%q, format=%q) → %v, want %v",
				tc.origin, tc.scope, tc.format, metricIDs(page.Rows), metricIDs(want))
		}
		if tc.format == "none" && page.Rows == nil {
			t.Errorf("(…, format=none) window rows = nil, want an empty (non-nil) slice")
		}
	}

	// SEARCH composes with the format subset (one term spanning both
	// sides of the auto/percent split), case-insensitively.
	hit := filterMetricRef(ref, "trade")
	if len(hit) < 2 {
		t.Fatalf(`query fixture: "trade" matched %d rows, want at least 2`, len(hit))
	}
	want := formatFilterMetricRef(originFilterMetricRef(hit, "user,plugin"), "auto,percent")
	if len(want) == 0 {
		t.Fatal("composed fixture matched nothing — the composition assertion would be vacuous")
	}
	page, err := s.ListMetricsPage("TRADE", "user,plugin", "", "", "auto,percent", 0, 500)
	if err != nil {
		t.Fatalf("ListMetricsPage(TRADE, mine, format=auto,percent): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
		t.Errorf("composed search+format window = %v, want %v", metricIDs(page.Rows), metricIDs(want))
	}

	// The composed walk (windows of 1) tiles the composed reference
	// exactly — four narrowings inside one WHERE, cursor included.
	sizes, walked := walkMetricPage(t, s, "trade", "user,plugin", "", "", "auto,percent", 0, 1)
	if len(sizes) != len(want) {
		t.Errorf("composed walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("composed walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// Every pair off AND every format box off: an empty, non-nil window
	// — the empty set spelled by both shapes at once.
	page, err = s.ListMetricsPage("", "none", "none", "", "none", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(all filters none): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext || page.Rows == nil {
		t.Errorf("all filters none → %d rows (HasNext=%v, nil=%v), want 0, false, non-nil",
			len(page.Rows), page.HasNext, page.Rows == nil)
	}
}
