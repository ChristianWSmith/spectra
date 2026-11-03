package store

import (
	"errors"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestVoiceSchemaFreshOpen: a fresh Open creates the M4 columns/tables
// (matches.enc_messages, voice_presence/voice_chunks), a second Open
// re-applies the baseline as a no-op, and the voice surface roundtrips
// after the reopen.
func TestVoiceSchemaFreshOpen(t *testing.T) {
	s, path := openFileStore(t)
	id := saveTestMatch(t, s, "/d/voice.dem", "sha-voice-schema", time.Now())

	em := testExtracted("sha-voice-schema", time.Now())
	em.Match.EncryptedMessages = 3
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s2, err := Open(path) // second Open: baseline re-applies as a no-op
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()

	m, err := s2.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.EncryptedMessages != 3 {
		t.Errorf("enc_messages = %d, want 3", m.EncryptedMessages)
	}
	// Presence insert/read proves both tables were created.
	if err := s2.InsertVoice(id, nil, models.VoicePresenceRow{
		ChunkCount: 7, PlayerCount: 2, OutSampleRate: models.VoiceOutSampleRate,
	}, nil); err != nil {
		t.Fatalf("InsertVoice (post-reopen): %v", err)
	}
	p, err := s2.GetVoicePresence(id)
	if err != nil || p.ChunkCount != 7 || p.PlayerCount != 2 || p.OutSampleRate != 16000 {
		t.Errorf("presence after reopen = %+v, %v; want chunks 7 players 2 rate 16000", p, err)
	}
}

// voiceTestRows builds an interleaved 2-player index with known offsets.
func voiceTestRows() []models.VoiceIndexRow {
	return []models.VoiceIndexRow{
		{Tick: 100, SteamID: "100", Off: 0, Len: 40, Section: 1},
		{Tick: 150, SteamID: "200", Off: 0, Len: 30},
		{Tick: 200, SteamID: "100", Off: 40, Len: 50, Caster: true, Section: 2},
		{Tick: 8000, SteamID: "100", Off: 90, Len: 20, Section: 3}, // past round 1 end
		{Tick: 50, SteamID: "200", Off: 30, Len: 10},               // before round 1 start
	}
}

func TestInsertVoiceRoundtrip(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voice", time.Now())
	em := testExtracted("sha-voice", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	presence := models.VoicePresenceRow{
		ChunkCount: 5, PlayerCount: 2, CasterCount: 1, KeyFound: true,
		OutSampleRate: models.VoiceOutSampleRate,
	}
	if err := s.InsertVoice(id, voiceTestRows(), presence, em.Rounds); err != nil {
		t.Fatalf("InsertVoice: %v", err)
	}

	got, err := s.GetVoicePresence(id)
	if err != nil {
		t.Fatalf("GetVoicePresence: %v", err)
	}
	if got.MatchID != id || got.ChunkCount != 5 || got.PlayerCount != 2 ||
		got.CasterCount != 1 || !got.KeyFound || got.OutSampleRate != 16000 {
		t.Errorf("presence = %+v, want match %d chunks 5 players 2 casters 1 keyFound rate 16000", got, id)
	}

	// Players: grouped, name-joined from players (alice=100, bob=200 —
	// chunks DESC then steam ID), seconds = chunks × 0.01.
	players, err := s.GetVoicePlayers(id)
	if err != nil {
		t.Fatalf("GetVoicePlayers: %v", err)
	}
	if len(players) != 2 {
		t.Fatalf("players = %d, want 2", len(players))
	}
	if players[0].SteamID != "100" || players[0].Name != "alice" || players[0].Chunks != 3 ||
		players[0].FirstTick != 100 || players[0].LastTick != 8000 {
		t.Errorf("players[0] = %+v, want steam 100/alice 3 chunks 100..8000", players[0])
	}
	if players[1].SteamID != "200" || players[1].Chunks != 2 || players[1].Seconds != 0.02 {
		t.Errorf("players[1] = %+v, want steam 200 2 chunks 0.02s", players[1])
	}

	// Round attribution from em.Rounds: tick 100..7620 → round 1;
	// outside every range → 0.
	ranges, err := s.GetVoiceChunkRange(id, "100", -1<<30, 1<<30)
	if err != nil {
		t.Fatalf("GetVoiceChunkRange: %v", err)
	}
	wantRounds := map[int]int{100: 1, 200: 1, 8000: 0}
	for _, r := range ranges {
		if want := wantRounds[r.Tick]; r.Round != want {
			t.Errorf("tick %d round = %d, want %d", r.Tick, r.Round, want)
		}
	}

	// Range filter: [100,200] for player 100 → 2 rows, ordered by tick.
	win, err := s.GetVoiceChunkRange(id, "100", 100, 200)
	if err != nil {
		t.Fatalf("GetVoiceChunkRange window: %v", err)
	}
	if len(win) != 2 || win[0].Tick != 100 || win[1].Tick != 200 {
		t.Fatalf("window rows = %+v, want ticks 100,200", win)
	}
	if win[0].Off != 0 || win[0].Len != 40 || win[1].Off != 40 || win[1].Len != 50 || !win[1].Caster {
		t.Errorf("window offsets = %+v, want byte-accurate Off/Len + caster flag", win)
	}

	// Ticks: all players vs one player, ordered by tick.
	all, err := s.GetVoiceTicks(id, "")
	if err != nil {
		t.Fatalf("GetVoiceTicks(all): %v", err)
	}
	wantAll := []int{50, 100, 150, 200, 8000}
	if len(all) != len(wantAll) {
		t.Fatalf("all ticks = %v, want %v", all, wantAll)
	}
	for i := range wantAll {
		if all[i] != wantAll[i] {
			t.Fatalf("all ticks = %v, want %v", all, wantAll)
		}
	}
	one, err := s.GetVoiceTicks(id, "200")
	if err != nil {
		t.Fatalf("GetVoiceTicks(200): %v", err)
	}
	if len(one) != 2 || one[0] != 50 || one[1] != 150 {
		t.Errorf("ticks(200) = %v, want [50 150]", one)
	}
}

func TestInsertVoiceReplaces(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicerep", time.Now())
	em := testExtracted("sha-voicerep", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.InsertVoice(id, voiceTestRows(), models.VoicePresenceRow{ChunkCount: 5, OutSampleRate: 16000}, em.Rounds); err != nil {
		t.Fatalf("InsertVoice #1: %v", err)
	}
	// Reprocess path: a second InsertVoice replaces (delete-then-insert).
	fresh := []models.VoiceIndexRow{{Tick: 10, SteamID: "100", Off: 0, Len: 5}}
	if err := s.InsertVoice(id, fresh, models.VoicePresenceRow{ChunkCount: 1, PlayerCount: 1, OutSampleRate: 16000}, em.Rounds); err != nil {
		t.Fatalf("InsertVoice #2: %v", err)
	}
	p, err := s.GetVoicePresence(id)
	if err != nil || p.ChunkCount != 1 {
		t.Errorf("presence after replace = %+v, %v; want chunks 1", p, err)
	}
	ticks, err := s.GetVoiceTicks(id, "")
	if err != nil || len(ticks) != 1 || ticks[0] != 10 {
		t.Errorf("ticks after replace = %v, %v; want [10]", ticks, err)
	}
}

func TestVoiceNotFound(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicenf", time.Now())
	if _, err := s.GetVoicePresence(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetVoicePresence(no rows) err = %v, want ErrNotFound", err)
	}
	players, err := s.GetVoicePlayers(id)
	if err != nil || len(players) != 0 {
		t.Errorf("GetVoicePlayers(no rows) = %v, %v; want empty, nil", players, err)
	}
}

func TestDeleteMatchDataClearsVoice(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicedel", time.Now())
	em := testExtracted("sha-voicedel", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.InsertVoice(id, voiceTestRows(), models.VoicePresenceRow{ChunkCount: 5, OutSampleRate: 16000}, em.Rounds); err != nil {
		t.Fatalf("InsertVoice: %v", err)
	}
	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if _, err := s.GetVoicePresence(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetVoicePresence after delete err = %v, want ErrNotFound", err)
	}
	ticks, err := s.GetVoiceTicks(id, "")
	if err != nil || len(ticks) != 0 {
		t.Errorf("GetVoiceTicks after delete = %v, %v; want empty", ticks, err)
	}
}

func TestEncryptedMessagesScan(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-enc", time.Now())
	em := testExtracted("sha-enc", time.Now())
	em.Match.EncryptedMessages = 42
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	m, err := s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.EncryptedMessages != 42 {
		t.Errorf("enc_messages = %d, want 42", m.EncryptedMessages)
	}
}
