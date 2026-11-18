package metrics

import (
	"database/sql"
	"math"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// The Economy-card seed equivalence (plan §8 (M8 rows)): pistol_hold
// and avg_equip_gap must be EXACTLY the numbers the Economy summary
// cards' view aggregate computed before the migration — no-exceptions
// equality, not an approximation. The oracle below is that view
// computation PORTED VERBATIM from frontend/src/lib/views/Economy.svelte
// (summary $derived: the pistol held/won loop and the decided-round
// gap loop), retired from production by the card migration and
// surviving ONLY here (M3/ME6 retirement precedent — the card numbers
// stay characterized by the economy tables DOM driver, section M8:
// pistol "1/2", gap "$67" = round(800/12)).
//
// Two matches carry the fixture (a dedicated corpus — the shared
// testdata/seed.sql cannot host this variety: its winners strictly
// alternate, so a HELD pistol round and a decided round whose winner
// brought the CHEAPER buy are structurally unreachable there, and its
// classification table is join_test's rig to seed):
//
//   - match 1 is the DOM driver's 13-round fixture MIRRORED row for
//     row (winners: r1/r13 ct, odd t, even ct, r5 undecided; equips
//     4000+100(r−1) ct / 3800+100(r−1) t; pistol labels r1+r13) —
//     its oracle reproduces the pinned card numbers exactly: held 1 of
//     2 pistol rounds (1/2 → 0.5) and gapSum 800 over 12 decided
//     rounds (800/12; the card rounds it to $67).
//   - match 2 is the DISCRIMINATING variety: consecutive same-side
//     wins (a held pistol), an undecided... none — five decided rounds
//     where the WINNER often brought the FATTER buy losing side's
//     money (r1: ct wins 3000 vs t's 5000 → gap −2000; r3: t wins
//     4500 vs ct's 5000 → −500 — a directional bug or an absolute
//     difference lands elsewhere), a pistol round with no next round
//     (r5 — never held), and pistols held 2 of 3.
//
// Every assertion is EXACT equality of the seeded expression's stored
// value against the oracle (and of the oracle against the hand-stated
// card numbers); a divergence here means the seed side is wrong.

// econCardRow is one row of the card's input (the fields the summary
// math reads off models.EconomyRow).
type econCardRow struct {
	round   int
	winner  string
	equipCT int
	equipT  int
	pistol  bool
}

// econCardSummary is the VIEW aggregate, ported verbatim from
// views/Economy.svelte's summary $derived — THE oracle:
//
//	pistol: per pistol round with a decided winner, held iff the
//	        IMMEDIATELY FOLLOWING row's winner is the same side (no
//	        following row ⇒ not held);
//	gap:    per DECIDED round, gap = winner equip − loser equip
//	        ((win || 0) − (lose || 0)); avgGap = Math.round(sum/n) is
//	        the card's DISPLAY rounding — the pre-round mean
//	        sum/gapN is what the seed stores (fmtMoney rounds the
//	        same way at render).
func econCardSummary(rows []econCardRow) (held, won int, gapSum, gapN float64) {
	for i := range rows {
		r := rows[i]
		if !r.pistol {
			continue
		}
		side := r.winner
		if side != "ct" && side != "t" {
			continue
		}
		won++
		if i+1 < len(rows) {
			nx := rows[i+1] // immediately following row in display order
			if (side == "ct" && nx.winner == "ct") || (side == "t" && nx.winner == "t") {
				held++
			}
		}
	}
	for i := range rows {
		r := rows[i]
		var win, lose int
		switch r.winner {
		case "ct":
			win, lose = r.equipCT, r.equipT
		case "t":
			win, lose = r.equipT, r.equipCT
		default:
			continue
		}
		gapSum += float64(win - lose)
		gapN++
	}
	return held, won, gapSum, gapN
}

// econFixtureRows is the fixture's rounds per match, in display order
// (round ASC — the card's rows[i+1] neighbor), labels resolved.
func econFixtureRows(t *testing.T, st *store.Store, matchID int) []econCardRow {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT r.number, r.winner, r.equip_ct, r.equip_t,
		        EXISTS(SELECT 1 FROM round_classifications c
		               WHERE c.match_id = r.match_id AND c.round = r.number
		                 AND c.label = 'pistol')
		 FROM rounds r WHERE r.match_id = ? ORDER BY r.number`,
		[]any{matchID}, 100, 5000,
	)
	if err != nil {
		t.Fatalf("read fixture rounds: %v", err)
	}
	rows := make([]econCardRow, 0, len(res.Rows))
	for _, r := range res.Rows {
		rows = append(rows, econCardRow{
			round:   int(r[0].(int64)),
			winner:  r[1].(string),
			equipCT: int(r[2].(int64)),
			equipT:  int(r[3].(int64)),
			pistol:  r[4].(int64) != 0,
		})
	}
	return rows
}

// econFixtureStore builds the dedicated two-match corpus (writes on a
// second connection beside the store handle — the seededStore /
// join_test pattern).
func econFixtureStore(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "econ.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() {
		_ = st.CloseRO()
		_ = st.Close()
	})
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fixture conn: %v", err)
	}
	defer func() { _ = db.Close() }()

	for _, m := range []struct {
		id   int
		path string
	}{{1, "econ/mirror.dem"}, {2, "econ/variety.dem"}} {
		if _, err := db.Exec(
			`INSERT INTO matches (id, path, sha256, size, map, status) VALUES (?, ?, ?, 1024, 'de_mirage', 'ready')`,
			m.id, m.path, "econ-sha-"+m.path,
		); err != nil {
			t.Fatalf("insert match: %v", err)
		}
	}

	// Match 1: the DOM driver fixture mirrored (see the file header).
	for r := 1; r <= 13; r++ {
		winner := "ct"
		switch {
		case r == 5:
			winner = "" // the driver's one undecided round
		case r == 1 || r == 13:
			winner = "ct"
		case r%2 == 1:
			winner = "t"
		}
		equipCT := 4000 + 100*(r-1)
		equipT := 3800 + 100*(r-1)
		if _, err := db.Exec(
			`INSERT INTO rounds (match_id, number, winner, equip_ct, equip_t) VALUES (1, ?, ?, ?, ?)`,
			r, winner, equipCT, equipT,
		); err != nil {
			t.Fatalf("insert match1 round %d: %v", r, err)
		}
	}
	for _, r := range []int{1, 13} {
		if _, err := db.Exec(
			`INSERT INTO round_classifications (match_id, round, label, confidence, rule_version, explanation)
			 VALUES (1, ?, 'pistol', 1.0, 1, '')`, r,
		); err != nil {
			t.Fatalf("insert match1 label r%d: %v", r, err)
		}
	}

	// Match 2: the discriminating variety — consecutive wins, winner
	// brings the cheaper buy twice, pistols on 1/3/5 (5 is last).
	type m2 struct {
		number          int
		winner          string
		equipCT, equipT int
		pistol          bool
	}
	for _, r := range []m2{
		{1, "ct", 3000, 5000, true},  // ct wins with the CHEAPER buy → −2000
		{2, "ct", 4500, 4000, false}, // held next: consecutive ct wins
		{3, "t", 5000, 4500, true},   // t wins with the cheaper buy → −500
		{4, "t", 4000, 4200, false},  // held next: consecutive t wins
		{5, "ct", 3500, 3600, true},  // last round — a pistol never held
	} {
		if _, err := db.Exec(
			`INSERT INTO rounds (match_id, number, winner, equip_ct, equip_t) VALUES (2, ?, ?, ?, ?)`,
			r.number, r.winner, r.equipCT, r.equipT,
		); err != nil {
			t.Fatalf("insert match2 round %d: %v", r.number, err)
		}
		if r.pistol {
			if _, err := db.Exec(
				`INSERT INTO round_classifications (match_id, round, label, confidence, rule_version, explanation)
				 VALUES (2, ?, 'pistol', 1.0, 1, '')`, r.number,
			); err != nil {
				t.Fatalf("insert match2 label r%d: %v", r.number, err)
			}
		}
	}
	return st
}

// TestEconomyCardSeedEquivalence is THE no-exceptions pin: the two
// seeded expressions' stored values are EXACTLY the card view
// aggregate's numbers (the ported oracle), and the oracle itself is
// exactly the economy tables driver's characterized card values for
// the mirrored fixture (pistol 1/2, gap 800/12 → round 67 = "$67").
func TestEconomyCardSeedEquivalence(t *testing.T) {
	st := econFixtureStore(t)

	// The SEEDED expressions — read from the catalog, so the
	// equivalence pins what production computes, not a copy here.
	seedExpr := map[string]string{}
	res, err := st.RunReadOnly(
		`SELECT name, expr FROM metrics WHERE origin = 'builtin' AND name IN ('pistol_hold', 'avg_equip_gap')`,
		nil, 10, 5000,
	)
	if err != nil {
		t.Fatalf("read seeds: %v", err)
	}
	for _, r := range res.Rows {
		seedExpr[r[0].(string)] = r[1].(string)
	}
	if len(seedExpr) != 2 {
		t.Fatalf("seeded rows = %d, want 2 (pistol_hold, avg_equip_gap)", len(seedExpr))
	}

	cases := []struct {
		matchID         int
		wantRows        int     // the match's rounds — the group's N behind both seeds
		wantDecided     float64 // the oracle's gapN (decided rounds only)
		wantWon         int
		wantHeld        int
		wantSum         float64
		wantPistolValue float64
		wantGapValue    float64
	}{
		// The DOM driver's fixture mirrored: the card numbers pinned by
		// econ-tables.dom.mjs M8 ("1/2", "$67" = round(800/12)).
		{1, 13, 12, 2, 1, 800, 0.5, 800.0 / 12.0},
		// The variety match: 2 of 3 pistols held (the last can never
		// hold), gapSum −1900 over 5 decided rounds → −380 exactly.
		{2, 5, 5, 3, 2, -1900, 2.0 / 3.0, -380},
	}
	for _, c := range cases {
		rows := econFixtureRows(t, st, c.matchID)
		if len(rows) != c.wantRows {
			t.Fatalf("match %d fixture rows = %d, want %d", c.matchID, len(rows), c.wantRows)
		}
		held, won, gapSum, gapN := econCardSummary(rows)
		// The ORACLE against the hand-stated card numbers — exact.
		if won != c.wantWon || held != c.wantHeld {
			t.Errorf("oracle match %d pistol = %d/%d, want hand-computed %d/%d",
				c.matchID, held, won, c.wantHeld, c.wantWon)
		}
		if gapSum != c.wantSum || gapN != c.wantDecided {
			t.Errorf("oracle match %d gap = %v/%v, want hand-computed %v/%v",
				c.matchID, gapSum, gapN, c.wantSum, c.wantDecided)
		}
		oraclePistol := float64(held) / float64(won)
		oracleGap := gapSum / gapN
		if oraclePistol != c.wantPistolValue {
			t.Errorf("oracle match %d pistol value = %v, want hand-computed %v", c.matchID, oraclePistol, c.wantPistolValue)
		}
		if oracleGap != c.wantGapValue {
			t.Errorf("oracle match %d gap value = %v, want hand-computed %v", c.matchID, oracleGap, c.wantGapValue)
		}

		// The seed's stored value vs the oracle — EXACT.
		scope := "match:" + strconv.Itoa(c.matchID)
		for _, tc := range []struct {
			name, expr string
			want       float64
		}{
			{"pistol_hold", seedExpr["pistol_hold"], oraclePistol},
			{"avg_equip_gap", seedExpr["avg_equip_gap"], oracleGap},
		} {
			pv, perr, err := RunPreview(st, Def{Expr: tc.expr, Subject: "match"}, scope, 10)
			if perr != nil {
				t.Fatalf("%s compile: %v", tc.name, perr)
			}
			if err != nil {
				t.Fatalf("%s run: %v (sql %s)", tc.name, err, pv.SQL)
			}
			if len(pv.Rows) != 1 {
				t.Fatalf("%s %s rows = %d, want 1", tc.name, scope, len(pv.Rows))
			}
			got := pv.Rows[0].Value
			if got != tc.want {
				t.Errorf("%s %s value = %v, want EXACT %v (the card view aggregate)",
					tc.name, scope, got, tc.want)
			}
			if pv.Rows[0].N != c.wantRows {
				t.Errorf("%s %s N = %d, want %d (the match's rounds)", tc.name, scope, pv.Rows[0].N, c.wantRows)
			}
		}
	}

	// The driver's DISPLAY hand-pins rest on the oracle: the card's
	// Math.round(800/12) is the "$67" the DOM driver checks, and the
	// held/won pair renders "1/2" — both asserted here against the
	// mirror's oracle so a fixture edit that breaks the card numbers
	// fails even before the seed runs.
	_, _, sum1, n1 := econCardSummary(econFixtureRows(t, st, 1))
	if int(math.Round(sum1/n1)) != 67 {
		t.Errorf("mirrored fixture gap round = %d, want 67 (the card's $67)", int(math.Round(sum1/n1)))
	}
}
