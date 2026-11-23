package extract

import (
	"strconv"

	"github.com/ChristianWSmith/spectra/internal/encounter"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// windowCollector gathers the match's frames as the parse runs (the same frames
// the position sink receives, at full precision) and builds the encounter
// windows once the parse is complete. The build needs events and rounds, which
// are only final at the end of the parse, so it runs there, before the match is
// returned.
type windowCollector struct {
	occ      encounter.Occluder
	frames   []encounter.Frame
	lastTick int32
	have     bool
}

// add records one frame. A repeated tick (the parser re-observes a tick) is
// dropped, as the tick writer drops it.
func (c *windowCollector) add(tick int32, players []PositionPlayer) {
	if c.have && tick == c.lastTick {
		return
	}
	f := encounter.Frame{Tick: int(tick), Players: make(map[uint64]encounter.Pos, len(players))}
	for _, p := range players {
		f.Players[p.SteamID] = encounter.Pos{
			X: float64(p.X), Y: float64(p.Y), Z: float64(p.Z),
			Duck: p.Duck, Side: p.Side, Yaw: float64(p.Yaw),
		}
	}
	c.frames = append(c.frames, f)
	c.lastTick, c.have = tick, true
}

// build writes the match's encounter windows into m.Windows.
func (c *windowCollector) build(m *models.ExtractedMatch) {
	if len(c.frames) == 0 {
		return
	}
	var shots []encounter.Shot
	for _, e := range m.Events {
		if e.Kind != "weapon_fire" || e.Round <= 0 || e.Attacker == "" {
			continue
		}
		id, err := strconv.ParseUint(e.Attacker, 10, 64)
		if err != nil {
			continue
		}
		shots = append(shots, encounter.Shot{Round: e.Round, Tick: e.Tick, Shooter: id})
	}
	rounds := make(map[int]encounter.Range, len(m.Rounds))
	for _, r := range m.Rounds {
		rounds[r.Number] = encounter.Range{Start: r.StartTick, End: r.EndTick}
	}
	encs, _ := encounter.Build(c.frames, shots, rounds, c.occ, 0)
	wins, encs := encounter.BuildWindows(c.frames, encs)
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
	m.Windows = rows
}
