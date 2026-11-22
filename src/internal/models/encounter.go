package models

// EncounterSample is one tick of an encounter: the shooter's eye, the enemy's
// eye (the canonical aim point, their head) and the enemy's world position.
// The body midpoint is the midpoint of the enemy's eye and world position.
type EncounterSample struct {
	Tick       int
	ShooterEye [3]float64
	EnemyEye   [3]float64
	EnemyWorld [3]float64
}

// EncounterRow is one shot-seeded visibility window for a (shooter, enemy) pair.
type EncounterRow struct {
	Round     int
	Shooter   string // steam id (accumulator key)
	Enemy     string
	StartTick int
	EndTick   int
	SeedTick  int
	Samples   []EncounterSample
}
