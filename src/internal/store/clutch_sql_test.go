package store

import (
	"database/sql"
	"math"
	"testing"
)

// clutchFixture is one counted round with two clutches, written straight to
// the tables the clutch SQL reads (player_ticks, events, rounds, players).
//
//	tick 100: CT A, D alive; T B, C alive
//	tick 200: D dies (B)           → A is a 1v2 on CT
//	tick 300: C dies (A)           → B is a 1v1 on T, A still 1v1
//	tick 400: B dies (A)           → A wins the 1v2, B loses the 1v1
//
// Expected: A 1v2 won (kills 300, 400 inside the span), B 1v1 lost (no kills).
func seedClutchFixture(t *testing.T, s *Store, id int64) {
	t.Helper()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.db.Exec(q, args...); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO rounds (match_id, number, winner, start_tick, end_tick, equip_ct, equip_t)
		  VALUES (?, 1, 'ct', 0, 1000, 4000, 3000)`, id)
	exec(`INSERT INTO players (match_id, steam_id, name, side) VALUES
		  (?, 'A', 'Alice', 'ct'), (?, 'D', 'Dan', 'ct'), (?, 'B', 'Bob', 't'), (?, 'C', 'Cy', 't')`, id, id, id, id)
	exec(`INSERT INTO round_player_sides (match_id, round, steam_id, side) VALUES
		  (?, 1, 'A', 'ct'), (?, 1, 'D', 'ct'), (?, 1, 'B', 't'), (?, 1, 'C', 't')`, id, id, id, id)
	alive := map[int][4]int{ // tick → alive flags for A, D, B, C
		100: {1, 1, 1, 1},
		200: {1, 0, 1, 1},
		300: {1, 0, 1, 0},
		400: {1, 0, 0, 0},
	}
	sides := [4]string{"ct", "ct", "t", "t"}
	ids := [4]string{"A", "D", "B", "C"}
	for _, tick := range []int{100, 200, 300, 400} {
		for i := range ids {
			exec(`INSERT INTO player_ticks (match_id, tick, steam_id, round, side, alive, hp)
				  VALUES (?, ?, ?, 1, ?, ?, 100)`, id, tick, ids[i], sides[i], alive[tick][i])
		}
	}
	exec(`INSERT INTO events (match_id, seq, tick, round, kind, attacker, victim) VALUES
		  (?, 1, 200, 1, 'kill', 'B', 'D'),
		  (?, 2, 300, 1, 'kill', 'A', 'C'),
		  (?, 3, 400, 1, 'kill', 'A', 'B')`, id, id, id)
}

// clutchMetric runs one clutch metric's stored expr against the match and
// returns its subject → value map.
func clutchMetric(t *testing.T, s *Store, name string, id int64) map[string]float64 {
	t.Helper()
	var expr string
	if err := s.db.QueryRow(`SELECT expr FROM metrics WHERE name = ?`, name).Scan(&expr); err != nil {
		t.Fatalf("metric %s: %v", name, err)
	}
	rows, err := s.db.Query(expr, sql.Named("match_id", id))
	if err != nil {
		t.Fatalf("run %s: %v", name, err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]float64{}
	for rows.Next() {
		var subj, dim string
		var v float64
		if err := rows.Scan(&subj, &dim, &v); err != nil {
			t.Fatalf("scan %s: %v", name, err)
		}
		out[subj] = v
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows %s: %v", name, err)
	}
	return out
}

func TestClutchRowsFixture(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	id, err := s.CreateMatchRow("clutch-fixture", "sha-clutch-fixture", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	seedClutchFixture(t, s, id)

	got, err := s.ClutchRows(id)
	if err != nil {
		t.Fatalf("ClutchRows: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ClutchRows = %+v, want 2 clutches", got)
	}
	a, b := got[0], got[1]
	if a.SteamID != "A" || a.Size != 2 || a.StartTick != 200 || a.EndTick != 400 || !a.Won ||
		a.HPLeft != 100 || a.Equip != 4000 || a.BombState != "carried" || a.KillTicks != "[300,400]" ||
		a.Name != "Alice" || a.ReplayAnchor != 200 || a.MatchID != id {
		t.Errorf("A clutch = %+v, want 1v2 won from tick 200 to 400, hp 100, equip 4000, kills [300,400]", a)
	}
	if b.SteamID != "B" || b.Size != 1 || b.StartTick != 300 || b.EndTick != 400 || b.Won ||
		b.HPLeft != 0 || b.Equip != 3000 || b.KillTicks != "null" {
		t.Errorf("B clutch = %+v, want 1v1 lost from tick 300 to 400, hp 0, equip 3000, no kills", b)
	}

	// The clutch family (round-grain, binds :round) must agree with the rows.
	var fam string
	if err := s.db.QueryRow(`SELECT expr FROM metrics WHERE name = 'clutch'`).Scan(&fam); err != nil {
		t.Fatalf("clutch family: %v", err)
	}
	famRows, err := s.db.Query(fam, sql.Named("match_id", id), sql.Named("round", 1))
	if err != nil {
		t.Fatalf("run clutch family: %v", err)
	}
	defer func() { _ = famRows.Close() }()
	n := 0
	for famRows.Next() {
		var subj, dim, bomb, kill, name string
		var v, round, size, start, end, won, hp, equip, replay float64
		if err := famRows.Scan(&subj, &dim, &v, &round, &size, &start, &end, &won, &hp, &bomb, &equip, &kill, &name, &replay); err != nil {
			t.Fatalf("scan family: %v", err)
		}
		if n >= len(got) {
			t.Fatalf("family row %d (%s) has no counterpart in ClutchRows", n, subj)
		}
		c := got[n]
		if subj != c.SteamID || int(size) != c.Size || int(start) != c.StartTick || int(end) != c.EndTick ||
			(won == 1) != c.Won || int(hp) != c.HPLeft || bomb != c.BombState || int(equip) != c.Equip || kill != c.KillTicks {
			t.Errorf("family row %d = %s size %v start %v end %v won %v hp %v bomb %s equip %v kills %s; ClutchRows %+v",
				n, subj, size, start, end, won, hp, bomb, equip, kill, c)
		}
		n++
	}
	if n != len(got) {
		t.Errorf("family returned %d rows, ClutchRows %d", n, len(got))
	}

	// The six clutch metrics (inline SQL over every round) equal the rows.
	want := map[string]map[string]float64{
		"clutches":          {"A": 1, "B": 1},
		"match_clutch_wins": {"A": 1, "B": 0},
		"clutch_win_rate":   {"A": 1, "B": 0},
		"clutch_avg_size":   {"A": 2, "B": 1},
		"clutch_avg_hp":     {"A": 100, "B": 0},
		"clutch_avg_equip":  {"A": 4000, "B": 3000},
	}
	for name, subjects := range want {
		gotVals := clutchMetric(t, s, name, id)
		if len(gotVals) != len(subjects) {
			t.Errorf("%s = %v, want %v", name, gotVals, subjects)
		}
		for subj, w := range subjects {
			if g, ok := gotVals[subj]; !ok || math.Abs(g-w) > 1e-9 {
				t.Errorf("%s[%s] = %v (present %v), want %v", name, subj, g, ok, w)
			}
		}
	}
}

// seedAliveRosterFixture pins the roster rule (backlog S10) on two rounds.
//
//	round 1 (start 100, end 2000), roster CT A D E, T B C
//	  tick 50    A disconnects before the round starts: does not count
//	  tick 995   E disconnects 5 ticks before the kill: counts (window)
//	  tick 1000  B kills D: D counts at the kill tick (inclusive)
//	  expect alive at tick 1000: CT 1 (A), T 2
//	round 2 (start 2100, end 3000), roster CT X Y, T Z
//	  tick 2400  X disconnects
//	  tick 2500  Z kills X: X is killed AND disconnected, counts once
//	  expect alive at tick 2500: CT 1 (Y), T 1 (a naive double count gives CT 0)
func seedAliveRosterFixture(t *testing.T, s *Store, id int64) {
	t.Helper()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.db.Exec(q, args...); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO rounds (match_id, number, winner, start_tick, end_tick, equip_ct, equip_t) VALUES
		  (?, 1, 'ct', 100, 2000, 4000, 3000), (?, 2, 't', 2100, 3000, 4000, 3000)`, id, id)
	exec(`INSERT INTO round_player_sides (match_id, round, steam_id, side) VALUES
		  (?, 1, 'A', 'ct'), (?, 1, 'D', 'ct'), (?, 1, 'E', 'ct'), (?, 1, 'B', 't'), (?, 1, 'C', 't'),
		  (?, 2, 'X', 'ct'), (?, 2, 'Y', 'ct'), (?, 2, 'Z', 't')`, id, id, id, id, id, id, id, id)
	exec(`INSERT INTO events (match_id, seq, tick, round, kind, attacker, victim) VALUES
		  (?, 1, 50, 1, 'player_disconnect', 'A', ''),
		  (?, 2, 995, 1, 'player_disconnect', 'E', ''),
		  (?, 3, 1000, 1, 'kill', 'B', 'D'),
		  (?, 4, 2400, 2, 'player_disconnect', 'X', ''),
		  (?, 5, 2500, 2, 'kill', 'Z', 'X')`, id, id, id, id, id)
}

