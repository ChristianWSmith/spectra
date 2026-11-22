package models

// WindowSample is one tick of an encounter window: both participants' eye and
// world positions. The enemy's eye is the canonical aim point (their head); the
// body midpoint is the midpoint of eye and world. Samples belong to the window,
// not to any one encounter.
type WindowSample struct {
	Tick           int
	P1Eye, P1World [3]float64
	P2Eye, P2World [3]float64
}

// EncounterWindow is the high-fidelity span for one pair of players in one round:
// the union of the overlapping encounters between them. Its samples are the data
// every encounter over it reads. P1 is the lower steam id.
type EncounterWindow struct {
	Round      int
	P1, P2     string
	StartTick  int
	EndTick    int
	Samples    []WindowSample
	Encounters []Encounter
}

// Encounter is one side of a window: who shot at whom, over which span. Both
// sides of a mutual fight reference the same window.
type Encounter struct {
	Shooter   string // steam id (accumulator key)
	Enemy     string
	StartTick int
	EndTick   int
	SeedTick  int
}

// EncounterShot is one weapon_fire event with a known shooter, the input the
// encounter build seeds from.
type EncounterShot struct {
	Round   int
	Tick    int
	Shooter string // steam id (accumulator key)
}

// RoundSpan is one counted round's tick span (inclusive).
type RoundSpan struct {
	Number     int
	Start, End int
}
