// Voice persistence vocabulary (M4): the store-level rows for the
// voice_chunks index and voice_presence header. Audio payloads themselves
// live in the per-match sidecar (<matchDir>/voice/<steamid>.opus) — the DB
// IS the chunk index (the chunks.idx file is intentionally replaced
// by these rows; see internal/sidecar VoiceWriter).
package models

// VoiceOutSampleRate is the PCM decode output rate served by the voice
// HTTP routes (16 kHz mono is speech-band sufficient).
const VoiceOutSampleRate = 16000

// VoiceIndexRow is one chunk's row in voice_chunks. SteamID is the decimal
// SteamID64 string; Off/Len address the payload inside that player's .opus
// file. Seq (assigned by the store on insert) is the global capture order.
// Round is assigned by the store at insert time from the match's round
// tick ranges — writers never know about rounds.
type VoiceIndexRow struct {
	Tick    int    `json:"tick"`
	Round   int    `json:"round"`
	SteamID string `json:"steamId"`
	Off     int64  `json:"off"`
	Len     int64  `json:"len"`
	Caster  bool   `json:"caster"`
	Section uint32 `json:"section"`
}

// VoicePresenceRow is the voice_presence header: one row per match with
// voice (absent row = no voice). KeyFound records that a parseable
// <demo>.info companion supplied the chat decryption key at import.
type VoicePresenceRow struct {
	MatchID       int64 `json:"matchId"`
	ChunkCount    int   `json:"chunkCount"`
	PlayerCount   int   `json:"playerCount"`
	CasterCount   int   `json:"casterCount"`
	KeyFound      bool  `json:"keyFound"`
	OutSampleRate int   `json:"outSampleRate"`
}

// VoicePlayerRow is one player's derived voice summary
// (voice_players is a read-time GROUP BY, not a table).
type VoicePlayerRow struct {
	MatchID   int64   `json:"matchId"`
	SteamID   string  `json:"steamId"`
	Name      string  `json:"name"`
	Chunks    int     `json:"chunks"`
	FirstTick int     `json:"firstTick"`
	LastTick  int     `json:"lastTick"`
	Seconds   float64 `json:"seconds"` // chunks × 10 ms Opus frame duration
}
