package main

import (
	"math"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

func pf(v float64) *float64 { return &v }

// seedHeatmapMatch stores the shared heatmap fixture (one counted round,
// players 100/200 on ct/t) with the given kill events and returns the
// store + match id (closed via t.Cleanup).
//
// Kill A: victim at the origin, killer at (100,100).
// Kill B: victim at (50,50), killer at (200,200).
func seedHeatmapMatch(t *testing.T, events []models.Event) (*store.Store, int64) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "heatmap.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	id, err := st.CreateMatchRow("/d.dem", "sha-heatmap", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Map: "de_test", TickRate: 64, DurationTicks: 1000, Frames: 100,
			PlaybackTimeS: 15.625, RealRounds: 1, ExtractedAt: time.Now(), ParseMS: 1,
		},
		Players: []models.Player{
			{SteamID: "100", Name: "a", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "b", Side: "t", FinalStatePresent: true},
		},
		Rounds: []models.Round{
			{Number: 1, Winner: "ct", StartTick: 0, EndTick: 1000},
		},
		RoundSides: []models.RoundPlayerSide{
			{Round: 1, SteamID: "100", Side: "ct"},
			{Round: 1, SteamID: "200", Side: "t"},
		},
		Events: events,
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return st, id
}

// twoKills is the shared event pair: kill A (victim 0,0 / killer
// 100,100) and kill B (victim 50,50 / killer 200,200).
func twoKills() []models.Event {
	return []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			PosX: pf(0), PosY: pf(0), AttackerPosX: pf(100), AttackerPosY: pf(100)},
		{Tick: 20, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			PosX: pf(50), PosY: pf(50), AttackerPosX: pf(200), AttackerPosY: pf(200)},
	}
}

// TestHeatmapKindsUseAttackerPosition guards the kills-vs-deaths split: the
// kills raster plots where the KILLER was (events.apos_*), deaths where the
// victim fell (events.pos_*). A shared-position bug would make the two
// heatmaps come out identical.
func TestHeatmapKindsUseAttackerPosition(t *testing.T) {
	st, id := seedHeatmapMatch(t, twoKills())
	as := &AnalyticsService{st: st}
	none := HeatmapFilter{RoundFrom: -1, RoundTo: -1}
	kills, err := as.GetHeatmap(id, "kills", none)
	if err != nil {
		t.Fatalf("GetHeatmap(kills): %v", err)
	}
	deaths, err := as.GetHeatmap(id, "deaths", none)
	if err != nil {
		t.Fatalf("GetHeatmap(deaths): %v", err)
	}
	if kills.Samples != 2 || deaths.Samples != 2 {
		t.Fatalf("samples kills=%d deaths=%d, want 2/2", kills.Samples, deaths.Samples)
	}
	// Bounds are the sampled extents ± heatmapPad (the kernel reach): the
	// kills raster must span the ATTACKER positions, the deaths raster
	// the VICTIM positions.
	if kills.MinX != 100-heatmapPad || kills.MaxX != 200+heatmapPad {
		t.Errorf("kills bounds x=[%v,%v], want the attacker span ±pad [%v,%v]",
			kills.MinX, kills.MaxX, 100-heatmapPad, 200+heatmapPad)
	}
	if deaths.MinX != 0-heatmapPad || deaths.MaxX != 50+heatmapPad {
		t.Errorf("deaths bounds x=[%v,%v], want the victim span ±pad [%v,%v]",
			deaths.MinX, deaths.MaxX, 0-heatmapPad, 50+heatmapPad)
	}
	identical := len(kills.Cells) == len(deaths.Cells)
	if identical {
		for i := range kills.Cells {
			if kills.Cells[i] != deaths.Cells[i] {
				identical = false
				break
			}
		}
	}
	if identical {
		t.Error("kills and deaths heatmaps are identical")
	}
}

