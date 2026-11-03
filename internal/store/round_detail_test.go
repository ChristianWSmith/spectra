package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetRoundDetailNegativeRounds pins the sentinel contract split:
//
//   - GetEvents/GetChat keep "Round < 0 = every round of the match" (the
//     timeline, Context view and the analytics pass rely on it);
//   - GetRoundDetail matches its round EXACTLY, because extract.agg.renumber
//     gives knife/warmup rounds NEGATIVE numbers (-2 knife, -1 warmup) that
//     are real rounds with their own events and chat.
//
// Before the fix, detail for round -1 forwarded the negative number into
// GetEvents/GetChat, whose `round >= 0` guard silently dropped the clause —
// a knife-round drill-down returned EVERY event and chat line of the match.
func TestGetRoundDetailNegativeRounds(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/neg.dem", "sha-neg", time.Now())
	em := testExtracted("sha-neg", time.Now())
	em.Rounds = []models.Round{
		{Number: -2, Pregame: true, StartTick: 10, EndTick: 20}, // knife
		{Number: -1, Warmup: true, StartTick: 30, EndTick: 40},  // warmup
		{Number: 1, Winner: "ct", StartTick: 50, EndTick: 100},  // first real round
	}
	em.Events = []models.Event{
		{Seq: 0, Tick: 15, Round: -2, Kind: models.EventKill, Attacker: "100", Victim: "200"},
		{Seq: 1, Tick: 35, Round: -1, Kind: models.EventKill, Attacker: "200", Victim: "100"},
		{Seq: 2, Tick: 60, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
	}
	em.Chat = []models.Chat{
		{Tick: 16, Round: -2, SteamID: "100", Name: "alice", Text: "knife", Kind: "chat"},
		{Tick: 36, Round: -1, SteamID: "200", Name: "bob", Text: "warmup", Kind: "chat"},
		{Tick: 61, Round: 1, SteamID: "100", Name: "alice", Text: "glhf", Kind: "chat"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	for _, tc := range []struct {
		round    int
		wantTick int
		wantText string
	}{
		{-2, 15, "knife"},
		{-1, 35, "warmup"},
		{1, 60, "glhf"},
	} {
		det, err := s.GetRoundDetail(id, tc.round)
		if err != nil {
			t.Fatalf("GetRoundDetail(%d): %v", tc.round, err)
		}
		if len(det.Events) != 1 || det.Events[0].Tick != tc.wantTick {
			t.Errorf("GetRoundDetail(%d).Events = %+v, want exactly the round's 1 event (tick %d)",
				tc.round, det.Events, tc.wantTick)
		}
		if len(det.Chat) != 1 || det.Chat[0].Text != tc.wantText {
			t.Errorf("GetRoundDetail(%d).Chat = %+v, want exactly the round's 1 line (%q)",
				tc.round, det.Chat, tc.wantText)
		}
	}

	// The public sentinel still means "all rounds".
	all, err := s.GetEvents(models.EventFilter{MatchID: id, Round: -1})
	if err != nil {
		t.Fatalf("GetEvents(-1): %v", err)
	}
	if len(all) != 3 {
		t.Errorf("GetEvents(Round: -1) = %d rows, want 3 (all rounds)", len(all))
	}
	chat, err := s.GetChat(id, -1)
	if err != nil {
		t.Fatalf("GetChat(-1): %v", err)
	}
	if len(chat) != 3 {
		t.Errorf("GetChat(-1) = %d rows, want 3 (all rounds)", len(chat))
	}
	// A round with no rows of its own yields empty, never the whole match.
	empty, err := s.GetRoundDetail(id, -1)
	if err != nil {
		t.Fatalf("GetRoundDetail(-1): %v", err)
	}
	if len(empty.Events) != 1 || len(empty.Chat) != 1 {
		t.Errorf("warmup detail = %d events / %d chat, want 1/1", len(empty.Events), len(empty.Chat))
	}
}
