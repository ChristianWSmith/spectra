package extract

import (
	"encoding/json"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestPlantDefuseLifecycleKinds pins the plant/defuse ATTEMPT rows
// (models.EventBombPlantBegin … EventBombDefuseAbort): the four kinds,
// their actor/site/detail stamps, the raw-pairing source rule (the two
// begins pair with bomb_beginplant / bomb_begindefuse — the raw events
// exist for every attempt; the *_abort cancels have NO raw counterpart
// in CS2, so their source is ""), and that NO scoreboard stat moves for
// them (only bomb_plant / bomb_defuse count plants/defuses — the golden
// fixture pins those).
func TestPlantDefuseLifecycleKinds(t *testing.T) {
	a := newAgg()

	// begin/start pair with their raw game event in the same frame; the
	// aborts carry no source at all.
	a.bombPlantBegin(100, "A", 76561198000000001, "planter")
	a.genericEvent("bomb_beginplant", 100, `{"userid":4,"site":1}`)
	a.bombPlantAborted(120, 76561198000000001, "planter")
	a.bombDefuseStart(200, "B", 76561198000000002, "defuser", true)
	a.genericEvent("bomb_begindefuse", 200, `{"userid":5,"site":2}`)
	a.bombDefuseAborted(210, 76561198000000002, "defuser")
	a.flushRaw()

	want := []struct {
		kind     string
		tick     int
		attacker string
		site     string
		raw      string
	}{
		{models.EventBombPlantBegin, 100, "76561198000000001", "A", `{"userid":4,"site":1}`},
		{models.EventBombPlantAbort, 120, "76561198000000001", "", ""},
		{models.EventBombDefuseStart, 200, "76561198000000002", "B", `{"userid":5,"site":2}`},
		{models.EventBombDefuseAbort, 210, "76561198000000002", "", ""},
	}
	if len(a.events) != len(want) {
		t.Fatalf("events = %d, want %d", len(a.events), len(want))
	}
	for i, w := range want {
		ev := a.events[i]
		if ev.Kind != w.kind {
			t.Errorf("event %d kind = %q, want %q", i, ev.Kind, w.kind)
		}
		if ev.Tick != w.tick {
			t.Errorf("event %d (%s) tick = %d, want %d", i, w.kind, ev.Tick, w.tick)
		}
		if ev.Attacker != w.attacker {
			t.Errorf("event %d (%s) attacker = %q, want %q", i, w.kind, ev.Attacker, w.attacker)
		}
		if ev.Site != w.site {
			t.Errorf("event %d (%s) site = %q, want %q", i, w.kind, ev.Site, w.site)
		}
		if ev.RawJSON != w.raw {
			t.Errorf("event %d (%s) raw = %q, want %q", i, w.kind, ev.RawJSON, w.raw)
		}
		// Rows before the first RoundStart land in round 1 (evRound).
		if ev.Round != 1 {
			t.Errorf("event %d (%s) round = %d, want 1", i, w.kind, ev.Round)
		}
	}

	// DetailJSON: the actor's name on all four, the kit flag on the
	// defuse START (the completion row records the same fact).
	for i, w := range want {
		var detail map[string]any
		if err := json.Unmarshal([]byte(a.events[i].DetailJSON), &detail); err != nil {
			t.Fatalf("event %d (%s) DetailJSON: %v", i, w.kind, err)
		}
		wantName := "planter"
		if w.kind == models.EventBombDefuseStart || w.kind == models.EventBombDefuseAbort {
			wantName = "defuser"
		}
		if detail["player"] != wantName {
			t.Errorf("event %d (%s) player = %v, want %q", i, w.kind, detail["player"], wantName)
		}
	}
	var start map[string]any
	if err := json.Unmarshal([]byte(a.events[2].DetailJSON), &start); err != nil {
		t.Fatalf("defuse start DetailJSON: %v", err)
	}
	if start["hasKit"] != true {
		t.Errorf("defuse start hasKit = %v, want true", start["hasKit"])
	}

	// No scoreboard side effect: the attempt rows create no player
	// accumulator and move no plant/defuse counter.
	if len(a.players) != 0 {
		t.Errorf("players = %d after attempt rows, want 0 (only bomb_plant/bomb_defuse count)", len(a.players))
	}
}