// TestHeatmapKernelRadiates guards the spatial kernel: one isolated kill
// must paint a soft blob across many cells (peak-normalized — the center
// cell still reads ~1 so the legend's count scale is unchanged), not a
// single-cell dot.
func TestHeatmapKernelRadiates(t *testing.T) {
	st, id := seedHeatmapMatch(t, twoKills()[:1])
	as := &AnalyticsService{st: st}
	g, err := as.GetHeatmap(id, "kills", HeatmapFilter{RoundFrom: -1, RoundTo: -1})
	if err != nil {
		t.Fatalf("GetHeatmap(kills): %v", err)
	}
	if g.Samples != 1 {
		t.Fatalf("samples = %d, want 1", g.Samples)
	}
	nonzero, sum, peak := 0, 0.0, 0.0
	for _, v := range g.Cells {
		if v != 0 {
			nonzero++
		}
		sum += v
		if v > peak {
			peak = v
		}
	}
	// The kernel (3σ reach, tapered to zero at its edge) covers a broad
	// disk of the 128×128 grid; a delta would leave exactly 1 cell.
	if nonzero < 500 {
		t.Errorf("single sample painted %d cells, want a broad blob (≥500)", nonzero)
	}
	// Peak-normalized: the center tap stays ~1 (an isolated sample still
	// reads as one event), and the surrounding taps carry the rest.
	if peak <= 0.5 || peak > 1.0000001 {
		t.Errorf("peak cell = %v, want (0.5, 1]", peak)
	}
	if sum <= 50 {
		t.Errorf("cell sum = %v, want the splatted weight well above the peak", sum)
	}
}

// TestHeatmapKDSignedField guards the kd kind: + at the kill positions
// (killers), − at the death positions (victims), on the union of both
// populations' bounds.
func TestHeatmapKDSignedField(t *testing.T) {
	st, id := seedHeatmapMatch(t, twoKills())
	as := &AnalyticsService{st: st}
	kd, err := as.GetHeatmapKD(id, HeatmapFilter{RoundFrom: -1, RoundTo: -1})
	if err != nil {
		t.Fatalf("GetHeatmapKD: %v", err)
	}
	if kd.Kind != "kd" {
		t.Errorf("kind = %q, want \"kd\"", kd.Kind)
	}
	if kd.Samples != 4 {
		t.Errorf("samples = %d, want 4 (2 kills + 2 deaths)", kd.Samples)
	}
	// Union bounds: attacker span ± pad on top, victim span ± pad below.
	if kd.MinX != -heatmapPad || kd.MaxX != 200+heatmapPad {
		t.Errorf("kd bounds x=[%v,%v], want [%v,%v]",
			kd.MinX, kd.MaxX, -heatmapPad, 200+heatmapPad)
	}
	if kd.MinY != -heatmapPad || kd.MaxY != 200+heatmapPad {
		t.Errorf("kd bounds y=[%v,%v], want [%v,%v]",
			kd.MinY, kd.MaxY, -heatmapPad, 200+heatmapPad)
	}
	// Sign: positive where the killers stood, negative where the victims
	// fell (midpoint of each pair sits between the two samples).
	if v := sampleHeatmapCell(kd, 150, 150); v <= 0 {
		t.Errorf("kd at kills midpoint = %v, want > 0", v)
	}
	if v := sampleHeatmapCell(kd, 25, 25); v >= 0 {
		t.Errorf("kd at deaths midpoint = %v, want < 0", v)
	}
	// Max is the largest magnitude (the renderer normalizes by it).
	if want := maxAbsCell(kd.Cells); kd.Max != want || kd.Max <= 0 {
		t.Errorf("Max = %v, want maxAbsCell = %v (> 0)", kd.Max, want)
	}
}

