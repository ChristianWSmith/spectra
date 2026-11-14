package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestPerfServiceDevDB measures M3 service-level targets (heatmap <2 s,
// profile load <200 ms) against the developer's real data. CI skips
// (SPECTRA_DEV_DB unset).
func TestPerfServiceDevDB(t *testing.T) {
	dbPath := os.Getenv("SPECTRA_DEV_DB")
	if dbPath == "" {
		t.Skip("set SPECTRA_DEV_DB to run service perf measurements")
	}
	matchID, _ := strconv.ParseInt(os.Getenv("SPECTRA_DEV_MATCH"), 10, 64)
	if matchID == 0 {
		matchID = 1
	}
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open dev db: %v", err)
	}
	defer func() { _ = st.Close() }()

	as := &AnalyticsService{st: st}

	var t0 time.Time
	for _, kind := range []string{"presence", "kills"} {
		t0 = time.Now()
		g, err := as.GetHeatmap(matchID, kind, HeatmapFilter{RoundFrom: -1, RoundTo: -1})
		if err != nil {
			t.Fatalf("GetHeatmap(%s): %v", kind, err)
		}
		t.Logf("GetHeatmap(%s): %dx%d, %d samples, max=%.2f in %s",
			kind, g.W, g.H, g.Samples, g.Max, time.Since(t0).Round(time.Millisecond))
	}

	t0 = time.Now()
	if _, err := as.GetEconomy(matchID); err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	t.Logf("GetEconomy: %s", time.Since(t0).Round(time.Millisecond))

	ps := &ProfileService{st: st}
	steam := os.Getenv("SPECTRA_DEV_STEAM")
	if steam == "" {
		steam = "76561198296382419"
	}
	t0 = time.Now()
	pf, err := ps.GetProfile(steam)
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	t.Logf("GetProfile(%s): matches=%d wins=%d clutches=%d openingRate=%.1f in %s",
		steam, pf.Matches, pf.Wins, pf.Clutches, pf.OpeningRate, time.Since(t0).Round(time.Millisecond))
}

// TestPerfVoiceDevDB measures the M4 voice routes against the developer's
// real data: a 2 s PCM window must decode in <20 ms and the full
// WAV generation time is recorded. Requires an imported voice-bearing
// match (run `spectra -import golden/de_cache.dem.zst` first). CI skips
// (SPECTRA_DEV_DB unset).
func TestPerfVoiceDevDB(t *testing.T) {
	dbPath := os.Getenv("SPECTRA_DEV_DB")
	if dbPath == "" {
		t.Skip("set SPECTRA_DEV_DB to run voice perf measurements")
	}
	matchID, _ := strconv.ParseInt(os.Getenv("SPECTRA_DEV_MATCH"), 10, 64)
	if matchID == 0 {
		matchID = 1
	}
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open dev db: %v", err)
	}
	defer func() { _ = st.Close() }()

	presence, err := st.GetVoicePresence(matchID)
	if err != nil {
		t.Fatalf("GetVoicePresence: %v (import a voice demo first)", err)
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	matchDir := filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10))
	rd, err := sidecar.OpenVoice(matchDir)
	if err != nil {
		t.Fatalf("OpenVoice: %v (the chunk index lives in the sidecar — re-import the match)", err)
	}
	players, err := rd.Players()
	if err != nil || len(players) == 0 {
		t.Fatalf("Players: %v, %v", players, err)
	}
	// Busiest player first (the service's chunks-DESC order).
	sort.Slice(players, func(i, j int) bool { return players[i].Chunks > players[j].Chunks })
	steam := players[0].SteamID
	tickRate := m.TickRate
	if tickRate <= 0 {
		tickRate = 64
	}

	// 2-second PCM window from the player's first voice tick (the timeline
	// engine's request shape; target <20 ms — the budget covers opening
	// the index per request, no cache).
	from := players[0].FirstTick
	to := from + int(2*tickRate)
	t0 := time.Now()
	pcm, err := decodeVoicePCM(rd, matchDir, steam, from, to, tickRate)
	if err != nil {
		t.Fatalf("decodeVoicePCM(2s window): %v", err)
	}
	window := time.Since(t0)
	t.Logf("voice PCM 2s window (%s): %d bytes in %s (presence chunks=%d)",
		steam, len(pcm), window.Round(time.Microsecond), presence.ChunkCount)
	if window > 20*time.Millisecond {
		t.Errorf("PCM 2s window took %s, target is <20ms", window)
	}

	// Full-match WAV: record the wall time (no hard target beyond the
	// "decode full match < 60 s" background-job budget).
	t0 = time.Now()
	full, err := decodeVoicePCM(rd, matchDir, steam, 0, m.DurationTicks, tickRate)
	if err != nil {
		t.Fatalf("decodeVoicePCM(full match): %v", err)
	}
	wav := waveFile(full, models.VoiceOutSampleRate)
	t.Logf("voice WAV full match (%s): %d chunks → %.1f MB in %s",
		steam, presence.ChunkCount, float64(len(wav))/1e6, time.Since(t0).Round(time.Millisecond))
}

// TestPerfSpatialDevDB measures the M5 §2.4 spatial series against the
// developer's real data: full sidecar decode + 137k frames × O(n²)
// pairwise must stay far under the <20 s precompute budget
// (computed on read). CI skips (SPECTRA_DEV_DB unset).
func TestPerfSpatialDevDB(t *testing.T) {
	dbPath := os.Getenv("SPECTRA_DEV_DB")
	if dbPath == "" {
		t.Skip("set SPECTRA_DEV_DB to run spatial perf measurements")
	}
	matchID, _ := strconv.ParseInt(os.Getenv("SPECTRA_DEV_MATCH"), 10, 64)
	if matchID == 0 {
		matchID = 1
	}
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open dev db: %v", err)
	}
	defer func() { _ = st.Close() }()

	ps := &PlatformService{st: st}
	for _, kind := range []string{"spacing", "spread"} {
		t0 := time.Now()
		ser, err := ps.GetSpatialSeries(matchID, kind, 120)
		if err != nil {
			t.Fatalf("GetSpatialSeries(%s): %v", kind, err)
		}
		valid := 0
		for _, v := range ser.Values {
			if v >= 0 {
				valid++
			}
		}
		t.Logf("GetSpatialSeries(%s): %d/%d buckets valid, toTick=%d in %s (service ms=%d)",
			kind, valid, ser.Buckets, ser.ToTick, time.Since(t0).Round(time.Millisecond), ser.MS)
	}
}
