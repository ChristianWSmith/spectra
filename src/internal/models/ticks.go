package models

// TickSample is one present participant's merged per-frame sample — the
// unit extract hands its tick sink (extract.TickSink) and the store's
// player_ticks writer (store.TickWriter) derives a row from. It merges the
// two per-frame populations extract already samples for the sidecar: the
// state sample (every playing participant, dead included) is the spine,
// and the alive-only position sample joins it by identity (HasPosition).
//
// Every field is a parser read; nothing is inferred. HP is forced to 0
// when !Alive (death is evidence, as in the sidecar's state stream),
// Money is the controller's account as read (it survives death), Weapon
// is the canonical weapon name and only sampled while alive, Side is the
// identity's team at that frame ("ct"/"t", "" when unassigned — never
// guessed). X/Y/Z are the RAW float world positions (the sidecar
// quantizes them; the store derives speed from these, before any
// quantization) and InAir the airborne flag — both meaningful only when
// HasPosition.
type TickSample struct {
	SteamID     string // accumulator key (SteamID64, or a bot's synthetic 0xFF key)
	Side        string
	Alive       bool
	HP          int
	Money       int
	Weapon      string
	HasPosition bool
	X, Y, Z     float64
	InAir       bool
}
