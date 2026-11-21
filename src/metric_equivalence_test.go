package main

import (
	"database/sql"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// W3 — THE "stored == computed" oracle (design §7's metric_equivalence_
// test, the eco_equivalence_test.go pattern): for a set of expressions,
// the rows the compute pass WRITES into metric_values must equal the
// rows a query-time evaluation (RunPreview) produces over the same
// data — match batch vs per-`match:<id>` runs, profile vs the "" run,
// denominators at both scopes, percentiles, a joined source, bots
// absent, no '' subjects, and a ref-composed value against an
// independent SQL hand-composition. If the pass's batched address mode
// or its row adapter ever drifts from the preview engine, this fails.

// The fixture roster for the synthetic bot/actor-less match.
const (
	eqHumanSID = "76561198000000011"
	eqBotSID   = "76561198000000099"
)

// newSeededFixture is the equivalence corpus: the committed synthetic
// library (metrics.LoadSeed — 3 ready matches × 8 players, hand-
// computable aggregates) PLUS a fourth ready match carrying a bot with
// its own events and an actor-less event, so the humans-only subject
// rule and `subject <> ”` are pinned against real rows — preview and
// stored must exclude them IDENTICALLY.
func newSeededFixture(t *testing.T) *depsFixture {
	t.Helper()
	f := newDepsFixture(t)
	db, err := sql.Open("sqlite", f.path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open seed conn: %v", err)
	}
	if err := metrics.LoadSeed(db); err != nil {
		_ = db.Close()
		t.Fatalf("LoadSeed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close seed conn: %v", err)
	}
	seedEquivalenceBotMatch(t, f.st)
	return f
}

// seedEquivalenceBotMatch stores a fourth ready match: one human with
// three damage events, one bot with two authored events, and one
// actor-less event (no attacker at all).
func seedEquivalenceBotMatch(t *testing.T, st *store.Store) {
	t.Helper()
	id, err := st.CreateMatchRow("/seed/botmatch.dem", "sha-equiv-bot", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/seed/botmatch.dem", SHA256: "sha-equiv-bot",
			Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct"},
			{SteamID: eqBotSID, Name: "BOT Neil", IsBot: true, Side: "t"},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct", RoundsPlayed: 1},
			{SteamID: eqBotSID, Name: "BOT Neil", Side: "t", RoundsPlayed: 1},
		},
	}
	for i := 0; i < 3; i++ {
		em.Events = append(em.Events, models.Event{
			Seq: i, Tick: 100 + i*10, Round: 1, Kind: "damage",
			Attacker: eqHumanSID, Victim: eqBotSID, Weapon: "ak47", Dmg: 10 * (i + 1),
		})
	}
	// Bot-authored events (subject rule must drop them everywhere) and
	// an actor-less event (`subject <> ''` must drop it — no '' subject
	// may ever become a stored value).
	em.Events = append(em.Events,
		models.Event{Seq: 3, Tick: 140, Round: 1, Kind: "damage", Attacker: eqBotSID, Victim: eqHumanSID, Weapon: "glock", Dmg: 5},
		models.Event{Seq: 4, Tick: 150, Round: 1, Kind: "kill", Attacker: eqBotSID, Victim: eqHumanSID, Weapon: "glock"},
		models.Event{Seq: 5, Tick: 160, Round: 1, Kind: "damage", Victim: eqHumanSID, Weapon: "world", Dmg: 1},
	)
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
}

// readyMatchIDs lists the library's ready matches — the match-scope
// units the preview oracle iterates.
func readyMatchIDs(t *testing.T, st *store.Store) []int64 {
	t.Helper()
	res, err := st.RunReadOnly(`SELECT id FROM matches WHERE status = 'ready' ORDER BY id`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("ready matches: %v", err)
	}
	var ids []int64
	for _, r := range res.Rows {
		ids = append(ids, r[0].(int64))
	}
	if len(ids) == 0 {
		t.Fatal("fixture has no ready matches")
	}
	return ids
}
