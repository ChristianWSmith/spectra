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
