package integration_test

// Golden acceptance for the per-tick player table (player_ticks): a real
// parse streams the golden demo through store.TickWriter and the stored
// rows are checked against the extraction they ride beside — the
// counted-round population, NULL-not-0 for unpositioned frames, the
// event-tick join the table exists for (every kill's attacker has a row
// at the kill's tick), and the same-frame in-air re-proof against the
// kill payload's attackerinair flag. It also logs the wall-clock of the
// tick stream and of SaveExtracted on a golden-sized match.

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// timedTickSink wraps the store writer to measure the time spent inside
// the sink (buffering + chunk flushes) separately from the parse.
type timedTickSink struct {
	w       *store.TickWriter
	elapsed time.Duration
	longest time.Duration // the slowest single call — a chunk flush's writer hold
	frames  int
}

func (s *timedTickSink) AddTicks(tick int32, round int, rate float64, p []models.TickSample) error {
	start := time.Now()
	err := s.w.AddTicks(tick, round, rate, p)
	d := time.Since(start)
	s.elapsed += d
	s.longest = max(s.longest, d)
	s.frames++
	return err
}

func TestGoldenPlayerTicks(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}

	dbPath := filepath.Join(t.TempDir(), "ticks.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-demo", "sha-golden-ticks", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	w, err := st.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	sink := &timedTickSink{w: w}

	parseStart := time.Now()
	m, err := extract.Parse(context.Background(), openGoldenDemo(t), extract.ParseOptions{Ticks: sink})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	parseWall := time.Since(parseStart)
	closeStart := time.Now()
	if err := w.Close(); err != nil {
		t.Fatalf("TickWriter.Close: %v", err)
	}
	sinkWall := sink.elapsed + time.Since(closeStart)

	saveStart := time.Now()
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	saveWall := time.Since(saveStart)

	total, err := st.PlayerTickCount(id)
	if err != nil {
		t.Fatalf("PlayerTickCount: %v", err)
	}
	t.Logf("tick stream: %d rows over %d frames; sink wall %.2fs inside a %.2fs parse (longest chunk flush %.3fs); SaveExtracted wall %.3fs (%d events)",
		total, sink.frames, sinkWall.Seconds(), parseWall.Seconds(), sink.longest.Seconds(), saveWall.Seconds(), len(m.Events))
	if total == 0 {
		t.Fatal("no player_ticks rows written for the golden demo")
	}

	db, err := sql.Open("sqlite", dbPath+"?mode=ro")
	if err != nil {
		t.Fatalf("open read handle: %v", err)
	}
	defer func() { _ = db.Close() }()
	one := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := db.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}

	// The rows survived SaveExtracted (streamed before it, not a
	// childTables member).
	if n := one(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ?`, id); n != total {
		t.Errorf("rows after SaveExtracted = %d, want %d", n, total)
	}

	// Counted-round population: every row's round is a stored round and
	// its tick is not before that round's start.
	if n := one(`SELECT COUNT(*) FROM player_ticks pt LEFT JOIN rounds r
		ON r.match_id = pt.match_id AND r.number = pt.round
		WHERE pt.match_id = ? AND (r.number IS NULL OR pt.tick < r.start_tick)`, id); n != 0 {
		t.Errorf("%d rows outside a stored round (or before its start tick)", n)
	}

	// NULL-not-0: a dead frame carries no position sample, so in_air,
	// speed and weapon are NULL and hp is the sampled 0.
	if n := one(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ? AND alive = 0
		AND (in_air IS NOT NULL OR speed IS NOT NULL OR weapon IS NOT NULL OR hp <> 0)`, id); n != 0 {
		t.Errorf("%d dead rows carry an in_air/speed/weapon value or nonzero hp", n)
	}
	if n := one(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ? AND alive = 0`, id); n == 0 {
		t.Error("no dead rows at all — the dead-frame contract is untested on the golden demo")
	}
	// Speed stays physically plausible (CS2.md movement entry: run speeds
	// top out near 250 u/s; bhop/knockback can exceed it briefly, a
	// teleport would show as thousands). Logged, plus a coarse bound.
	var maxSpeed sql.NullFloat64
	if err := db.QueryRow(`SELECT MAX(speed) FROM player_ticks WHERE match_id = ?`, id).Scan(&maxSpeed); err != nil {
		t.Fatalf("max speed: %v", err)
	}
	t.Logf("max horizontal speed = %.1f u/s", maxSpeed.Float64)

	// Event-tick join + same-frame in-air re-proof: every kill with a
	// player attacker has that attacker's row at the kill's tick, and the
	// row's in_air equals the payload's attackerinair.
	missing, compared, mismatched := 0, 0, 0
	for _, e := range m.Events {
		if e.Kind != models.EventKill || e.Attacker == "" || e.Attacker == e.Victim {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(e.RawJSON), &raw); err != nil {
			continue
		}
		want, ok := raw["attackerinair"].(bool)
		if !ok {
			continue
		}
		var inAir sql.NullInt64
		err := db.QueryRow(`SELECT in_air FROM player_ticks WHERE match_id = ? AND tick = ? AND steam_id = ?`,
			id, e.Tick, e.Attacker).Scan(&inAir)
		if err == sql.ErrNoRows {
			missing++
			t.Errorf("kill tick=%d attacker=%s: no player_ticks row at the kill's tick", e.Tick, e.Attacker)
			continue
		}
		if err != nil {
			t.Fatalf("join probe: %v", err)
		}
		compared++
		if !inAir.Valid || (inAir.Int64 != 0) != want {
			mismatched++
			t.Errorf("kill tick=%d attacker=%s: in_air = %+v, payload attackerinair = %v", e.Tick, e.Attacker, inAir, want)
		}
	}
	t.Logf("kill join: compared=%d missing=%d in_air mismatches=%d", compared, missing, mismatched)
	if compared == 0 {
		t.Error("no kill joined a tick row — the join contract is untested")
	}
}
