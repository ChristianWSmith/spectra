package analytics

// Write-path contract for the stored trade-opportunity counts
// (match_trade_opps): Compute writes them on a FRESH pass, the
// ComputeForBatch twin writes them too (shared body — only the career
// rebuild differs), a zero-round match writes NO rows, and a re-run
// under a different radius rewrites the rows (delete-then-insert leaves
// no stale count behind).

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// seedTradeOppMatch stores tradeOppFixture under a unique path/sha and
// returns the store + match id.
func seedTradeOppMatch(t *testing.T) (*store.Store, int64) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "compute-tradeopps.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateMatchRow("/d/tradeopps-compute.dem", "sha-tradeopps-compute", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, tradeOppFixture()); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return st, id
}

// tradeOppCfg is the fixture's rules input at the given radius.
func tradeOppCfg(distance int) Config {
	return Config{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: distance, RuleVersion: 1,
	}
}

// TestComputeWritesTradeOpps: a fresh Compute stores both metrics, the
// batch twin stores the same rows, and a zero-round match stores none.
func TestComputeWritesTradeOpps(t *testing.T) {
	st, id := seedTradeOppMatch(t)

	// Fresh compute: the counts exist and match the hand-computed pins
	// (alice's opps walk = 8 @1000u; carl's missed = the two duplicate
	// t=100 untraded rows (paired join keeps the FIRST row's 150u) plus
	// his round-3 death = 3).
	if err := Compute(st, id, tradeOppCfg(1000)); err != nil {
		t.Fatalf("Compute: %v", err)
	}
	if n := storedOpps(t, st, "100"); n != 8 {
		t.Errorf("alice opps after fresh Compute = %d, want 8", n)
	}
	if missed := combatMissed(t, st, id); missed["300"] != 3 {
		t.Errorf("carl missed = %d, want 3 (duplicate t=100 rows pair to the first kill + round 3)", missed["300"])
	}

	// The batch twin shares the body: re-running through ComputeForBatch
	// rewrites the same rows (idempotent — replace, never append).
	if err := ComputeForBatch(st, id, tradeOppCfg(1000)); err != nil {
		t.Fatalf("ComputeForBatch: %v", err)
	}
	if n := storedOpps(t, st, "100"); n != 8 {
		t.Errorf("alice opps after batch Compute = %d, want 8 (same write path)", n)
	}
	if missed := combatMissed(t, st, id); missed["300"] != 3 {
		t.Errorf("carl missed after batch Compute = %d, want 3", missed["300"])
	}

	// A zero-round match (bare lifecycle row, no extract) writes NOTHING:
	// reads must treat the absence as 0 (the same rule as a missing
	// player_stats row).
	bare, err := st.CreateMatchRow("/d/bare-tradeopps.dem", "sha-bare-tradeopps", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow(bare): %v", err)
	}
	if err := Compute(st, bare, tradeOppCfg(1000)); err != nil {
		t.Fatalf("Compute(zero rounds): %v", err)
	}
	if n := storedOpps(t, st, "100"); n != 8 {
		t.Errorf("alice opps after zero-round compute = %d, want 8 (the bare match added no rows)", n)
	}
	rows, err := st.GetCombatStats(bare)
	if err != nil {
		t.Fatalf("GetCombatStats(bare): %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("bare match combat rows = %d, want 0", len(rows))
	}
}

// TestComputeTradeOppsFollowRadius: a re-run under another radius
// rewrites the stored rows to the new gate — growing back after a
// narrow run proves delete-then-insert leaves no stale count (the
// read-side of this loop: analyticservice's
// TestTradeOppDistanceChangeRecomputesStoredCounts, which drives it
// through SetConfig's bump → behind → re-run).
func TestComputeTradeOppsFollowRadius(t *testing.T) {
	st, id := seedTradeOppMatch(t)

	for _, tc := range []struct {
		distance, wantAlice int
	}{
		{1000, 8}, {200, 6}, {0, 1}, {1000, 8},
	} {
		if err := Compute(st, id, tradeOppCfg(tc.distance)); err != nil {
			t.Fatalf("Compute(@%d): %v", tc.distance, err)
		}
		if n := storedOpps(t, st, "100"); n != tc.wantAlice {
			t.Errorf("alice opps @%du = %d, want %d (stored rows must follow the radius)",
				tc.distance, n, tc.wantAlice)
		}
	}
}

// combatMissed reads the stored missed counts through GetCombatStats
// (the only public surface for them), keyed by steam id.
func combatMissed(t *testing.T, st *store.Store, matchID int64) map[string]int {
	t.Helper()
	rows, err := st.GetCombatStats(matchID)
	if err != nil {
		t.Fatalf("GetCombatStats: %v", err)
	}
	out := map[string]int{}
	for _, r := range rows {
		out[r.SteamID] = r.TradeOppMissed
	}
	return out
}

// storedOpps reads one player's stored trade-opportunity count — the
// library-wide SUM(opps) over match_trade_opps that
// store.CountPlayerTradeOpportunities used to serve, spelled inline
// here now that dogfooding W4 removed that reader (its last consumer,
// the profile Trade rate card, converted in W3; no production reader of
// the aggregate remains). The WRITE path is what these tests pin — the
// read is one index seek through QueryWrite (the write handle, which —
// unlike RunReadOnly — also serves a :memory: fixture; the same
// ValidateReadOnlySQL gate applies).
func storedOpps(t *testing.T, st *store.Store, sid string) int {
	t.Helper()
	res, err := st.QueryWrite(context.Background(),
		`SELECT COALESCE(SUM(opps), 0) FROM match_trade_opps WHERE steam_id = ?`,
		[]any{sid}, 1)
	if err != nil {
		t.Fatalf("stored opps(%s): %v", sid, err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("stored opps(%s): %d rows, want 1", sid, len(res.Rows))
	}
	switch v := res.Rows[0][0].(type) {
	case int64:
		return int(v)
	case float64:
		return int(v)
	case int:
		return v
	default:
		t.Fatalf("stored opps(%s): unexpected value %T (%v)", sid, v, v)
		return 0
	}
}
