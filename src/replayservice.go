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
// This service carries the small control-plane data: meta. (The landmark
// feed itself is composed client-side from the source-specific reads —
// MatchService.GetEvents / GetChat / LibraryService.GetGenericEvents —
// see frontend lib/replay/landmarks.js; there is no separate landmark
// query.)

// ReplayMeta describes one match's position sidecar for the renderer.
type ReplayMeta struct {
	MatchID    int64          `json:"matchId"`
	TickRate   float64        `json:"tickRate"`
	SampleRate int            `json:"sampleRate"` // frames per second sampled (64)
	Frames     int            `json:"frames"`
	HasSidecar bool           `json:"hasSidecar"`
	Players    []ReplayPlayer `json:"players"`
}

// ReplayPlayer is one slot-table entry (index = slot in the raw stream).
type ReplayPlayer struct {
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Side    string `json:"side"`
	// IsBot is players.is_bot for this slot ("" when the roster has no
	// row for it — then false, never a guess). It is what lets the
	// frontend apply the replay exception: a bot is listed only while it
	// covers a disconnected human (frontend lib/replay/playercard.js
	// presentAt). The rest of the app never lists bots at all.
	IsBot bool `json:"isBot"`
	// Color is the player's CS2 teammate color as the RAW
	// m_iCompTeammateColor int (0 blue, 1 green, 2 yellow, 3 orange,
	// 4 purple, -1 none/GOTV — CS2.md "Player scoreboard/radar colors").
	// It rides the sidecar's slot table, so it is absent (null) for a
	// match whose sidecar predates the field — the frontend then draws
	// no color ring instead of guessing one.
	Color *int `json:"color,omitempty"`
}

// ReplayService serves replay meta.
type ReplayService struct {
	st  *store.Store
	app *application.App
}

// GetReplayMeta returns sidecar metadata for a match. ErrNotFound when the
// match is unknown; a missing sidecar is NOT an error — HasSidecar is
// false and the match row's mirrored columns (0 when no sidecar was
// stored) describe the absence. When the sidecar is present it is the
// source of truth for frames/sample rate/slots and the players array
// follows the slot table order (carrying that slot's teammate color when
// the sidecar has one); without one, players are ordered by name.
func (s *ReplayService) GetReplayMeta(matchID int64) (ReplayMeta, error) {
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return ReplayMeta{}, err
	}
	meta := ReplayMeta{
		MatchID:    matchID,
		TickRate:   m.TickRate,
		SampleRate: m.SampleRate,
		Frames:     m.PositionFrames,
	}

	// Roster identity for the slot table (name + final side + the bot
	// flag): the players read model, not the 37-column scoreboard — meta
	// only needs identity (IsBot drives the replay exception).
	refs, err := s.st.GetPlayerRefs(matchID)
	if err != nil {
		return ReplayMeta{}, err
	}
	bySteam := make(map[string]models.PlayerRef, len(refs))
	for _, ref := range refs {
		bySteam[ref.SteamID] = ref
	}

	rd, err := sidecar.Open(filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10)))
	switch {
	case err == nil:
		meta.HasSidecar = true
		sm := rd.Meta()
		meta.Frames = sm.Frames
		meta.SampleRate = sm.SampleRate
		if sm.TickRate > 0 {
			meta.TickRate = sm.TickRate
		}
		for i, id := range sm.Players {
			sid := strconv.FormatUint(id, 10)
			// Teammate color rides the slot table by the same index
			// (sidecar.Meta.ColorAt): a sidecar written before the
			// field leaves Color nil — no ring, never a guess.
			color, hasColor := sm.ColorAt(i)
			p := ReplayPlayer{SteamID: sid}
			if row, ok := bySteam[sid]; ok {
				delete(bySteam, sid)
				p.Name, p.Side, p.IsBot = row.Name, row.Side, row.IsBot
			}
			if hasColor {
				c := color
				p.Color = &c
			}
			meta.Players = append(meta.Players, p)
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
		rest = append(rest, ReplayPlayer{SteamID: sid, Name: row.Name, Side: row.Side, IsBot: row.IsBot})
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
