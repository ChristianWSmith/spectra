package analytics

// The rule-stamp contract of Compute/ComputeForBatch (the RULE STAMP
// note on Compute): a successful pass stamps cfg.RuleVersion onto the
// match — including the zero-round no-op — and a pass that fails
// mid-way never stamps, whatever its earlier replaces already committed.

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// stampCfg is a valid rules input with a distinctive version.
func stampCfg(version int) Config {
	return Config{TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, RuleVersion: version}
}

// seedStampedMatch stores tradeFixture under a unique path/sha and
// returns the store + match id.
func seedStampedMatch(t *testing.T) (*store.Store, int64) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	em := tradeFixture()
	em.Match.Path = "/d/compute-stamp.dem"
	em.Match.SHA256 = "sha-compute-stamp"
	id, err := st.CreateMatchRow(em.Match.Path, em.Match.SHA256, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return st, id
}

// TestComputeStampsRuleVersion: a fresh successful compute stamps the
// config's rule_version — the value the behind read compares against.
func TestComputeStampsRuleVersion(t *testing.T) {
	st, id := seedStampedMatch(t)

	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 0 {
		t.Fatalf("stamp before compute = %d, %v; want 0 (never analyzed)", v, err)
	}
	if err := Compute(st, id, stampCfg(7)); err != nil {
		t.Fatalf("Compute: %v", err)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 7 {
		t.Fatalf("stamp after compute = %d, %v; want 7", v, err)
	}
	// The batch twin stamps identically (it differs only in the career
	// rebuild — see TestRecomputeAllResolvesBehindSet for the batch's
	// single-rebuild wiring).
	if err := ComputeForBatch(st, id, stampCfg(9)); err != nil {
		t.Fatalf("ComputeForBatch: %v", err)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 9 {
		t.Fatalf("stamp after batch compute = %d, %v; want 9", v, err)
	}
}

// TestComputeZeroRoundNoOpStamps: a match with no extracted rounds is a
// no-op (not an error) but Compute DID run under this version — it must
// stamp, otherwise such matches are "behind" forever and every
// re-run-all churns them again.
func TestComputeZeroRoundNoOpStamps(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// Bare lifecycle row: no extract, no rounds, status queued.
	id, err := st.CreateMatchRow("/d/bare.dem", "sha-compute-bare", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := Compute(st, id, stampCfg(4)); err != nil {
		t.Fatalf("Compute(zero rounds): %v", err)
	}
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 4 {
		t.Fatalf("stamp after zero-round compute = %d, %v; want 4", v, err)
	}
}

// TestComputeFailureDoesNotStamp: a pass that dies AFTER some replaces
// already committed must leave the stamp at its previous value (a failed
// compute stays behind → retryable). The reachable mid-pass failure is
// forced by dropping utility_events through a second connection — the
// store holds a single connection, and tests elsewhere (query, metrics,
// library) already open a raw second handle to the same file.
func TestComputeFailureDoesNotStamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stamp.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	em := tradeFixture()
	em.Match.Path = "/d/compute-fail.dem"
	em.Match.SHA256 = "sha-compute-fail"
	id, err := st.CreateMatchRow(em.Match.Path, em.Match.SHA256, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// An earlier successful pass stamped v2; this pass runs under v5.
	if err := st.SetMatchRuleVersion(id, 2); err != nil {
		t.Fatalf("SetMatchRuleVersion: %v", err)
	}

	db2, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("second connection: %v", err)
	}
	if _, err := db2.Exec(`DROP TABLE utility_events`); err != nil {
		t.Fatalf("drop utility_events: %v", err)
	}
	if err := db2.Close(); err != nil {
		t.Fatalf("close second connection: %v", err)
	}

	if err := Compute(st, id, stampCfg(5)); err == nil {
		t.Fatal("Compute succeeded with utility_events dropped, want an error")
	}
	// The pass got PAST several replaces before dying (they commit per
	// table) — proof the failure was mid-pass, not at the first write.
	classes, err := st.GetRoundClasses(id)
	if err != nil {
		t.Fatalf("GetRoundClasses: %v", err)
	}
	if len(classes) == 0 {
		t.Fatal("no classifications written — the failure was not mid-pass")
	}
	// …and the stamp still says the last SUCCESSFUL pass's version.
	if v, err := st.GetMatchRuleVersion(id); err != nil || v != 2 {
		t.Fatalf("stamp after failed compute = %d, %v; want 2 (unchanged)", v, err)
	}
}
