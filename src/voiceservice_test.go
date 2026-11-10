package main

import (
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// writeVoiceSidecar writes a small voice index into a match's sidecar dir:
// player "1" speaks three times (ticks 10/20/40), player "2" once
// (tick 30) — the fixture the presence gate, the player listing and the
// lanes all read.
func writeVoiceSidecar(t *testing.T, matchID int64) {
	t.Helper()
	dir := filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10))
	w, err := sidecar.NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	for _, c := range []extract.VoiceChunk{
		{Tick: 10, XUID: 1, Payload: []byte{1, 2, 3}},
		{Tick: 20, XUID: 1, Payload: []byte{4, 5}},
		{Tick: 30, XUID: 2, Payload: []byte{6}},
		{Tick: 40, XUID: 1, Payload: []byte{7}},
	} {
		if err := w.Add(c); err != nil {
			t.Fatalf("Add(tick=%d): %v", c.Tick, err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close voice writer: %v", err)
	}
}

// newVoiceFixture points XDG at a temp dir, opens a store with one seeded
// match (id 1 — seedPlatformMatch's roster is SteamID "1".."4") and writes
// the presence header the sidecar-less and sidecar-present cases gate on.
func newVoiceFixture(t *testing.T) (*store.Store, int64) {
	t.Helper()
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	id := seedPlatformMatch(t, st)
	return st, id
}

// TestVoicePresenceGate pins the badge contract: presence + no voice/*.idx
// is badge-off (a match imported before the index moved out of the DB must
// not report counts nothing can play), presence + index is the real count,
// and no presence row at all is badge-off too.
func TestVoicePresenceGate(t *testing.T) {
	st, id := newVoiceFixture(t)
	svc := &VoiceService{st: st}

	// No presence row, no index.
	p, err := svc.GetVoicePresence(id)
	if err != nil {
		t.Fatalf("GetVoicePresence(no row): %v", err)
	}
	if p.HasVoice || p.ChunkCount != 0 || p.PlayerCount != 0 || p.CasterCount != 0 {
		t.Errorf("badge(no row) = %+v, want HasVoice=false and zero counts", p)
	}
	if p.OutSampleRate != models.VoiceOutSampleRate || p.Decoder != voiceDecoderName {
		t.Errorf("badge(no row) rate/decoder = %d/%q, want %d/%q",
			p.OutSampleRate, p.Decoder, models.VoiceOutSampleRate, voiceDecoderName)
	}

	// Presence row WITHOUT an index — the "predates the sidecar" path.
	if err := st.SaveVoicePresence(id, models.VoicePresenceRow{
		ChunkCount: 4, PlayerCount: 2, CasterCount: 1, KeyFound: true,
		OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}
	p, err = svc.GetVoicePresence(id)
	if err != nil {
		t.Fatalf("GetVoicePresence(no index): %v", err)
	}
	if p.HasVoice || p.ChunkCount != 0 || p.PlayerCount != 0 || p.CasterCount != 0 || p.KeyFound {
		t.Errorf("badge(no index) = %+v, want badge-off (stale counts hidden)", p)
	}

	// Index present — the row's counts are now honest.
	writeVoiceSidecar(t, id)
	p, err = svc.GetVoicePresence(id)
	if err != nil {
		t.Fatalf("GetVoicePresence(index): %v", err)
	}
	if !p.HasVoice || p.ChunkCount != 4 || p.PlayerCount != 2 || p.CasterCount != 1 || !p.KeyFound {
		t.Errorf("badge(index) = %+v, want HasVoice with chunks 4 players 2 casters 1 keyFound", p)
	}
}

// TestVoicePlayersAndLanes pins the sidecar read surface: per-player
// summaries (roster names via GetPlayerRefs, chunks DESC then steam ID,
// seconds = chunks × 0.01) and the lane buckets, both empty without an
// index and never an error.
func TestVoicePlayersAndLanes(t *testing.T) {
	st, id := newVoiceFixture(t)
	svc := &VoiceService{st: st}
	if err := st.SaveVoicePresence(id, models.VoicePresenceRow{
		ChunkCount: 4, PlayerCount: 2, OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}

	// Before the index exists: empty listings, no error.
	players, err := svc.GetVoicePlayers(id)
	if err != nil || len(players) != 0 {
		t.Fatalf("GetVoicePlayers(no index) = %v, %v; want empty, nil", players, err)
	}
	lanes, err := svc.GetVoiceLanes(id, 16)
	if err != nil || len(lanes.Players) != 0 {
		t.Fatalf("GetVoiceLanes(no index) = %+v, %v; want no players, nil", lanes, err)
	}

	writeVoiceSidecar(t, id)
	players, err = svc.GetVoicePlayers(id)
	if err != nil {
		t.Fatalf("GetVoicePlayers: %v", err)
	}
	if len(players) != 2 {
		t.Fatalf("players = %d, want 2", len(players))
	}
	// chunks DESC: player "1" (3 chunks, roster name p0) before "2" (1).
	if p := players[0]; p.SteamID != "1" || p.Name != "p0" || p.Chunks != 3 ||
		p.FirstTick != 10 || p.LastTick != 40 || p.Seconds != 0.03 {
		t.Errorf("players[0] = %+v, want steam 1/p0 3 chunks 10..40 0.03s", p)
	}
	if p := players[1]; p.SteamID != "2" || p.Name != "p1" || p.Chunks != 1 ||
		p.FirstTick != 30 || p.LastTick != 30 || p.Seconds != 0.01 {
		t.Errorf("players[1] = %+v, want steam 2/p1 1 chunk 30..30 0.01s", p)
	}

	// Lanes: buckets cover [0, DurationTicks); one bucket per tick here so
	// the assertions are exact, and the lane order matches the listing.
	lanes, err = svc.GetVoiceLanes(id, 1280)
	if err != nil {
		t.Fatalf("GetVoiceLanes: %v", err)
	}
	if lanes.FromTick != 0 || lanes.ToTick != 1280 || lanes.Buckets != 1280 {
		t.Fatalf("lane header = %+v, want 0..1280 in 1280 buckets", lanes)
	}
	if len(lanes.Players) != 2 {
		t.Fatalf("lanes = %d players, want 2", len(lanes.Players))
	}
	wantCounts := map[string]map[int]int{
		"1": {10: 1, 20: 1, 40: 1},
		"2": {30: 1},
	}
	for _, lane := range lanes.Players {
		want := wantCounts[lane.SteamID]
		if want == nil {
			t.Fatalf("unexpected lane %s", lane.SteamID)
		}
		sum := 0
		for b, n := range lane.Counts {
			if n != want[b] {
				t.Errorf("lane %s bucket %d = %d, want %d", lane.SteamID, b, n, want[b])
			}
			sum += n
		}
		if sum == 0 {
			t.Errorf("lane %s has no chunks", lane.SteamID)
		}
	}
	if lanes.Players[0].SteamID != "1" {
		t.Errorf("lane order = %s first, want busiest player first", lanes.Players[0].SteamID)
	}
}

// TestVoiceIndexWindowsPinsWindowMath pins the server-side sparse-window
// map: start = tick / windowTicks * windowTicks (integer division — the
// exact complement of the engine's Math.floor(end / windowTicks) *
// windowTicks, whose JS twin lives in src/lib/voicewindows.js and is
// pinned by frontend/src/lib/voicewindows.test.js). One start per
// speech-bearing window; WindowTicks echoes the caller (the engine's
// consistency check); an unusable windowTicks yields NO map — the engine
// fail-opens to fetching, never skipping.
func TestVoiceIndexWindowsPinsWindowMath(t *testing.T) {
	// Window edges: 0..15 → 0, 16..31 → 16, 32..47 → 32, 48..63 → 48, …;
	// equal starts (and same-tick ties) collapse to one row.
	got := windowStarts([]int{0, 15, 16, 31, 32, 63, 64, 64, 100}, 16)
	want := []int{0, 16, 32, 48, 64, 96}
	if len(got) != len(want) {
		t.Fatalf("windowStarts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("windowStarts = %v, want %v", got, want)
		}
	}
	if s := windowStarts(nil, 16); len(s) != 0 {
		t.Errorf("windowStarts(no ticks) = %v, want empty", s)
	}
	if s := windowStarts([]int{5}, 0); s != nil {
		t.Errorf("windowStarts(windowTicks 0) = %v, want nil (fail-open)", s)
	}
}

// TestVoiceIndexOnePass pins GetVoiceIndex against the thin wrappers: the
// combined read's players/lanes must equal GetVoicePlayers/GetVoiceLanes
// (same single index pass, same ordering), and its window map must match
// windowStarts per player — plus the fail-open shapes (no index → all
// empty, windowTicks < 1 → no map rows).
func TestVoiceIndexOnePass(t *testing.T) {
	st, id := newVoiceFixture(t)
	svc := &VoiceService{st: st}
	if err := st.SaveVoicePresence(id, models.VoicePresenceRow{
		ChunkCount: 4, PlayerCount: 2, OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}

	// Before the index exists: everything empty, no error (same gate the
	// two wrappers already pin).
	empty, err := svc.GetVoiceIndex(id, 16, 16)
	if err != nil {
		t.Fatalf("GetVoiceIndex(no index): %v", err)
	}
	if len(empty.Players) != 0 || len(empty.Lanes.Players) != 0 || len(empty.Windows.Players) != 0 {
		t.Errorf("GetVoiceIndex(no index) = %+v, want empty players/lanes/windows", empty)
	}
	if empty.Windows.WindowTicks != 16 {
		t.Errorf("WindowTicks(no index) = %d, want the echoed 16", empty.Windows.WindowTicks)
	}

	writeVoiceSidecar(t, id) // player "1": ticks 10/20/40; player "2": tick 30
	idx, err := svc.GetVoiceIndex(id, 16, 16)
	if err != nil {
		t.Fatalf("GetVoiceIndex: %v", err)
	}
	players, err := svc.GetVoicePlayers(id)
	if err != nil {
		t.Fatalf("GetVoicePlayers: %v", err)
	}
	lanes, err := svc.GetVoiceLanes(id, 16)
	if err != nil {
		t.Fatalf("GetVoiceLanes: %v", err)
	}
	if !reflect.DeepEqual(idx.Players, players) {
		t.Errorf("index players = %+v, want the wrapper's %+v", idx.Players, players)
	}
	if !reflect.DeepEqual(idx.Lanes, lanes) {
		t.Errorf("index lanes = %+v, want the wrapper's %+v", idx.Lanes, lanes)
	}
	// Windows: player 1's ticks 10/20/40 → starts 0/16/32; player 2's
	// tick 30 → 16. (windowTicks 16 divides the match's chunk ticks.)
	wantWindows := map[string][]int{"1": {0, 16, 32}, "2": {16}}
	if idx.Windows.WindowTicks != 16 {
		t.Errorf("WindowTicks = %d, want 16", idx.Windows.WindowTicks)
	}
	if len(idx.Windows.Players) != len(wantWindows) {
		t.Fatalf("windows = %+v, want one row per speaking player", idx.Windows.Players)
	}
	for _, w := range idx.Windows.Players {
		want := wantWindows[w.SteamID]
		if want == nil {
			t.Fatalf("unexpected window row %s", w.SteamID)
		}
		if !reflect.DeepEqual(w.Starts, want) {
			t.Errorf("windows[%s] = %v, want %v", w.SteamID, w.Starts, want)
		}
	}

	// windowTicks < 1 → no map rows at all (WindowTicks stays the echo):
	// the engine treats that as "no map" and fetches every window.
	noMap, err := svc.GetVoiceIndex(id, 16, 0)
	if err != nil {
		t.Fatalf("GetVoiceIndex(windowTicks 0): %v", err)
	}
	if noMap.Windows.WindowTicks != 0 || len(noMap.Windows.Players) != 0 {
		t.Errorf("windows(windowTicks 0) = %+v, want no map (fail-open)", noMap.Windows)
	}
	// buckets <= 0 still defaults (the wrapper's contract).
	if def, err := svc.GetVoiceIndex(id, 0, 16); err != nil || def.Lanes.Buckets != voiceDefaultBuckets {
		t.Errorf("GetVoiceIndex(buckets 0) = %+v, %v; want buckets %d", def, err, voiceDefaultBuckets)
	}
}

// TestVoiceProvenanceGate: the provenance panel reports the presence
// row's chunk count only when the sidecar index can back it — one honest
// number for a match whose index never shipped.
func TestVoiceProvenanceGate(t *testing.T) {
	st, id := newVoiceFixture(t)
	if err := st.SaveVoicePresence(id, models.VoicePresenceRow{
		ChunkCount: 4, PlayerCount: 2, OutSampleRate: models.VoiceOutSampleRate,
	}); err != nil {
		t.Fatalf("SaveVoicePresence: %v", err)
	}
	svc := &PlatformService{st: st}

	p, err := svc.GetProvenance(id)
	if err != nil {
		t.Fatalf("GetProvenance(no index): %v", err)
	}
	if p.VoiceChunks != 0 {
		t.Errorf("VoiceChunks(no index) = %d, want 0", p.VoiceChunks)
	}

	writeVoiceSidecar(t, id)
	p, err = svc.GetProvenance(id)
	if err != nil {
		t.Fatalf("GetProvenance(index): %v", err)
	}
	if p.VoiceChunks != 4 {
		t.Errorf("VoiceChunks(index) = %d, want 4", p.VoiceChunks)
	}
}
