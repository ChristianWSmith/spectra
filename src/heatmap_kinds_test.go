package main

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
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
// 100,100) and kill B (victim 50,50 / killer 200,200). Z: A's victim
// sits at 0, its killer at 100; B's victim at 200, its killer at 50 —
// chosen so the [0,100) band keeps exactly one sample of each kind and
// its exclusive top bound (100) falls on A's killer. No band is set by
// the pre-layer tests, which count every sample whatever its z.
func twoKills() []models.Event {
	return []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			PosX: pf(0), PosY: pf(0), PosZ: pf(0),
			AttackerPosX: pf(100), AttackerPosY: pf(100), AttackerPosZ: pf(100)},
		{Tick: 20, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			PosX: pf(50), PosY: pf(50), PosZ: pf(200),
			AttackerPosX: pf(200), AttackerPosY: pf(200), AttackerPosZ: pf(50)},
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

// grenadeEvents is the grenade fixture: one throw of every canonical
// weapon name (Molotov ≡ Incendiary — both must land in the same
// molotov heatmap) plus two detonations, a smoke throw in round 2, and a
// kill at a far corner the grenade kinds must never plot.
//
//	100 (ct) throws HE → (10,10), Molotov → (30,30), smoke r2 → (60,60)
//	200 (t)  throws flash → (20,20), Incendiary → (40,40)
//	100 detonates HE → (110,110); 200 detonates flash → (120,120)
func grenadeEvents() []models.Event {
	return []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "100", Weapon: "HE Grenade",
			PosX: pf(10), PosY: pf(10)},
		{Tick: 11, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "200", Weapon: "Flashbang",
			PosX: pf(20), PosY: pf(20)},
		{Tick: 12, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "100", Weapon: "Molotov",
			PosX: pf(30), PosY: pf(30)},
		{Tick: 13, Round: 1, Kind: models.EventGrenadeThrow, Attacker: "200", Weapon: "Incendiary Grenade",
			PosX: pf(40), PosY: pf(40)},
		{Tick: 14, Round: 2, Kind: models.EventGrenadeThrow, Attacker: "100", Weapon: "Smoke Grenade",
			PosX: pf(60), PosY: pf(60)},
		{Tick: 20, Round: 1, Kind: models.EventGrenade, Attacker: "100", Weapon: "HE Grenade",
			PosX: pf(110), PosY: pf(110)},
		{Tick: 21, Round: 1, Kind: models.EventGrenade, Attacker: "200", Weapon: "Flashbang",
			PosX: pf(120), PosY: pf(120)},
		// A kill far away: a grenade kind must never plot it (different
		// events.kind), and the throw/detonation positions must not leak
		// into the kills raster either.
		{Tick: 30, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			PosX: pf(999), PosY: pf(999), AttackerPosX: pf(998), AttackerPosY: pf(998)},
	}
}

// TestGrenadeHeatmapKindsMatchCanonicalUtilitySet pins the registry to
// models' canonical utility set (models.weapons.go — the ONE weapon→kind
// projection every layer shares): every canonical weapon name must
// normalize into a utilKind the registry plots, the registry must carry
// no utilKind no weapon produces, and each id must be "<util>_<flavor>"
// with the flavor's events.kind (thrown → grenade_throw, det → grenade).
// A new grenade type (or a Molotov/Incendiary split) fails here until the
// heatmap pair and the frontend list (lib/heatkinds.js) agree.
func TestGrenadeHeatmapKindsMatchCanonicalUtilitySet(t *testing.T) {
	// The canonical names models.IsUtilityWeapon keys on — pinned to the
	// parser's equipment enum by extract.TestUtilityWeaponSetsIdentical.
	canonical := []string{"HE Grenade", "Flashbang", "Smoke Grenade",
		"Molotov", "Incendiary Grenade", "Decoy Grenade"}
	wantUtil := map[string]bool{}
	for _, w := range canonical {
		k := models.UtilityWeaponKind(w)
		if k == "" {
			t.Fatalf("models.UtilityWeaponKind(%q) = \"\", want the stored utility kind", w)
		}
		wantUtil[k] = true
	}
	gotUtil := map[string]bool{}
	for id, spec := range grenadeHeatmapKinds {
		flavor, util, found := cutKind(id)
		if !found || util != spec.utilKind {
			t.Errorf("kind %q: id must be <util>_<flavor> with util == spec.utilKind %q", id, spec.utilKind)
			continue
		}
		wantEvent := models.EventGrenadeThrow
		if flavor == "det" {
			wantEvent = models.EventGrenade
		} else if flavor != "thrown" {
			t.Errorf("kind %q: flavor %q, want thrown|det", id, flavor)
		}
		if spec.eventKind != wantEvent {
			t.Errorf("kind %q: eventKind %q, want %q", id, spec.eventKind, wantEvent)
		}
		gotUtil[spec.utilKind] = true
	}
	for u := range wantUtil {
		if !gotUtil[u] {
			t.Errorf("registry has no heatmap kind for canonical utility kind %q", u)
		}
	}
	for u := range gotUtil {
		if !wantUtil[u] {
			t.Errorf("registry plots utility kind %q no canonical weapon produces", u)
		}
	}
	// Molotov ≡ Incendiary must share ONE pair (the parenthetical rule of
	// the per-grenade heatmaps): both names project to "molotov".
	if models.UtilityWeaponKind("Molotov") != models.UtilityWeaponKind("Incendiary Grenade") {
		t.Fatal("Molotov and Incendiary Grenade no longer share a stored kind")
	}
}

