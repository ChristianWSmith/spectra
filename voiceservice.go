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

// VoiceService is the M4 control plane for per-match voice data. Bulk audio
// does NOT go through bindings: PCM/WAV ride the asset-server HTTP routes
// under /api/sidecar/<id>/voice/… (pcm?steamId&fromTick&toTick → s16le mono
// @16 kHz with gaps zero-filled; wav?steamId → full-track download).
// The chunk index itself is read from the sidecar (sidecar.OpenVoice) —
// SQLite only answers the presence header.

// voiceDecoderName identifies the pinned pure-Go decoder for Settings.
const voiceDecoderName = "pion/opus e7b8aa5 (pure Go)"

// voiceDefaultBuckets is the GetVoiceLanes density bucket count when the
// caller passes <= 0.
const voiceDefaultBuckets = 160

// matchSidecarDir is a match's sidecar directory — the argument
// sidecar.OpenVoice takes.
func matchSidecarDir(matchID int64) string {
	return filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10))
}

// VoicePresence is the match header badge payload.
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

// VoicePlayer is one participant's voice summary (derived from the
// sidecar's per-player chunk index at read time).
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

// badgeOff is the "no voice" payload: HasVoice=false with zero counts and
// the decoder/rate filled in, so a match without voice degrades to a
// silent badge instead of an error.
func (s *VoiceService) badgeOff(matchID int64) VoicePresence {
	return VoicePresence{
		MatchID:       matchID,
		OutSampleRate: models.VoiceOutSampleRate,
		Decoder:       voiceDecoderName,
	}
}

// GetVoicePresence returns badge + Settings status for a match. A match
// with no voice rows is not an error: it yields the badge-off shape
// (HasVoice=false, zero counts) so a Valve-MM demo degrades gracefully.
// The row is additionally GATED on the sidecar index: a presence row whose
// voice/*.idx is absent describes a match imported before the index moved
// out of the database — nothing can play it, so it reports badge-off too
// (old DBs show no voice until one reprocess; no nudge, one honest number).
func (s *VoiceService) GetVoicePresence(matchID int64) (VoicePresence, error) {
	p, err := s.st.GetVoicePresence(matchID)
	if errors.Is(err, store.ErrNotFound) {
		return s.badgeOff(matchID), nil
	}
	if err != nil {
		return VoicePresence{}, err
	}
	if _, err := sidecar.OpenVoice(matchSidecarDir(matchID)); err != nil {
		if errors.Is(err, sidecar.ErrNoVoiceIndex) {
			return s.badgeOff(matchID), nil
		}
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

// voicePlayerStats reads the sidecar index's per-player summaries; a match
// with no index yields an empty slice (never an error — "no voice" is not
// a failure here either).
func voicePlayerStats(matchID int64) ([]sidecar.VoicePlayerStat, error) {
	rd, err := sidecar.OpenVoice(matchSidecarDir(matchID))
	if errors.Is(err, sidecar.ErrNoVoiceIndex) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return rd.Players()
}

// orderVoiceStats pins the read order both voice listings share: chunks
// DESC, then steam ID ASC (string order — the SQL ORDER BY the store used
// to own). The comparator is total (SteamIDs are unique), so plain
// sort.Slice is deterministic.
func orderVoiceStats(stats []sidecar.VoicePlayerStat) {
	sort.Slice(stats, func(i, j int) bool {
		if stats[i].Chunks != stats[j].Chunks {
			return stats[i].Chunks > stats[j].Chunks
		}
		return stats[i].SteamID < stats[j].SteamID
	})
}

// voiceNames maps SteamID → roster name through the canonical single-match
// lookup (store.GetPlayerRefs — deliberately not playersJoin). Players
// absent from the roster (casters) map to "".
func (s *VoiceService) voiceNames(matchID int64) (map[string]string, error) {
	refs, err := s.st.GetPlayerRefs(matchID)
	if err != nil {
		return nil, err
	}
	names := make(map[string]string, len(refs))
	for _, ref := range refs {
		names[ref.SteamID] = ref.Name
	}
	return names, nil
}

// GetVoicePlayers returns per-player voice summaries (empty slice when no
// voice — never an error).
func (s *VoiceService) GetVoicePlayers(matchID int64) ([]VoicePlayer, error) {
	stats, err := voicePlayerStats(matchID)
	if err != nil {
		return nil, err
	}
	names, err := s.voiceNames(matchID)
	if err != nil {
		return nil, err
	}
	orderVoiceStats(stats)
	out := make([]VoicePlayer, 0, len(stats))
	for _, p := range stats {
		out = append(out, VoicePlayer{
			SteamID:   p.SteamID,
			Name:      names[p.SteamID],
			Chunks:    p.Chunks,
			FirstTick: p.FirstTick,
			LastTick:  p.LastTick,
			Seconds:   float64(p.Chunks) * 0.01, // 10 ms Opus frames
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
	rd, err := sidecar.OpenVoice(matchSidecarDir(matchID))
	if errors.Is(err, sidecar.ErrNoVoiceIndex) {
		return res, nil
	}
	if err != nil {
		return VoiceLanesResult{}, err
	}
	stats, err := rd.Players()
	if err != nil {
		return VoiceLanesResult{}, err
	}
	orderVoiceStats(stats)
	span := float64(to - from)
	for _, p := range stats {
		ticks, err := rd.Ticks(p.SteamID)
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
