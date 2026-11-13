package metrics

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// botSteamID is the synthetic 0xFF-prefixed identity extract gives bots
// (extract.isBotKey) — the same spelling the store tests use.
const (
	botSteamID = "18374686479671623692"
	aliceID    = "76561198000000001" // real SteamID64 shape (labels resolve)
)

// botStore opens a file-backed store with ONE match whose roster carries
// a human and a bot, plus one kill per actor (event rows keep bots; only
// the player LISTING excludes them).
func botStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "bots.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id, err := st.CreateMatchRow("/d/bots.dem", "sha-metric-bots", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/bots.dem", SHA256: "sha-metric-bots", Map: "de_dust2",
			TickRate: 64, ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: aliceID, Name: "alice", Side: "ct"},
			{SteamID: botSteamID, Name: "Crew", Side: "ct", IsBot: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: aliceID, Name: "alice", Side: "ct", RoundsPlayed: 1},
			{SteamID: botSteamID, Name: "Crew", Side: "ct", RoundsPlayed: 1},
		},
		Events: []models.Event{
			{Tick: 100, Round: 1, Kind: models.EventKill, Attacker: aliceID, Victim: botSteamID, Weapon: "ak47"},
			{Tick: 200, Round: 1, Kind: models.EventKill, Attacker: botSteamID, Victim: aliceID, Weapon: "ak47"},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return st
}

// TestPlayerGroupExcludesBots pins the metrics layer's slice of the
// humans-only rule: a `player`-grouped metric is a player LISTING, so
// bot groups are dropped through store.HumanOnlyBySteamID (the same
// condition the roster reads use). Two boundaries are pinned with it:
// an UNGROUPED aggregate still counts bot rows (it records what
// happened — the event-shaped exception), and a non-player grouping is
// untouched. Widening the filter past the player dimension is now
// sanctioned for MULTI-source expressions whose source set mixes
// populations — pinned separately by TestJoinedPopulationAlignment
// (join_test.go); these single-source boundaries stay as they are.
func TestPlayerGroupExcludesBots(t *testing.T) {
	st := botStore(t)

	grouped, perr, err := RunPreview(st, Def{
		Expr: "from player_stats: count()", GroupBy: "player",
	}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(grouped.Rows) != 1 || grouped.Rows[0].Group != aliceID {
		t.Fatalf("player_stats by player = %+v, want only alice (the bot group is dropped)", grouped.Rows)
	}
	if grouped.Rows[0].Label != "alice" {
		t.Errorf("label = %q, want alice", grouped.Rows[0].Label)
	}

	// Same rule on the other steam-id-keyed player dimensions.
	for _, expr := range []string{"from events: count()"} {
		pv, perr, err := RunPreview(st, Def{Expr: expr, GroupBy: "player"}, "", 100)
		if perr != nil || err != nil {
			t.Fatalf("preview %q: %v %v", expr, perr, err)
		}
		if len(pv.Rows) != 1 || pv.Rows[0].Group != aliceID {
			t.Errorf("%s by player = %+v, want only alice", expr, pv.Rows)
		}
	}

	// SCOPED: an ungrouped aggregate counts every row — bot kills are
	// still "things that happened" (the event-shaped exception).
	plain, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("plain preview: %v %v", perr, err)
	}
	if len(plain.Rows) != 1 || plain.Rows[0].Value != 2 {
		t.Errorf("ungrouped events count = %+v, want 2 (bots included — scope boundary)", plain.Rows)
	}

	// A scoped preview takes the same path (match_id binds into the
	// statement, the humans-only condition rides the same WHERE).
	scoped, perr, err := RunPreview(st, Def{
		Expr: "from player_stats: count()", GroupBy: "player",
	}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped preview: %v %v", perr, err)
	}
	if len(scoped.Rows) != 1 || scoped.Rows[0].Group != aliceID {
		t.Errorf("scoped player_stats by player = %+v, want only alice", scoped.Rows)
	}
}