// cutKind splits a grenade heatmap id into (flavor, util, ok).
func cutKind(id string) (flavor, util string, ok bool) {
	i := strings.LastIndex(id, "_")
	if i <= 0 || i == len(id)-1 {
		return "", "", false
	}
	return id[i+1:], id[:i], true
}

// TestHeatmapGrenadeKinds guards the two flavors' populations: "_thrown"
// plots the throw origins (grenade_throw pos_*), "_det" the blast
// positions (grenade pos_*), each restricted to ONE utility kind — with
// Molotov and Incendiary sharing the molotov pair — and never another
// event kind's position.
func TestHeatmapGrenadeKinds(t *testing.T) {
	st, id := seedHeatmapMatch(t, grenadeEvents())
	as := &AnalyticsService{st: st}
	none := HeatmapFilter{RoundFrom: -1, RoundTo: -1}
	samplesOf := func(kind string) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, kind, none)
		if err != nil {
			t.Fatalf("GetHeatmap(%s): %v", kind, err)
		}
		if g.Kind != kind {
			t.Errorf("kind = %q, want %q", g.Kind, kind)
		}
		return g
	}

	// Thrown: one HE at (10,10) — the bounds are that sample ± heatmapPad,
	// so a flash throw (20,20) or a detonation (110,110) cannot be in it.
	he := samplesOf("he_thrown")
	if he.Samples != 1 {
		t.Errorf("he_thrown samples = %d, want 1", he.Samples)
	}
	if he.MinX != 10-heatmapPad || he.MaxX != 10+heatmapPad || he.MinY != 10-heatmapPad || he.MaxY != 10+heatmapPad {
		t.Errorf("he_thrown bounds = [%v,%v]×[%v,%v], want (10,10) ± pad",
			he.MinX, he.MaxX, he.MinY, he.MaxY)
	}
	// Molotov ≡ Incendiary: BOTH throws (30,30) and (40,40) land here.
	mol := samplesOf("molotov_thrown")
	if mol.Samples != 2 {
		t.Errorf("molotov_thrown samples = %d, want 2 (Molotov + Incendiary Grenade)", mol.Samples)
	}
	if mol.MinX != 30-heatmapPad || mol.MaxX != 40+heatmapPad {
		t.Errorf("molotov_thrown bounds x = [%v,%v], want the Molotov/Incendiary span ± pad",
			mol.MinX, mol.MaxX)
	}
	// Detonations: HE blast at (110,110) only — no throw positions, no
	// kill position (999,999) from the kill event.
	det := samplesOf("he_det")
	if det.Samples != 1 || det.MinX != 110-heatmapPad || det.MaxX != 110+heatmapPad {
		t.Errorf("he_det = %d samples bounds x [%v,%v], want 1 sample at (110,110) ± pad",
			det.Samples, det.MinX, det.MaxX)
	}
	// Round range: the round-2 smoke throw drops out of rounds 1–1.
	if g := samplesOf("smoke_thrown"); g.Samples != 1 {
		t.Errorf("smoke_thrown samples = %d, want 1 (the round-2 throw)", g.Samples)
	}
	r1, err := as.GetHeatmap(id, "smoke_thrown", HeatmapFilter{RoundFrom: 1, RoundTo: 1})
	if err != nil {
		t.Fatalf("GetHeatmap(smoke_thrown, r1): %v", err)
	}
	if r1.Samples != 0 {
		t.Errorf("smoke_thrown in rounds 1–1 = %d samples, want 0 (its throw is round 2)", r1.Samples)
	}
	// No decoy events: an empty raster, not an error.
	dec := samplesOf("decoy_thrown")
	if dec.Samples != 0 || dec.Max != 0 || len(dec.Cells) != heatmapGridSide*heatmapGridSide {
		t.Errorf("decoy_thrown = %d samples / max %v / %d cells, want an empty raster",
			dec.Samples, dec.Max, len(dec.Cells))
	}
	// The bare grenade type is not a kind id — only the two flavors are.
	if _, err := as.GetHeatmap(id, "he", none); err == nil {
		t.Error(`GetHeatmap("he") succeeded, want an unknown-kind error`)
	}
	// And the grenade populations never feed the kill kinds.
	kills, err := as.GetHeatmap(id, "kills", none)
	if err != nil {
		t.Fatalf("GetHeatmap(kills): %v", err)
	}
	if kills.Samples != 1 {
		t.Errorf("kills samples = %d, want 1 (grenade events are not kills)", kills.Samples)
	}
}

