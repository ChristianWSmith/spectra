package extract

import (
	"encoding/json"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

// nearTeammateDist is the trade-opportunity proximity measure: the closest
// living teammate of the victim to the KILLER at the death tick. These
// pins cover the two cases the gate depends on — a teammate near enough to
// trade, and nobody measurable — plus the zero-vector "no position"
// conventions on both sides.
func TestNearTeammateDist(t *testing.T) {
	killer := r3.Vector{X: 100, Y: 200, Z: 0}
	near := r3.Vector{X: 100, Y: 350, Z: 0} // 150u away
	far := r3.Vector{X: 100, Y: 900, Z: 0}  // 700u away
	noPos := r3.Vector{}                    // zero vector = unknown position

	// Nearby teammate → the distance (rounded to one decimal).
	if d := nearTeammateDist(killer, []r3.Vector{far, near}); d != 150 {
		t.Errorf("nearTeammateDist(near+far) = %v, want 150 (min over mates)", d)
	}
	// No teammate at all → -1: never counted as a trade opportunity.
	if d := nearTeammateDist(killer, nil); d != -1 {
		t.Errorf("nearTeammateDist(no mates) = %v, want the -1 sentinel", d)
	}
	// Every teammate without position data → -1 (no position → no claim).
	if d := nearTeammateDist(killer, []r3.Vector{noPos, noPos}); d != -1 {
		t.Errorf("nearTeammateDist(mates without positions) = %v, want the -1 sentinel", d)
	}
	// Killer position unknown → -1 even with teammates present.
	if d := nearTeammateDist(noPos, []r3.Vector{near}); d != -1 {
		t.Errorf("nearTeammateDist(unknown killer pos) = %v, want the -1 sentinel", d)
	}
	// A zero-vector mate must not be measured (bogus map-center stamp).
	if d := nearTeammateDist(killer, []r3.Vector{noPos}); d != -1 {
		t.Errorf("nearTeammateDist(zero mate skipped) = %v, want the -1 sentinel", d)
	}
	// Rounding: 3-4-5 triangle → 5.
	if d := nearTeammateDist(r3.Vector{}, []r3.Vector{}); d != -1 {
		t.Errorf("nearTeammateDist(zero killer) = %v, want -1", d)
	}
	if d := nearTeammateDist(r3.Vector{X: 3}, []r3.Vector{{Y: 4}}); d != 5 {
		t.Errorf("nearTeammateDist(3-4-5) = %v, want 5", d)
	}
}

// livingTeammatePos guards: no game state, no victim, or a victim with no
// known team yields nothing (never a guessed proximity).
func TestLivingTeammatePosGuards(t *testing.T) {
	victim := &common.Player{Team: common.TeamCounterTerrorists}
	if got := livingTeammatePos(nil, nil, victim); got != nil {
		t.Errorf("livingTeammatePos(nil gs) = %v, want nil", got)
	}
	if got := livingTeammatePos(nil, nil, nil); got != nil {
		t.Errorf("livingTeammatePos(nil victim) = %v, want nil", got)
	}
	spectator := &common.Player{Team: common.TeamSpectators}
	if got := livingTeammatePos(nil, nil, spectator); got != nil {
		t.Errorf("livingTeammatePos(spectator victim) = %v, want nil (no team → no teammates)", got)
	}
	unassigned := &common.Player{Team: common.TeamUnassigned}
	if got := livingTeammatePos(nil, nil, unassigned); got != nil {
		t.Errorf("livingTeammatePos(unassigned victim) = %v, want nil", got)
	}
}

// killDetailNearDist pulls the nearDist the kill handler stored in
// detail_json — the payload store.GetCombatStats gates on.
func killDetailNearDist(t *testing.T, a *agg) float64 {
	t.Helper()
	var kill *models.Event
	for i := range a.events {
		if a.events[i].Kind == models.EventKill {
			kill = &a.events[i]
		}
	}
	if kill == nil {
		t.Fatal("kill event missing")
	}
	var det struct {
		NearDist *float64 `json:"nearDist"`
	}
	if err := json.Unmarshal([]byte(kill.DetailJSON), &det); err != nil {
		t.Fatalf("kill detail JSON %q: %v", kill.DetailJSON, err)
	}
	if det.NearDist == nil {
		t.Fatalf("kill detail JSON has no nearDist: %s", kill.DetailJSON)
	}
	return *det.NearDist
}

// The kill handler's proximity plumbing: a teammate near the killer lands
// in detail_json.nearDist, nobody measurable stores the -1 sentinel, and
// an unknown killer position stores -1 too.
func TestKillStoresNearDist(t *testing.T) {
	px, py, pz := pos3(100, 200, 0)

	// Death with a nearby teammate (150u) → 150.
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 100, tickRate: 64, real: true,
		killerKey: 3, killerName: "killer", killerSide: "t",
		victimKey: 2, victimName: "victim", victimSide: "ct",
		weapon:       "AK-47",
		attackerPosX: px, attackerPosY: py, attackerPosZ: pz,
		matePos: []r3.Vector{{X: 100, Y: 350, Z: 0}},
	})
	if d := killDetailNearDist(t, a); d != 150 {
		t.Errorf("nearDist (nearby teammate) = %v, want 150", d)
	}

	// Death with no living teammate → -1 (never counted downstream).
	a = newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 100, tickRate: 64, real: true,
		killerKey: 3, killerName: "killer", killerSide: "t",
		victimKey: 2, victimName: "victim", victimSide: "ct",
		weapon:       "AK-47",
		attackerPosX: px, attackerPosY: py, attackerPosZ: pz,
	})
	if d := killDetailNearDist(t, a); d != -1 {
		t.Errorf("nearDist (no teammate) = %v, want the -1 sentinel", d)
	}

	// Killer position unknown → -1 even with a teammate in range.
	a = newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 100, tickRate: 64, real: true,
		killerKey: 3, killerName: "killer", killerSide: "t",
		victimKey: 2, victimName: "victim", victimSide: "ct",
		weapon:  "AK-47",
		matePos: []r3.Vector{{X: 100, Y: 350, Z: 0}},
	})
	if d := killDetailNearDist(t, a); d != -1 {
		t.Errorf("nearDist (unknown killer pos) = %v, want the -1 sentinel", d)
	}
}