// TestHeatmapKDPlayerFilter guards the signed filter semantics: the
// SteamID filter applies per side — kills where the player was the
// attacker (+), deaths where they died (−) — the populations the kills
// and deaths kinds would select, reused via heatmapEvents.
func TestHeatmapKDPlayerFilter(t *testing.T) {
	st, id := seedHeatmapMatch(t, twoKills())
	as := &AnalyticsService{st: st}
	kd, err := as.GetHeatmapKD(id, HeatmapFilter{RoundFrom: -1, RoundTo: -1, SteamID: "100"})
	if err != nil {
		t.Fatalf("GetHeatmapKD: %v", err)
	}
	// Player 100: kill A (attacker 100, + at 100,100) and kill B's death
	// (victim 100, − at 50,50). Kill B's attacker position and kill A's
	// victim position are filtered out.
	if kd.Samples != 2 {
		t.Errorf("samples = %d, want 2 (1 kill + 1 death)", kd.Samples)
	}
	if v := sampleHeatmapCell(kd, 100, 100); v <= 0 {
		t.Errorf("kd at player's kill position = %v, want > 0", v)
	}
	if v := sampleHeatmapCell(kd, 50, 50); v >= 0 {
		t.Errorf("kd at player's death position = %v, want < 0", v)
	}
}

// TestHeatmapKDEmpty: a match with no kill events yields an empty signed
// raster (zero bounds, no signal) rather than an error.
func TestHeatmapKDEmpty(t *testing.T) {
	st, id := seedHeatmapMatch(t, nil)
	as := &AnalyticsService{st: st}
	kd, err := as.GetHeatmapKD(id, HeatmapFilter{RoundFrom: -1, RoundTo: -1})
	if err != nil {
		t.Fatalf("GetHeatmapKD: %v", err)
	}
	if kd.Kind != "kd" || kd.Samples != 0 || kd.Max != 0 || len(kd.Cells) != heatmapGridSide*heatmapGridSide {
		t.Errorf("empty kd = kind %q, samples %d, max %v, cells %d — want kd/0/0/full grid",
			kd.Kind, kd.Samples, kd.Max, len(kd.Cells))
	}
}

// TestGaussianTapTapersToZero pins the kernel window: peak-normalized
// at the center, positive inside the 3σ reach, exactly zero at and
// beyond it — a splat ends in transparency (value 0 → alpha 0 at the
// renderer) instead of the hard ring a bare Gaussian cutoff leaves.
func TestGaussianTapTapersToZero(t *testing.T) {
	const sigma = 4.0
	if v := gaussianTap(0, sigma); v != 1 {
		t.Errorf("center tap = %v, want 1 (peak-normalized)", v)
	}
	prev := 1.0
	for off := 1; off < int(heatmapKernelSigmas*sigma); off++ {
		v := gaussianTap(off, sigma)
		if v <= 0 || v >= prev {
			t.Fatalf("tap(%d) = %v, want in (0, %v) and decreasing", off, v, prev)
		}
		prev = v
	}
	// The ceil'd radius step and everything after is dead (u ≥ 1).
	for _, off := range []int{int(math.Ceil(heatmapKernelSigmas * sigma)), int(heatmapKernelSigmas*sigma) + 3, 99} {
		if v := gaussianTap(off, sigma); v != 0 {
			t.Errorf("tap(%d) = %v, want 0 at/after the 3σ reach", off, v)
		}
	}
}

