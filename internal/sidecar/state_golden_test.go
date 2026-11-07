package sidecar

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// goldenStateDemo is the repo-root golden acceptance demo (Git LFS).
const goldenStateDemo = "../../golden/de_cache.dem.zst"

// lfsStatePointerPrefix/MaxSize detect an un-smudged LFS pointer (the
// demo is skipped rather than parsed) — same policy as the integration
// package's golden tests.
const (
	lfsStatePointerPrefix  = "version https://git-lfs.github.com/spec"
	lfsStatePointerMaxSize = 4096
)

// skipGoldenState reports why the golden state-stream test cannot run
// (empty reason = run it).
func skipGoldenState() string {
	fi, err := os.Stat(goldenStateDemo)
	if err != nil {
		if os.IsNotExist(err) {
			return "golden demo missing (shallow clone or LFS not pulled)"
		}
		return "stat golden demo: " + err.Error()
	}
	if fi.Size() < lfsStatePointerMaxSize {
		data, rerr := os.ReadFile(goldenStateDemo) //nolint:gosec // fixed repo-root test path
		if rerr != nil {
			return "read golden demo: " + rerr.Error()
		}
		first, _, _ := strings.Cut(string(data), "\n")
		if strings.HasPrefix(strings.TrimRight(first, "\r"), lfsStatePointerPrefix) {
			return "golden demo is a Git LFS pointer (run git lfs pull)"
		}
	}
	return ""
}

