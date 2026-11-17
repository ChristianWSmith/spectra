package metrics

import (
	"context"
	"math"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ---- m3: combat damage seeds — value equivalence (plan §7 M3) ----
//
// store.GetCombatStats → AnalyticsService.GetCombatStats → the
// frontend getCombatStats wrapper were retired from production in this
// wave (adoption means migration: the Combat panel that read them is
// gone and no frontend caller remained). Damage-no-kill and Kill
// conversion % now live as the dmg_no_kill / kill_conversion builtin
// seeds over the EXISTS construct (plan §6.2/D7), and this file is
// their equivalence proof against the ME0-characterized pre-image
// values (the deleted TestGetCombatStatsFromStoredRows and
// TestGetCombatStatsSQLDecisions in internal/store):
//
//	characterized               → seed value
//	DMGNoKill 50 (alice)        → dmg_no_kill 50
//	DMGConvPct ≈54.55 (0..100)  → kill_conversion × 100 ≈ 54.55
//	DMGNoKill 50/10 (zoe/dave)  → dmg_no_kill 50/10 (actor-pair rule)
//	FF 10 (alice, dave)         → NO SEED: see the FF note below
//	humans-only base rows       → no metric row for the bot (engine side)
//
// Scale note: the retired read-DTO carried DMGConvPct on a 0..100
// scale (the Combat tab's fmtPercent consumed it raw); the metric
// system's `percent` format stores 0..1 like every other percent seed
// (hs_pct, kast), so equivalence is asserted as value × 100 — the same
// ×100 bridge TestFixtureCorpusScoreboardEquivalence uses for kast.
//
// FF note (plan §7 M3 "FF damage too if expressible; else stays,
// noted"): friendly fire needs the VICTIM's stored side beside the
// attacker's, and no grammar source carries it — `events` has no side
// column, the side-carrying sources (player_stats, round_player_sides)
// join only on the row's own subject (the attacker), and exists()'s
// inner scan is the primary events table alone (whitelist.go). So FF
// stays Go-side: the retired SQL survives HERE as the reference oracle
// (the M2 precedent — kdPerMatchSQL survives only as the oracle in
// metric_series_read_test.go), and this file holds the only remaining
// copy of its decisions.
//
// The name-ORDER decision (old decision 3) retired with the roster
// read it served: nothing orders these numbers by name any more. The
// oracle keeps its ORDER BY as a faithful copy but does not pin it.

// combatOracleRow is the retired GetCombatStats read shape per human
// attacker: unconverted damage, conversion percent on the retired
// 0..100 scale, and friendly fire (the no-seed column).
type combatOracleRow struct {
	NoKill  int
	ConvPct float64
	FF      int
}

// combatStatsOracle runs the RETIRED store.GetCombatStats SQL verbatim
// (the reference oracle — see the FF note above): the damage aggregate
// with its same-tick EXISTS split and final-side friendly fire, over
// the humans-only, name-ordered base rows the roster read used.
func combatStatsOracle(t *testing.T, st *store.Store, matchID int64) map[string]combatOracleRow {
	t.Helper()
	dmgRes, err := st.RunReadOnly(
		`SELECT e.attacker,
			SUM(e.dmg),
			SUM(CASE WHEN EXISTS (
				SELECT 1 FROM events k
				WHERE k.match_id = e.match_id AND k.kind = 'kill' AND k.tick = e.tick
					AND k.attacker = e.attacker AND k.victim = e.victim
			) THEN e.dmg ELSE 0 END),
			SUM(CASE WHEN vp.steam_id IS NOT NULL AND ap.side = vp.side THEN e.dmg ELSE 0 END)
		 FROM events e
		 LEFT JOIN players ap ON ap.match_id = e.match_id AND e.attacker <> '' AND ap.steam_id = e.attacker
		 LEFT JOIN players vp ON vp.match_id = e.match_id AND e.victim <> '' AND vp.steam_id = e.victim
		 WHERE e.match_id = ? AND e.kind = 'damage' AND e.attacker <> ''
		 GROUP BY e.attacker`,
		[]any{matchID}, 500, 5000)
	if err != nil {
		t.Fatalf("oracle damage aggregate: %v", err)
	}
	type agg struct{ total, onKill, ff float64 }
	byAttacker := map[string]agg{}
	for _, r := range dmgRes.Rows {
		byAttacker[r[0].(string)] = agg{toFloat(r[1]), toFloat(r[2]), toFloat(r[3])}
	}
	// The old base rows: every HUMAN with stats for the match, by name.
	baseRes, err := st.RunReadOnly(
		`SELECT ps.steam_id, p.name
		 FROM player_stats ps
		 JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id
		 WHERE ps.match_id = ? AND p.is_bot = 0 ORDER BY p.name ASC`,
		[]any{matchID}, 500, 5000)
	if err != nil {
		t.Fatalf("oracle base rows: %v", err)
	}
	out := map[string]combatOracleRow{}
	for _, r := range baseRes.Rows {
		sid := r[0].(string)
		a := byAttacker[sid]
		row := combatOracleRow{NoKill: int(a.total - a.onKill), FF: int(a.ff)}
		if a.total > 0 {
			row.ConvPct = 100 * a.onKill / a.total
		}
		out[sid] = row
	}
	return out
}

// combatPreview runs one seed definition at a scope and keys its rows
// by subject (previewAt's row-preserving twin — N and Label matter
// here).
func combatPreview(t *testing.T, st *store.Store, def Def, scope string) map[string]PreviewRow {
	t.Helper()
	pv, perr, err := RunPreview(st, def, scope, 500)
	if perr != nil {
		t.Fatalf("parse %q: %v", def.Expr, perr)
	}
	if err != nil {
		t.Fatalf("run %q (scope %q): %v (sql: %s)", def.Expr, scope, err, pv.SQL)
	}
	out := make(map[string]PreviewRow, len(pv.Rows))
	for _, r := range pv.Rows {
		out[r.Group] = r
	}
	return out
}

// saveCombatMatch stores one extracted-match fixture under a fresh
// match row, ready for the sweep.
func saveCombatMatch(t *testing.T, st *store.Store, sha string, em *models.ExtractedMatch) int64 {
	t.Helper()
	em.Match.Path = "/d/" + sha + ".dem"
	em.Match.SHA256 = sha
	if em.Match.ExtractedAt.IsZero() {
		em.Match.ExtractedAt = time.Now()
	}
	id, err := st.CreateMatchRow(em.Match.Path, sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return id
}

// combatStore opens a file-backed store (the preview path needs one).
func combatStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "combat-equiv.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// characterizationFixture is the ME0 characterized corpus
// (TestGetCombatStatsFromStoredRows verbatim): alice deals 110 damage
// to bob — 60 on the kill's tick, 40 on a later tick — plus 10 friendly
// fire on carl (both ct). Expected: DMGNoKill 50, DMGConvPct ≈54.55,
// FF 10.
func characterizationFixture(t *testing.T) (*store.Store, int64) {
	t.Helper()
	st := combatStore(t)
	em := &models.ExtractedMatch{
		Match: models.Match{Map: "de_dust2", TickRate: 64},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct"},
			{SteamID: "200", Name: "bob", Side: "t"},
			{SteamID: "300", Name: "carl", Side: "ct"},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Name: "alice", Side: "ct"},
			{SteamID: "200", Name: "bob", Side: "t"},
		},
		Events: []models.Event{
			{Seq: 0, Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
			{Seq: 1, Tick: 10, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 60},
			{Seq: 2, Tick: 20, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 40},
			{Seq: 3, Tick: 30, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "300", Dmg: 10}, // FF (both ct)
		},
	}
	return st, saveCombatMatch(t, st, "combat-equiv-a", em)
}

// TestCombatDamageSeedEquivalence is THE m3 acceptance: the seeded
// dmg_no_kill / kill_conversion definitions (read from the schema, never
// a test-local copy) reproduce ME0's characterized values on the
// characterized corpus, and the retired SQL's oracle agrees with them.
func TestCombatDamageSeedEquivalence(t *testing.T) {
	st, id := characterizationFixture(t)
	oracle := combatStatsOracle(t, st, id)

	// The characterized pre-image, through the oracle: if this fails the
	// oracle drifted from the retired reader — stop, do not adjust.
	alice, ok := oracle["100"]
	if !ok {
		t.Fatalf("oracle has no alice row: %+v", oracle)
	}
	if alice.NoKill != 50 {
		t.Errorf("oracle DMGNoKill = %d, want 50 (110 total − 60 on-kill)", alice.NoKill)
	}
	if want := 100 * 60.0 / 110.0; math.Abs(alice.ConvPct-want) > 1e-9 {
		t.Errorf("oracle DMGConvPct = %v, want %v (≈54.55, the 0..100 scale)", alice.ConvPct, want)
	}
	if alice.FF != 10 {
		t.Errorf("oracle FF = %d, want 10 (alice and carl both ct)", alice.FF)
	}

	noKill := combatPreview(t, st, seedDef(t, st, "dmg_no_kill"), "match:"+itoa(id))
	conv := combatPreview(t, st, seedDef(t, st, "kill_conversion"), "match:"+itoa(id))

	aNoKill, ok := noKill["100"]
	if !ok {
		t.Fatalf("dmg_no_kill has no alice row: %+v", noKill)
	}
	if int(aNoKill.Value) != alice.NoKill || aNoKill.Value != 50 {
		t.Errorf("dmg_no_kill(alice) = %v, want the characterized 50", aNoKill.Value)
	}
	// N = alice's four event rows — the group behind the aggregate.
	if aNoKill.N != 4 {
		t.Errorf("dmg_no_kill(alice) N = %d, want 4 (alice's event rows)", aNoKill.N)
	}
	aConv, ok := conv["100"]
	if !ok {
		t.Fatalf("kill_conversion has no alice row: %+v", conv)
	}
	// Percent bridge: the seed stores 0..1, the retired read-DTO
	// carried 0..100 — ×100 is the number the old Combat tab showed.
	if want := 100 * 60.0 / 110.0; math.Abs(aConv.Value*100-want) > 1e-9 {
		t.Errorf("kill_conversion(alice) × 100 = %v, want %v (≈54.55)", aConv.Value*100, want)
	}
	if math.Abs(aConv.Value*100-54.55) > 0.01 {
		t.Errorf("kill_conversion(alice) × 100 = %v, want ≈54.55 (the characterized percent)", aConv.Value*100)
	}

	// Population: the roster read's zero rows (bob dealt no damage)
	// died with it — a seed row exists for the subjects its source
	// carries. Carl dealt no damage and has no event rows either.
	if row, ok := noKill["200"]; ok {
		t.Errorf("dmg_no_kill(bob) = %v, want no row (the roster read's zero row retired with the reader)", row.Value)
	}
	if row, ok := noKill["300"]; ok {
		t.Errorf("dmg_no_kill(carl) = %v, want no row (carl has no events)", row.Value)
	}
}

// decisionFixture is the ME0 decision corpus
// (TestGetCombatStatsSQLDecisions verbatim, plus a bot's damage): the
// same-tick kill by a DIFFERENT attacker must not convert, both-unknown
// sides count as friendly fire, and the bot's damage never reaches a
// value.
func decisionFixture(t *testing.T) (*store.Store, int64) {
	t.Helper()
	st := combatStore(t)
	em := &models.ExtractedMatch{
		Match: models.Match{Map: "de_dust2", TickRate: 64},
		Players: []models.Player{
			{SteamID: "100", Name: "zoe", Side: "ct"},
			{SteamID: "200", Name: "amy", Side: "t"},
			{SteamID: "300", Name: "carl", Side: "ct"},
			{SteamID: "400", Name: "dave", Side: ""}, // unknown side
			{SteamID: "500", Name: "erin", Side: ""}, // unknown side
			{SteamID: botSteamID, Name: "bot", Side: "ct", IsBot: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Name: "zoe", Side: "ct", RoundsPlayed: 2},
			{SteamID: "200", Name: "amy", Side: "t", RoundsPlayed: 2},
			{SteamID: "300", Name: "carl", Side: "ct", RoundsPlayed: 2},
			{SteamID: "400", Name: "dave", Side: "", RoundsPlayed: 2},
			{SteamID: "500", Name: "erin", Side: "", RoundsPlayed: 2},
			{SteamID: botSteamID, Name: "bot", Side: "ct", RoundsPlayed: 2},
		},
		Events: []models.Event{
			// (1) Friendly fire with BOTH sides unknown: '' == '' counts.
			{Seq: 0, Tick: 100, Round: 1, Kind: models.EventDamage, Attacker: "400", Victim: "500", Dmg: 10},
			// (2) Damage whose victim dies the same tick from a
			// DIFFERENT attacker: the kill must match attacker+victim+
			// tick, so this stays damage-without-kill.
			{Seq: 1, Tick: 200, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 50},
			{Seq: 2, Tick: 200, Round: 1, Kind: models.EventKill, Attacker: "300", Victim: "200"},
			// (3) Same attacker+victim+tick → on-kill damage.
			{Seq: 3, Tick: 300, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200", Dmg: 40},
			{Seq: 4, Tick: 300, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
			// (4) The bot's damage: event rows keep it in storage, but
			// neither the roster read's base rows nor a metric value may
			// surface it (humans-only, old decision 5).
			{Seq: 5, Tick: 400, Round: 1, Kind: models.EventDamage, Attacker: botSteamID, Victim: "100", Dmg: 10},
		},
	}
	return st, saveCombatMatch(t, st, "combat-equiv-b", em)
}

// TestCombatSeedActorPairAndRosterEquivalence pins the retired SQL's
// read decisions through the seeds where they migrated and through the
// oracle where they did not:
//
//   - actor-pair/tick conversion (old decision 2): zoe's 90 damage
//     converts only the same-attacker same-tick 40 → NoKill 50 both
//     sides; the different-attacker kill on the same tick does not
//     convert (the exists_test correlation pin's sibling at seed level);
//   - both-unknown-sides friendly fire (old decision 1): dave FF 10 —
//     oracle-only, no seed (see the FF note);
//   - humans-only (old decision 5): the bot's damage reaches neither
//     the oracle's base rows nor any metric row;
//   - name ordering (old decision 3): retired with the roster read —
//     not asserted anywhere (see the file header).
func TestCombatSeedActorPairAndRosterEquivalence(t *testing.T) {
	st, id := decisionFixture(t)
	oracle := combatStatsOracle(t, st, id)

	zoe, ok := oracle["100"]
	if !ok {
		t.Fatalf("oracle has no zoe row: %+v", oracle)
	}
	if zoe.NoKill != 50 {
		t.Errorf("oracle zoe DMGNoKill = %d, want 50 (90 total − 40 same-attacker on-kill)", zoe.NoKill)
	}
	dave, ok := oracle["400"]
	if !ok {
		t.Fatalf("oracle has no dave row: %+v", oracle)
	}
	if dave.NoKill != 10 || dave.FF != 10 {
		t.Errorf("oracle dave noKill/ff = %d/%d, want 10/10 ('' == '' counts as FF)", dave.NoKill, dave.FF)
	}
	if _, ok := oracle[botSteamID]; ok {
		t.Errorf("oracle lists the bot: %+v (base rows are humans only)", oracle[botSteamID])
	}

	noKill := combatPreview(t, st, seedDef(t, st, "dmg_no_kill"), "match:"+itoa(id))
	conv := combatPreview(t, st, seedDef(t, st, "kill_conversion"), "match:"+itoa(id))

	if v := noKill["100"].Value; v != 50 {
		t.Errorf("dmg_no_kill(zoe) = %v, want 50 (the different-attacker kill must not convert)", v)
	}
	if v := noKill["400"].Value; v != 10 {
		t.Errorf("dmg_no_kill(dave) = %v, want 10", v)
	}
	if row, ok := noKill[botSteamID]; ok {
		t.Errorf("dmg_no_kill(bot) = %v, want no row (humans-only, engine side)", row.Value)
	}
	// Carl only ever holds a kill row: his damage sums are 0 on both
	// sides (the old roster zeros for damage-less subjects).
	if v, ok := noKill["300"]; !ok || v.Value != 0 {
		t.Errorf("dmg_no_kill(carl) = %+v, want a 0 row (his kill event anchors the group)", v)
	}
	if v := conv["100"].Value * 100; math.Abs(v-zoe.ConvPct) > 1e-9 {
		t.Errorf("kill_conversion(zoe) × 100 = %v, want the oracle's %v (40/90)", v, zoe.ConvPct)
	}
	if v := conv["400"].Value; v != 0 {
		t.Errorf("kill_conversion(dave) = %v, want 0 (no on-kill damage)", v)
	}
}

// TestCombatSeedsSweepFresh pins the "no new wiring" claim: the two
// M3 seeds are ordinary match-scope builtins, so the existing
// behind-predicate → sweep path (startup + per-import) picks them up —
// after one Sweep on a fixture both read fresh, not behind.
func TestCombatSeedsSweepFresh(t *testing.T) {
	st, _ := characterizationFixture(t)
	if _, err := Sweep(context.Background(), st, nil); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	res, err := st.RunReadOnly(
		`SELECT id, name FROM metrics WHERE name IN ('dmg_no_kill', 'kill_conversion')`,
		nil, 10, 5000)
	if err != nil {
		t.Fatalf("read seeds: %v", err)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("combat seeds in schema = %d, want 2", len(res.Rows))
	}
	cov, err := st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	byID := map[int64]store.MetricCoverage{}
	for _, c := range cov {
		byID[c.MetricID] = c
	}
	for _, r := range res.Rows {
		id := r[0].(int64)
		name := r[1].(string)
		c, ok := byID[id]
		if !ok {
			t.Errorf("%s missing from coverage", name)
			continue
		}
		if c.Behind || c.FreshRows == 0 {
			t.Errorf("%s coverage = %+v, want fresh rows after one Sweep", name, c)
		}
	}
}