// TestHeatmapGrenadeThrowerFilter guards the filter party: both grenade
// flavors filter on the THROWER (thrown: who threw; detonated: whose
// grenade landed), by SteamID and by that player's exact per-round side.
func TestHeatmapGrenadeThrowerFilter(t *testing.T) {
	st, id := seedHeatmapMatch(t, grenadeEvents())
	as := &AnalyticsService{st: st}

	byPlayer := func(kind, steamID string) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, kind, HeatmapFilter{RoundFrom: -1, RoundTo: -1, SteamID: steamID})
		if err != nil {
			t.Fatalf("GetHeatmap(%s, %s): %v", kind, steamID, err)
		}
		return g
	}
	// Player 100 (ct): HE throw (10,10) + Molotov throw (30,30) + HE det
	// (110,110); the flash/Incendiary/smoke rows belong to 200/round 2.
	if g := byPlayer("he_thrown", "100"); g.Samples != 1 {
		t.Errorf("he_thrown for 100 = %d samples, want 1", g.Samples)
	}
	if g := byPlayer("molotov_thrown", "100"); g.Samples != 1 {
		t.Errorf("molotov_thrown for 100 = %d samples, want 1 (the Molotov, not the incendiary)", g.Samples)
	}
	if g := byPlayer("flash_det", "100"); g.Samples != 0 {
		t.Errorf("flash_det for 100 = %d samples, want 0 (200 threw it)", g.Samples)
	}
	if g := byPlayer("flash_det", "200"); g.Samples != 1 {
		t.Errorf("flash_det for 200 = %d samples, want 1", g.Samples)
	}

	// Team filter resolves the thrower's side from the exact freeze-end
	// samples (100 = ct, 200 = t): CT sees HE + Molotov throws, T the
	// flash + incendiary throws.
	byTeam := func(kind, team string) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, kind, HeatmapFilter{RoundFrom: -1, RoundTo: -1, Team: team})
		if err != nil {
			t.Fatalf("GetHeatmap(%s, team %s): %v", kind, team, err)
		}
		return g
	}
	if g := byTeam("molotov_thrown", "ct"); g.Samples != 1 {
		t.Errorf("molotov_thrown for ct = %d samples, want 1", g.Samples)
	}
	if g := byTeam("molotov_thrown", "t"); g.Samples != 1 {
		t.Errorf("molotov_thrown for t = %d samples, want 1 (the incendiary throw)", g.Samples)
	}
	if g := byTeam("he_det", "t"); g.Samples != 0 {
		t.Errorf("he_det for t = %d samples, want 0 (100 threw it)", g.Samples)
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

// --- Layer z band (multi-floor maps) -----------------------------------------
//
// The z→layer rule is canonical in the frontend: layerIndexForZ
// (frontend/src/lib/replay/layers.js, "Band convention") — half-open
// [zMin, zMax), the shared boundary claimed by the band whose zMin it is,
// missing Z → the default layer (index 0) — restated for pack authors in
// frontend/public/maps/README.md. HeatmapFilter.zInBand is its Go twin for
// the server-side sample pass; these tests pin THAT, so a divergence from
// the frontend rule fails here.

// TestHeatmapEventBandFilter pins the event-side band: each sample is
// tested against the z of the SAME position source its x/y comes from
// (kills → AttackerPosZ, deaths → PosZ), the reported bounds describe the
// KEPT samples only (the raster is bounds-derived), and the high bound is
// exclusive — z == zMax belongs to the next band, not this one.
func TestHeatmapEventBandFilter(t *testing.T) {
	st, id := seedHeatmapMatch(t, twoKills())
	as := &AnalyticsService{st: st}
	killGrid := func(kind string, f HeatmapFilter) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, kind, f)
		if err != nil {
			t.Fatalf("GetHeatmap(%s): %v", kind, err)
		}
		return g
	}
	band := func(lo, hi float64) HeatmapFilter {
		return HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(lo), ZMax: pf(hi)}
	}

	// [0,100): A's victim (z 0) is in, A's killer (z 100) is out — the
	// exclusive top drops it — and B is the mirror (killer z 50 in, victim
	// z 200 out).
	kills := killGrid("kills", band(0, 100))
	if kills.Samples != 1 {
		t.Errorf("kills in [0,100) = %d samples, want 1 (A's killer at z=100 excluded)", kills.Samples)
	}
	if kills.MinX != 200-heatmapPad || kills.MaxX != 200+heatmapPad {
		t.Errorf("kills bounds x = [%v,%v], want B's attacker span ± pad [%v,%v]",
			kills.MinX, kills.MaxX, 200-heatmapPad, 200+heatmapPad)
	}
	deaths := killGrid("deaths", band(0, 100))
	if deaths.Samples != 1 {
		t.Errorf("deaths in [0,100) = %d samples, want 1 (A's victim at z=0 included)", deaths.Samples)
	}
	if deaths.MinX != -heatmapPad || deaths.MaxX != 0+heatmapPad {
		t.Errorf("deaths bounds x = [%v,%v], want A's victim span ± pad [%v,%v]",
			deaths.MinX, deaths.MaxX, -heatmapPad, heatmapPad)
	}
	// The z under test is the PLOTTED source's: had the kills pass read
	// the victim's z (or deaths the attacker's), the surviving sample and
	// therefore these bounds would swap — caught by the two checks above.

	// A nil bound is open on that side: [0, ∞) keeps both killers (z 100
	// and 50), so the bounds span them.
	open := killGrid("kills", HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(0)})
	if open.Samples != 2 || open.MinX != 100-heatmapPad || open.MaxX != 200+heatmapPad {
		t.Errorf("kills in [0,∞) = %d samples bounds x [%v,%v], want both attackers ± pad",
			open.Samples, open.MinX, open.MaxX)
	}
	// Both bounds nil = no band = every sample (today's behavior).
	none := killGrid("kills", HeatmapFilter{RoundFrom: -1, RoundTo: -1})
	if none.Samples != 2 || none.MinX != 100-heatmapPad || none.MaxX != 200+heatmapPad {
		t.Errorf("kills with no band = %d samples bounds x [%v,%v], want both attackers ± pad",
			none.Samples, none.MinX, none.MaxX)
	}
	// kd inherits the band through heatmapEvents (kills + deaths populations).
	kd, err := as.GetHeatmapKD(id, band(0, 100))
	if err != nil {
		t.Fatalf("GetHeatmapKD: %v", err)
	}
	if kd.Samples != 2 {
		t.Errorf("kd samples in [0,100) = %d, want 2 (one kill + one death)", kd.Samples)
	}
}

