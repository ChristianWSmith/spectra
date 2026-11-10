// Voice persistence vocabulary (M4): the store-level voice_presence header
// plus the sidecar's chunk-index row shape. Audio payloads and their index
// live entirely in the per-match sidecar (<matchDir>/voice/<steamid>.opus +
// <steamid>.idx — internal/sidecar): the database IS NOT the index.
package models

// VoiceOutSampleRate is the PCM decode output rate served by the voice
// HTTP routes (16 kHz mono is speech-band sufficient).
const VoiceOutSampleRate = 16000

// VoiceIndexRow is one chunk of a player's voice index (the <steamid>.idx
// record, internal/sidecar). SteamID is the decimal SteamID64 string;
// Off/Len address the payload inside that player's .opus file. It is
// written by the sidecar VoiceWriter and read back by the sidecar voice
// reader — nothing in SQLite carries it. There is deliberately no round:
// the index is tick-ordered only, and a round can be derived at read time
// via store.RoundForTick when a caller needs one.
type VoiceIndexRow struct {
	Tick    int    `json:"tick"`
	SteamID string `json:"steamId"`
	Off     int64  `json:"off"`
	Len     int64  `json:"len"`
	Caster  bool   `json:"caster"`
	Section uint32 `json:"section"`
}

// VoicePresenceRow is the voice_presence header: one row per match with
// voice (absent row = no voice). KeyFound records that a parseable
// <demo>.info companion supplied the chat decryption key at import. The
// counts are provenance only — the playable index is the sidecar's
// voice/*.idx (readers gate the presence row on it).
type VoicePresenceRow struct {
	MatchID       int64 `json:"matchId"`
	ChunkCount    int   `json:"chunkCount"`
	PlayerCount   int   `json:"playerCount"`
	CasterCount   int   `json:"casterCount"`
	KeyFound      bool  `json:"keyFound"`
	OutSampleRate int   `json:"outSampleRate"`
}
