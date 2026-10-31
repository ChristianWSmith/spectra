package main

import (
	"errors"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ReplayService is the M2 frontend surface for the tactical replay. Bulk
// position bytes do NOT go through here — they ride the asset-server HTTP
// route /api/sidecar/<matchID>/positions (Range-capable, decompressed
// server-side) because bound []byte calls are base64-inflated.
// This service carries the small control-plane data: meta + landmarks.

// ReplayMeta describes one match's position sidecar for the renderer.
type ReplayMeta struct {
	MatchID       int64          `json:"matchId"`
	TickRate      float64        `json:"tickRate"`
	SampleRate    int            `json:"sampleRate"` // frames per second sampled (64)
	Frames        int            `json:"frames"`
	FormatVersion int            `json:"formatVersion"`
	HasSidecar    bool           `json:"hasSidecar"`
	Players       []ReplayPlayer `json:"players"`
}

// ReplayPlayer is one slot-table entry (index = slot in the raw stream).
type ReplayPlayer struct {
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Side    string `json:"side"`
}

// Landmark is one position-stamped event anchor (grenade throw/detonation,
// bomb plant/defuse/explode, kill) used for scrubber markers, site
// highlighting, and grenade polylines.
type Landmark struct {
	Kind    string   `json:"kind"`
	Tick    int      `json:"tick"`
	Round   int      `json:"round"`
	X       *float64 `json:"x,omitempty"`
	Y       *float64 `json:"y,omitempty"`
	Z       *float64 `json:"z,omitempty"`
	SteamID string   `json:"steamId,omitempty"`
	Weapon  string   `json:"weapon,omitempty"`
	Site    string   `json:"site,omitempty"`
}

// ReplayService serves replay meta + landmarks.
type ReplayService struct {
	st  *store.Store
	app *application.App
}

// GetReplayMeta returns sidecar metadata for a match. ErrNotFound when the
// match is unknown; a missing sidecar is NOT an error — HasSidecar is
// false and the match row's mirrored columns (0 for pre-M2 imports)
// describe the absence. When the sidecar is present it is the source of
// truth for frames/format/slots and the players array follows the slot
// table order; without one, players are ordered by name.
func (s *ReplayService) GetReplayMeta(matchID int64) (ReplayMeta, error) {
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return ReplayMeta{}, err
	}
	meta := ReplayMeta{
		MatchID:       matchID,
		TickRate:      m.TickRate,
		SampleRate:    m.SampleRate,
		Frames:        m.PositionFrames,
		FormatVersion: m.PositionFormat,
	}

	board, err := s.st.GetScoreboard(matchID, "name", false)
	if err != nil {
		return ReplayMeta{}, err
	}
	bySteam := make(map[string]models.PlayerStatsRow, len(board))
	for _, row := range board {
		bySteam[row.SteamID] = row
	}

	rd, err := sidecar.Open(filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10)))
	switch {
	case err == nil:
		meta.HasSidecar = true
		sm := rd.Meta()
		meta.Frames = sm.Frames
		meta.FormatVersion = sm.FormatVersion
		meta.SampleRate = sm.SampleRate
		if sm.TickRate > 0 {
			meta.TickRate = sm.TickRate
		}
		for _, id := range sm.Players {
			sid := strconv.FormatUint(id, 10)
			row, ok := bySteam[sid]
			if ok {
				delete(bySteam, sid)
				meta.Players = append(meta.Players, ReplayPlayer{SteamID: sid, Name: row.Name, Side: row.Side})
			} else {
				meta.Players = append(meta.Players, ReplayPlayer{SteamID: sid})
			}
		}
	case errors.Is(err, sidecar.ErrNoSidecar):
		// HasSidecar stays false; nothing else to report.
	default:
		return ReplayMeta{}, err
	}

	// Anything not covered by the slot table (no sidecar, or a player the
	// sidecar never sampled) follows, ordered by name then SteamID.
	rest := make([]ReplayPlayer, 0, len(bySteam))
	for sid, row := range bySteam {
		rest = append(rest, ReplayPlayer{SteamID: sid, Name: row.Name, Side: row.Side})
	}
	sort.Slice(rest, func(i, j int) bool {
		if rest[i].Name != rest[j].Name {
			return rest[i].Name < rest[j].Name
		}
		return rest[i].SteamID < rest[j].SteamID
	})
	meta.Players = append(meta.Players, rest...)
	return meta, nil
}

// GetLandmarks returns position-stamped anchors for a match:
// events carrying a position plus the bomb/grenade/kill landmark kinds,
// ordered by tick, capped at 5000 rows. SteamID attributes the actor —
// attacker for kills/damage, thrower for grenades, empty for bomb events
// (the bomb entity is the subject, not a player).
func (s *ReplayService) GetLandmarks(matchID int64) ([]Landmark, error) {
	rows, err := s.st.GetLandmarks(matchID, 5000)
	if err != nil {
		return nil, err
	}
	out := make([]Landmark, 0, len(rows))
	for _, e := range rows {
		lm := Landmark{
			Kind:   e.Kind,
			Tick:   e.Tick,
			Round:  e.Round,
			X:      e.PosX,
			Y:      e.PosY,
			Z:      e.PosZ,
			Weapon: e.Weapon,
			Site:   e.Site,
		}
		switch e.Kind {
		case models.EventBombPlant, models.EventBombDefuse, models.EventBombExplode:
			// no player attribution
		default:
			lm.SteamID = e.Attacker
		}
		out = append(out, lm)
	}
	return out, nil
}
