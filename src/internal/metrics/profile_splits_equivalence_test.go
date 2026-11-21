package metrics

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// ---- profile partition seeds: value equivalence (plan §7 M5/M6) ----
//
// The Sides table's Go read (store.GetPlayerSideSplits, folded into
// ProfileSide by profileservice.GetProfile) and the Maps table's Go
// reads (the history fold over matches/wins/kills/deaths plus
// store.GetPlayerMapADR's pooled micro-average) migrate to the
// side/map-partitioned builtin seeds in this wave (adoption means
// migration): the production surfaces read the stored seed rows and the
// retired computations survive ONLY here, as reference oracles — the
// M3 precedent (combat_equivalence_test.go).
//
// The pass condition is EXACT equality (owner ruling 2026-11-17, "we
// don't do exceptions"): every oracle number, per player and per dim,
// equals the seed's stored-shape value bit for bit. Both sides divide
// the same integers through IEEE doubles (the seeds' ratio() emission
// and the oracles' own arithmetic), so exact == is the honest pin.
//
// Scale bridges, asserted here rather than assumed:
//   - KAST: the oracle carries 0..100 (100 × AVG), the percent seed
//     stores 0..1 → seed × 100 == oracle (the MetricDisplayScale rule);
//   - round win %: the oracle's profileservice fold carries 0..100, the
//     seed stores the fraction → same ×100 bridge;
//   - side K/D: the fold floored the divisor at max(deaths, 1) — the
//     seed's max(sum(deaths), 1) is the same floor, spelled in the
//     expression (no NULL→0 divergence).
//
// The seed rows are read from the CATALOG by name (expr + denominator
// come from the seeded row, never a copy in this file), compiled through
// the same Address the sweep uses, so the equivalence covers the actual
// shipped definition.

// seedByName loads a seeded builtin's statement from the catalog — the
// test must pin what schema.sql actually ships.
func seedByName(t *testing.T, st *store.Store, name string) string {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT expr FROM metrics WHERE name = ? AND origin = 'builtin'`,
		[]any{name}, 1, 5000,
	)
	if err != nil || len(res.Rows) != 1 {
		t.Fatalf("seed %q: rows=%d err=%v", name, len(res.Rows), err)
	}
	return res.Rows[0][0].(string)
}

// profileSeedRows runs one profile-scope partitioned seed over the whole
// library (the sweep's career statement) and keys its rows by
// (subject, dim) — the shape the stored read serves the surface. Raw
// partitioned seeds run through the raw path (ruling 22).
func profileSeedRows(t *testing.T, st *store.Store, name, partition string) map[string]map[string]float64 {
	t.Helper()
	expr := seedByName(t, st, name)
	raw := map[string]map[string]float64{}
	var rows []store.RawMetricRow
	if strings.Contains(expr, ":steam_id") {
		rows = careerRows(t, st, expr)
	} else {
		rows = rawPreviewRows(t, st, expr, "")
	}
	for _, r := range rows {
		if raw[r.SubjectKey] == nil {
			raw[r.SubjectKey] = map[string]float64{}
		}
		if _, dup := raw[r.SubjectKey][r.Dim]; dup {
			t.Errorf("%s: duplicate row for (%s, %q)", name, r.SubjectKey, r.Dim)
		}
		raw[r.SubjectKey][r.Dim] = rawValue(r)
	}
	return raw
}

// corpusHumans returns the corpus roster (human player_stats rows) in
// subject order.
func corpusHumans(t *testing.T, st *store.Store) []string {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT DISTINCT steam_id FROM player_stats ORDER BY steam_id ASC`, nil, 100, 5000,
	)
	if err != nil {
		t.Fatalf("roster: %v", err)
	}
	out := make([]string, 0, len(res.Rows))
	for _, r := range res.Rows {
		out = append(out, r[0].(string))
	}
	if len(out) != 8 {
		t.Fatalf("roster = %d players, want the corpus 8", len(out))
	}
	return out
}

// TestSideSplitSeedEquivalence pins the M5 migration: every
// GetPlayerSideSplits oracle number equals the side-partitioned seed's
// value for that player's dim, and the seed emits no dim the oracle did
// not produce (the reverse direction: a fabricated dim would show up
// here).
func TestSideSplitSeedEquivalence(t *testing.T) {
	st := seededStore(t)

	rounds := profileSeedRows(t, st, "side_rounds", "side")
	winPct := profileSeedRows(t, st, "side_win_pct", "side")
	adr := profileSeedRows(t, st, "side_adr", "side")
	kast := profileSeedRows(t, st, "side_kast", "side")
	kd := profileSeedRows(t, st, "side_kd", "side")

	for _, steamID := range corpusHumans(t, st) {
		oracle, err := st.GetPlayerSideSplits(steamID)
		if err != nil {
			t.Fatalf("oracle GetPlayerSideSplits(%s): %v", steamID, err)
		}
		if len(oracle) == 0 {
			t.Fatalf("oracle returned no side rows for %s (the corpus fills samples for every round)", steamID)
		}
		wantDims := map[string]bool{}
		for _, o := range oracle {
			wantDims[o.Side] = true
			got, ok := rounds[steamID][o.Side]
			if !ok {
				t.Errorf("%s/%s: side_rounds has no dim row (oracle rounds=%d)", steamID, o.Side, o.Rounds)
				continue
			}
			if got != float64(o.Rounds) {
				t.Errorf("%s/%s: side_rounds = %v, oracle = %d", steamID, o.Side, got, o.Rounds)
			}
			// N is asserted through the fixture; here the VALUES are the
			// contract — the oracle's exact arithmetic per dim:
			if v := winPct[steamID][o.Side]; v != float64(o.Wins)/float64(o.Rounds) {
				t.Errorf("%s/%s: side_win_pct = %v, oracle = %d/%d", steamID, o.Side, v, o.Wins, o.Rounds)
			}
			if v := adr[steamID][o.Side]; v != o.ADR {
				t.Errorf("%s/%s: side_adr = %v, oracle = %v", steamID, o.Side, v, o.ADR)
			}
			// ×100 bridge: percent seeds store the fraction.
			if v := kast[steamID][o.Side] * 100; v != o.KASTPct {
				t.Errorf("%s/%s: side_kast×100 = %v, oracle = %v", steamID, o.Side, v, o.KASTPct)
			}
			floor := o.Deaths
			if floor < 1 {
				floor = 1
			}
			if v := kd[steamID][o.Side]; v != float64(o.Kills)/float64(floor) {
				t.Errorf("%s/%s: side_kd = %v, oracle = %d/%d", steamID, o.Side, v, o.Kills, floor)
			}
		}
		// The reverse direction: no fabricated or missing dims.
		for _, m := range []map[string]map[string]float64{rounds, winPct, adr, kast, kd} {
			for dim := range m[steamID] {
				if !wantDims[dim] {
					t.Errorf("%s: seed dim %q has no oracle row", steamID, dim)
				}
			}
			if len(m[steamID]) != len(wantDims) {
				t.Errorf("%s: seed dims = %d, oracle dims = %d", steamID, len(m[steamID]), len(wantDims))
			}
		}
	}
}

