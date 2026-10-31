package extract

// VoiceChunk is one CSVCMsg_VoiceData capture unit (plan M4 §2). Payload is
// exactly one raw Opus packet (ref/findings/findings-voice.md: no TOC/length
// wrapper, 10 ms mono frame); Tick is GameState().IngameTick() at handler
// time (the message's own tick field is 0 in SourceTV demos); Section is the
// per-sender chunk counter used to detect rare gaps. XUID is the sender's
// SteamID64 (0 when absent).
type VoiceChunk struct {
	Tick    int
	XUID    uint64
	Payload []byte
	Caster  bool
	Section uint32
}

// VoiceSink receives one call per captured voice chunk. Implementations
// must consume Payload synchronously (the slice is only valid for the call
// — same contract as PositionSink). An error returned from Add aborts the
// parse.
type VoiceSink interface {
	Add(c VoiceChunk) error
}
