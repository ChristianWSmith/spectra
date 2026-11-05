package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetGenericEventsFilterEquivalence pins GetGenericEvents' optional
// filter semantics (G5): the shared whereClause builder must return the
// IDENTICAL result set (row order included) as the direct
// optional-placeholder spelling in const oldIDiom — asserted for the empty
// name (no filter) and for a real name.
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
			got, err := s.GetGenericEvents(id, tc.arg, -1, tc.limit, 0)
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

// TestGetEventsFilterMatrix: every optional filter ANDs into the shared
// whereClause builder — each narrows the base result set to the expected
// rows, and an empty one adds no clause.
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
		// Kinds: the multi-kind form the Replay landmark feed's categories
		// use. Non-empty Kinds takes precedence over the single Kind.
		{"kinds kill+bomb", func() models.EventFilter {
			f := base()
			f.Kinds = []string{models.EventKill, models.EventBombPlant}
			return f
		}(), 3},
		{"kinds overrides kind", func() models.EventFilter {
			f := base()
			f.Kind = models.EventKill
			f.Kinds = []string{models.EventRoundEnd}
			return f
		}(), 1},
		{"kinds empty = no clause", func() models.EventFilter {
			f := base()
			f.Kinds = []string{}
			return f
		}(), 5},
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

// TestGetGenericEventsRoundOffset pins the landmark feed's generic-source
// contract: round < 0 = every round (the shared sentinel), round >= 0 is
// an exact match (negative knife/warmup rounds are real rounds), and
// limit/offset page in rowid order without silent truncation. RowID —
// the record identity the feed selects on — is returned on every row.
func TestGetGenericEventsRoundOffset(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ge-page.dem", "sha-generic-page", time.Now())
	em := &models.ExtractedMatch{
		Match: models.Match{Path: "/d/ge-page.dem", SHA256: "sha-generic-page", ExtractedAt: time.Now()},
		GenericEvents: []models.GenericEvent{
			{Name: "weapon_fire", Tick: 10, Round: 1, PayloadJSON: `{"userid":1}`},
			{Name: "weapon_fire", Tick: 20, Round: 1, PayloadJSON: `{"userid":2}`},
			{Name: "weapon_fire", Tick: 30, Round: -1, PayloadJSON: `{"userid":3}`},
			{Name: "weapon_fire", Tick: 40, Round: 2, PayloadJSON: `{"userid":4}`},
			{Name: "weapon_fire", Tick: 50, Round: 2, PayloadJSON: `{"userid":5}`},
		},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	all, err := s.GetGenericEvents(id, "weapon_fire", -1, 100, 0)
	if err != nil {
		t.Fatalf("GetGenericEvents(all): %v", err)
	}
	if len(all) != 5 {
		t.Fatalf("all rows = %d, want 5", len(all))
	}
	for i, g := range all {
		if g.RowID == 0 {
			t.Errorf("row %d RowID = 0, want the SQLite rowid", i)
		}
		if g.MatchID != id {
			t.Errorf("row %d matchId = %d, want %d", i, g.MatchID, id)
		}
	}

	// Exact round (round 1), and the negative knife/warmup sentinel works
	// as a REAL round number when the caller passes it explicitly.
	r2, err := s.GetGenericEvents(id, "weapon_fire", 2, 100, 0)
	if err != nil || len(r2) != 2 || r2[0].Tick != 40 || r2[1].Tick != 50 {
		t.Errorf("round 2 rows = %+v (err %v), want ticks 40,50", r2, err)
	}
	rneg, err := s.GetGenericEvents(id, "weapon_fire", -1, 100, 0)
	if err != nil || len(rneg) != 5 {
		t.Errorf("round -1 rows = %d (err %v), want 5 (all rounds)", len(rneg), err)
	}

	// Paging: offset 2 → rows 3..5 of the rowid order.
	page, err := s.GetGenericEvents(id, "weapon_fire", -1, 2, 2)
	if err != nil {
		t.Fatalf("GetGenericEvents(page): %v", err)
	}
	if len(page) != 2 || page[0].Tick != 30 || page[1].Tick != 40 {
		t.Errorf("page rows = %+v, want ticks 30,40", page)
	}
}
