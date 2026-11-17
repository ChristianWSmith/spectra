package library

import (
	"context"
	"io"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// emptyExtraction is a parse that SUCCEEDS but yields no playable
// content — the shape a demo with an unparseable entity stream produces
// (the demoinfocs parser recovers per packet, game events still parse,
// but no player/round state ever materializes: zero players, zero
// counted rounds, one parser warning per packet). See the guard in
// Importer.process between parse and SaveExtracted.
func emptyExtraction(players, rounds int) func(context.Context, io.Reader, extract.ParseOptions) (*models.ExtractedMatch, error) {
	return func(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
		if _, err := io.ReadAll(r); err != nil {
			return nil, err
		}
		if opts.Progress != nil {
			opts.Progress(1, 1)
		}
		em := &models.ExtractedMatch{Match: models.Match{Map: "de_test", TickRate: 64}}
		for i := 0; i < players; i++ {
			em.Players = append(em.Players, models.Player{
				SteamID: strconv.FormatUint(uint64(100+i), 10),
				Name:    "player",
				Side:    "ct",
			})
		}
		for i := 0; i < rounds; i++ {
			em.Rounds = append(em.Rounds, models.Round{Number: i + 1, StartTick: 1, EndTick: 64})
		}
		return em, nil
	}
}

// TestEmptyExtractionNeverStoresReadyMatch pins the content guard
// (2026-11-17, owner bug): an extraction with no players or no rounds
// must FAIL the job and leave the match FAILED — never a "ready" row.
// Two consequences are asserted because both were owner-visible
// symptoms:
//
//   - a ready-but-content-less match renders blank everywhere (library
//     row, scoreboard, rounds);
//   - it is UN-HEALABLE work for the metric sweeps: store.MetricCoverage
//     treats every ready match as a unit owing a fresh row per
//     match-scope metric, so the import-body and startup sweeps would
//     re-attempt forever, write nothing (no inputs to compute over), and
//     the metrics stay "behind" permanently. The coverage assertion below
//     fails on a stored empty match for exactly that reason.
func TestEmptyExtractionNeverStoresReadyMatch(t *testing.T) {
	cases := []struct {
		name    string
		players int
		rounds  int
		wantErr string
	}{
		{name: "no players and no rounds", players: 0, rounds: 0, wantErr: "no rounds were found"},
		{name: "players but no rounds", players: 1, rounds: 0, wantErr: "no rounds were found"},
		{name: "rounds but no players", players: 0, rounds: 1, wantErr: "no players were found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			im, st := newTestImporter(t, emptyExtraction(tc.players, tc.rounds))
			ids := im.Enqueue([]string{writeDemo(t, "empty.dem", "content")})
			if len(ids) != 1 {
				t.Fatalf("Enqueue = %d jobs, want 1", len(ids))
			}

			job := waitStatus(t, st, ids[0], models.JobFailed)
			if !strings.Contains(job.Error, tc.wantErr) {
				t.Errorf("job error = %q, want it to contain %q", job.Error, tc.wantErr)
			}

			matchID := waitJobMatch(t, st, ids[0])
			m, err := st.GetMatch(matchID)
			if err != nil {
				t.Fatalf("GetMatch: %v", err)
			}
			if m.Status == models.StatusReady {
				t.Errorf("match status = %q, want a non-ready status — a content-less match must never be ready", m.Status)
			}
			if !strings.Contains(m.Error, tc.wantErr) {
				t.Errorf("match error = %q, want it to contain %q", m.Error, tc.wantErr)
			}

			// The freshen invariant: with the match never ready, the
			// behind predicate owes nothing for it — no metric may read
			// behind on this store (pre-fix, the stored ready match with
			// zero metric rows makes every match-scope metric behind).
			cfg, err := st.GetConfig()
			if err != nil {
				t.Fatalf("GetConfig: %v", err)
			}
			coverage, err := st.MetricCoverage(cfg.RuleVersion)
			if err != nil {
				t.Fatalf("MetricCoverage: %v", err)
			}
			for _, c := range coverage {
				if c.Behind {
					t.Errorf("metric %d reads behind after the failed import — the sweep can never freshen a content-less match", c.MetricID)
				}
			}
		})
	}
}
