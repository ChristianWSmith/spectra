package store

import (
	"errors"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestGetRoundDetailExactRound pins the sentinel contract split:
//
//   - GetEvents takes an INCLUSIVE, PARTIAL round range (0 = open on
//     that side); both bounds open means every round of the match, which
//     is what the timeline, Context view and the analytics pass read.
//     The old "Round < 0 = all rounds" sentinel is gone — a negative
//     bound is just an ordinary (here: unknown) round number.
//   - GetChat keeps its own "round < 0 = every round" sentinel;
//   - GetRoundDetail matches its round EXACTLY through queryEvents'
//     exactRound (the range's 0 = open sentinel cannot express a round
//     0): a round with no rounds row — including any negative number,
//     which no stored round carries since the knife/warmup discard — is
//     ErrNotFound, never the whole match.
//
// The regression this pins: detail for an unmatched round used to forward
// its number into GetEvents/GetChat, whose `round >= 0` guard silently
// dropped the clause — a drill-down returned EVERY event and chat line of
// the match.
func TestGetRoundDetailExactRound(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/neg.dem", "sha-neg", time.Now())
	em := testExtracted("sha-neg", time.Now())
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", StartTick: 50, EndTick: 100}, // the only stored round
	}
	em.Events = []models.Event{
		{Seq: 0, Tick: 15, Round: 0, Kind: models.EventKill, Attacker: "100", Victim: "200"},
		{Seq: 1, Tick: 60, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200"},
	}
	em.Chat = []models.Chat{
		{Tick: 16, Round: 0, SteamID: "100", Name: "alice", Text: "pre", Kind: "chat"},
		{Tick: 61, Round: 1, SteamID: "100", Name: "alice", Text: "glhf", Kind: "chat"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	det, err := s.GetRoundDetail(id, 1)
	if err != nil {
		t.Fatalf("GetRoundDetail(1): %v", err)
	}
	if len(det.Events) != 1 || det.Events[0].Tick != 60 {
		t.Errorf("GetRoundDetail(1).Events = %+v, want exactly the round's 1 event (tick 60)", det.Events)
	}
	if len(det.Chat) != 1 || det.Chat[0].Text != "glhf" {
		t.Errorf("GetRoundDetail(1).Chat = %+v, want exactly the round's 1 line (%q)", det.Chat, "glhf")
	}

	// Unknown round numbers (0 and any negative) are not found — never a
	// fall-through to every row of the match.
	for _, round := range []int{0, -1, -2, 99} {
		if _, err := s.GetRoundDetail(id, round); !errors.Is(err, ErrNotFound) {
			t.Errorf("GetRoundDetail(%d) err = %v, want ErrNotFound", round, err)
		}
	}

	// Both round bounds open still means "all rounds".
	all, err := s.GetEvents(models.EventFilter{MatchID: id})
	if err != nil {
		t.Fatalf("GetEvents(all): %v", err)
	}
	if len(all) != 2 {
		t.Errorf("GetEvents(open range) = %d rows, want 2 (all rounds)", len(all))
	}
	chat, err := s.GetChat(id, -1, "")
	if err != nil {
		t.Fatalf("GetChat(-1): %v", err)
	}
	if len(chat) != 2 {
		t.Errorf("GetChat(-1) = %d rows, want 2 (all rounds)", len(chat))
	}
}

// TestGetChatPlayerScope pins the landmark feed's chat source contract:
// player "" = every sender, otherwise an exact steam_id match, combinable
// with the round filter (round < 0 still means all rounds).
func TestGetChatPlayerScope(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/chat-scope.dem", "sha-chat-scope", time.Now())
	em := testExtracted("sha-chat-scope", time.Now())
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", StartTick: 50, EndTick: 100},
		{Number: 2, Winner: "t", StartTick: 100, EndTick: 150},
	}
	em.Chat = []models.Chat{
		{Tick: 60, Round: 1, SteamID: "100", Name: "alice", Text: "a1", Kind: "chat"},
		{Tick: 70, Round: 1, SteamID: "200", Name: "bob", Text: "b1", Kind: "chat"},
		{Tick: 110, Round: 2, SteamID: "100", Name: "alice", Text: "a2", Kind: "chat"},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	all, err := s.GetChat(id, -1, "")
	if err != nil || len(all) != 3 {
		t.Fatalf("GetChat(all) = %d rows (err %v), want 3", len(all), err)
	}
	alice, err := s.GetChat(id, -1, "100")
	if err != nil || len(alice) != 2 || alice[0].Text != "a1" || alice[1].Text != "a2" {
		t.Errorf("GetChat(alice) = %+v (err %v), want a1,a2", alice, err)
	}
	// Round + player combined (exact round).
	both, err := s.GetChat(id, 2, "100")
	if err != nil || len(both) != 1 || both[0].Text != "a2" {
		t.Errorf("GetChat(round 2, alice) = %+v (err %v), want a2", both, err)
	}
	none, err := s.GetChat(id, 2, "999")
	if err != nil || len(none) != 0 {
		t.Errorf("GetChat(round 2, stranger) = %+v (err %v), want empty", none, err)
	}
}