// TestHeatmapEventBandUnknownZ pins the missing-Z rule: a sample with no
// z at all cannot be placed in a band, so it is dropped unless
// IncludeUnknownZ admits it — the flag the frontend sets for layer 0
// only, mirroring layerIndexForZ's missing-Z → default-layer rule. With
// no band every sample counts with or without the flag.
func TestHeatmapEventBandUnknownZ(t *testing.T) {
	// Kill 1 carries a known in-band z (50); kill 2 has NO z anywhere —
	// the NULL-pos shape a world kill / vanished pawn produces.
	events := []models.Event{
		{Tick: 10, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
			PosX: pf(0), PosY: pf(0), PosZ: pf(50),
			AttackerPosX: pf(100), AttackerPosY: pf(100), AttackerPosZ: pf(50)},
		{Tick: 20, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
			PosX: pf(50), PosY: pf(50),
			AttackerPosX: pf(200), AttackerPosY: pf(200)},
	}
	st, id := seedHeatmapMatch(t, events)
	as := &AnalyticsService{st: st}
	gridOf := func(kind string, f HeatmapFilter) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, kind, f)
		if err != nil {
			t.Fatalf("GetHeatmap(%s): %v", kind, err)
		}
		return g
	}
	band := HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(0), ZMax: pf(100)}
	keep := band

	// Band, flag off: only the known in-band kill counts — kill 2's
	// unknown z is not a pass.
	g := gridOf("kills", band)
	if g.Samples != 1 || g.MinX != 100-heatmapPad || g.MaxX != 100+heatmapPad {
		t.Errorf("kills in [0,100) with unknown z dropped = %d samples bounds x [%v,%v], want 1 at (100,100) ± pad",
			g.Samples, g.MinX, g.MaxX)
	}
	g = gridOf("deaths", band)
	if g.Samples != 1 || g.MinX != -heatmapPad || g.MaxX != 0+heatmapPad {
		t.Errorf("deaths in [0,100) with unknown z dropped = %d samples bounds x [%v,%v], want 1 at (0,0) ± pad",
			g.Samples, g.MinX, g.MaxX)
	}
	// Flag on (layer 0): the zless sample is admitted on BOTH populations,
	// and the bounds grow to cover it.
	keep.IncludeUnknownZ = true
	g = gridOf("kills", keep)
	if g.Samples != 2 || g.MinX != 100-heatmapPad || g.MaxX != 200+heatmapPad {
		t.Errorf("kills with includeUnknownZ = %d samples bounds x [%v,%v], want 2 spanning (100..200,100) ± pad",
			g.Samples, g.MinX, g.MaxX)
	}
	g = gridOf("deaths", keep)
	if g.Samples != 2 || g.MinX != -heatmapPad || g.MaxX != 50+heatmapPad {
		t.Errorf("deaths with includeUnknownZ = %d samples bounds x [%v,%v], want 2 spanning (0..50,0) ± pad",
			g.Samples, g.MinX, g.MaxX)
	}
	// No band: the flag is inert — every sample counts, as before layers.
	none := HeatmapFilter{RoundFrom: -1, RoundTo: -1, IncludeUnknownZ: false}
	if g := gridOf("kills", none); g.Samples != 2 {
		t.Errorf("kills with no band = %d samples, want 2 (no band counts every sample)", g.Samples)
	}
}

