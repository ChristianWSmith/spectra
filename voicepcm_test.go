package main

import (
	"encoding/binary"
	"fmt"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

// TestDecodeVoicePCMEmptyWindow pins the chunk-less window shape: NO
// zero-filled silence buffer is allocated or returned (the route ships the
// fixed 8-byte header with 0 samples instead, which the engine's n === 0
// path turns into "no buffer, no source"), while a window that DOES hold
// chunks still zero-fills its full timeline length.
func TestDecodeVoicePCMEmptyWindow(t *testing.T) {
	_, id := newVoiceFixture(t)
	writeVoiceSidecar(t, id) // player "1": ticks 10/20/40 (match spans 1280)
	matchDir := matchSidecarDir(id)
	rd, err := sidecar.OpenVoice(matchDir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}

	// A window past every chunk → 0 samples, not a 64-tick silence buffer.
	pcm, err := decodeVoicePCM(rd, matchDir, "1", 1000, 1064, 64)
	if err != nil {
		t.Fatalf("decodeVoicePCM(chunk-less window): %v", err)
	}
	if len(pcm) != 0 {
		t.Errorf("chunk-less window pcm = %d bytes, want 0 (no silence buffer)", len(pcm))
	}

	// A player with no index file is chunk-less too (empty, never an error).
	pcm, err = decodeVoicePCM(rd, matchDir, "999", 0, 64, 64)
	if err != nil {
		t.Fatalf("decodeVoicePCM(unknown player): %v", err)
	}
	if len(pcm) != 0 {
		t.Errorf("unknown player pcm = %d bytes, want 0", len(pcm))
	}

	// A window that HOLDS chunks keeps the full zero-filled timeline:
	// 64 ticks × 250 samples/tick × 2 bytes (the fixture's payloads are
	// not decodable Opus, so the samples stay zero — the length is the
	// contract under test).
	pcm, err = decodeVoicePCM(rd, matchDir, "1", 0, 64, 64)
	if err != nil {
		t.Fatalf("decodeVoicePCM(window with chunks): %v", err)
	}
	if want := 64 * 250 * 2; len(pcm) != want {
		t.Errorf("window pcm = %d bytes, want %d", len(pcm), want)
	}
}

// TestVoicePCMRouteEmptyWindow pins the HTTP contract end to end (one
// handleSidecar pass — the single-GetMatch/single-OpenVoice request path):
// a chunk-less window answers 200 with Content-Length 8 — the fixed
// int32 fromTick | int32 sampleRate header and zero samples — while a
// window with chunks answers 8 + the full-length PCM body. A missing
// match stays 404.
func TestVoicePCMRouteEmptyWindow(t *testing.T) {
	st, id := newVoiceFixture(t)
	writeVoiceSidecar(t, id)
	p := fmt.Sprintf("%d/voice/pcm", id)
	get := func(from, to int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET",
			fmt.Sprintf("/api/sidecar/%s?steamId=1&fromTick=%d&toTick=%d", p, from, to), nil)
		rec := httptest.NewRecorder()
		handleSidecar(st, rec, req, p)
		return rec
	}

	silent := get(1000, 1064) // past every chunk (ticks 10/20/40)
	if silent.Code != 200 {
		t.Fatalf("silent window status = %d, want 200", silent.Code)
	}
	if got := silent.Header().Get("Content-Length"); got != "8" {
		t.Errorf("silent Content-Length = %q, want \"8\" (header only)", got)
	}
	body := silent.Body.Bytes()
	if len(body) != 8 {
		t.Fatalf("silent body = %d bytes, want 8", len(body))
	}
	if from := int32(binary.LittleEndian.Uint32(body[0:4])); from != 1000 {
		t.Errorf("header fromTick = %d, want 1000", from)
	}
	if rate := binary.LittleEndian.Uint32(body[4:8]); rate != models.VoiceOutSampleRate {
		t.Errorf("header sampleRate = %d, want %d", rate, models.VoiceOutSampleRate)
	}

	noisy := get(0, 64) // ticks 10/20/40 fall in here
	want := 8 + 64*250*2
	if noisy.Code != 200 {
		t.Fatalf("chunk window status = %d, want 200", noisy.Code)
	}
	if got := noisy.Header().Get("Content-Length"); got != strconv.Itoa(want) {
		t.Errorf("chunk window Content-Length = %q, want %d", got, want)
	}
	if noisy.Body.Len() != want {
		t.Errorf("chunk window body = %d bytes, want %d", noisy.Body.Len(), want)
	}

	// The match gate is unchanged: no such match → 404 (never 500).
	req := httptest.NewRequest("GET", "/api/sidecar/999999/voice/pcm?steamId=1&fromTick=0&toTick=64", nil)
	rec := httptest.NewRecorder()
	handleSidecar(st, rec, req, "999999/voice/pcm")
	if rec.Code != 404 {
		t.Errorf("missing match status = %d, want 404", rec.Code)
	}
}
