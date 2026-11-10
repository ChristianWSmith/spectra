package store

import (
	"errors"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestVoiceSchemaFreshOpen: a fresh Open creates the M4 columns/tables
// (matches.enc_messages, voice_presence) but NO voice_chunks — the chunk
// index lives in the per-match sidecar now — a second Open re-applies the
// baseline as a no-op, and the presence surface roundtrips after the
// reopen.
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
	// The baseline must not grow a chunk table back: a stale local DB can
	// still hold one (no DROP TABLE, pre-release policy), but a fresh
	// schema never creates it.
	var tables int
	if err := s2.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'voice_chunks'`,
	).Scan(&tables); err != nil {
		t.Fatalf("count voice_chunks: %v", err)
	}
	if tables != 0 {
		t.Errorf("voice_chunks table exists in a fresh schema")
	}
	// Presence insert/read proves voice_presence was created.
	if err := s2.SaveVoicePresence(id, models.VoicePresenceRow{
		ChunkCount: 7, PlayerCount: 2, OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		t.Fatalf("SaveVoicePresence (post-reopen): %v", err)
	}
	p, err := s2.GetVoicePresence(id)
	if err != nil || p.ChunkCount != 7 || p.PlayerCount != 2 || p.OutSampleRate != 16000 {
		t.Errorf("presence after reopen = %+v, %v; want chunks 7 players 2 rate 16000", p, err)
	}
}

// TestSaveVoicePresenceRoundtrip: the presence header writes and reads
// back whole (chunk index assertions live in internal/sidecar — the index
// is not in this database).
func TestSaveVoicePresenceRoundtrip(t *testing.T) {
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
	if err := s.SaveVoicePresence(id, presence); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}

	got, err := s.GetVoicePresence(id)
	if err != nil {
		t.Fatalf("GetVoicePresence: %v", err)
	}
	if got.MatchID != id || got.ChunkCount != 5 || got.PlayerCount != 2 ||
		got.CasterCount != 1 || !got.KeyFound || got.OutSampleRate != 16000 {
		t.Errorf("presence = %+v, want match %d chunks 5 players 2 casters 1 keyFound rate 16000", got, id)
	}
}

// TestSaveVoicePresenceReprocess: the import path is SaveExtracted
// (clears the row through childTables) then SaveVoicePresence — a second
// pass replaces the header with the new counts.
func TestSaveVoicePresenceReprocess(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicerep", time.Now())
	em := testExtracted("sha-voicerep", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.SaveVoicePresence(id, models.VoicePresenceRow{ChunkCount: 5, OutSampleRate: 16000}); err != nil {
		t.Fatalf("SaveVoicePresence #1: %v", err)
	}
	// Reprocess path: SaveExtracted clears, the second write replaces.
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted (reprocess): %v", err)
	}
	if err := s.SaveVoicePresence(id, models.VoicePresenceRow{ChunkCount: 1, PlayerCount: 1, OutSampleRate: 16000}); err != nil {
		t.Fatalf("SaveVoicePresence #2: %v", err)
	}
	p, err := s.GetVoicePresence(id)
	if err != nil || p.ChunkCount != 1 || p.PlayerCount != 1 {
		t.Errorf("presence after reprocess = %+v, %v; want chunks 1 players 1", p, err)
	}
}

// TestVoiceNotFound: no presence row is ErrNotFound (badge-off), not an
// error for callers that treat absence as "no voice".
func TestVoiceNotFound(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicenf", time.Now())
	if _, err := s.GetVoicePresence(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetVoicePresence(no rows) err = %v, want ErrNotFound", err)
	}
}

// TestDeleteMatchDataClearsVoice: voice_presence is a child table —
// deleting the match clears the header (the sidecar directory is removed
// by the service, not the store).
func TestDeleteMatchDataClearsVoice(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-voicedel", time.Now())
	em := testExtracted("sha-voicedel", time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := s.SaveVoicePresence(id, models.VoicePresenceRow{ChunkCount: 5, OutSampleRate: 16000}); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}
	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if _, err := s.GetVoicePresence(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetVoicePresence after delete err = %v, want ErrNotFound", err)
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