// TestGoldenStateStream parses the golden demo with BOTH sinks wired
// (the production import path) and pins the state stream's shape:
// capability meta, record-count sanity, sampled HP sanity, and the
// weapon_fire ↔ attackButton acceptance cross-check (every weapon_fire
// should see SOMEONE's sampled trigger down within a small frame window —
// if the demo carried no button state this collapses to ~0%). It also
// logs the measured raw/zstd sizes quoted in state.go's format doc.
//
// Skipped under -short (it is a full demo parse) and when the LFS demo
// is absent.
func TestGoldenStateStream(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if reason := skipGoldenState(); reason != "" {
		t.Skip(reason)
	}

	f, err := os.Open(goldenStateDemo) //nolint:gosec // fixed repo-root test path
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(f, magic); err != nil {
		t.Fatalf("sniff demo magic: %v", err)
	}
	if !bytes.Equal(magic, []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		t.Fatalf("golden demo magic = %x, want zstd frame", magic)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("rewind demo: %v", err)
	}
	zr, err := zstd.NewReader(f)
	if err != nil {
		t.Fatalf("zstd.NewReader: %v", err)
	}
	defer zr.Close()

	dir := t.TempDir()
	w, err := NewWriter(dir, 0)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	em, err := extract.Parse(t.Context(), zr, extract.ParseOptions{Positions: w, State: w})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	meta, err := w.Close(em.Match.TickRate)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}

	// ---- capability + lockstep ----
	if meta.StateFormatVersion != StateFormatVersion {
		t.Errorf("stateFormatVersion = %d, want %d", meta.StateFormatVersion, StateFormatVersion)
	}
	if len(meta.WeaponNames) < 5 {
		t.Errorf("weaponNames = %v, want a real vocabulary", meta.WeaponNames)
	}
	if len(meta.Players) != 10 {
		t.Fatalf("slots = %d, want 10 (golden demo identity)", len(meta.Players))
	}
	if w.st.frames != meta.Frames {
		t.Errorf("state frames = %d, positions frames = %d — sinks must advance in lockstep",
			w.st.frames, meta.Frames)
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !r.HasState() {
		t.Fatal("HasState = false after a wired parse")
	}
	posRaw, err := r.ReadRange(0, 0)
	if err != nil {
		t.Fatalf("ReadRange: %v", err)
	}
	frames, err := DecodeFrames(posRaw, meta.Players)
	if err != nil {
		t.Fatalf("DecodeFrames: %v", err)
	}
	stateRaw, err := r.ReadStateRange(0, 0)
	if err != nil {
		t.Fatalf("ReadStateRange: %v", err)
	}
	recs, err := DecodeStateRecords(stateRaw)
	if err != nil {
		t.Fatalf("DecodeStateRecords: %v", err)
	}

	// ---- size measurement (quoted in state.go's format doc) ----
	stateInfo, err := os.Stat(filepath.Join(dir, StateBinName))
	if err != nil {
		t.Fatalf("stat state.bin: %v", err)
	}
	posInfo, err := os.Stat(filepath.Join(dir, BinName))
	if err != nil {
		t.Fatalf("stat positions.bin: %v", err)
	}
	// What a frameDelta encoding would have cost vs the absolute frames
	// actually written (the doc quotes both).
	prev, absBytes, deltaBytes := 0, 0, 0
	for _, rec := range recs {
		absBytes += len(binary.AppendUvarint(nil, uint64(rec.Frame)))
		deltaBytes += len(binary.AppendUvarint(nil, uint64(rec.Frame-prev)))
		prev = rec.Frame
	}
	t.Logf("state stream: %d records; raw %d B, zstd %d B (positions: %d B raw stream, %d B zstd)",
		len(recs), w.st.rawLen, stateInfo.Size(), len(posRaw), posInfo.Size())
	t.Logf("frame bytes: absolute uvarint %d B vs frameDelta %d B (delta would save %d B raw)",
		absBytes, deltaBytes, absBytes-deltaBytes)

	// ---- record-count sanity ----
	if len(recs) < 1000 {
		t.Errorf("state records = %d, want ≥1000 for a full match", len(recs))
	}
	if len(recs) > 100000 {
		t.Errorf("state records = %d, want ≤100000 (stream must stay sparse)", len(recs))
	}
	if len(recs) > meta.Frames*10 {
		t.Errorf("state records = %d > 10× frames %d — not a change stream", len(recs), meta.Frames)
	}

	// ---- sampled HP sanity: real deaths and respawns present ----
	var deaths, seeds int
	var maxHP uint8
	for _, rec := range recs {
		if !rec.Has(StateHP) {
			continue
		}
		if rec.HP == 0 {
			deaths++
		}
		if rec.HP > maxHP {
			maxHP = rec.HP
		}
		if rec.Mask == stateFields {
			seeds++
		}
	}
	if maxHP > 100 {
		t.Errorf("max sampled HP = %d, want ≤100 (golden demo is competitive rules)", maxHP)
	}
	if deaths < 100 {
		t.Errorf("hp:0 records = %d, want ≥100 (deaths are sampled)", deaths)
	}
	if seeds < 100 {
		t.Errorf("full-mask (seed) records = %d, want ≥100 (a seed per round start × participants)", seeds)
	}
	// No record may exceed the slot table.
	for _, rec := range recs {
		if rec.Slot >= len(meta.Players) {
			t.Fatalf("record slot %d outside slot table %d", rec.Slot, len(meta.Players))
		}
	}

	// ---- money/helmet sanity (the v2 fields) ----
	var moneyRecs, helmetTrue int
	var maxMoney uint16
	for _, rec := range recs {
		if rec.Has(StateMoney) {
			moneyRecs++
			if rec.Money > maxMoney {
				maxMoney = rec.Money
			}
		}
		if rec.Has(StateHelmet) && rec.Helmet {
			helmetTrue++
		}
	}
	if moneyRecs < 100 {
		t.Errorf("money records = %d, want ≥100 (every buy/kill/round-end reward moves an account)",
			moneyRecs)
	}
	if maxMoney == 0 || maxMoney > 16000 {
		t.Errorf("max sampled money = %d, want 1..16000 (CS2 account cap, u16 wire)", maxMoney)
	}
	if helmetTrue < 100 {
		t.Errorf("helmet=true records = %d, want ≥100 (armor+helm is the default buy)",
			helmetTrue)
	}

	// ---- weapon_fire ↔ attackButton acceptance cross-check ----
	ticks := make([]int, len(frames))
	for i, fr := range frames {
		ticks[i] = fr.Tick
	}
	// Per-slot attack transitions (records only carry changes).
	type attackPoint struct {
		frame int
		on    bool
	}
	perSlot := make([][]attackPoint, len(meta.Players))
	transitions := 0
	for _, rec := range recs {
		if !rec.Has(StateAttack) {
			continue
		}
		transitions++
		perSlot[rec.Slot] = append(perSlot[rec.Slot], attackPoint{frame: rec.Frame, on: rec.Attack})
	}
	if transitions == 0 {
		t.Fatal("no attack-button transitions — the demo carries no button state?")
	}
	attackOnAt := func(slot, frame int) bool {
		pts := perSlot[slot]
		lo, hi := 0, len(pts)-1
		ans := -1
		for lo <= hi {
			mid := (lo + hi) / 2
			if pts[mid].frame <= frame {
				ans = mid
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}
		return ans >= 0 && pts[ans].on
	}
	frameAtOrAfterTick := func(tick int) int {
		lo, hi := 0, len(ticks)-1
		ans := len(ticks) - 1
		for lo <= hi {
			mid := (lo + hi) / 2
			if ticks[mid] >= tick {
				ans = mid
				hi = mid - 1
			} else {
				lo = mid + 1
			}
		}
		return ans
	}

	var fires, matched int
	for _, g := range em.GenericEvents {
		if g.Name != "weapon_fire" {
			continue
		}
		fires++
		f := frameAtOrAfterTick(g.Tick)
		// Window: 4 frames (62 ms) before to 8 frames (125 ms) after —
		// the shot lands within a few ticks of the trigger press, and
		// players release shortly after.
		hit := false
		for fr := f - 4; !hit && fr <= f+8; fr++ {
			if fr < 0 || fr >= len(ticks) {
				continue
			}
			for slot := range perSlot {
				if attackOnAt(slot, fr) {
					hit = true
					break
				}
			}
		}
		if hit {
			matched++
		}
	}
	if fires == 0 {
		t.Fatal("no weapon_fire generic events — payload vocabulary changed?")
	}
	ratio := float64(matched) / float64(fires)
	t.Logf("weapon_fire ↔ sampled attack: %d/%d (%.1f%%) within ±window; %d attack transitions",
		matched, fires, ratio*100, transitions)
	if ratio < 0.85 {
		t.Errorf("weapon_fire with a nearby attack-down = %.1f%%, want ≥85%% (button sampling broken?)",
			ratio*100)
	}
}
