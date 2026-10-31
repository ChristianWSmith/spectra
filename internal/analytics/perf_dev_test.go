package analytics

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestPerfDevDB measures the M3 performance table against the developer's
// real data. Skipped unless SPECTRA_DEV_DB points at a populated SQLite
// file (never set in CI).
func TestPerfDevDB(t *testing.T) {
	dbPath := os.Getenv("SPECTRA_DEV_DB")
	if dbPath == "" {
		t.Skip("set SPECTRA_DEV_DB to run M3 perf measurements")
	}
	matchID, err := strconv.ParseInt(os.Getenv("SPECTRA_DEV_MATCH"), 10, 64)
	if err != nil {
		matchID = 1
	}
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open dev db: %v", err)
	}
	defer func() { _ = st.Close() }()

	// FilterBar server side: advanced event query.
	t0 := time.Now()
	rows, err := st.GetEvents(models.EventFilter{MatchID: matchID, Round: -1, Kind: "kill", Limit: 50000})
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	t.Logf("GetEvents(kill, all rounds): %d rows in %s", len(rows), time.Since(t0).Round(time.Millisecond))

	// Career rebuild (plan: <5 s for 100 matches; dev DB has fewer — record).
	t0 = time.Now()
	if err := st.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}
	t.Logf("RebuildCareer: %s", time.Since(t0).Round(time.Millisecond))

	_ = filepath.Dir(dbPath)
}
