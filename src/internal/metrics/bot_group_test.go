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
// a human and a bot, two kills (one per actor) and one ACTOR-LESS event
// (attacker "" — the shape a fall/world-damage row has): event rows keep
// bots and no-actors in storage; the metrics layer's subject condition
// is what excludes both from values.
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
			{Seq: 0, Tick: 100, Round: 1, Kind: models.EventKill, Attacker: aliceID, Victim: botSteamID, Weapon: "ak47"},
			{Seq: 1, Tick: 200, Round: 1, Kind: models.EventKill, Attacker: botSteamID, Victim: aliceID, Weapon: "ak47"},
			// No actor: the `subject <> ''` half of the condition.
			{Seq: 2, Tick: 300, Round: 1, Kind: "damage", Attacker: "", Victim: aliceID, Weapon: "", Dmg: 15},
		},
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return st
}

// TestSubjectStatementExcludesBots pins the metrics layer's slice of the
// humans-only rule under subject addressing: EVERY statement is
// subject-addressed, so `subject <> ”` + store.HumanOnlyBySteamID over
// the subject are UNCONDITIONAL. A player listing drops bot groups; a
// plain event aggregate counts only human-subject rows (the former
// "records what happened, bots included" boundary retired with the
// mixed-population special case — joined sets are pinned separately by
// TestJoinedPopulationAlignment); a match-scoped run takes the same
// path. botStore's actor-less event pins the other half: a row with no
// subject never becomes a value either.
func TestSubjectStatementExcludesBots(t *testing.T) {
	st := botStore(t)

	// The subject grouping IS the listing: the bot's group never appears.
	grouped, perr, err := RunPreview(st, Def{Expr: "from player_stats: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(grouped.Rows) != 1 || grouped.Rows[0].Group != aliceID {
		t.Fatalf("player_stats by subject = %+v, want only alice (the bot group is dropped)", grouped.Rows)
	}
	if grouped.Rows[0].Label != "alice" {
		t.Errorf("label = %q, want alice", grouped.Rows[0].Label)
	}
	if grouped.Rows[0].Value != 1 {
		t.Errorf("count = %v, want 1 (the human's player_stats row)", grouped.Rows[0].Value)
	}

	// Event rows: three stored (alice's kill, the bot's kill, the
	// actor-less damage) → exactly one value, alice's kill. Both halves
	// of the subject condition are load-bearing: humans-only drops the
	// bot, `subject <> ''` drops the actor-less row.
	plain, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("plain preview: %v %v", perr, err)
	}
	if len(plain.Rows) != 1 || plain.Rows[0].Group != aliceID || plain.Rows[0].Value != 1 {
		t.Errorf("events by subject = %+v, want only alice at 1 (bot and no-actor rows dropped)", plain.Rows)
	}

	// Same rule on the other subject-keyed source (thrower/attacker are
	// the events/utility_events subjects; the condition is per subject,
	// not per source population).
	scoped, perr, err := RunPreview(st, Def{Expr: "from player_stats: count()"}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped preview: %v %v", perr, err)
	}
	if len(scoped.Rows) != 1 || scoped.Rows[0].Group != aliceID {
		t.Errorf("scoped player_stats by subject = %+v, want only alice", scoped.Rows)
	}

	scopedEvents, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "match:1", 100)
	if perr != nil || err != nil {
		t.Fatalf("scoped events preview: %v %v", perr, err)
	}
	if len(scopedEvents.Rows) != 1 || scopedEvents.Rows[0].Value != 1 {
		t.Errorf("scoped events by subject = %+v, want only alice at 1", scopedEvents.Rows)
	}
}
