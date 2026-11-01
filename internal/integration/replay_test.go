package integration_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"io"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"strconv"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

var updateReplay = flag.Bool("update-replay", false, "regenerate testdata/donk.replay.json")

// replayGolden captures cross-source invariants: the position
// sidecar and the typed events must agree about where the match happened.
type replayGolden struct {
	Frames        int     `json:"frames"`
	Slots         int     `json:"slots"`
	TickRate      float64 `json:"tickRate"`
	RealRounds    int     `json:"realRounds"`
	FirstFreeze   int     `json:"firstFreezeTick"`
	AliveAtFreeze int     `json:"aliveAtFreeze"`
	Bounds        struct {
		MinX, MinY, MaxX, MaxY float64
	} `json:"bounds"`
	// PlantCentroids: bomb-plant position clusters per site (world units).
	PlantCentroids map[string]struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
		N int     `json:"n"`
	} `json:"plantCentroids"`
	// MaxPlantEccentricity: farthest plant from its own site centroid.
	MaxPlantEccentricity float64 `json:"maxPlantEccentricity"`
	// KillPosPairs: kills where BOTH event victim-pos and sidecar victim-pos
	// were available; MaxKillSidecarDelta is the worst disagreement
	// (hitbox point vs sampled pawn origin, ≤2 frames of movement).
	KillPosPairs        int     `json:"killPosPairs"`
	MaxKillSidecarDelta float64 `json:"maxKillSidecarDelta"`
}

