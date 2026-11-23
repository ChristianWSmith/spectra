package library

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// tickParse is a parse that streams `frames` tick frames (one player each)
// through the wired tick sink, then either fails with err, returns a
// content-less extraction (rounds == 0 trips the content guard), or
// returns fakeParse's minimal valid extraction.
func tickParse(frames *atomic.Int32, fail *atomic.Bool, rounds int) func(context.Context, io.Reader, extract.ParseOptions) (*models.ExtractedMatch, error) {
	return func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if _, err := io.ReadAll(r); err != nil {
			return nil, err
		}
		if opts.Ticks == nil {
			return nil, errors.New("tick sink not wired")
		}
		for i := int32(0); i < frames.Load(); i++ {
			// HP alternates so every frame is a state change: the row count then
			// follows the frame count (the state-change rule would keep one row otherwise).
			sample := []models.TickSample{{SteamID: "100", Side: "ct", Alive: true, HP: 100 - int(i%2), HasPosition: true, X: float64(i)}}
			if err := opts.Ticks.AddTicks(i, 1, 64, sample); err != nil {
				return nil, err
			}
		}
		if fail.Load() {
			return nil, errors.New("boom")
		}
		em := &models.ExtractedMatch{
			Match:   models.Match{Map: "de_test", TickRate: 64},
			Players: []models.Player{{SteamID: "100", Name: "tester", Side: "ct"}},
		}
		for i := 0; i < rounds; i++ {
			em.Rounds = append(em.Rounds, models.Round{Number: i + 1, StartTick: 1, EndTick: 64})
		}
		return em, nil
	}
}

func tickCount(t *testing.T, st *store.Store, matchID int64) int {
	t.Helper()
	n, err := st.PlayerTickCount(matchID)
	if err != nil {
		t.Fatalf("PlayerTickCount: %v", err)
	}
	return n
}

// TestImportStreamsPlayerTicks pins the job body's tick lifecycle: a
// successful import keeps the streamed rows (they land before
// SaveExtracted, which must not erase them), a reprocess replaces them
// (no stranded rows from the earlier parse), and a failed reprocess
// deletes its half-written rows with the half-written sidecar.
func TestImportStreamsPlayerTicks(t *testing.T) {
	var frames atomic.Int32
	var fail atomic.Bool
	frames.Store(5)
	im, st := newTestImporter(t, tickParse(&frames, &fail, 1))

	job := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "ticks.dem", "ticks")})[0], models.JobDone)
	if n := tickCount(t, st, job.MatchID); n != 5 {
		t.Fatalf("after import: %d tick rows, want 5", n)
	}

	frames.Store(3)
	reID, err := im.Reprocess(job.MatchID)
	if err != nil {
		t.Fatalf("Reprocess: %v", err)
	}
	waitStatus(t, st, reID, models.JobDone)
	if n := tickCount(t, st, job.MatchID); n != 3 {
		t.Errorf("after reprocess: %d tick rows, want 3 (the earlier parse's rows replaced)", n)
	}

	fail.Store(true)
	boomID, err := im.Reprocess(job.MatchID)
	if err != nil {
		t.Fatalf("Reprocess (failing): %v", err)
	}
	waitStatus(t, st, boomID, models.JobFailed)
	waitMatchStatus(t, st, job.MatchID, models.StatusFailed)
	if n := tickCount(t, st, job.MatchID); n != 0 {
		t.Errorf("after failed reprocess: %d tick rows, want 0 (partial rows cleaned up)", n)
	}
}

// TestImportFailureDeletesPlayerTicks: every failure path that removes
// the half-written sidecar also deletes the half-written tick rows — a
// parse error, and the content guard (a parse that streamed rows but
// produced no counted round).
func TestImportFailureDeletesPlayerTicks(t *testing.T) {
	cases := []struct {
		name   string
		fail   bool
		rounds int
	}{
		{name: "parse error", fail: true, rounds: 1},
		{name: "content guard", fail: false, rounds: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var frames atomic.Int32
			var fail atomic.Bool
			frames.Store(4)
			fail.Store(tc.fail)
			im, st := newTestImporter(t, tickParse(&frames, &fail, tc.rounds))
			job := waitStatus(t, st, im.Enqueue([]string{writeDemo(t, "fail.dem", "fail")})[0], models.JobFailed)
			matchID := waitJobMatch(t, st, job.ID)
			if n := tickCount(t, st, matchID); n != 0 {
				t.Errorf("after failed import: %d tick rows, want 0", n)
			}
		})
	}
}
