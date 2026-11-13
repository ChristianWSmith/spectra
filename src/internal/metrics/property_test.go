package metrics

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// runValues executes expr and returns subject → value for identity
// checks. There is no groupBy argument: every statement is subject-
// grouped by the engine, so the map is keyed by subject (SteamID64).
func runValues(t *testing.T, st *store.Store, expr string) map[string]float64 {
	t.Helper()
	pv, perr, err := RunPreview(st, Def{Expr: expr}, "", 1000)
	if perr != nil {
		t.Fatalf("compile %q: %v", expr, perr)
	}
	if err != nil {
		t.Fatalf("run %q: %v (sql %s)", expr, err, pv.SQL)
	}
	out := make(map[string]float64, len(pv.Rows))
	for _, r := range pv.Rows {
		out[r.Group] = r.Value
	}
	return out
}

// TestAggregationIdentities are property tests over the
// synthetic seed: aggregation laws must hold per subject (every
// statement is subject-addressed — the former ""/player/round group
// loop collapsed into one subject-keyed run per expression).
func TestAggregationIdentities(t *testing.T) {
	st := seededStore(t)

	t.Run("count split identity", func(t *testing.T) {
		// count(A) + count(NOT A) == count() for every subject (headshot
		// is 0/1, never NULL).
		yes := runValues(t, st, "from events: count(where headshot)")
		no := runValues(t, st, "from events: count(where not headshot)")
		all := runValues(t, st, "from events: count()")
		if len(all) == 0 {
			t.Fatal("no rows")
		}
		for g, total := range all {
			if yes[g]+no[g] != total {
				t.Errorf("subject %q: %v + %v != %v", g, yes[g], no[g], total)
			}
		}
	})

	t.Run("avg within [min, max]", func(t *testing.T) {
		avg := runValues(t, st, "from events: avg(distance)")
		min := runValues(t, st, "from events: min(distance)")
		max := runValues(t, st, "from events: max(distance)")
		for g, a := range avg {
			if a < min[g]-1e-9 || a > max[g]+1e-9 {
				t.Errorf("subject %q: avg %v outside [%v, %v]", g, a, min[g], max[g])
			}
		}
	})

	t.Run("ratio within [0, 1]", func(t *testing.T) {
		r := runValues(t, st,
			"from events: ratio(count(where kind='kill' and headshot), count(where kind='kill'))")
		for g, v := range r {
			if v < 0 || v > 1 {
				t.Errorf("subject %q: ratio %v outside [0,1]", g, v)
			}
		}
	})

	t.Run("sum equals avg times n", func(t *testing.T) {
		// Per subject: sum(where damage) == avg(where damage) *
		// count(where damage).
		avg := runValues(t, st, "from events: avg(where kind='damage', dmg)")
		sum := runValues(t, st, "from events: sum(where kind='damage', dmg)")
		cnt := runValues(t, st, "from events: count(where kind='damage')")
		for g := range cnt {
			if diff := sum[g] - avg[g]*cnt[g]; diff > 1e-6 || diff < -1e-6 {
				t.Errorf("subject %q: sum %v != avg %v * n %v", g, sum[g], avg[g], cnt[g])
			}
		}
	})

	t.Run("stddev non-negative and zero on constants", func(t *testing.T) {
		sd := runValues(t, st, "from events: stddev(where kind='damage', dmg)")
		for g, v := range sd {
			if v < 0 {
				t.Errorf("subject %q stddev %v < 0", g, v)
			}
		}
		// damage rows all carry distance = 25 → σ = 0 (float clamp).
		constSD := runValues(t, st, "from events: stddev(where kind='damage', distance)")
		for g, v := range constSD {
			if v > 1e-9 {
				t.Errorf("subject %q constant-column stddev = %v, want ~0", g, v)
			}
		}
	})

	t.Run("percentiles monotone within range", func(t *testing.T) {
		p25 := runValues(t, st, "from events: percentile(0.25, dmg)")
		p50 := runValues(t, st, "from events: percentile(0.5, dmg)")
		p75 := runValues(t, st, "from events: percentile(0.75, dmg)")
		min := runValues(t, st, "from events: min(dmg)")
		max := runValues(t, st, "from events: max(dmg)")
		if len(p50) == 0 {
			t.Fatal("no percentile rows")
		}
		for g := range p50 {
			if !(min[g] <= p25[g] && p25[g] <= p50[g] && p50[g] <= p75[g] && p75[g] <= max[g]) {
				t.Errorf("subject %q percentile order violated: min %v p25 %v p50 %v p75 %v max %v",
					g, min[g], p25[g], p50[g], p75[g], max[g])
			}
		}
	})

	t.Run("untraded death counts uniform across players", func(t *testing.T) {
		// Seed law: every player suffers 3 untraded deaths per match → 9
		// over the library, so the subject groups are all equal (and
		// positive).
		counts := runValues(t, st,
			"from player_round_stats: count(where deaths=1 and traded=0)")
		if len(counts) != 8 {
			t.Fatalf("subjects = %d, want 8", len(counts))
		}
		for g, v := range counts {
			if v != 9 {
				t.Errorf("subject %q untraded deaths = %v, want 9", g, v)
			}
		}
	})
}
