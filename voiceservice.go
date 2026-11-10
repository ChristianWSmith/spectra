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

// VoicePlayerWindow is one player's non-empty window start ticks — the
// per-player row of the sparse-window map.
type VoicePlayerWindow struct {
	SteamID string `json:"steamId"`
	Starts  []int  `json:"starts"`
}

// VoiceWindows is the server-exact sparse-window map: per player, the
// start tick of every WindowTicks-wide window that holds ≥1 chunk. The
// replay engine skips scheduling the windows absent from it (~90% of
// requested windows are pure silence) — membership is ALWAYS server-
// computed here, never derived client-side from lanes (float bucket math
// could drop real speech = an audible dropout). WindowTicks echoes the
// caller's argument so the engine can prove the map was built for ITS
// window size; WindowTicks 0 with no players means "no map", which the
// engine treats as fail-open (fetch, never skip).
type VoiceWindows struct {
	WindowTicks int                 `json:"windowTicks"`
	Players     []VoicePlayerWindow `json:"players"`
}

// VoiceIndexResult is the ONE match-load read: per-player summaries, the
// timeline lane buckets and the sparse-window map — all derived from a
// single walk over the per-player index files (GetVoicePlayers +
// GetVoiceLanes used to walk them three times).
type VoiceIndexResult struct {
	MatchID int64            `json:"matchId"`
	Players []VoicePlayer    `json:"players"`
	Lanes   VoiceLanesResult `json:"lanes"`
	Windows VoiceWindows     `json:"windows"`
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

// voiceIndexRead opens the match's voice index and reads every player's
// file ONCE (sidecar.PlayersWithTicks — summary AND ticks from one read):
// THE index pass behind GetVoicePlayers, GetVoiceLanes and GetVoiceIndex
// (match load used to walk each file up to three times). A match without
// an index yields (nil, nil) — "no voice" is not a failure here either.
func voiceIndexRead(matchID int64) ([]sidecar.VoicePlayerIndex, error) {
	rd, err := sidecar.OpenVoice(matchSidecarDir(matchID))
	if errors.Is(err, sidecar.ErrNoVoiceIndex) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return rd.PlayersWithTicks()
}

// orderVoiceIndex pins the read order all voice listings share: chunks
// DESC, then steam ID ASC (string order — the SQL ORDER BY the store used
// to own). The comparator is total (SteamIDs are unique), so plain
// sort.Slice is deterministic.
func orderVoiceIndex(idx []sidecar.VoicePlayerIndex) {
	sort.Slice(idx, func(i, j int) bool {
		if idx[i].Chunks != idx[j].Chunks {
			return idx[i].Chunks > idx[j].Chunks
		}
		return idx[i].SteamID < idx[j].SteamID
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
// voice — never an error). Thin wrapper over the one index pass.
func (s *VoiceService) GetVoicePlayers(matchID int64) ([]VoicePlayer, error) {
	idx, err := voiceIndexRead(matchID)
	if err != nil {
		return nil, err
	}
	names, err := s.voiceNames(matchID)
	if err != nil {
		return nil, err
	}
	orderVoiceIndex(idx)
	return voicePlayerRows(idx, names), nil
}

// voicePlayerRows maps the index-pass rows onto the binding DTO (roster
// names joined through voiceNames — casters map to "").
func voicePlayerRows(idx []sidecar.VoicePlayerIndex, names map[string]string) []VoicePlayer {
	out := make([]VoicePlayer, 0, len(idx))
	for _, p := range idx {
		out = append(out, VoicePlayer{
			SteamID:   p.SteamID,
			Name:      names[p.SteamID],
			Chunks:    p.Chunks,
			FirstTick: p.FirstTick,
			LastTick:  p.LastTick,
			Seconds:   float64(p.Chunks) * 0.01, // 10 ms Opus frames
		})
	}
	return out
}

// laneCounts buckets one player's chunk ticks into `buckets` cells over
// [from, from+span) — the GetVoiceLanes formula, shared by GetVoiceIndex
// (one spelling of the bucket math).
func laneCounts(ticks []int, from int, span float64, buckets int) []int {
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
	return counts
}

// voiceLanes builds the lane result from ONE index pass (idx must already
// be in listing order — orderVoiceIndex). The bucket window is the match
// timeline [0, durationTicks) — the span the events/replay view uses.
func voiceLanes(durationTicks, buckets int, idx []sidecar.VoicePlayerIndex) VoiceLanesResult {
	res := VoiceLanesResult{FromTick: 0, ToTick: durationTicks, Buckets: buckets, Players: []VoiceLane{}}
	if res.ToTick <= res.FromTick || len(idx) == 0 {
		return res
	}
	span := float64(res.ToTick - res.FromTick)
	for _, p := range idx {
		res.Players = append(res.Players, VoiceLane{
			SteamID: p.SteamID,
			Counts:  laneCounts(p.Ticks, res.FromTick, span, buckets),
		})
	}
	return res
}

// windowStarts maps one player's chunk ticks onto the start tick of the
// fixed window holding them: tick / windowTicks * windowTicks (integer
// division — the exact complement of the engine's
// Math.floor(end / windowTicks) * windowTicks; windowTicks is the
// caller's, so the window math lives in exactly one place per side).
// Index order is tick-sorted, so same-window duplicates collapse
// consecutively. windowTicks < 1 yields nil — no map, fail-open client
// side.
func windowStarts(ticks []int, windowTicks int) []int {
	if windowTicks < 1 {
		return nil
	}
	out := make([]int, 0, len(ticks))
	for _, t := range ticks {
		start := t / windowTicks * windowTicks
		if len(out) == 0 || out[len(out)-1] != start {
			out = append(out, start)
		}
	}
	return out
}

// GetVoiceLanes returns density buckets across the match span for the
// timeline lanes. The bucket window is the match timeline [0,
// DurationTicks) — the same span the events/replay view uses — so lane
// clicks seek the master clock directly. Players without voice are
// omitted; buckets <= 0 defaults to 160. Thin wrapper over the one index
// pass.
func (s *VoiceService) GetVoiceLanes(matchID int64, buckets int) (VoiceLanesResult, error) {
	if buckets <= 0 {
		buckets = voiceDefaultBuckets
	}
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return VoiceLanesResult{}, err
	}
	if m.DurationTicks <= 0 {
		return voiceLanes(m.DurationTicks, buckets, nil), nil
	}
	idx, err := voiceIndexRead(matchID)
	if err != nil {
		return VoiceLanesResult{}, err
	}
	orderVoiceIndex(idx)
	return voiceLanes(m.DurationTicks, buckets, idx), nil
}

// GetVoiceIndex is the ONE match-load voice read: per-player summaries,
// lane buckets and the sparse-window map from a single walk over the
// index files (the replay view's three reads collapsed into one).
// buckets <= 0 defaults to 160; windowTicks < 1 (or a player with no
// window starts) yields NO map for that scope — the engine fail-opens to
// fetching rather than skipping.
func (s *VoiceService) GetVoiceIndex(matchID int64, buckets, windowTicks int) (VoiceIndexResult, error) {
	if buckets <= 0 {
		buckets = voiceDefaultBuckets
	}
	if windowTicks < 0 {
		windowTicks = 0
	}
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return VoiceIndexResult{}, err
	}
	res := VoiceIndexResult{
		MatchID: matchID,
		Players: []VoicePlayer{},
		Lanes:   voiceLanes(m.DurationTicks, buckets, nil),
		Windows: VoiceWindows{WindowTicks: windowTicks, Players: []VoicePlayerWindow{}},
	}
	idx, err := voiceIndexRead(matchID)
	if err != nil {
		return VoiceIndexResult{}, err
	}
	if len(idx) == 0 {
		return res, nil
	}
	names, err := s.voiceNames(matchID)
	if err != nil {
		return VoiceIndexResult{}, err
	}
	orderVoiceIndex(idx)
	res.Players = voicePlayerRows(idx, names)
	res.Lanes = voiceLanes(m.DurationTicks, buckets, idx)
	if windowTicks >= 1 {
		for _, p := range idx {
			res.Windows.Players = append(res.Windows.Players, VoicePlayerWindow{
				SteamID: p.SteamID,
				Starts:  windowStarts(p.Ticks, windowTicks),
			})
		}
	}
	return res, nil
}
