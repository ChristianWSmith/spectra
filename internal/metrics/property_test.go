package metrics

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// runValues executes expr and returns group → value (and the sample size
// map) for identity checks.
func runValues(t *testing.T, st *store.Store, expr, groupBy string) map[string]float64 {
	t.Helper()
	pv, perr, err := RunPreview(st, Def{Expr: expr, GroupBy: groupBy}, "", 1000)
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

// TestAggregationIdentities are the plan §5 property tests over the
// synthetic seed: aggregation laws must hold per group and ungrouped.
func TestAggregationIdentities(t *testing.T) {
	st := seededStore(t)

	t.Run("count split identity", func(t *testing.T) {
		// count(A) + count(NOT A) == count() for every player group and
		// over the whole library (headshot is 0/1, never NULL).
		for _, group := range []string{"", "player"} {
			yes := runValues(t, st, "from events: count(where headshot)", group)
			no := runValues(t, st, "from events: count(where not headshot)", group)
			all := runValues(t, st, "from events: count()", group)
			if len(all) == 0 {
				t.Fatalf("group %q: no rows", group)
			}
			for g, total := range all {
				if yes[g]+no[g] != total {
					t.Errorf("group %q key %q: %v + %v != %v", group, g, yes[g], no[g], total)
				}
			}
		}
	})

	t.Run("avg within [min, max]", func(t *testing.T) {
		for _, group := range []string{"", "player", "round"} {
			avg := runValues(t, st, "from events: avg(distance)", group)
			min := runValues(t, st, "from events: min(distance)", group)
			max := runValues(t, st, "from events: max(distance)", group)
			for g, a := range avg {
				if a < min[g]-1e-9 || a > max[g]+1e-9 {
					t.Errorf("group %q key %q: avg %v outside [%v, %v]", group, g, a, min[g], max[g])
				}
			}
		}
	})

	t.Run("ratio within [0, 1]", func(t *testing.T) {
		for _, group := range []string{"", "player"} {
			r := runValues(t, st,
				"from events: ratio(count(where kind='kill' and headshot), count(where kind='kill'))", group)
			for g, v := range r {
				if v < 0 || v > 1 {
					t.Errorf("group %q key %q: ratio %v outside [0,1]", group, g, v)
				}
			}
		}
	})

	t.Run("sum equals avg times n", func(t *testing.T) {
		// Ungrouped: sum(where damage) == avg(where damage) * count(where damage).
		avg := runValues(t, st, "from events: avg(where kind='damage', dmg)", "")[""]
		sum := runValues(t, st, "from events: sum(where kind='damage', dmg)", "")[""]
		cnt := runValues(t, st, "from events: count(where kind='damage')", "")[""]
		if diff := sum - avg*cnt; diff > 1e-6 || diff < -1e-6 {
			t.Errorf("sum %v != avg %v * n %v", sum, avg, cnt)
		}
	})

	t.Run("stddev non-negative and zero on constants", func(t *testing.T) {
		sd := runValues(t, st, "from events: stddev(where kind='damage', dmg)", "player")
		for g, v := range sd {
			if v < 0 {
				t.Errorf("player %q stddev %v < 0", g, v)
			}
		}
		// damage rows all carry distance = 25 → σ = 0 (float clamp).
		constSD := runValues(t, st, "from events: stddev(where kind='damage', distance)", "")[""]
		if constSD > 1e-9 {
			t.Errorf("constant-column stddev = %v, want ~0", constSD)
		}
	})

	t.Run("percentiles monotone within range", func(t *testing.T) {
		p25 := runValues(t, st, "from events: percentile(0.25, dmg)", "")[""]
		p50 := runValues(t, st, "from events: percentile(0.5, dmg)", "")[""]
		p75 := runValues(t, st, "from events: percentile(0.75, dmg)", "")[""]
		min := runValues(t, st, "from events: min(dmg)", "")[""]
		max := runValues(t, st, "from events: max(dmg)", "")[""]
		if !(min <= p25 && p25 <= p50 && p50 <= p75 && p75 <= max) {
			t.Errorf("percentile order violated: min %v p25 %v p50 %v p75 %v max %v", min, p25, p50, p75, max)
		}
	})

	t.Run("untraded death counts uniform across players", func(t *testing.T) {
		// Seed law: every player suffers 3 untraded deaths per match → 9
		// over the library, so grouped counts are all equal (and positive).
		counts := runValues(t, st,
			"from player_round_stats: count(where deaths=1 and traded=0)", "player")
		if len(counts) != 8 {
			t.Fatalf("player groups = %d, want 8", len(counts))
		}
		for g, v := range counts {
			if v != 9 {
				t.Errorf("player %q untraded deaths = %v, want 9", g, v)
			}
		}
	})
}
