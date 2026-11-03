package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetGenericEventsFilterEquivalence pins the optional-filter rewrite
// (G5): GetGenericEvents moved from the optional-placeholder filter (a
// bound empty-string parameter ORed with the real name) to the shared
// whereClause builder. Both spellings must return the IDENTICAL result set
// (row order included) — asserted here against the old query text, for the
// empty name (no filter) and for a real name.
func TestGetGenericEventsFilterEquivalence(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ge.dem", "sha-generic-events", time.Now())

	// The pre-rewrite query, verbatim.
	const oldIDiom = `SELECT name, tick, round, payload_json FROM generic_events
		WHERE match_id = ? AND (? = '' OR name = ?) ORDER BY rowid LIMIT ?`

	cases := []struct {
		name  string
		arg   string
		limit int
	}{
		{"empty name = all rows", "", 10},
		{"named filter", "player_death", 10},
		{"unknown name", "no_such_event", 10},
		{"limit clamps to one", "player_death", 1},
		{"limit <= 0 default", "", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.GetGenericEvents(id, tc.arg, tc.limit)
			if err != nil {
				t.Fatalf("GetGenericEvents: %v", err)
			}
			// The clamp is shared by both spellings (500 default / 5000 cap)
			// and runs BEFORE the query in each.
			lim := tc.limit
			if lim <= 0 {
				lim = 500
			}
			if lim > 5000 {
				lim = 5000
			}
			rows, err := s.db.Query(oldIDiom, id, tc.arg, tc.arg, lim)
			if err != nil {
				t.Fatalf("old idiom: %v", err)
			}
			defer rows.Close()
			type row struct {
				name    string
				tick    int
				round   int
				payload string
			}
			var want []row
			for rows.Next() {
				var r row
				if err := rows.Scan(&r.name, &r.tick, &r.round, &r.payload); err != nil {
					t.Fatalf("scan: %v", err)
				}
				want = append(want, r)
			}
			if err := rows.Err(); err != nil {
				t.Fatalf("rows: %v", err)
			}
			if len(got) != len(want) {
				t.Fatalf("rows = %d, want %d (old idiom)", len(got), len(want))
			}
			for i, w := range want {
				g := got[i]
				if g.Name != w.name || g.Tick != w.tick || g.Round != w.round || g.PayloadJSON != w.payload {
					t.Errorf("row %d = %+v, want %+v", i, g, w)
				}
				if g.MatchID != id {
					t.Errorf("row %d matchId = %d, want %d", i, g.MatchID, id)
				}
			}
		})
	}
}

// TestGetEventsFilterMatrix: queryEvents moved to the shared whereClause
// builder (it was already the append-the-AND idiom) — every optional
// filter must still AND in exactly as before, with the same result sets.
func TestGetEventsFilterMatrix(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ev.dem", "sha-event-filters", time.Now())

	base := func() models.EventFilter {
		return models.EventFilter{MatchID: id, Round: -1, Limit: 0}
	}
	// Fixture: kill(ak47, hs, dmg 100), damage(ak47, 30), kill(awp, hs),
	// bomb_planted, round_end — all round 1.
	cases := []struct {
		name string
		f    models.EventFilter
		want int
	}{
		{"all rounds", base(), 5},
		{"kind kill", func() models.EventFilter { f := base(); f.Kind = "kill"; return f }(), 2},
		{"weapon ak47", func() models.EventFilter { f := base(); f.Weapon = "ak47"; return f }(), 2},
		{"steam id attacker/victim", func() models.EventFilter { f := base(); f.SteamID = "100"; return f }(), 3},
		{"headshot only", func() models.EventFilter { f := base(); f.HeadshotOnly = true; return f }(), 2},
		{"dmg min 50", func() models.EventFilter { f := base(); f.DmgMin = 50; return f }(), 1},
		{"tick range", func() models.EventFilter { f := base(); f.TickFrom = 100; f.TickTo = 200; return f }(), 3},
		{"exact round 1", func() models.EventFilter { f := base(); f.Round = 1; return f }(), 5},
		{"exact round 0 (absent)", func() models.EventFilter { f := base(); f.Round = 0; return f }(), 0},
		{"limit 2", func() models.EventFilter { f := base(); f.Limit = 2; return f }(), 2},
		{"offset 3", func() models.EventFilter { f := base(); f.Offset = 3; return f }(), 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.GetEvents(tc.f)
			if err != nil {
				t.Fatalf("GetEvents: %v", err)
			}
			if len(got) != tc.want {
				t.Fatalf("rows = %d, want %d", len(got), tc.want)
			}
		})
	}
}
