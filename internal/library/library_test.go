package library

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

func newTestImporter(t *testing.T, parse func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error)) (*Importer, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	im := New(Options{
		Store:         st,
		Parse:         parse,
		ParserVersion: "test",
		// Never the user's real data dir: test matches share the same
		// numeric ids as real ones (Options doc).
		SidecarDir: t.TempDir(),
	})
	t.Cleanup(im.Shutdown)
	return im, st
}

// fakeParse reads the stream (proving it is a valid reader), feeds the
// progress + position sinks the pipeline wired up, and returns a minimal
// ExtractedMatch.
func fakeParse(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
	if _, err := io.ReadAll(r); err != nil {
		return nil, err
	}
	if opts.Progress != nil {
		opts.Progress(1, 1)
	}
	if opts.Positions != nil {
		for i := 0; i < 3; i++ {
			players := []extract.PositionPlayer{{SteamID: 100, X: float32(i), Y: 1, Z: 2}}
			if i%2 == 0 {
				players = append(players, extract.PositionPlayer{SteamID: 200, X: 3, Y: 4, Z: 5})
			}
			if err := opts.Positions.AddFrame(int32(i*64), players); err != nil {
				return nil, err
			}
		}
	}
	return &models.ExtractedMatch{Match: models.Match{Map: "de_test", TickRate: 64}}, nil
}

func writeDemo(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write demo: %v", err)
	}
	return path
}

func waitStatus(t *testing.T, st *store.Store, jobID int64, want string) models.Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		jobs, err := st.ListJobs()
		if err != nil {
			t.Fatalf("list jobs: %v", err)
		}
		for _, j := range jobs {
			if j.ID == jobID && j.Status == want {
				return j
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %d never reached status %q", jobID, want)
	return models.Job{}
}

func TestImportSuccess(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)
	path := writeDemo(t, "ok.dem", "not-really-a-demo")

	ids := im.Enqueue([]string{path})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobDone)
	if job.MatchID == 0 {
		t.Fatal("job has no match link")
	}
	m, err := st.GetMatch(job.MatchID)
	if err != nil {
		t.Fatalf("get match: %v", err)
	}
	if m.Status != models.StatusReady {
		t.Fatalf("match status = %q, want ready", m.Status)
	}
	if m.ParserVersion != "test" {
		t.Fatalf("parser version = %q, want test", m.ParserVersion)
	}
}

func TestImportDuplicateRejected(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)
	path := writeDemo(t, "dup.dem", "same bytes")

	first := im.Enqueue([]string{path})[0]
	waitStatus(t, st, first, models.JobDone)

	second := im.Enqueue([]string{path})[0]
	job := waitStatus(t, st, second, models.JobFailed)
	if !strings.Contains(job.Error, "already imported (match") {
		t.Fatalf("error = %q, want already-imported message", job.Error)
	}
}

func TestImportInvalidPathFailsImmediately(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)

	ids := im.Enqueue([]string{"/no/such/file.txt"})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1 (invalid paths still get a job)", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobFailed)
	if !strings.Contains(job.Error, "unsupported file type") {
		t.Fatalf("error = %q, want unsupported-file-type message", job.Error)
	}
}

func TestCancelQueuedJob(t *testing.T) {
	block := make(chan struct{})
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		<-block // hold the worker on the first job
		return &models.ExtractedMatch{}, nil
	}
	im, st := newTestImporter(t, parse)
	defer close(block)

	running := im.Enqueue([]string{writeDemo(t, "a.dem", "a")})[0]
	queued := im.Enqueue([]string{writeDemo(t, "b.dem", "b")})[0]

	// Wait until the first job is claimed, so the second is truly queued.
	waitStatus(t, st, running, models.JobRunning)
	if err := im.Cancel(queued); err != nil {
		t.Fatalf("cancel queued: %v", err)
	}
	if err := im.Cancel(running); err != nil {
		t.Fatalf("cancel running: %v", err)
	}
	waitStatus(t, st, queued, models.JobCancelled)
	waitStatus(t, st, running, models.JobCancelled)
}

func TestReprocessRequiresMatch(t *testing.T) {
	im, _ := newTestImporter(t, fakeParse)
	if _, err := im.Reprocess(999); err == nil {
		t.Fatal("Reprocess of missing match: want error, got nil")
	}
}

