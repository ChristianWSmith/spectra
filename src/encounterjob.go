package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/source2"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// buildEncountersFor returns the import-time encounter build (library.Options.
// BuildEncounters). It reads the match's sidecar and the map's world collision
// cache, seeds shot-with-visibility windows, and stores them. Derived data:
// re-running replaces the match's encounters.
func buildEncountersFor(st *store.Store) func(ctx context.Context, matchID int64) error {
	return func(ctx context.Context, matchID int64) error {
		return buildEncounters(ctx, st, matchID)
	}
}

func buildEncounters(ctx context.Context, st *store.Store, matchID int64) error {
	m, err := st.GetMatch(matchID)
	if err != nil {
		return fmt.Errorf("match: %w", err)
	}
	if m == nil || m.Map == "" {
		return fmt.Errorf("match %d has no map name", matchID)
	}
	occ, err := worldOccluder(m.Map)
	if err != nil {
		return err
	}
	idStr := strconv.FormatInt(matchID, 10)
	stream, err := sidecar.Load(filepath.Join(data.MatchesDir(), idStr), 0, 0)
	if err != nil {
		return fmt.Errorf("couldn't read the match's recorded positions: %w", err)
	}
	frames := make([]encounter.Frame, 0, len(stream.Frames))
	for _, f := range stream.Frames {
		ef := encounter.Frame{Tick: f.Tick, Players: make(map[uint64]encounter.Pos, len(f.Players))}
		for _, p := range f.Players {
			ef.Players[p.SteamID] = encounter.Pos{X: p.X, Y: p.Y, Z: p.Z, Duck: p.Duck, Side: p.Side}
		}
		frames = append(frames, ef)
	}
	shotRows, roundRows, err := st.EncounterInputs(matchID)
	if err != nil {
		return err
	}
	shots := make([]encounter.Shot, 0, len(shotRows))
	for _, sh := range shotRows {
		id, err := strconv.ParseUint(sh.Shooter, 10, 64)
		if err != nil {
			continue
		}
		shots = append(shots, encounter.Shot{Round: sh.Round, Tick: sh.Tick, Shooter: id})
	}
	rounds := make(map[int]encounter.Range, len(roundRows))
	for _, r := range roundRows {
		rounds[r.Number] = encounter.Range{Start: r.Start, End: r.End}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	encs, _ := encounter.Build(frames, shots, rounds, occ, 0)
	wins, encs := encounter.BuildWindows(frames, encs)
	rows := make([]models.EncounterWindow, len(wins))
	for i, w := range wins {
		rows[i] = models.EncounterWindow{
			Round: w.Round, P1: strconv.FormatUint(w.P1, 10), P2: strconv.FormatUint(w.P2, 10),
			StartTick: w.Start, EndTick: w.End,
		}
		for _, sm := range w.Samples {
			rows[i].Samples = append(rows[i].Samples, models.WindowSample{
				Tick: sm.Tick, P1Eye: sm.P1Eye, P1World: sm.P1World, P2Eye: sm.P2Eye, P2World: sm.P2World,
			})
		}
	}
	for _, e := range encs {
		if e.Window < 0 || e.Window >= len(rows) {
			continue
		}
		rows[e.Window].Encounters = append(rows[e.Window].Encounters, models.Encounter{
			Shooter: strconv.FormatUint(e.Shooter, 10), Enemy: strconv.FormatUint(e.Enemy, 10),
			StartTick: e.Start, EndTick: e.End, SeedTick: e.Seed,
		})
	}
	return st.SaveEncounterWindows(matchID, rows)
}

// worldOccluder loads the map's world collision cache (written by the asset
// extraction) and returns the segment-blocked query over it.
func worldOccluder(mapName string) (encounter.Occluder, error) {
	path := filepath.Join(data.WorldColDir(), mapName+".worldcol")
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("world collision for %s: %w (extract the CS2 assets)", mapName, err)
	}
	defer f.Close()
	meshes, err := source2.ReadMeshes(f)
	if err != nil {
		return nil, fmt.Errorf("world collision for %s: %w", mapName, err)
	}
	return func(a, b [3]float64) bool {
		seg := source2.Segment{
			A: source2.Vec3{float32(a[0]), float32(a[1]), float32(a[2])},
			B: source2.Vec3{float32(b[0]), float32(b[1]), float32(b[2])},
		}
		for i := range meshes {
			if meshes[i].Blocked(seg) {
				return true
			}
		}
		return false
	}, nil
}