// TestHeatmapConvolveMatchesDirectSplat guards the separable refactor:
// delta accumulation + the two 1D passes must reproduce the per-sample
// 2D splat (Gaussian × taper per axis) cell for cell — the same field,
// only the order of summation may differ.
func TestHeatmapConvolveMatchesDirectSplat(t *testing.T) {
	samples := []struct {
		x, y, w float64
	}{{100, 100, 1}, {137, 91, 2.5}, {100, 100, 0.75}, {600, 640, 1}}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, s := range samples {
		minX, minY = math.Min(minX, s.x), math.Min(minY, s.y)
		maxX, maxY = math.Max(maxX, s.x), math.Max(maxY, s.y)
	}
	g := newHeatmapRaster(minX, minY, maxX, maxY)
	for _, s := range samples {
		if !g.add(s.x, s.y, s.w) {
			t.Fatalf("sample (%v,%v) fell outside the padded grid", s.x, s.y)
		}
	}
	got := g.grid("test", len(samples)).Cells

	// Direct 2D splat over every cell of every sample (clipped at the
	// border), with the separable weight computed independently.
	sx := heatmapSigmaWorld / g.cellW
	sy := heatmapSigmaWorld / g.cellH
	want := make([]float64, heatmapGridSide*heatmapGridSide)
	for _, s := range samples {
		cx := int((s.x - g.minX) / g.cellW)
		cy := int((s.y - g.minY) / g.cellH)
		for dy := -heatmapGridSide; dy < heatmapGridSide; dy++ {
			for dx := -heatmapGridSide; dx < heatmapGridSide; dx++ {
				tx, ty := cx+dx, cy+dy
				if tx < 0 || tx >= heatmapGridSide || ty < 0 || ty >= heatmapGridSide {
					continue
				}
				w := s.w * gaussianTap(dx, sx) * gaussianTap(dy, sy)
				if w != 0 {
					want[ty*heatmapGridSide+tx] += w
				}
			}
		}
	}
	for i := range want {
		diff := math.Abs(want[i] - got[i])
		if scale := math.Abs(want[i]); scale > 1 {
			diff /= scale
		}
		if diff > 1e-9 {
			t.Fatalf("cell %d: convolved %v, direct splat %v (diff %v)",
				i, got[i], want[i], diff)
		}
	}
}

// TestSampleHeatmapCellBilinear pins the combine's resample: a linear
// field reads back exactly at any point (interpolated, not snapped to
// the containing cell), edge cells extend, and points outside the raster
// read 0.
func TestSampleHeatmapCellBilinear(t *testing.T) {
	const side = 4
	g := HeatmapGrid{W: side, H: side, MinX: 0, MinY: 0, MaxX: 40, MaxY: 40}
	for r := 0; r < side; r++ {
		for c := 0; c < side; c++ {
			g.Cells = append(g.Cells, float64(r*side+c)) // value = row*side + col
		}
	}
	cw := (g.MaxX - g.MinX) / side
	at := func(x, y float64) float64 { return sampleHeatmapCell(g, x, y) }
	// Cell centers read their own cell exactly.
	for r := 0; r < side; r++ {
		for c := 0; c < side; c++ {
			got := at(float64(c)*cw+cw/2, float64(r)*cw+cw/2)
			if got != float64(r*side+c) {
				t.Errorf("center (%.1f,%.1f) = %v, want %d", float64(c)*cw+cw/2, float64(r)*cw+cw/2, got, r*side+c)
			}
		}
	}
	// Midpoints between adjacent cell centers: the average of the two
	// neighbours — a nearest-neighbour resample would snap to one.
	if got := at(10, 5); got != (0+1)/2.0 {
		t.Errorf("midpoint (10,5) = %v, want 0.5", got)
	}
	if got := at(5, 10); got != (0+4)/2.0 {
		t.Errorf("midpoint (5,10) = %v, want 2 (vertical neighbour)", got)
	}
	// Bilinear on a linear field reproduces the plane: value = row*4+col
	// evaluated at (col 0.75, row 0.75) — between the four centres at
	// (5|15, 5|15).
	if got := at(12.5, 12.5); math.Abs(got-(0.75*4+0.75)) > 1e-9 {
		t.Errorf("interpolated (12.5,12.5) = %v, want %v", got, 0.75*4+0.75)
	}
	// Points past the last cell center extend the edge value instead of
	// reading a phantom cell beyond the grid (y=35 sits exactly on row
	// 3's center; x=37.5 is past col 3's center at 35).
	if got := at(37.5, 35); got != 3*side+3 {
		t.Errorf("edge (37.5,35) = %v, want the extended edge cell %d", got, 3*side+3)
	}
	// Outside the raster reads 0 (union bounds extend past a population).
	for _, p := range [][2]float64{{-0.01, 5}, {40, 5}, {5, -0.01}, {5, 40}} {
		if got := at(p[0], p[1]); got != 0 {
			t.Errorf("outside (%v,%v) = %v, want 0", p[0], p[1], got)
		}
	}
}
