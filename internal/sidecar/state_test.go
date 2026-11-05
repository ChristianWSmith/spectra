package sidecar

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

const (
	stateA = uint64(76561198000000011)
	stateB = uint64(76561198000000012)
)

// aliveSample is a fully-loaded living sample (the canonical shape the
// extractor emits while alive).
func aliveSample(id uint64, hp int) extract.StatePlayer {
	return extract.StatePlayer{
		SteamID:     id,
		HP:          hp,
		Armor:       100,
		Weapon:      "AK-47",
		Inventory:   []string{"AK-47", "USP-S"},
		MagAmmo:     30,
		ReserveAmmo: 90,
		Alive:       true,
	}
}

// deadSample is the extractor's death shape: hp 0, no weapon/ammo fields.
func deadSample(id uint64) extract.StatePlayer {
	return extract.StatePlayer{SteamID: id, HP: 0, Alive: false}
}

// stateFrameWriter drives lockstep AddFrame+AddState calls (production
// wiring: the extractor calls the position sink first, then the state
// sink, once per frame).
type stateFrameWriter struct {
	w     *Writer
	frame int
}

func newFrameWriter(t *testing.T, dir string) *stateFrameWriter {
	t.Helper()
	w, err := NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	return &stateFrameWriter{w: w}
}

// step writes one frame: a position sample (assigns/keeps slots) plus the
// state samples for the same participants.
func (fw *stateFrameWriter) step(t *testing.T, seed bool, states ...extract.StatePlayer) {
	t.Helper()
	pos := make([]extract.PositionPlayer, 0, len(states))
	for i, s := range states {
		pos = append(pos, extract.PositionPlayer{
			SteamID: s.SteamID,
			X:       float32(i),
			Y:       float32(fw.frame),
		})
	}
	if err := fw.w.AddFrame(int32(fw.frame*2), pos); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	if err := fw.w.AddState(seed, states); err != nil {
		t.Fatalf("AddState: %v", err)
	}
	fw.frame++
}

// decodeState decodes the whole state stream from dir.
func decodeState(t *testing.T, dir string) ([]StateRecord, Meta) {
	t.Helper()
	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	raw, err := r.ReadStateRange(0, 0)
	if err != nil {
		t.Fatalf("ReadStateRange: %v", err)
	}
	recs, err := DecodeStateRecords(raw)
	if err != nil {
		t.Fatalf("DecodeStateRecords: %v", err)
	}
	return recs, r.Meta()
}

// slotOfSteam resolves a decoded record's slot back to the SteamID (meta
// slot table), so assertions read in SteamIDs.
func slotOfSteam(meta Meta, slot int) uint64 {
	return meta.Players[slot]
}