// TestHeatmapPresenceBandFilter pins the sidecar (presence) side of the
// band: BOTH passes honor it — the raster's bounds come from the kept
// samples only (the raster is bounds-derived) and no dropped sample
// deposits dwell. Sidecar seeding mirrors TestGetSpatialSeries
// (platformservice_test.go); extract.PositionPlayer carries the Z the
// band reads.
func TestHeatmapPresenceBandFilter(t *testing.T) {
	useTempXDG(t)
	st, id := seedHeatmapMatch(t, nil)
	as := &AnalyticsService{st: st}

	// 100 frames @ tick = frame index: player 100 stands at (0,0,z=0),
	// player 200 at (100,0,z=200) — 200 sits above the [0,100) band.
	dir := filepath.Join(data.MatchesDir(), strconv.FormatInt(id, 10))
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for i := 0; i < 100; i++ {
		players := []extract.PositionPlayer{
			{SteamID: 100, X: 0, Y: 0, Z: 0},
			{SteamID: 200, X: 100, Y: 0, Z: 200},
		}
		if err := w.AddFrame(int32(i), players); err != nil {
			t.Fatalf("AddFrame: %v", err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close sidecar: %v", err)
	}

	presence := func(f HeatmapFilter) HeatmapGrid {
		t.Helper()
		g, err := as.GetHeatmap(id, "presence", f)
		if err != nil {
			t.Fatalf("GetHeatmap(presence): %v", err)
		}
		return g
	}
	// No band: both players' dwell, both extents (today's behavior).
	all := presence(HeatmapFilter{RoundFrom: -1, RoundTo: -1})
	if all.Samples != 200 {
		t.Fatalf("presence samples = %d, want 200 (2 players × 100 frames)", all.Samples)
	}
	if all.MinX != -heatmapPad || all.MaxX != 100+heatmapPad {
		t.Errorf("presence bounds x = [%v,%v], want both players ± pad", all.MinX, all.MaxX)
	}
	// [0,100): player 200 (z=200) is dropped in the extent pass (bounds
	// shrink to player 100) AND in the add pass (100 dwell samples).
	lo := presence(HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(0), ZMax: pf(100)})
	if lo.Samples != 100 {
		t.Errorf("presence in [0,100) = %d samples, want 100 (player 200's dwell dropped)", lo.Samples)
	}
	if lo.MinX != -heatmapPad || lo.MaxX != 0+heatmapPad || lo.MinY != -heatmapPad || lo.MaxY != 0+heatmapPad {
		t.Errorf("presence bounds = [%v,%v]×[%v,%v], want player 100's (0,0) ± pad",
			lo.MinX, lo.MaxX, lo.MinY, lo.MaxY)
	}
	// The mirror band: only player 200 survives, so the extents move.
	hi := presence(HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(100), ZMax: pf(300)})
	if hi.Samples != 100 || hi.MinX != 100-heatmapPad || hi.MaxX != 100+heatmapPad {
		t.Errorf("presence in [100,300) = %d samples bounds x [%v,%v], want 100 at (100,0) ± pad",
			hi.Samples, hi.MinX, hi.MaxX)
	}
	// A band claiming nobody: the empty raster (zero bounds), not an error.
	empty := presence(HeatmapFilter{RoundFrom: -1, RoundTo: -1, ZMin: pf(500), ZMax: pf(600)})
	if empty.Samples != 0 || empty.Max != 0 || len(empty.Cells) != heatmapGridSide*heatmapGridSide {
		t.Errorf("presence in [500,600) = %d samples / max %v / %d cells, want an empty raster",
			empty.Samples, empty.Max, len(empty.Cells))
	}
}