func TestReplaySidecar(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}

	// Map pack transform (de_cache — committed fixture).
	metaBytes, err := os.ReadFile(filepath.Join("..", "..", "frontend", "public", "maps", "de_cache", "meta.json"))
	if err != nil {
		t.Fatalf("read map pack meta: %v", err)
	}
	var pack struct {
		Transform struct {
			PosX  float64 `json:"pos_x"`
			PosY  float64 `json:"pos_y"`
			Scale float64 `json:"scale"`
		} `json:"transform"`
		Radar struct{ Width, Height int } `json:"radar"`
	}
	if err := json.Unmarshal(metaBytes, &pack); err != nil {
		t.Fatalf("parse map pack meta: %v", err)
	}
	if pack.Transform.Scale == 0 || pack.Radar.Width == 0 {
		t.Fatalf("map pack meta incomplete: %+v", pack)
	}

	// Parse the golden demo with sampling into a temp sidecar (this IS the
	// second full parse of the test run — same cost class as TestGolden).
	f, err := os.Open(demoPath) //nolint:gosec // fixed repo-root path
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, len(zstdMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		t.Fatalf("sniff demo magic: %v", err)
	}
	reader := io.MultiReader(bytes.NewReader(head), f)
	if bytes.Equal(head, zstdMagic[:]) {
		zr, zerr := zstd.NewReader(reader)
		if zerr != nil {
			t.Fatalf("zstd.NewReader: %v", zerr)
		}
		defer zr.Close()
		reader = zr
	}

	dir := t.TempDir()
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("sidecar writer: %v", err)
	}
	start := time.Now()
	em, err := extract.Parse(t.Context(), reader, extract.ParseOptions{Positions: w})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	meta, err := w.Close(em.Match.TickRate)
	if err != nil {
		t.Fatalf("sidecar close: %v", err)
	}
	t.Logf("parsed+sampled in %s; sidecar meta: %d frames, %d slots", time.Since(start).Round(time.Millisecond), meta.Frames, len(meta.Players))

	rdr, err := sidecar.Open(dir)
	if err != nil {
		t.Fatalf("sidecar open: %v", err)
	}
	stream, err := rdr.ReadRange(0, -1)
	if err != nil {
		t.Fatalf("sidecar read: %v", err)
	}
	frames := decodeSidecar(t, stream)

	got := replayGolden{
		Frames:     len(frames),
		Slots:      len(meta.Players),
		TickRate:   meta.TickRate,
		RealRounds: em.Match.RealRounds,
		PlantCentroids: map[string]struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
			N int     `json:"n"`
		}{},
	}

	// Bounds: the radar's world coverage (transform + image size).
	got.Bounds.MinX = pack.Transform.PosX
	got.Bounds.MaxX = pack.Transform.PosX + float64(pack.Radar.Width)*pack.Transform.Scale
	got.Bounds.MaxY = pack.Transform.PosY
	got.Bounds.MinY = pack.Transform.PosY - float64(pack.Radar.Height)*pack.Transform.Scale

	inBounds := func(x, y float64) bool {
		return x >= got.Bounds.MinX-1 && x <= got.Bounds.MaxX+1 && y >= got.Bounds.MinY-1 && y <= got.Bounds.MaxY+1
	}

	// 1. Freezetime sanity: every alive player at the first real round's
	// freeze end must be inside the map bounds (catches axis/quantization
	// bugs; quantization is ±1 u).
	var firstFreeze int
	for _, r := range em.Rounds {
		if !r.Warmup && r.FreezeEndTick > 0 {
			firstFreeze = r.FreezeEndTick
			break
		}
	}
	if firstFreeze == 0 {
		t.Fatal("no real round with a freeze-end tick")
	}
	got.FirstFreeze = firstFreeze
	fi := frameAtOrAfter(frames, firstFreeze)
	alive := 0
	for _, p := range frames[fi].players {
		alive++
		if !inBounds(float64(p.x), float64(p.y)) {
			t.Errorf("freeze-end: player slot %d at (%d,%d) outside bounds %+v", p.slot, p.x, p.y, got.Bounds)
		}
	}
	got.AliveAtFreeze = alive
	if alive < 5 {
		t.Errorf("freeze-end alive count %d — expected most of 10", alive)
	}

	// 2. Bomb plants cluster by site (world positions from event payloads).
	sums := map[string][2]float64{}
	counts := map[string]int{}
	for _, ev := range em.Events {
		if ev.Kind != models.EventBombPlant || ev.PosX == nil || ev.PosY == nil || ev.Site == "" {
			continue
		}
		if !inBounds(*ev.PosX, *ev.PosY) {
			t.Errorf("plant at (%v,%v) outside bounds", *ev.PosX, *ev.PosY)
		}
		s := sums[ev.Site]
		sums[ev.Site] = [2]float64{s[0] + *ev.PosX, s[1] + *ev.PosY}
		counts[ev.Site]++
	}
	if len(sums) < 2 {
		t.Fatalf("expected plants at both sites, got %v", sums)
	}
	for site, s := range sums {
		n := counts[site]
		got.PlantCentroids[site] = struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
			N int     `json:"n"`
		}{X: s[0] / float64(n), Y: s[1] / float64(n), N: n}
	}
	for _, ev := range em.Events {
		if ev.Kind != models.EventBombPlant || ev.PosX == nil || ev.Site == "" {
			continue
		}
		c := got.PlantCentroids[ev.Site]
		d := math.Hypot(*ev.PosX-c.X, *ev.PosY-c.Y)
		if d > got.MaxPlantEccentricity {
			got.MaxPlantEccentricity = d
		}
	}
	if got.MaxPlantEccentricity > 400 {
		t.Errorf("plant eccentricity %.1f u > 400 — sites don't cluster", got.MaxPlantEccentricity)
	}

	// 3. Kills: event victim position must agree with the sidecar sample at
	// the kill tick (cross-source consistency; hitbox vs pawn origin).
	slotOf := map[uint64]int{}
	for i, id := range meta.Players {
		slotOf[id] = i
	}
	var nKill, nPos, nParse, nSlot, nFrame int
	for _, ev := range em.Events {
		if ev.Kind != models.EventKill {
			continue
		}
		nKill++
		if ev.PosX == nil || ev.Victim == "" {
			continue
		}
		nPos++
		vid, perr := strconv.ParseUint(ev.Victim, 10, 64)
		if perr != nil {
			continue
		}
		nParse++
		si, ok := slotOf[vid]
		if !ok {
			continue // bots / unknown — no slot
		}
		nSlot++
		// Last sample STRICTLY before the kill: the victim's bit is already
		// cleared in the kill-tick frame (alive-only stream), so at-or-before
		// would always miss them. One frame of movement is inside tolerance.
		fi := frameAtOrBefore(frames, ev.Tick-1)
		p, ok := framePlayer(frames[fi], si)
		if !ok {
			continue // victim not present in that frame's mask
		}
		nFrame++
		d := math.Hypot(float64(p.x)-*ev.PosX, float64(p.y)-*ev.PosY)
		got.KillPosPairs++
		if d > got.MaxKillSidecarDelta {
			got.MaxKillSidecarDelta = d
		}
	}
	t.Logf("kill stages: events=%d pos=%d parsed=%d slot=%d frame=%d", nKill, nPos, nParse, nSlot, nFrame)
	if got.KillPosPairs < 100 {
		t.Errorf("only %d kill position pairs cross-checked — extraction of positions regressed?", got.KillPosPairs)
	}
	if got.MaxKillSidecarDelta > 96 {
		t.Errorf("max kill/sidecar disagreement %.1f u > 96 sanity bound", got.MaxKillSidecarDelta)
	}

	// 4. Hard safety nets (always, even on -update-replay).
	if got.Frames != 136948 || got.Slots != 10 || got.RealRounds != 23 || math.Abs(got.TickRate-64) > 0.01 {
		t.Fatalf("safety net: golden demo identity drifted: %+v", got)
	}

	// 5. Fixture compare / regenerate.
	fixPath := filepath.Join("testdata", "donk.replay.json")
	if *updateReplay {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(fixPath, append(b, '\n'), 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		t.Logf("updated %s", fixPath)
		return
	}
	fb, err := os.ReadFile(fixPath)
	if err != nil {
		t.Fatalf("read fixture (run go test ./internal/integration -update-replay): %v", err)
	}
	var want replayGolden
	if err := json.Unmarshal(fb, &want); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	compareReplay(t, got, want)
}