// TestMapSplitSeedEquivalence pins the M6 migration: the Maps card's
// history fold (matches/wins per map, kills/deaths for the K/D twin) and
// GetPlayerMapADR's pooled micro-average equal the map-partitioned
// seeds' values for every player and map.
func TestMapSplitSeedEquivalence(t *testing.T) {
	st := seededStore(t)
	storeCorpusFolds(t, st)

	matches := profileSeedRows(t, st, "map_matches", "map")
	wins := profileSeedRows(t, st, "map_wins", "map")
	winPct := profileSeedRows(t, st, "map_win_pct", "map")
	adr := profileSeedRows(t, st, "map_adr", "map")
	kd := profileSeedRows(t, st, "map_kd", "map")

	for _, steamID := range corpusHumans(t, st) {
		// The retired Maps fold: group the history rows by map.
		history, err := st.GetPlayerHistory(steamID)
		if err != nil {
			t.Fatalf("oracle GetPlayerHistory(%s): %v", steamID, err)
		}
		type foldRow struct{ matches, wins, kills, deaths int }
		fold := map[string]*foldRow{}
		for _, h := range history {
			f := fold[h.Map]
			if f == nil {
				f = &foldRow{}
				fold[h.Map] = f
			}
			f.matches++
			if h.Win {
				f.wins++
			}
			f.kills += h.Kills
			f.deaths += h.Deaths
		}
		mapADR, err := st.GetPlayerMapADR(steamID)
		if err != nil {
			t.Fatalf("oracle GetPlayerMapADR(%s): %v", steamID, err)
		}
		oracleADR := map[string]float64{}
		for _, row := range mapADR {
			if row.ADR != nil {
				oracleADR[row.Map] = *row.ADR
			}
		}

		if len(fold) == 0 {
			t.Fatalf("oracle fold produced no maps for %s", steamID)
		}
		for m, f := range fold {
			if got := matches[steamID][m]; got != float64(f.matches) {
				t.Errorf("%s/%s: map_matches = %v, fold = %d", steamID, m, got, f.matches)
			}
			if got := wins[steamID][m]; got != float64(f.wins) {
				t.Errorf("%s/%s: map_wins = %v, fold = %d", steamID, m, got, f.wins)
			}
			if got := winPct[steamID][m]; got != float64(f.wins)/float64(f.matches) {
				t.Errorf("%s/%s: map_win_pct = %v, fold = %d/%d", steamID, m, got, f.wins, f.matches)
			}
			wantADR, ok := oracleADR[m]
			if !ok {
				t.Errorf("%s/%s: GetPlayerMapADR has no row (fold matches=%d)", steamID, m, f.matches)
			} else if got := adr[steamID][m]; got != wantADR {
				t.Errorf("%s/%s: map_adr = %v, oracle = %v", steamID, m, got, wantADR)
			}
			// The seed's NULLIF divisor: no deaths → 0 beside N (never
			// a fabricated kill rate); the tied corpus never hits it.
			wantKD := 0.0
			if f.deaths != 0 {
				wantKD = float64(f.kills) / float64(f.deaths)
			}
			if got := kd[steamID][m]; got != wantKD {
				t.Errorf("%s/%s: map_kd = %v, fold = %d/%d", steamID, m, got, f.kills, f.deaths)
			}
		}
		// The reverse direction: no fabricated maps in any seed.
		for _, mm := range []map[string]map[string]float64{matches, wins, winPct, adr, kd} {
			for m := range mm[steamID] {
				if _, ok := fold[m]; !ok {
					t.Errorf("%s: seed map %q has no fold row", steamID, m)
				}
			}
			if len(mm[steamID]) != len(fold) {
				t.Errorf("%s: seed maps = %d, fold maps = %d", steamID, len(mm[steamID]), len(fold))
			}
		}
	}
}

// storeCorpusFolds stores the per-match fold values the profile reads take
// from metric rows (kills, deaths, damage, assists) for the corpus's three
// matches, through the production raw run.
func storeCorpusFolds(t *testing.T, st *store.Store) {
	t.Helper()
	for _, name := range []string{"kills", "deaths", "total_damage", "assists"} {
		storeMatchMetric(t, st, name, []int64{1, 2, 3})
	}
}
