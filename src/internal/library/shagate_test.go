package library

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestSHAGateSerializesPerHash pins the gate's duties: same-sha
// acquisitions strictly serialize (the second user registers as a waiter
// BEFORE it blocks on the entry — refs bumped under the map lock — and
// acquires only after the first releases), different hashes never
// contend on one entry, and every entry is dropped once its last
// holder/waiter leaves (the map tracks in-flight shas only).
func TestSHAGateSerializesPerHash(t *testing.T) {
	g := newSHAGate()

	refs := func(sha string) int {
		g.mu.Lock()
		defer g.mu.Unlock()
		if e, ok := g.entries[sha]; ok {
			return e.refs
		}
		return 0
	}
	// Poll like waitStatus does: the waiter's ref bump happens before it
	// blocks, so refs==2 is the observable proof that B is queued.
	waitRefs := func(sha string, want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if refs(sha) == want {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatalf("sha %q refs = %d, want %d", sha, refs(sha), want)
	}

	releaseA := g.lock("same")
	acquired := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		releaseB := g.lock("same")
		close(acquired)
		releaseB()
		close(finished)
	}()
	waitRefs("same", 2) // B holds a reference and is queued on A's entry

	// A different hash gets its own entry — it acquires immediately and
	// drops straight back out (never contends with the held "same").
	releaseOther := g.lock("other")
	releaseOther()
	if n := refs("other"); n != 0 {
		t.Errorf("other-sha refs = %d after release, want 0 (entry dropped)", n)
	}

	select {
	case <-acquired:
		t.Fatal("second same-sha lock acquired while the first was still held")
	default:
	}

	releaseA()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("waiter never acquired after the holder released")
	}
	waitRefs("same", 0) // last one out deletes the entry
	g.mu.Lock()
	_, exists := g.entries["same"]
	g.mu.Unlock()
	if exists {
		t.Error("sha entry leaked after its last holder/waiter left")
	}
}

// TestSameSHAConcurrentImportsCleanLoser is the pipeline-level pin of
// race-table item 1 (two jobs, one content hash): at N=2 the winner
// parks inside its sha-critical section (the first StageCopy emit, before
// its match row exists) while the loser has already hashed and is queued
// on the per-sha gate — proven through events, never a sleep. The loser
// then takes the CLEAN "already imported (match N)" path: exactly one
// match row, no raw "UNIQUE constraint failed" error, no second copy.
// BEHAVIOR pin (the concurrent-claims guarantee).
func TestSameSHAConcurrentImportsCleanLoser(t *testing.T) {
	if workerCount < 2 {
		t.Skipf("worker pool size %d — this machine cannot run 2 workers", workerCount)
	}
	const content = "identical bytes in two files"
	parked := make(chan struct{})    // winner is inside its sha section, row not yet created
	resume := make(chan struct{})    // test releases the winner
	hashes := make(chan struct{}, 4) // one token per StageHash entry
	var parkOnce sync.Once
	var winnerJob int64 // written before close(parked); read after the receive

	im, st := newTestImporterWith(t, Options{
		Parse:       fakeParse,
		Concurrency: func() int { return 2 },
		Emit: func(name string, data any) {
			if name != EventJobProgress {
				return
			}
			ev, ok := data.(JobProgressEvent)
			if !ok {
				return
			}
			switch ev.Stage {
			case models.StageHash:
				select {
				case hashes <- struct{}{}:
				default:
				}
			case models.StageCopy:
				// The FIRST job into its sha section parks here — mid
				// section: dedupe already checked (not found), match row
				// not yet created, gate held.
				parkOnce.Do(func() {
					winnerJob = ev.JobID
					close(parked)
					<-resume
				})
			}
		},
	})

	pathA := writeDemo(t, "dup-a.dem", content)
	pathB := writeDemo(t, "dup-b.dem", content) // same bytes, different path
	ids := im.Enqueue([]string{pathA, pathB})
	if len(ids) != 2 {
		t.Fatalf("Enqueue returned %d ids, want 2", len(ids))
	}

	// Winner parked inside its section (watchdog: a pipeline that never
	// reaches its sha section fails instead of hanging)…
	select {
	case <-parked:
	case <-time.After(5 * time.Second):
		t.Fatal("no import reached its sha-critical section (StageCopy)")
	}
	loserJob := ids[0]
	if winnerJob == ids[0] {
		loserJob = ids[1]
	}
	// …and the loser is genuinely IN the pipeline: claimed (running) and
	// past its hash stage, so its next instruction is the sha gate it
	// cannot pass while the winner holds it.
	waitStatus(t, st, loserJob, models.JobRunning)
	for i := 0; i < 2; i++ { // winner hashed before it parked; this is the loser's
		select {
		case <-hashes:
		case <-time.After(5 * time.Second):
			t.Fatalf("hash stage %d never announced — the loser never entered the pipeline", i+1)
		}
	}

	// Release the winner: it creates the match row, then drops the gate —
	// the loser's dedupe check can only run after that (the gate was held
	// from before the winner's StageCopy until after its row create).
	close(resume)

	winner := waitStatus(t, st, winnerJob, models.JobDone)
	l := jobByID(t, st, loserJob)
	if l.Status != models.JobFailed || !strings.Contains(l.Error, "already imported (match") {
		t.Errorf("loser job = (%q, %q), want failed with the clean already-imported path", l.Status, l.Error)
	}
	if strings.Contains(l.Error, "UNIQUE constraint") {
		t.Errorf("loser error = %q, want the clean path, never a raw constraint error", l.Error)
	}
	rows, err := st.ListMatches("", "extracted_at", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("match rows = %d, want 1", len(rows))
	}
	wantMsg := fmt.Sprintf("already imported (match %d)", rows[0].ID)
	if l.Error != wantMsg {
		t.Errorf("loser error = %q, want %q", l.Error, wantMsg)
	}
	if winner.MatchID != rows[0].ID {
		t.Errorf("winner match = %d, want the only row %d", winner.MatchID, rows[0].ID)
	}
	// The loser never copied (dedupe precedes the copy in the section):
	// exactly the winner's managed copy is on disk.
	if names := dirNames(t, im.copyDir); len(names) != 1 {
		t.Errorf("managed copy files = %v, want exactly the winner's (the loser never copied)", names)
	}
}
