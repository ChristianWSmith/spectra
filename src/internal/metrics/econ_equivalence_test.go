package metrics

import (
	"database/sql"
	"math"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/rules"
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
// math reads off models.EconomyRow — the stored round_side_classes
// buy classes ride beside the round facts for the force/lost oracle
// below).
type econCardRow struct {
	round   int
	winner  string
	equipCT int
	equipT  int
	pistol  bool
	classCT string
	classT  string
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

// --- side parity (the per-team key) --------------------------------------
//
// The force and lost cards are PER-TEAM rollups: each round's side
// resolves to the TEAM behind it through sideparity.teamKeyAt, keyed by
// the team's final side. The oracle ports that JavaScript VERBATIM
// (frontend/src/lib/sideparity.js — flipIndexes/eraOf/sideInEra/
// teamKeyAt, null → ""); the seed side reads the stored `team` column,
// which production stamps through Go's rules.TeamKeyAt (the twin pinned
// to this same fixture by internal/rules/testdata/sideparity.json). A
// JS/Go twin drift therefore fails HERE, exactly where the card and the
// stored row would disagree.

// jsFlipIndexes is sideparity.js flipIndexes: the counted-round indexes
// (0-based) where side switches happen — 12, then 27 + 3*(k−2).
func jsFlipIndexes(counted, switches int) []int {
	n, s := counted, switches
	if n <= 0 || s <= 0 {
		return nil
	}
	var flips []int
	for k := 1; k <= s; k++ {
		idx := 12
		if k > 1 {
			idx = 27 + 3*(k-2)
		}
		if idx > 0 && idx < n {
			flips = append(flips, idx)
		}
	}
	return flips
}

// jsSideInEra is sideparity.js sideInEra: the side the team that ENDED
// on finalSide played in half `era` (the JS null for a non-side reads
// "" here).
func jsSideInEra(finalSide string, switches, era int) string {
	if finalSide != "ct" && finalSide != "t" {
		return ""
	}
	s, e := switches, era
	if s < 0 {
		s = 0
	}
	if e < 0 {
		e = 0
	}
	eras := s + 1
	if eras < 1 {
		eras = 1 // JS Math.max(1, s+1)
	}
	flips := eras - 1 - e
	if flips < 0 {
		flips = -flips
	}
	if flips%2 == 0 {
		return finalSide
	}
	if finalSide == "ct" {
		return "t"
	}
	return "ct"
}

// jsTeamKeyAt is sideparity.js teamKeyAt: the SIDE played in the
// counted round at `index` maps to that TEAM's final-side key (the JS
// null for a non-side reads "" here).
func jsTeamKeyAt(side string, index, counted, switches int) string {
	if side != "ct" && side != "t" {
		return ""
	}
	era := 0
	for _, fl := range jsFlipIndexes(counted, switches) {
		if fl <= index {
			era++
		}
	}
	if jsSideInEra("ct", switches, era) == side {
		return "ct"
	}
	return "t"
}

// econForceTeam is one team's force-buy counts as the card shows them
// (the sub-line's won/total pair).
type econForceTeam struct{ won, total int }

// econForceLost is the force + lost-equip view aggregate — ported
// verbatim from views/Economy.svelte's summary $derived (the force loop
// and the lost-equipment half of the gap/lost loop), THE oracle for the
// last two Economy cards' numbers:
//
//	force: per row, each side whose stored class is 'force' counts ONE
//	        force round for the TEAM behind that side (teamKeyAt over
//	        the economy rows' index and length — a round both teams
//	        force-bought counts for each); won iff that side won the
//	        round; the card's headline percent pools both teams
//	        (Math.round(100·Σwon/Σtotal)), the sub-line shows each
//	        team's own pair;
//	lost:  per DECIDED round the loser's freeze-end equip credits the
//	        TEAM behind the loser side; lostTotal is the two halves
//	        summed (rounds whose team key is '' would drop — never
//	        guessed); firstForce/lostRound are the DRILL anchors (view
//	        navigation, not rendered values).
type econForceLost struct {
	force      map[string]econForceTeam // 'ct'/'t' final-side keys
	lost       map[string]int           // per-team lost dollars
	lostTotal  int
	firstForce int
	lostRound  int
}

func econForceLostSummary(rows []econCardRow, switches int) econForceLost {
	counted := len(rows)
	out := econForceLost{
		force: map[string]econForceTeam{"ct": {}, "t": {}},
		lost:  map[string]int{"ct": 0, "t": 0},
	}
	for i := range rows {
		r := rows[i]
		var sides []string
		if r.classCT == "force" {
			sides = append(sides, "ct")
		}
		if r.classT == "force" {
			sides = append(sides, "t")
		}
		for _, side := range sides {
			key := jsTeamKeyAt(side, i, counted, switches)
			if key == "" {
				continue // unknown side → no guessed team
			}
			team := out.force[key]
			team.total++
			if (side == "ct" && r.winner == "ct") || (side == "t" && r.winner == "t") {
				team.won++
			}
			out.force[key] = team
			if out.firstForce == 0 {
				out.firstForce = r.round
			}
		}
	}
	lostBest := math.Inf(-1)
	for i := range rows {
		r := rows[i]
		var loserSide string
		switch r.winner {
		case "ct":
			loserSide = "t"
		case "t":
			loserSide = "ct"
		default:
			continue // undecided — the card skips it
		}
		loserEquip := r.equipCT // JS: loserSide === 'ct' ? equipCT || 0 : equipT || 0
		if loserSide == "t" {
			loserEquip = r.equipT
		}
		if key := jsTeamKeyAt(loserSide, i, counted, switches); key != "" {
			out.lost[key] += loserEquip
		}
		if float64(loserEquip) > lostBest {
			lostBest = float64(loserEquip)
			out.lostRound = r.round
		}
	}
	out.lostTotal = out.lost["ct"] + out.lost["t"]
	return out
}

// econFixtureRows is the fixture's rounds per match, in display order
// (round ASC — the card's rows[i+1] neighbor), labels and per-side buy
// classes resolved exactly as store.GetEconomy serves them (rounds ⋈
// round_classifications ⋈ round_side_classes).
func econFixtureRows(t *testing.T, st *store.Store, matchID int) []econCardRow {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT r.number, r.winner, r.equip_ct, r.equip_t,
		        EXISTS(SELECT 1 FROM round_classifications c
		               WHERE c.match_id = r.match_id AND c.round = r.number
		                 AND c.label = 'pistol'),
		        COALESCE(rsct.class, ''), COALESCE(rst.class, '')
		 FROM rounds r
		 LEFT JOIN round_side_classes rsct
		   ON rsct.match_id = r.match_id AND rsct.round = r.number AND rsct.side = 'ct'
		 LEFT JOIN round_side_classes rst
		   ON rst.match_id = r.match_id AND rst.round = r.number AND rst.side = 't'
		 WHERE r.match_id = ? ORDER BY r.number`,
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
			classCT: r[5].(string),
			classT:  r[6].(string),
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
		id       int
		path     string
		switches int
	}{
		// Match 1 mirrors the DOM driver fixture INCLUDING its ONE
		// recorded side switch (econ-tables.dom.mjs match.sideSwitches:
		// 1 — flips after counted round 12): that is what makes its
		// per-team force/lost attribution exercise team ≠ side.
		{1, "econ/mirror.dem", 1},
		{2, "econ/variety.dem", 0},
		{3, "econ/noforce.dem", 0},
	} {
		if _, err := db.Exec(
			`INSERT INTO matches (id, path, sha256, size, map, status, side_switches) VALUES (?, ?, ?, 1024, 'de_mirage', 'ready', ?)`,
			m.id, m.path, "econ-sha-"+m.path, m.switches,
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
	// Match 1's per-side classes MIRROR the DOM driver fixture's
	// economyRows (classCT odd full/even eco, classT odd eco/even
	// force — six T-side force rounds, every one in era 0) and its
	// round_economy rows carry the SAME freeze-end equips as the
	// rounds.equip_* columns the card renders. Every team stamp is
	// rules.TeamKeyAt — the EXACT formula SaveExtracted/Compute write
	// into the stored `team` column (the SEED side); the oracle below
	// recomputes the view's JavaScript teamKeyAt client-side.
	for r := 1; r <= 13; r++ {
		classCT, classT := "full", "eco"
		if r%2 == 0 {
			classCT, classT = "eco", "force"
		}
		for _, side := range []string{"ct", "t"} {
			class, equip := classCT, 4000+100*(r-1)
			if side == "t" {
				class, equip = classT, 3800+100*(r-1)
			}
			team := rules.TeamKeyAt(side, r-1, 13, 1)
			if _, err := db.Exec(
				`INSERT INTO round_side_classes (match_id, round, side, class, team) VALUES (1, ?, ?, ?, ?)`,
				r, side, class, team,
			); err != nil {
				t.Fatalf("insert match1 side class r%d %s: %v", r, side, err)
			}
			if _, err := db.Exec(
				`INSERT INTO round_economy (match_id, round, side, equip_value, team) VALUES (1, ?, ?, ?, ?)`,
				r, side, equip, team,
			); err != nil {
				t.Fatalf("insert match1 economy r%d %s: %v", r, side, err)
			}
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
	m2rows := []m2{
		{1, "ct", 3000, 5000, true},  // ct wins with the CHEAPER buy → −2000
		{2, "ct", 4500, 4000, false}, // held next: consecutive ct wins
		{3, "t", 5000, 4500, true},   // t wins with the cheaper buy → −500
		{4, "t", 4000, 4200, false},  // held next: consecutive t wins
		{5, "ct", 3500, 3600, true},  // last round — a pistol never held
	}
	for _, r := range m2rows {
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
	// Match 2's classes give BOTH teams force rounds, so the pooled
	// force rate differs from either team's own rate: ct forces r1/r3/r4
	// (wins r1 only — 1/3), t forces r2/r3 (wins r3 only — 1/2). No
	// side switch (team = side), so the stamps are the identity era map.
	m2class := map[int][2]string{
		1: {"force", "full"}, 2: {"eco", "force"}, 3: {"force", "force"},
		4: {"force", "eco"}, 5: {"full", "full"},
	}
	for _, r := range m2rows {
		for _, side := range []string{"ct", "t"} {
			class, equip := m2class[r.number][0], r.equipCT
			if side == "t" {
				class, equip = m2class[r.number][1], r.equipT
			}
			team := rules.TeamKeyAt(side, r.number-1, 5, 0)
			if _, err := db.Exec(
				`INSERT INTO round_side_classes (match_id, round, side, class, team) VALUES (2, ?, ?, ?, ?)`,
				r.number, side, class, team,
			); err != nil {
				t.Fatalf("insert match2 side class r%d %s: %v", r.number, side, err)
			}
			if _, err := db.Exec(
				`INSERT INTO round_economy (match_id, round, side, equip_value, team) VALUES (2, ?, ?, ?, ?)`,
				r.number, side, equip, team,
			); err != nil {
				t.Fatalf("insert match2 economy r%d %s: %v", r.number, side, err)
			}
		}
	}

	// Match 3: the analyzed-but-ZERO-force shape — class rows exist for
	// both teams every round (so the count seeds RETURN rows: 0 beside
	// their N — the card's "no force buys" branch — never an absent
	// row), none of them 'force'; four decided rounds carry the
	// lost-equip split (ct 5000+4300 = 9300, t 4500+4100 = 8600).
	type m3 struct {
		number          int
		winner          string
		equipCT, equipT int
		classCT, classT string
	}
	for _, r := range []m3{
		{1, "ct", 4000, 4500, "full", "eco"},
		{2, "t", 5000, 3500, "eco", "full"},
		{3, "ct", 4200, 4100, "full", "eco"},
		{4, "t", 4300, 4000, "eco", "full"},
	} {
		if _, err := db.Exec(
			`INSERT INTO rounds (match_id, number, winner, equip_ct, equip_t) VALUES (3, ?, ?, ?, ?)`,
			r.number, r.winner, r.equipCT, r.equipT,
		); err != nil {
			t.Fatalf("insert match3 round %d: %v", r.number, err)
		}
		for _, side := range []string{"ct", "t"} {
			class, equip := r.classCT, r.equipCT
			if side == "t" {
				class, equip = r.classT, r.equipT
			}
			team := rules.TeamKeyAt(side, r.number-1, 4, 0)
			if _, err := db.Exec(
				`INSERT INTO round_side_classes (match_id, round, side, class, team) VALUES (3, ?, ?, ?, ?)`,
				r.number, side, class, team,
			); err != nil {
				t.Fatalf("insert match3 side class r%d %s: %v", r.number, side, err)
			}
			if _, err := db.Exec(
				`INSERT INTO round_economy (match_id, round, side, equip_value, team) VALUES (3, ?, ?, ?, ?)`,
				r.number, side, equip, team,
			); err != nil {
				t.Fatalf("insert match3 economy r%d %s: %v", r.number, side, err)
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
			pv, perr, err := RunPreview(t.Context(), st, Def{Expr: tc.expr, Subject: "match"}, scope, 10)
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

// forceLostCase is one match's hand-stated force/lost pins (the numbers
// BOTH the oracle and the seeds must reproduce exactly).
type forceLostCase struct {
	matchID   int
	wantForce map[string]econForceTeam // per final-side team key; nil = the UNANALYZED shape (no class rows → the seeds emit no rows)
	wantLost  map[string]int           // per team
	wantTot   int
	classN    int // each team's round_side_classes rows — the count seeds' N (0 = don't assert)
	econN     int // each team's round_economy rows — the lost seeds' N
}

// forceLostCorpus is the SHARED fixture's (testdata/seed.sql) pins: three
// matches, sides never switch (team = side), force class rows on matches
// 2-3 only (rounds 2-4 both sides — ct wins only r3 → 1/3, t wins r2+r4
// → 2/3), every round decided with loser equip 2500 (CT loss, even) or
// 2000 (T loss, odd) → 12×2500 = 30000 per team-side half, 54000 total;
// match 1 carries NO class rows (join_test's rig owns that match's
// analysis tables) → the honest ABSENCE the force seeds must keep.
var forceLostCorpus = []forceLostCase{
	{matchID: 1, wantForce: nil, wantLost: map[string]int{"ct": 30000, "t": 24000}, wantTot: 54000, econN: 24},
	{matchID: 2, wantForce: map[string]econForceTeam{"ct": {1, 3}, "t": {2, 3}}, wantLost: map[string]int{"ct": 30000, "t": 24000}, wantTot: 54000, classN: 3, econN: 24},
	{matchID: 3, wantForce: map[string]econForceTeam{"ct": {1, 3}, "t": {2, 3}}, wantLost: map[string]int{"ct": 30000, "t": 24000}, wantTot: 54000, classN: 3, econN: 24},
}

// forceLostFixture is the DEDICATED fixture's pins (econFixtureStore —
// the shapes the shared corpus cannot host, in-file explained there):
// match 1 the DOM driver's mirror WITH its side switch (six era-0
// T-side force rounds attributing to the final-CT team, none won —
// exactly the driver's "0%" / "Alpha 0/6 · Beta 0/0" and lost
// 30200/23600/53800), match 2 both teams force-buying (pooled 2/5 = 40%
// against the teams' own 1/3 and 1/2), match 3 analyzed with ZERO force
// rounds (the seeds RETURN 0-beside-N rows — the card's "no force
// buys" branch — never an absent row).
var forceLostFixture = []forceLostCase{
	{matchID: 1, wantForce: map[string]econForceTeam{"ct": {0, 6}, "t": {0, 0}}, wantLost: map[string]int{"ct": 30200, "t": 23600}, wantTot: 53800, classN: 13, econN: 13},
	{matchID: 2, wantForce: map[string]econForceTeam{"ct": {1, 3}, "t": {1, 2}}, wantLost: map[string]int{"ct": 9000, "t": 12600}, wantTot: 21600, classN: 5, econN: 5},
	{matchID: 3, wantForce: map[string]econForceTeam{"ct": {0, 0}, "t": {0, 0}}, wantLost: map[string]int{"ct": 9300, "t": 8600}, wantTot: 17900, classN: 4, econN: 4},
}

// TestEconomyForceLostSeedEquivalence is the no-exceptions pin for the
// LAST two Economy cards (ME8's exception audit, 2026-11-18 — the
// view-aggregate relocation rule's third clause: these values were
// still computed in the view while stored seeds duplicated them): the
// force card's per-team won/total counts (its headline percent pools
// them across both teams) and the lost card's total + per-team halves
// must be EXACTLY the numbers the view aggregate computed before the
// migration. The oracle is that view computation PORTED VERBATIM
// (econForceLostSummary + the sideparity.js teamKeyAt port), retired
// from production by the card migration and surviving ONLY here (the
// M3/ME6b retirement precedent — the rendered strings stay
// characterized by the economy tables DOM driver, section M8: force
// "0%" / "Alpha 0/6 · Beta 0/0", lost "$53,800" / "Alpha $30,200 ·
// Beta $23,600").
//
// Every assertion is EXACT equality, in both directions: oracle against
// the hand-stated pins (a fixture edit that moves the numbers fails
// here first), then each seeded expression's stored rows against the
// oracle per team/row (a divergence means the seed side — the
// expression or the stored team stamp — is wrong).
func TestEconomyForceLostSeedEquivalence(t *testing.T) {
	// The SEEDED expressions — read from the catalog, so the
	// equivalence pins what production computes, not a copy here.
	readSeeds := func(t *testing.T, st *store.Store) map[string]string {
		t.Helper()
		res, err := st.RunReadOnly(
			`SELECT name, expr FROM metrics WHERE origin = 'builtin'
			   AND name IN ('team_force_wins', 'team_force_rounds', 'lost_equip', 'team_lost_equip')`,
			nil, 10, 5000,
		)
		if err != nil {
			t.Fatalf("read seeds: %v", err)
		}
		out := map[string]string{}
		for _, r := range res.Rows {
			out[r[0].(string)] = r[1].(string)
		}
		if len(out) != 4 {
			t.Fatalf("seeded rows = %d, want 4 (team_force_wins, team_force_rounds, lost_equip, team_lost_equip)", len(out))
		}
		return out
	}

	run := func(t *testing.T, st *store.Store, cases []forceLostCase) {
		t.Helper()
		seedExpr := readSeeds(t, st)
		for _, c := range cases {
			scope := "match:" + strconv.Itoa(c.matchID)

			// The match's side switches — the oracle's parity input,
			// read exactly where the card reads it (the match row).
			sres, err := st.RunReadOnly(
				`SELECT side_switches FROM matches WHERE id = ?`, []any{c.matchID}, 1, 5000,
			)
			if err != nil || len(sres.Rows) != 1 {
				t.Fatalf("match %d side_switches: %v", c.matchID, err)
			}
			switches := int(sres.Rows[0][0].(int64))

			// The ORACLE against the hand-stated pins — exact.
			oracle := econForceLostSummary(econFixtureRows(t, st, c.matchID), switches)
			for _, key := range []string{"ct", "t"} {
				want, have := c.wantForce[key], oracle.force[key]
				if want.won != have.won || want.total != have.total {
					t.Errorf("match %d oracle force[%s] = %+v, want hand-computed %+v", c.matchID, key, have, want)
				}
				if got := oracle.lost[key]; c.wantLost[key] != got {
					t.Errorf("match %d oracle lost[%s] = %d, want hand-computed %d", c.matchID, key, got, c.wantLost[key])
				}
			}
			if oracle.lostTotal != c.wantTot {
				t.Errorf("match %d oracle lostTotal = %d, want hand-computed %d", c.matchID, oracle.lostTotal, c.wantTot)
			}

			// team rows are addressed by their stored team key — map
			// the preview's rows by subject group.
			teamRows := func(t *testing.T, name string) map[string]PreviewRow {
				t.Helper()
				pv, perr, err := RunPreview(t.Context(), st, Def{Expr: seedExpr[name], Subject: "team"}, scope, 10)
				if perr != nil {
					t.Fatalf("%s compile: %v", name, perr)
				}
				if err != nil {
					t.Fatalf("%s run: %v (sql %s)", name, err, pv.SQL)
				}
				out := map[string]PreviewRow{}
				for _, r := range pv.Rows {
					out[r.Group] = r
				}
				return out
			}

			// The count seeds: per team, EXACTLY the oracle's won /
			// total (the sub-line's pairs), with N = the team's stored
			// class rows (the group behind the value, never the filtered
			// force rows).
			if c.wantForce == nil {
				// The unanalyzed shape: NO class rows → no team group →
				// no rows at all (the card's dash; never a fabricated 0).
				for _, name := range []string{"team_force_wins", "team_force_rounds"} {
					if rows := teamRows(t, name); len(rows) != 0 {
						t.Errorf("%s match %d rows = %+v, want NONE (unanalyzed match has no class rows)", name, c.matchID, rows)
					}
				}
			} else {
				for name, field := range map[string]string{"team_force_wins": "won", "team_force_rounds": "total"} {
					rows := teamRows(t, name)
					for _, key := range []string{"ct", "t"} {
						row, ok := rows[key]
						if !ok {
							t.Errorf("%s match %d missing team %q row (%+v)", name, c.matchID, key, rows)
							continue
						}
						want := float64(c.wantForce[key].won)
						if field == "total" {
							want = float64(c.wantForce[key].total)
						}
						if row.Value != want {
							t.Errorf("%s match %d team %s value = %v, want EXACT %v (the card's count pair)",
								name, c.matchID, key, row.Value, want)
						}
						if c.classN != 0 && row.N != c.classN {
							t.Errorf("%s match %d team %s N = %d, want %d (the team's class rows)", name, c.matchID, key, row.N, c.classN)
						}
					}
				}
			}

			// lost_equip (match subject): one row, EXACTLY the card's
			// pooled total.
			pv, perr, err := RunPreview(t.Context(), st, Def{Expr: seedExpr["lost_equip"], Subject: "match"}, scope, 10)
			if perr != nil {
				t.Fatalf("lost_equip compile: %v", perr)
			}
			if err != nil {
				t.Fatalf("lost_equip run: %v (sql %s)", err, pv.SQL)
			}
			if len(pv.Rows) != 1 {
				t.Fatalf("lost_equip %s rows = %d, want 1", scope, len(pv.Rows))
			}
			if got := pv.Rows[0].Value; got != float64(c.wantTot) {
				t.Errorf("lost_equip %s value = %v, want EXACT %d (the card's headline total)", scope, got, c.wantTot)
			}

			// team_lost_equip: per team, EXACTLY the oracle's halves,
			// with N = the team's stored economy rows.
			lostRows := teamRows(t, "team_lost_equip")
			for _, key := range []string{"ct", "t"} {
				row, ok := lostRows[key]
				if !ok {
					t.Errorf("team_lost_equip match %d missing team %q row (%+v)", c.matchID, key, lostRows)
					continue
				}
				if want := float64(c.wantLost[key]); row.Value != want {
					t.Errorf("team_lost_equip match %d team %s value = %v, want EXACT %v (the card's sub-line half)",
						c.matchID, key, row.Value, want)
				}
				if c.econN != 0 && row.N != c.econN {
					t.Errorf("team_lost_equip match %d team %s N = %d, want %d (the team's economy rows)",
						c.matchID, key, row.N, c.econN)
				}
			}
		}
	}

	t.Run("shared corpus", func(t *testing.T) {
		run(t, seededStore(t), forceLostCorpus)
	})
	t.Run("dedicated fixture", func(t *testing.T) {
		run(t, econFixtureStore(t), forceLostFixture)
	})

	// The driver's DISPLAY hand-pins rest on the oracle: the mirror's
	// headline percent is Math.round(100·0/6) = "0%" and its lost total
	// fmtMoney(53800) = "$53,800" — the strings section M8 checks.
	st := econFixtureStore(t)
	oracle := econForceLostSummary(econFixtureRows(t, st, 1), 1)
	pooled := oracle.force["ct"].won + oracle.force["t"].won
	total := oracle.force["ct"].total + oracle.force["t"].total
	if int(math.Round(100*float64(pooled)/float64(total))) != 0 {
		t.Errorf("mirror force headline = %d%%, want 0 (the card's 0%%)", int(math.Round(100*float64(pooled)/float64(total))))
	}
	if oracle.lostTotal != 53800 {
		t.Errorf("mirror lost total = %d, want 53800 (the card's $53,800)", oracle.lostTotal)
	}
}
