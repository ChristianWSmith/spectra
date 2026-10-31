package main

import (
	"errors"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// VoiceService is the M4 control plane for per-match voice data. Bulk audio
// does NOT go through bindings: PCM/WAV ride the asset-server HTTP routes
// under /api/sidecar/<id>/voice/… (pcm?steamId&fromTick&toTick → s16le mono
// @16 kHz with gaps zero-filled; wav?steamId → full-track download).

// voiceDecoderName identifies the pinned pure-Go decoder for Settings.
const voiceDecoderName = "pion/opus e7b8aa5 (pure Go)"

// voiceDefaultBuckets is the GetVoiceLanes density bucket count when the
// caller passes <= 0.
const voiceDefaultBuckets = 160

// VoicePresence is the match header badge payload (plan §5).
type VoicePresence struct {
	MatchID     int64 `json:"matchId"`
	HasVoice    bool  `json:"hasVoice"`
	ChunkCount  int   `json:"chunkCount"`
	PlayerCount int   `json:"playerCount"`
	CasterCount int   `json:"casterCount"`
	// KeyFound: a parseable <demo>.info companion supplied the chat
	// decryption key on import (chat.decrypted flows from it).
	KeyFound bool `json:"keyFound"`
	// OutSampleRate is the PCM decode rate served by the HTTP route.
	OutSampleRate int `json:"outSampleRate"` // 16000
	// Decoder identifies the pinned pure-Go decoder (Settings/status).
	Decoder string `json:"decoder"`
}

// VoicePlayer is one participant's voice summary (voice_players derived
// from the chunk index at read time).
type VoicePlayer struct {
	SteamID   string  `json:"steamId"`
	Name      string  `json:"name"`
	Chunks    int     `json:"chunks"`
	FirstTick int     `json:"firstTick"`
	LastTick  int     `json:"lastTick"`
	Seconds   float64 `json:"seconds"` // chunks × 10 ms (frame duration)
}

// VoiceLanesResult is index-only density for the timeline lanes (plan
// §2.5 — no decode involved; buckets cover [fromTick,toTick)).
type VoiceLanesResult struct {
	FromTick int         `json:"fromTick"`
	ToTick   int         `json:"toTick"`
	Buckets  int         `json:"buckets"`
	Players  []VoiceLane `json:"players"`
}

// VoiceLane is one player's per-bucket chunk counts (steamId for join with
// names/teams client-side).
type VoiceLane struct {
	SteamID string `json:"steamId"`
	Counts  []int  `json:"counts"`
}

// VoiceService — see doc comment above.
type VoiceService struct {
	st  *store.Store
	app *application.App
}

// GetVoicePresence returns badge + Settings status for a match. A match
// with no voice rows is not an error: it yields the badge-off shape
// (HasVoice=false, zero counts) so a Valve-MM demo degrades gracefully.
func (s *VoiceService) GetVoicePresence(matchID int64) (VoicePresence, error) {
	p, err := s.st.GetVoicePresence(matchID)
	if errors.Is(err, store.ErrNotFound) {
		return VoicePresence{
			MatchID:       matchID,
			OutSampleRate: models.VoiceOutSampleRate,
			Decoder:       voiceDecoderName,
		}, nil
	}
	if err != nil {
		return VoicePresence{}, err
	}
	return VoicePresence{
		MatchID:       matchID,
		HasVoice:      p.ChunkCount > 0,
		ChunkCount:    p.ChunkCount,
		PlayerCount:   p.PlayerCount,
		CasterCount:   p.CasterCount,
		KeyFound:      p.KeyFound,
		OutSampleRate: p.OutSampleRate,
		Decoder:       voiceDecoderName,
	}, nil
}

// GetVoicePlayers returns per-player voice summaries (empty slice when no
// voice — never an error).
func (s *VoiceService) GetVoicePlayers(matchID int64) ([]VoicePlayer, error) {
	rows, err := s.st.GetVoicePlayers(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]VoicePlayer, 0, len(rows))
	for _, r := range rows {
		out = append(out, VoicePlayer{
			SteamID:   r.SteamID,
			Name:      r.Name,
			Chunks:    r.Chunks,
			FirstTick: r.FirstTick,
			LastTick:  r.LastTick,
			Seconds:   r.Seconds,
		})
	}
	return out, nil
}

// GetVoiceLanes returns density buckets across the match span for the
// timeline lanes. The bucket window is the match timeline [0,
// DurationTicks) — the same span the events/replay view uses — so lane
// clicks seek the master clock directly. Players without voice are
// omitted; buckets <= 0 defaults to 160.
func (s *VoiceService) GetVoiceLanes(matchID int64, buckets int) (VoiceLanesResult, error) {
	if buckets <= 0 {
		buckets = voiceDefaultBuckets
	}
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return VoiceLanesResult{}, err
	}
	from, to := 0, m.DurationTicks
	res := VoiceLanesResult{FromTick: from, ToTick: to, Buckets: buckets, Players: []VoiceLane{}}
	if to <= from {
		return res, nil
	}
	players, err := s.st.GetVoicePlayers(matchID)
	if err != nil {
		return VoiceLanesResult{}, err
	}
	span := float64(to - from)
	for _, p := range players {
		ticks, err := s.st.GetVoiceTicks(matchID, p.SteamID)
		if err != nil {
			return VoiceLanesResult{}, err
		}
		counts := make([]int, buckets)
		for _, t := range ticks {
			b := int(float64(t-from) / span * float64(buckets))
			if b < 0 {
				b = 0
			}
			if b >= buckets {
				b = buckets - 1 // tick == to lands in the last bucket
			}
			counts[b]++
		}
		res.Players = append(res.Players, VoiceLane{SteamID: p.SteamID, Counts: counts})
	}
	return res, nil
}
