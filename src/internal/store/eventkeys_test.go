package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetEventKeysMatchesGetEvents pins the ONE-matcher contract behind
// the replay's scrubber-marker answer: for every shape of filter the
// landmark feed can build, store.GetEventKeys returns exactly the
// (id, tick, kind) of the rows store.GetEvents returns — same order
// (seq), same clause set (both share eventWhere), no paging of its own.
// The two reads are what the LIST and the SCRUBBER MARKERS each ask, so
// a disagreement between them is the on-screen "markers on an empty
// list" bug this read exists to kill: the marker set can only ever be
// the list's answer, never a re-implementation of it.
func TestGetEventKeysMatchesGetEvents(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/keys.dem", "sha-event-keys", time.Now())

	// A fixture that gives EVERY clause something to bite on: two rounds
	// (the side samples swap across the switch), positioned endpoints on
	// both sides, weapons/distances/headshots for the advanced keys and
	// playerless rows the side/team scopes must never empty.
	em := testExtracted("sha-event-keys", time.Now())
	em.Match.SideSwitches = 1
	em.RoundSides = append(em.RoundSides,
		models.RoundPlayerSide{Round: 2, SteamID: "100", Side: "t"},
		models.RoundPlayerSide{Round: 2, SteamID: "200", Side: "ct"},
	)
	em.Events = []models.Event{
		// 0 — kill: victim OUTSIDE the rect below, attacker INSIDE (the
		// either-endpoint bbox — the kills heatmap rasterizes the killer).
		{Seq: 0, Tick: 60, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			Weapon: "ak47", Headshot: true, Distance: 10,
			PosX: pf(5), PosY: pf(5), PosZ: pf(0),
			AttackerPosX: pf(50), AttackerPosY: pf(50)},
		// 1 — damage: victim position only, no attacker position.
		{Seq: 1, Tick: 70, Round: 1, Kind: models.EventDamage, Attacker: "200", Victim: "100",
			Weapon: "awp", Distance: 50, PosX: pf(120), PosY: pf(120)},
		// 2 — kill: victim OUTSIDE, attacker INSIDE (the same rect).
		{Seq: 2, Tick: 80, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			Weapon: "awp", Distance: 30,
			PosX: pf(900), PosY: pf(900),
			AttackerPosX: pf(45), AttackerPosY: pf(45)},
		// 3 — grenade throw: the side/team thrower endpoint, no position
		// on the victim side at all.
		{Seq: 3, Tick: 90, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "100",
			Weapon: "Smoke Grenade", PosX: pf(-80), PosY: pf(-80)},
		// 4/5 — playerless rows: a side/team scope must never empty them
		// (the endpoint clauses leave uncovered kinds unconstrained).
		{Seq: 4, Tick: 100, Round: 1, Kind: models.EventRoundEnd},
		{Seq: 5, Tick: 110, Round: 1, Kind: models.EventRoundStart},
		// 6 — a round-2 kill (the side samples differ there: 100=t).
		{Seq: 6, Tick: 250, Round: 2, Kind: models.EventKill, Attacker: "100", Victim: "200",
			Weapon: "ak47", Headshot: false, Distance: 8,
			PosX: pf(70), PosY: pf(70), AttackerPosX: pf(15), AttackerPosY: pf(15)},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	parity := func(name string, f models.EventFilter) {
		t.Helper()
		f.MatchID = id
		keys, err := s.GetEventKeys(f)
		if err != nil {
			t.Fatalf("GetEventKeys(%s): %v", name, err)
		}
		rows, err := s.GetEvents(f)
		if err != nil {
			t.Fatalf("GetEvents(%s): %v", name, err)
		}
		if len(keys) != len(rows) {
			t.Fatalf("%s: keys=%d rows=%d — the marker answer must be the list's answer", name, len(keys), len(rows))
		}
		for i := range rows {
			if keys[i].ID != rows[i].ID || keys[i].Tick != rows[i].Tick || keys[i].Kind != rows[i].Kind {
				t.Fatalf("%s: key[%d] = {id:%d tick:%d kind:%q}, want {id:%d tick:%d kind:%q}",
					name, i, keys[i].ID, keys[i].Tick, keys[i].Kind,
					rows[i].ID, rows[i].Tick, rows[i].Kind)
			}
		}
	}

	// The clause matrix — every EventFilter key the FEED can send (the
	// Replay fetch's exact field set), alone and composed.
	parity("unfiltered", models.EventFilter{})

	// Sanity first: parity on a filter that matches EVERYTHING would be
	// vacuous, so the core keys must actually bite on this fixture.
	fullRows, err := s.GetEvents(models.EventFilter{MatchID: id})
	if err != nil {
		t.Fatalf("GetEvents(all): %v", err)
	}
	for _, f := range []models.EventFilter{
		{Kinds: []string{models.EventKill}},
		{SteamID: "100"},
		{Weapon: "ak47"},
		{HeadshotOnly: true},
		{RoundFrom: 2},
		{BBox: &models.BBox{MinX: 40, MaxX: 60, MinY: 40, MaxY: 60}},
	} {
		f.MatchID = id
		rows, err := s.GetEvents(f)
		if err != nil {
			t.Fatalf("GetEvents(bite %+v): %v", f, err)
		}
		if len(rows) == 0 || len(rows) == len(fullRows) {
			t.Fatalf("filter %+v matched %d of %d rows — the fixture must make every clause bite",
				f, len(rows), len(fullRows))
		}
	}

	parity("kinds IN", models.EventFilter{Kinds: []string{models.EventKill, models.EventDamage}})
	parity("kinds round rows", models.EventFilter{Kinds: []string{models.EventRoundStart, models.EventRoundEnd}})
	parity("single kind", models.EventFilter{Kind: models.EventDamage})
	parity("player either endpoint", models.EventFilter{SteamID: "100"})
	parity("player as killer", models.EventFilter{SteamID: "100", KillRole: "attacker"})
	parity("player as victim", models.EventFilter{SteamID: "100", KillRole: "victim"})
	parity("side ct", models.EventFilter{Side: "ct"})
	parity("side t", models.EventFilter{Side: "t"})
	parity("side t kills/attacker", models.EventFilter{Side: "t", KillRole: "attacker"})
	parity("team t", models.EventFilter{Team: "t"})
	parity("team ct kills/attacker", models.EventFilter{Team: "ct", KillRole: "attacker"})
	parity("weapon", models.EventFilter{Weapon: "ak47"})
	parity("distance min", models.EventFilter{DistanceMin: 20})
	parity("distance max", models.EventFilter{DistanceMax: 40})
	parity("distance window", models.EventFilter{DistanceMin: 5, DistanceMax: 35})
	parity("headshot only", models.EventFilter{HeadshotOnly: true})
	parity("bbox (either endpoint)", models.EventFilter{BBox: &models.BBox{MinX: 40, MaxX: 60, MinY: 40, MaxY: 60}})
	parity("bbox far away (empty)", models.EventFilter{BBox: &models.BBox{MinX: 500, MaxX: 600, MinY: 500, MaxY: 600}})
	parity("round lower bound", models.EventFilter{RoundFrom: 2})
	parity("round window", models.EventFilter{RoundFrom: 1, RoundTo: 1})
	parity("compose kinds+player+role+side+weapon+hs",
		models.EventFilter{Kinds: []string{models.EventKill}, SteamID: "100", KillRole: "attacker",
			Side: "t", Weapon: "ak47", HeadshotOnly: true})
	parity("compose round+kinds+player",
		models.EventFilter{RoundFrom: 1, Kinds: []string{models.EventKill}, SteamID: "200"})

	// The bbox semantics the marker answer inherits (the either-endpoint
	// rule store pins for the list): rows 0 and 2 both match the rect —
	// one through the victim side, one through the attacker side.
	rect := models.EventFilter{MatchID: id, BBox: &models.BBox{MinX: 40, MaxX: 60, MinY: 40, MaxY: 60}}
	keys, err := s.GetEventKeys(rect)
	if err != nil {
		t.Fatalf("GetEventKeys(rect): %v", err)
	}
	got := make([]int64, len(keys))
	for i, k := range keys {
		got[i] = k.ID
	}
	if len(got) != 2 || got[0] == got[1] {
		t.Fatalf("bbox keys = %v, want the two endpoint-hits (rows 0 and 2)", got)
	}

	// NO PAGING: a Limit/Offset the ROW read honors must not truncate the
	// marker answer — the whole matching set comes back, in seq order.
	all, err := s.GetEventKeys(models.EventFilter{MatchID: id})
	if err != nil {
		t.Fatalf("GetEventKeys(all): %v", err)
	}
	paged, err := s.GetEventKeys(models.EventFilter{MatchID: id, Limit: 1, Offset: 2})
	if err != nil {
		t.Fatalf("GetEventKeys(paged): %v", err)
	}
	if len(all) != len(em.Events) {
		t.Fatalf("keys(all) = %d, want %d", len(all), len(em.Events))
	}
	if len(paged) != len(all) {
		t.Fatalf("Limit/Offset truncated the key answer: %d keys, want %d (no paging)", len(paged), len(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].ID >= all[i].ID {
			t.Fatalf("keys are not in seq order at %d: %+v then %+v", i, all[i-1], all[i])
		}
	}

	// An unknown match is an EMPTY answer, never an error (the marker set
	// of a match with no rows is simply empty).
	empty, err := s.GetEventKeys(models.EventFilter{MatchID: 999999})
	if err != nil {
		t.Fatalf("GetEventKeys(unknown match): %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("keys(unknown match) = %v, want empty", empty)
	}
}