// TestImportWritesSidecar proves the pipeline wires the position sink: a
// successful import leaves a readable sidecar (frames fed by fakeParse)
// and mirrors its meta onto the match row.
func TestImportWritesSidecar(t *testing.T) {
	im, st := newTestImporter(t, fakeParse)
	path := writeDemo(t, "sidecar.dem", "fake demo bytes")

	ids := im.Enqueue([]string{path})
	job := waitStatus(t, st, ids[0], models.JobDone)

	dir := filepath.Join(im.sidecarDir, strconv.FormatInt(job.MatchID, 10))
	r, err := sidecar.Open(dir)
	if err != nil {
		t.Fatalf("sidecar.Open after import: %v", err)
	}
	meta := r.Meta()
	if meta.Frames != 3 || meta.TickRate != 64 ||
		meta.FormatVersion != sidecar.FormatVersion || meta.SampleRate != sidecar.SampleRate {
		t.Errorf("sidecar meta = %+v, want frames=3 tickRate=64 format=1 sample=64", meta)
	}
	if len(meta.Players) != 2 {
		t.Errorf("slot table = %v, want 2 players", meta.Players)
	}
	raw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	if len(raw) == 0 {
		t.Error("sidecar stream is empty")
	}

	m, err := st.GetMatch(job.MatchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.PositionFormat != sidecar.FormatVersion || m.SampleRate != sidecar.SampleRate ||
		m.PositionFrames != 3 {
		t.Errorf("match position columns = %d/%d/%d, want %d/%d/3",
			m.PositionFormat, m.SampleRate, m.PositionFrames,
			sidecar.FormatVersion, sidecar.SampleRate)
	}
}

// TestImportParseFailureRemovesSidecar asserts a failed parse never leaves
// a half-written sidecar behind.
func TestImportParseFailureRemovesSidecar(t *testing.T) {
	failing := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if _, err := io.ReadAll(r); err != nil {
			return nil, err
		}
		if opts.Positions != nil {
			if err := opts.Positions.AddFrame(1, []extract.PositionPlayer{{SteamID: 1}}); err != nil {
				return nil, err
			}
		}
		return nil, errors.New("boom")
	}
	im, st := newTestImporter(t, failing)

	ids := im.Enqueue([]string{writeDemo(t, "boom.dem", "x")})
	job := waitStatus(t, st, ids[0], models.JobFailed)
	if !strings.Contains(job.Error, "boom") {
		t.Errorf("job error = %q, want it to contain boom", job.Error)
	}
	dir := filepath.Join(im.sidecarDir, strconv.FormatInt(job.MatchID, 10))
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("sidecar dir after failure: stat err = %v, want not-exist", err)
	}
}

// TestImportRunsAnalyzeStage proves the M3 wiring: a successful import
// runs the analytics pass (stage "analyze") and leaves classified rows,
// player rounds and a career rollup behind.
func TestImportRunsAnalyzeStage(t *testing.T) {
	parse := func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if _, err := io.ReadAll(r); err != nil {
			return nil, err
		}
		return &models.ExtractedMatch{
			Match: models.Match{Map: "de_analyze", TickRate: 64},
			Players: []models.Player{
				{SteamID: "1", Name: "one", Side: "ct"},
				{SteamID: "2", Name: "two", Side: "t"},
			},
			PlayerStats: []models.PlayerStats{
				{SteamID: "1", Name: "one", Side: "ct", Kills: 1, ADR: 50, RoundsPlayed: 1},
				{SteamID: "2", Name: "two", Side: "t", Deaths: 1, ADR: 25, RoundsPlayed: 1},
			},
			Rounds: []models.Round{
				{Number: 1, Winner: "ct", EquipCT: 5000, EquipT: 4200, StartTick: 100, EndTick: 7600},
			},
			RoundEconomy: []models.RoundEconomy{
				{Round: 1, Side: "ct", EquipValue: 5000},
				{Round: 1, Side: "t", EquipValue: 4200},
			},
			Events: []models.Event{
				{Tick: 500, Round: 1, Kind: models.EventKill, Attacker: "1", Victim: "2", Distance: 12},
			},
		}, nil
	}
	im, st := newTestImporter(t, parse)
	ids := im.Enqueue([]string{writeDemo(t, "analyze.dem", "x")})
	job := waitStatus(t, st, ids[0], models.JobDone)
	if job.MatchID == 0 {
		t.Fatal("job has no match link")
	}
	classes, err := st.GetRoundClasses(job.MatchID)
	if err != nil || len(classes) != 1 || classes[0].Label != "pistol" {
		t.Fatalf("round classes = %+v, %v, want 1 pistol row", classes, err)
	}
	prs, err := st.GetPlayerRounds(job.MatchID, "")
	if err != nil || len(prs) != 2 {
		t.Fatalf("player rounds = %+v, %v, want 2 rows", prs, err)
	}
	if prs[0].Kills != 1 && prs[1].Kills != 1 {
		t.Errorf("kills not attributed: %+v", prs)
	}
	career, err := st.GetCareer("1")
	if err != nil || career.Matches != 1 {
		t.Fatalf("career = %+v, %v, want 1 match after analyze", career, err)
	}
	// Economy rows join classifications (label carried through GetEconomy).
	econ, err := st.GetEconomy(job.MatchID)
	if err != nil || len(econ) != 1 || econ[0].Label != "pistol" {
		t.Fatalf("economy = %+v, %v", econ, err)
	}
}