// --- Wire contract: the region drill's pad ----------------------------------
//
// The displayed cell value is the Gaussian-smeared splat (σ = 150u,
// windowed to zero at the 3σ reach = heatmapPad) of everything within the
// kernel's reach, while the drill hands the CLICKED CELL's edges to the
// feed — so the wire must carry the kernel reach for the view to expand
// the cell by (Heatmaps.svelte onRegion: cell ± pad = the events whose
// splat can reach the cell). The kd combine rebuilds the struct in
// combineSignedHeatmaps and every empty raster takes an early-return
// literal, so each construction path is pinned here: drop the field on
// any one of them and that kind's drill silently reverts to the raw
// ~30×36u cell (the owner's guaranteed-empty "No events match these
// filters." arrival).
func TestHeatmapGridCarriesKernelPad(t *testing.T) {
	// The pad IS the kernel reach — not an independent magic number.
	if heatmapPad != heatmapKernelReach || heatmapKernelReach != heatmapKernelSigmas*heatmapSigmaWorld {
		t.Fatalf("pad %v / reach %v / %vσ·%vσ — pad must be the 3σ kernel reach",
			heatmapPad, heatmapKernelReach, heatmapKernelSigmas, heatmapSigmaWorld)
	}
	st, id := seedHeatmapMatch(t, twoKills())
	as := &AnalyticsService{st: st}
	none := HeatmapFilter{RoundFrom: -1, RoundTo: -1}

	kills, err := as.GetHeatmap(id, "kills", none)
	if err != nil {
		t.Fatalf("GetHeatmap(kills): %v", err)
	}
	if kills.Pad != heatmapPad {
		t.Errorf("kills pad = %v, want %v (the kernel reach)", kills.Pad, heatmapPad)
	}
	// The kd combine path: heatmapEvents' grids are resampled into a NEW
	// HeatmapGrid literal — the field must be carried across.
	kd, err := as.GetHeatmapKD(id, none)
	if err != nil {
		t.Fatalf("GetHeatmapKD: %v", err)
	}
	if kd.Pad != heatmapPad {
		t.Errorf("kd pad = %v, want %v (the combine must carry the kernel reach)", kd.Pad, heatmapPad)
	}
	// The empty-raster early return keeps the same contract.
	empty, err := as.GetHeatmap(id, "decoy_thrown", none)
	if err != nil {
		t.Fatalf("GetHeatmap(decoy_thrown): %v", err)
	}
	if empty.Samples != 0 || empty.Pad != heatmapPad {
		t.Errorf("empty grid = %d samples / pad %v, want 0 samples and pad %v",
			empty.Samples, empty.Pad, heatmapPad)
	}
	// The JSON key the frontend reads (grid.pad) must survive the wire.
	raw, err := json.Marshal(kills)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if v, ok := wire["pad"]; !ok {
		t.Errorf("HeatmapGrid JSON has no pad key: %s", raw)
	} else if v != float64(heatmapPad) {
		t.Errorf("wire pad = %v, want %v", v, heatmapPad)
	}
}
