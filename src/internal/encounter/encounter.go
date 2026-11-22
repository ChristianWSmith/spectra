// Package encounter builds shot-seeded visibility windows (tier-2 encounters).
//
// Rule (owner, 2026-11-22): a shot is a seed only when the shooter has a line of
// sight to an enemy at that tick. The window for the (shooter, enemy) pair
// extends backward and forward as far as the pair stays visible and alive,
// within its round. A shot whose tick falls inside an existing window of the
// same shooter is skipped as a seed.
package encounter

import "sort"

// Pos is one participant's sampled position at a frame.
type Pos struct {
	X, Y, Z float64
	Duck    bool
	Side    string // "ct", "t" or ""
}

// Frame is one sidecar frame: the participants alive at Tick.
type Frame struct {
	Tick    int
	Players map[uint64]Pos
}

// Shot is one weapon_fire event with a known shooter and round.
type Shot struct {
	Round   int
	Tick    int
	Shooter uint64
}

// Range is a round's tick span (inclusive).
type Range struct{ Start, End int }

// Occluder reports whether the segment between two points is blocked.
type Occluder func(a, b [3]float64) bool

// Viewpoint is one tick's eye positions for the pair: the shooter's and the
// enemy's. The enemy's eye is the canonical aim point for crosshair metrics:
// the opponent's head, the point a player is trying to put the crosshair on.
type Viewpoint struct {
	Tick       int
	Shooter    [3]float64 // shooter's eye
	Enemy      [3]float64 // enemy's eye (the canonical aim point)
	EnemyWorld [3]float64 // enemy's world (origin) position, for box reconstruction
}

// Encounter is one visibility window for a shooter and an enemy.
type Encounter struct {
	Round      int
	Shooter    uint64
	Enemy      uint64
	Start, End int
	Seed       int // tick of the seeding shot
	// Viewpoints holds one sample per frame in [Start, End] where both
	// participants are present.
	Viewpoints []Viewpoint
}

// Stats summarizes one build.
type Stats struct {
	Shots, Seeds, SkippedCovered, NoLineOfSight int
}

// eyeZ is the eye height above the sampled origin (crouching or standing).
func eyeZ(p Pos) float64 {
	if p.Duck {
		return 46
	}
	return 64
}

func eye(p Pos) [3]float64 { return [3]float64{p.X, p.Y, p.Z + eyeZ(p)} }

// Bounding box (CS:GO/CS2 mapping, sources in S18): 32 units wide, centered on
// the world origin, standing 72 high and crouching 54. The top of the box is the
// eye height plus 8 (eye 64 standing, 46 crouching, owner's rule). Width does not
// follow the eye, which is offset laterally. Targets are the four corners at the
// top of the box and the four corners at mid height: 8 points per enemy.
const hullHalfWidth = 16.0

// Targets returns the enemy's bounding-box sample points. A line counts as clear
// when it reaches any of them.
func Targets(p Pos) [][3]float64 {
	top := eyeZ(p) + 8
	heights := []float64{top * 0.5, top}
	out := make([][3]float64, 0, 8)
	for _, hz := range heights {
		for _, dx := range []float64{-hullHalfWidth, hullHalfWidth} {
			for _, dy := range []float64{-hullHalfWidth, hullHalfWidth} {
				out = append(out, [3]float64{p.X + dx, p.Y + dy, p.Z + hz})
			}
		}
	}
	return out
}

// anyClear reports whether the shooter's eye reaches any of the enemy's sample
// points without being blocked.
func anyClear(from [3]float64, enemy Pos, occ Occluder) bool {
	for _, t := range Targets(enemy) {
		if !occ(from, t) {
			return true
		}
	}
	return false
}

// AnyClear is the exported form of anyClear for validation tools.
func AnyClear(from [3]float64, enemy Pos, occ Occluder) bool { return anyClear(from, enemy, occ) }

// EyeOf returns a participant's eye point (for validation tools).
func EyeOf(p Pos) [3]float64 { return eye(p) }

// frameAt returns the index of the frame at tick, or the nearest one, or -1.
func frameAt(frames []Frame, tick int) int {
	i := sort.Search(len(frames), func(k int) bool { return frames[k].Tick >= tick })
	if i < len(frames) && frames[i].Tick == tick {
		return i
	}
	if i > 0 && (i == len(frames) || tick-frames[i-1].Tick <= frames[i].Tick-tick) {
		return i - 1
	}
	if i < len(frames) {
		return i
	}
	return -1
}