// TestAliveCountRosterRule pins the inclusive kill-tick rule and the
// disconnect-within-round rule of the alive_count metric and of the clutch
// CTE's alive count (both read the roster, not player_ticks).
func TestAliveCountRosterRule(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	id, err := s.CreateMatchRow("alive-roster-fixture", "sha-alive-roster-fixture", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	seedAliveRosterFixture(t, s, id)

	var expr string
	if err := s.db.QueryRow(`SELECT expr FROM metrics WHERE name = 'alive_count'`).Scan(&expr); err != nil {
		t.Fatalf("alive_count: %v", err)
	}
	want := map[int]map[string]int{
		1: {"ct@1000": 1, "t@1000": 2},
		2: {"ct@2500": 1, "t@2500": 1},
	}
	for round, w := range want {
		rows, err := s.db.Query(expr, sql.Named("match_id", id), sql.Named("round", round))
		if err != nil {
			t.Fatalf("run alive_count round %d: %v", round, err)
		}
		got := map[string]int{}
		for rows.Next() {
			var subj, dim string
			var v int
			if err := rows.Scan(&subj, &dim, &v); err != nil {
				t.Fatalf("scan alive_count: %v", err)
			}
			got[subj+"@"+dim] = v
		}
		_ = rows.Close()
		if len(got) != len(w) {
			t.Errorf("round %d alive_count = %v, want %v", round, got, w)
		}
		for k, v := range w {
			if got[k] != v {
				t.Errorf("round %d alive_count[%s] = %d, want %d (all %v)", round, k, got[k], v, got)
			}
		}
	}

	// The clutch CTE's alive count is the same rule: round 1 at tick 1000 has
	// CT 1 alive (A) against T 2, so A is the 1v2 that starts at the kill tick.
	clutches, err := s.ClutchRows(id)
	if err != nil {
		t.Fatalf("ClutchRows: %v", err)
	}
	found := false
	for _, c := range clutches {
		if c.Round == 1 && c.SteamID == "A" {
			found = true
			if c.Size != 2 || c.StartTick != 1000 {
				t.Errorf("A round 1 clutch = size %d start %d, want size 2 start 1000", c.Size, c.StartTick)
			}
		}
	}
	if !found {
		t.Errorf("no round 1 clutch for A in %+v", clutches)
	}
}

// TestClutchesTableGone pins the drop: the table is gone and no seeded metric
// still carries the placeholder.
func TestClutchesTableGone(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('clutches')`).Scan(&n); err != nil {
		t.Fatalf("pragma_table_info: %v", err)
	}
	if n != 0 {
		t.Errorf("clutches table has %d columns, want the table dropped", n)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'clutches'`).Scan(&n); err != nil {
		t.Fatalf("sqlite_master: %v", err)
	}
	if n != 0 {
		t.Errorf("sqlite_master lists the clutches table")
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE expr LIKE '%{{CLUTCH_CTE}}%'`).Scan(&n); err != nil {
		t.Fatalf("placeholder scan: %v", err)
	}
	if n != 0 {
		t.Errorf("%d seeded metric exprs still hold the clutch placeholder", n)
	}
}