// TestStateStreamExplicit pins the record-level behavior: seeds emit
// everything, deltas carry only what changed, unchanged frames emit
// nothing, death is a sampled hp:0 with no weapon/ammo bits, and the
// last-known weapon/ammo survive the death for the reader.
func TestStateStreamExplicit(t *testing.T) {
	dir := t.TempDir()
	fw := newFrameWriter(t, dir)

	// f0: round start — both seeded with full records.
	fw.step(t, true, aliveSample(stateA, 100), aliveSample(stateB, 100))
	// f1: A takes 10 damage — exactly one hp-only record.
	fw.step(t, false, aliveSample(stateA, 90), aliveSample(stateB, 100))
	// f2: nothing changed — no records (delta suppression).
	fw.step(t, false, aliveSample(stateA, 90), aliveSample(stateB, 100))
	// f3: A holds the trigger — attack-only record.
	a := aliveSample(stateA, 90)
	a.Attack = true
	fw.step(t, false, a, aliveSample(stateB, 100))
	// f4: B dies — sampled hp:0 (+armor as read), no weapon/ammo bits;
	// A still holds the trigger (last-known must survive).
	fw.step(t, false, a, deadSample(stateB))
	// f5: B stays dead, unchanged — no records.
	fw.step(t, false, a, deadSample(stateB))
	// f6: B respawns with the same loadout — only the changed HP/armor.
	fw.step(t, false, a, aliveSample(stateB, 100))
	// f7: A releases the trigger — attack-only record (0).
	fw.step(t, false, aliveSample(stateA, 90), aliveSample(stateB, 100))

	if _, err := fw.w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
	recs, meta := decodeState(t, dir)

	if meta.StateFormatVersion != StateFormatVersion {
		t.Errorf("stateFormatVersion = %d, want %d", meta.StateFormatVersion, StateFormatVersion)
	}
	if len(meta.WeaponNames) == 0 || meta.WeaponNames[0] != unknownWeaponName {
		t.Fatalf("weaponNames = %v, want [%q ...]", meta.WeaponNames, unknownWeaponName)
	}
	weaponIdx := -1
	for i, n := range meta.WeaponNames {
		if n == "AK-47" {
			weaponIdx = i
		}
	}
	if weaponIdx < 0 {
		t.Fatalf("AK-47 not interned: %v", meta.WeaponNames)
	}

	type want struct {
		frame, slot int
		mask        uint8
		hp, armor   uint8
		attack      bool
	}
	wants := []want{
		{0, 0, stateFields, 100, 100, false},
		{0, 1, stateFields, 100, 100, false},
		{1, 0, StateHP, 90, 0, false},
		{3, 0, StateAttack, 0, 0, true},
		{4, 1, StateHP | StateArmor, 0, 0, false},
		{6, 1, StateHP | StateArmor, 100, 100, false},
		{7, 0, StateAttack, 0, 0, false},
	}
	if len(recs) != len(wants) {
		t.Fatalf("records = %d, want %d: %+v", len(recs), len(wants), recs)
	}
	for i, w := range wants {
		got := recs[i]
		slot := got.Slot
		if slotOfSteam(meta, slot) != [2]uint64{stateA, stateB}[w.slot] {
			t.Errorf("rec %d slot %d = steam %d, want participant %d", i, slot, slotOfSteam(meta, slot), w.slot)
		}
		if got.Frame != w.frame || got.Mask != w.mask {
			t.Errorf("rec %d = frame %d mask %#b, want frame %d mask %#b", i, got.Frame, got.Mask, w.frame, w.mask)
		}
		if w.mask&StateHP != 0 && got.HP != w.hp {
			t.Errorf("rec %d hp = %d, want %d", i, got.HP, w.hp)
		}
		if w.mask&StateArmor != 0 && got.Armor != w.armor {
			t.Errorf("rec %d armor = %d, want %d", i, got.Armor, w.armor)
		}
		if w.mask&StateAttack != 0 && got.Attack != w.attack {
			t.Errorf("rec %d attack = %v, want %v", i, got.Attack, w.attack)
		}
	}

	// Reconstruction (apply records in order): A ends hp 90 with the
	// trigger released; B ends hp 100 with the last-known loadout — the
	// death record never carried weapon/ammo bits.
	type recon struct {
		hp, armor    uint8
		weapon       string
		inv          []uint8
		mag, reserve uint16
		attack       bool
		weaponSeen   bool
	}
	var ra, rb recon
	for _, r := range recs {
		dst := &ra
		if r.Slot != 0 {
			dst = &rb
		}
		if r.Has(StateHP) {
			dst.hp = r.HP
		}
		if r.Has(StateArmor) {
			dst.armor = r.Armor
		}
		if r.Has(StateWeapon) {
			dst.weapon = meta.WeaponNames[r.Weapon]
			dst.weaponSeen = true
		}
		if r.Has(StateInventory) {
			dst.inv = r.Inventory
		}
		if r.Has(StateMagAmmo) {
			dst.mag = r.MagAmmo
		}
		if r.Has(StateReserveAmmo) {
			dst.reserve = r.ReserveAmmo
		}
		if r.Has(StateAttack) {
			dst.attack = r.Attack
		}
	}
	if ra.hp != 90 || ra.attack || ra.weapon != "AK-47" || ra.mag != 30 || ra.reserve != 90 {
		t.Errorf("A reconstructed = %+v, want hp90/no trigger/AK-47/30/90", ra)
	}
	if len(ra.inv) != 2 {
		t.Errorf("A inventory = %v, want 2 entries", ra.inv)
	}
	if rb.hp != 100 || rb.attack || rb.weapon != "AK-47" || !rb.weaponSeen {
		t.Errorf("B reconstructed = %+v, want hp100/no trigger/last-known AK-47", rb)
	}
}