// visibleEnemy returns the first enemy of the shooter visible at frame f, or
// ok=false when none is.
func visibleEnemy(f Frame, shooter uint64, occ Occluder) (enemy uint64, ok bool) {
	s, present := f.Players[shooter]
	if !present || s.Side == "" {
		return 0, false
	}
	se := eye(s)
	// Deterministic order: lowest steam id first.
	ids := make([]uint64, 0, len(f.Players))
	for id := range f.Players {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		p := f.Players[id]
		if id == shooter || p.Side == "" || p.Side == s.Side {
			continue
		}
		if anyClear(se, p, occ) {
			return id, true
		}
	}
	return 0, false
}

// pairVisibleAt reports whether the shooter and enemy are both present and
// the segment between them is clear at frame f.
func pairVisibleAt(f Frame, shooter, enemy uint64, occ Occluder) bool {
	s, ok1 := f.Players[shooter]
	e, ok2 := f.Players[enemy]
	if !ok1 || !ok2 || s.Side == "" || e.Side == "" || s.Side == e.Side {
		return false
	}
	return anyClear(eye(s), e, occ)
}

// Build returns the encounters for the shots, in shot order. frames must be
// sorted by Tick. maxHalf bounds how far a window may extend from its seed
// (ticks, each direction); 0 means no bound beyond the round.
func Build(frames []Frame, shots []Shot, rounds map[int]Range, occ Occluder, maxHalf int) ([]Encounter, Stats) {
	sort.Slice(shots, func(i, j int) bool { return shots[i].Tick < shots[j].Tick })
	var st Stats
	var out []Encounter
	byShooter := map[uint64][]Encounter{}
	covered := func(shooter uint64, tick int) bool {
		for _, e := range byShooter[shooter] {
			if tick >= e.Start && tick <= e.End {
				return true
			}
		}
		return false
	}
	for _, sh := range shots {
		st.Shots++
		if covered(sh.Shooter, sh.Tick) {
			st.SkippedCovered++
			continue
		}
		rng, ok := rounds[sh.Round]
		if !ok {
			continue
		}
		i := frameAt(frames, sh.Tick)
		if i < 0 {
			st.NoLineOfSight++
			continue
		}
		enemy, ok := visibleEnemy(frames[i], sh.Shooter, occ)
		if !ok {
			st.NoLineOfSight++
			continue
		}
		st.Seeds++
		lo := rng.Start
		hi := rng.End
		if maxHalf > 0 {
			if sh.Tick-maxHalf > lo {
				lo = sh.Tick - maxHalf
			}
			if sh.Tick+maxHalf < hi {
				hi = sh.Tick + maxHalf
			}
		}
		// Backward from the seed frame while the pair stays visible.
		first := i
		for k := i - 1; k >= 0 && frames[k].Tick >= lo; k-- {
			if !pairVisibleAt(frames[k], sh.Shooter, enemy, occ) {
				break
			}
			first = k
		}
		last := i
		for k := i + 1; k < len(frames) && frames[k].Tick <= hi; k++ {
			if !pairVisibleAt(frames[k], sh.Shooter, enemy, occ) {
				break
			}
			last = k
		}
		enc := Encounter{Round: sh.Round, Shooter: sh.Shooter, Enemy: enemy,
			Start: frames[first].Tick, End: frames[last].Tick, Seed: sh.Tick}
		for k := first; k <= last; k++ {
			// The sidecar can repeat a tick (two frames at one tick): keep one
			// viewpoint per tick.
			if n := len(enc.Viewpoints); n > 0 && enc.Viewpoints[n-1].Tick == frames[k].Tick {
				continue
			}
			s, ok1 := frames[k].Players[sh.Shooter]
			e, ok2 := frames[k].Players[enemy]
			if ok1 && ok2 {
				enc.Viewpoints = append(enc.Viewpoints, Viewpoint{
					Tick: frames[k].Tick, Shooter: eye(s), Enemy: eye(e),
					EnemyWorld: [3]float64{e.X, e.Y, e.Z},
				})
			}
		}
		out = append(out, enc)
		byShooter[sh.Shooter] = append(byShooter[sh.Shooter], enc)
	}
	return out, st
}