func compareReplay(t *testing.T, got, want replayGolden) {
	t.Helper()
	fail := false
	if got.Frames != want.Frames {
		t.Errorf("frames: got %d want %d", got.Frames, want.Frames)
		fail = true
	}
	if got.Slots != want.Slots {
		t.Errorf("slots: got %d want %d", got.Slots, want.Slots)
		fail = true
	}
	if got.RealRounds != want.RealRounds {
		t.Errorf("realRounds: got %d want %d", got.RealRounds, want.RealRounds)
		fail = true
	}
	if got.FirstFreeze != want.FirstFreeze {
		t.Errorf("firstFreeze: got %d want %d", got.FirstFreeze, want.FirstFreeze)
		fail = true
	}
	if got.AliveAtFreeze != want.AliveAtFreeze {
		t.Errorf("aliveAtFreeze: got %d want %d", got.AliveAtFreeze, want.AliveAtFreeze)
		fail = true
	}
	if math.Abs(got.MaxPlantEccentricity-want.MaxPlantEccentricity) > 2 {
		t.Errorf("maxPlantEccentricity: got %.2f want %.2f", got.MaxPlantEccentricity, want.MaxPlantEccentricity)
		fail = true
	}
	if math.Abs(got.MaxKillSidecarDelta-want.MaxKillSidecarDelta) > 4 {
		t.Errorf("maxKillSidecarDelta: got %.2f want %.2f", got.MaxKillSidecarDelta, want.MaxKillSidecarDelta)
		fail = true
	}
	if got.KillPosPairs != want.KillPosPairs {
		t.Errorf("killPosPairs: got %d want %d", got.KillPosPairs, want.KillPosPairs)
		fail = true
	}
	for site, c := range want.PlantCentroids {
		g, ok := got.PlantCentroids[site]
		if !ok {
			t.Errorf("plantCentroids[%s] missing", site)
			fail = true
			continue
		}
		if g.N != c.N {
			t.Errorf("plantCentroids[%s].n: got %d want %d", site, g.N, c.N)
			fail = true
		}
		if math.Hypot(g.X-c.X, g.Y-c.Y) > 16 {
			t.Errorf("plantCentroids[%s] moved: got (%.1f,%.1f) want (%.1f,%.1f)", site, g.X, g.Y, c.X, c.Y)
			fail = true
		}
	}
	if !fail {
		t.Log("replay fixture matches")
	}
}

// ---- sidecar stream decoding (layout documented in internal/sidecar) ----

type sFrame struct {
	tick    int32
	players []sPlayer
}

type sPlayer struct {
	slot int
	x, y int16
}

func decodeSidecar(t *testing.T, b []byte) []sFrame {
	t.Helper()
	var frames []sFrame
	for off := 0; off+6 <= len(b); {
		tick := int32(binary.LittleEndian.Uint32(b[off : off+4]))
		mask := binary.LittleEndian.Uint16(b[off+4 : off+6])
		off += 6
		fr := sFrame{tick: tick}
		for s := 0; s < 16 && off+8 <= len(b); s++ {
			if mask&(1<<uint(s)) == 0 {
				continue
			}
			fr.players = append(fr.players, sPlayer{
				slot: s,
				x:    int16(binary.LittleEndian.Uint16(b[off : off+2])),
				y:    int16(binary.LittleEndian.Uint16(b[off+2 : off+4])),
			})
			off += 8
		}
		frames = append(frames, fr)
	}
	return frames
}

func frameAtOrAfter(frames []sFrame, tick int) int {
	lo, hi := 0, len(frames)-1
	ans := len(frames) - 1
	for lo <= hi {
		mid := (lo + hi) / 2
		if int(frames[mid].tick) >= tick {
			ans = mid
			hi = mid - 1
		} else {
			lo = mid + 1
		}
	}
	return ans
}

func frameAtOrBefore(frames []sFrame, tick int) int {
	lo, hi := 0, len(frames)-1
	ans := 0
	for lo <= hi {
		mid := (lo + hi) / 2
		if int(frames[mid].tick) <= tick {
			ans = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return ans
}

func framePlayer(fr sFrame, slot int) (sPlayer, bool) {
	for _, p := range fr.players {
		if p.slot == slot {
			return p, true
		}
	}
	return sPlayer{}, false
}