// TestStateStreamSkipsUnknownSlot: a state sample for a SteamID the
// position stream never locked must be skipped with a log line, never a
// parse failure (mirrors AddFrame's latecomer policy).
func TestStateStreamSkipsUnknownSlot(t *testing.T) {
	dir := t.TempDir()
	fw := newFrameWriter(t, dir)
	latecomer := uint64(76561198000000099)
	fw.step(t, true, aliveSample(stateA, 100))
	fw.step(t, false, aliveSample(stateA, 80), aliveSample(latecomer, 100))
	if _, err := fw.w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
	recs, _ := decodeState(t, dir)
	// f0 seed (slot A) + f1's hp change; the latecomer never lands.
	if len(recs) != 2 {
		t.Fatalf("records = %d, want 2 (latecomer skipped): %+v", len(recs), recs)
	}
	for i, r := range recs {
		if r.Slot != 0 {
			t.Errorf("rec %d slot = %d, want 0 (latecomer must not get a slot)", i, r.Slot)
		}
	}
	if recs[0].HP != 100 || recs[1].HP != 80 {
		t.Errorf("hp sequence = %d → %d, want 100 → 80", recs[0].HP, recs[1].HP)
	}
}

// TestStateBlocksAndRange: >256 records spill into independent zstd
// blocks; range reads return exactly the records in [from,to) (and the
// whole stream for 0/0 or an inverted range).
func TestStateBlocksAndRange(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	const frames = 900
	for i := 0; i < frames; i++ {
		// One position frame + one changing hp sample per frame →
		// one record per frame (plus seeds) → several blocks.
		if err := w.AddFrame(int32(i*2), []extract.PositionPlayer{
			{SteamID: stateA, X: float32(i), Y: 1},
			{SteamID: stateB, X: 2, Y: float32(i)},
		}); err != nil {
			t.Fatalf("AddFrame: %v", err)
		}
		seed := i%64 == 0
		states := []extract.StatePlayer{
			aliveSample(stateA, 100-i%100),
			aliveSample(stateB, 100-(i/2)%100),
		}
		if err := w.AddState(seed, states); err != nil {
			t.Fatalf("AddState: %v", err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}

	idxRaw, err := os.ReadFile(filepath.Join(dir, StateIdxName))
	if err != nil {
		t.Fatalf("read state.idx: %v", err)
	}
	entries, err := parseIdxEntries(idxRaw)
	if err != nil {
		t.Fatalf("parse state.idx: %v", err)
	}
	if len(entries) < 3 {
		t.Fatalf("state blocks = %d, want ≥3", len(entries))
	}
	var total int
	for _, e := range entries {
		if e.frameCount == 0 || e.frameCount > StateBlockRecords {
			t.Errorf("block records = %d, want 1..%d", e.frameCount, StateBlockRecords)
		}
		total += int(e.frameCount)
	}

	full, _ := decodeState(t, dir)
	if len(full) != total {
		t.Fatalf("decoded %d records, idx says %d", len(full), total)
	}
	if len(full) < frames {
		t.Fatalf("records = %d, want ≥%d (hp changes every frame)", len(full), frames)
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Every block must decompress alone (the range path relies on it).
	for i, e := range entries {
		end := r.stateSize
		if i+1 < len(entries) {
			end = int64(entries[i+1].byteOffset)
		}
		raw := make([]byte, end-int64(e.byteOffset))
		f, oerr := os.Open(filepath.Join(dir, StateBinName))
		if oerr != nil {
			t.Fatalf("open state.bin: %v", oerr)
		}
		_, rerr := f.ReadAt(raw, int64(e.byteOffset))
		_ = f.Close()
		if rerr != nil {
			t.Fatalf("block %d read: %v", i, rerr)
		}
		data, derr := decompressStateBlock(t, raw)
		if derr != nil {
			t.Fatalf("block %d decompress: %v", i, derr)
		}
		recs, cerr := DecodeStateRecords(data)
		if cerr != nil {
			t.Fatalf("block %d decode: %v", i, cerr)
		}
		if len(recs) != int(e.frameCount) {
			t.Errorf("block %d records = %d, idx says %d", i, len(recs), e.frameCount)
		}
	}

	// Range [300, 400) equals the filtered full stream.
	filtered := func(from, to int) []StateRecord {
		t.Helper()
		var out []StateRecord
		for _, rec := range full {
			if rec.Frame >= from && rec.Frame < to {
				out = append(out, rec)
			}
		}
		return out
	}
	checkRange := func(from, to int) {
		t.Helper()
		wantTo := to
		if wantTo <= from {
			wantTo = frames + 1 // unbounded = through the end
		}
		raw, err := r.ReadStateRange(from, to)
		if err != nil {
			t.Fatalf("ReadStateRange(%d,%d): %v", from, to, err)
		}
		got, err := DecodeStateRecords(raw)
		if err != nil {
			t.Fatalf("decode range(%d,%d): %v", from, to, err)
		}
		want := filtered(from, wantTo)
		if len(got) != len(want) {
			t.Fatalf("range(%d,%d): %d records, want %d", from, to, len(got), len(want))
		}
		for i := range got {
			if !sameStateRecord(got[i], want[i]) {
				t.Errorf("range(%d,%d) rec %d = %+v, want %+v", from, to, i, got[i], want[i])
			}
		}
	}
	checkRange(300, 400)
	checkRange(0, 0)   // whole stream
	checkRange(0, 10)  // prefix
	checkRange(600, 0) // unbounded tail from 600

	// from beyond every record → empty; inverted range = whole stream
	// from `from`.
	if raw, err := r.ReadStateRange(frames+10, 0); err != nil || len(raw) != 0 {
		t.Errorf("ReadStateRange(beyond,0) = %d bytes, %v; want empty, nil", len(raw), err)
	}
	if raw, err := r.ReadStateRange(5, 3); err != nil {
		t.Errorf("ReadStateRange(5,3): %v", err)
	} else if got, _ := DecodeStateRecords(raw); len(got) != len(filtered(5, frames+1)) {
		t.Errorf("inverted range = %d records, want tail from 5", len(got))
	}
}

// decompressStateBlock decodes one state.bin block payload.
func decompressStateBlock(t *testing.T, raw []byte) ([]byte, error) {
	t.Helper()
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, err
	}
	defer dec.Close()
	return dec.DecodeAll(raw, nil)
}

// TestAddStateAfterCloseFails mirrors the positions writer's guard.
func TestAddStateAfterCloseFails(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.AddState(true, nil); err == nil {
		t.Error("AddState after Close: want error, got nil")
	}
}

// TestStateAbsentFailsSoft: matches imported before the state stream (a
// parse that never called AddState) carry no state files — Open succeeds,
// HasState is false, ReadStateRange reports ErrNoState, meta carries no
// stateFormatVersion. Also: a fresh NewWriter wipes stale state files so
// a reprocess can never inherit the old stream.
func TestStateAbsentFailsSoft(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	if err := w.AddFrame(0, []extract.PositionPlayer{{SteamID: stateA, X: 1}}); err != nil {
		t.Fatalf("AddFrame: %v", err)
	}
	meta, err := w.Close(64)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if meta.StateFormatVersion != 0 || meta.WeaponNames != nil {
		t.Errorf("positions-only meta = %+v, want no state fields", meta)
	}
	if _, err := os.Stat(filepath.Join(dir, StateBinName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("state.bin exists after positions-only parse: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, StateIdxName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("state.idx exists after positions-only parse: %v", err)
	}

	r, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if r.HasState() {
		t.Error("HasState = true, want false")
	}
	if _, err := r.ReadStateRange(0, 0); !errors.Is(err, ErrNoState) {
		t.Errorf("ReadStateRange err = %v, want ErrNoState", err)
	}

	// Stale-state cleanup: seed a state stream, then construct a new
	// Writer (reprocess path) — the old files must be gone before the
	// new parse starts.
	fw := newFrameWriter(t, dir)
	fw.step(t, true, aliveSample(stateA, 100))
	if _, err := fw.w.Close(64); err != nil {
		t.Fatalf("Close #2: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, StateBinName)); err != nil {
		t.Fatalf("state.bin missing after state parse: %v", err)
	}
	if _, err := NewWriter(dir, 64); err != nil {
		t.Fatalf("NewWriter #3: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, StateBinName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("stale state.bin survived NewWriter: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, StateIdxName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("stale state.idx survived NewWriter: %v", err)
	}
}

// TestStateRecordPinnedBytes pins the wire format: any change to the
// layout must be a stateFormatVersion bump, so encode/decode against
// hard-coded bytes.
func TestStateRecordPinnedBytes(t *testing.T) {
	s := stateSample{hp: 57, armor: 100, attack: true}
	got := appendStateRecord(nil, 300, 1, StateHP|StateArmor|StateAttack, s, func(string) uint8 { return 0 })
	// 300 → uvarint AC 02; slot 1; mask 0x43; hp 57; armor 100; attack 1.
	want := []byte{0xAC, 0x02, 0x01, 0x43, 57, 100, 1}
	if !bytes.Equal(got, want) {
		t.Fatalf("record = %x, want %x", got, want)
	}
	recs, err := DecodeStateRecords(want)
	if err != nil {
		t.Fatalf("DecodeStateRecords: %v", err)
	}
	if len(recs) != 1 || recs[0].Frame != 300 || recs[0].Slot != 1 ||
		recs[0].HP != 57 || recs[0].Armor != 100 || !recs[0].Attack {
		t.Fatalf("decoded = %+v", recs)
	}

	// Weapon + inventory + ammo record: frame 0, slot 0, mask
	// weapon|inventory|mag|reserve = 0x04|0x08|0x10|0x20 = 0x3C,
	// weapon index 3, inventory [3, 7], mag 150 (Negev), reserve 200.
	s2 := stateSample{weapon: "w", inventory: []string{"a", "b"}, mag: 150, reserve: 200}
	names := map[string]uint8{"w": 3, "a": 3, "b": 7}
	got2 := appendStateRecord(nil, 0, 0, StateWeapon|StateInventory|StateMagAmmo|StateReserveAmmo, s2,
		func(n string) uint8 { return names[n] })
	want2 := []byte{0x00, 0x00, 0x3C, 0x03, 0x02, 0x03, 0x07, 0x96, 0x00, 0xC8, 0x00}
	if !bytes.Equal(got2, want2) {
		t.Fatalf("record2 = %x, want %x", got2, want2)
	}
}

// TestStateCorrupt: truncated/invalid streams fail loudly with errors
// (never partial output).
func TestStateCorrupt(t *testing.T) {
	// Truncated record (hp byte missing).
	if _, err := DecodeStateRecords([]byte{0x01, 0x00, StateHP}); !errCorrupts(err) {
		t.Errorf("truncated hp: err = %v, want corrupt", err)
	}
	// Unknown field bit.
	if _, err := DecodeStateRecords([]byte{0x01, 0x00, 0x80}); !errCorrupts(err) {
		t.Errorf("unknown bit: err = %v, want corrupt", err)
	}
	// Slot out of range.
	if _, err := DecodeStateRecords([]byte{0x01, maxSlots, 0}); !errCorrupts(err) {
		t.Errorf("slot 16: err = %v, want corrupt", err)
	}
	// Attack flag not 0/1.
	if _, err := DecodeStateRecords([]byte{0x01, 0x00, StateAttack, 5}); !errCorrupts(err) {
		t.Errorf("attack=5: err = %v, want corrupt", err)
	}
	// Non-monotonic frames (absolute frames must ascend).
	if _, err := DecodeStateRecords([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00}); !errCorrupts(err) {
		t.Errorf("frame 5 then 3: err = %v, want corrupt", err)
	}
	// Unterminated varint.
	if _, err := DecodeStateRecords(bytes.Repeat([]byte{0x80}, 12)); !errCorrupts(err) {
		t.Errorf("unterminated varint: err = %v, want corrupt", err)
	}
	// Inventory count past the end.
	if _, err := DecodeStateRecords([]byte{0x01, 0x00, StateInventory, 0x03, 0x01}); !errCorrupts(err) {
		t.Errorf("short inventory: err = %v, want corrupt", err)
	}
	// A valid stream still round-trips.
	ok, err := DecodeStateRecords([]byte{0x00, 0x00, StateHP, 42})
	if err != nil || len(ok) != 1 || ok[0].HP != 42 {
		t.Errorf("valid stream: %v, %+v", err, ok)
	}
}

func errCorrupts(err error) bool {
	return err != nil && bytes.Contains([]byte(err.Error()), []byte("corrupt"))
}

// sameStateRecord compares records field-wise (Inventory is a slice).
func sameStateRecord(a, b StateRecord) bool {
	if a.Frame != b.Frame || a.Slot != b.Slot || a.Mask != b.Mask ||
		a.HP != b.HP || a.Armor != b.Armor || a.Weapon != b.Weapon ||
		a.MagAmmo != b.MagAmmo || a.ReserveAmmo != b.ReserveAmmo ||
		a.Attack != b.Attack {
		return false
	}
	return bytes.Equal(a.Inventory, b.Inventory)
}
