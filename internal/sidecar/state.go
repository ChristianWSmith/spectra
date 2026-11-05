package sidecar

// The sparse player-state stream — state.bin/state.idx — rides alongside
// the position stream inside the same match directory. Player state
// (HP, armor, active weapon, inventory, mag/reserve ammo, trigger) is a
// step function: it changes a few times a second, so a PER-CHANGE record
// anchored to frame indices loses zero accuracy versus a fatter per-frame
// payload (+8 B/player/frame would roughly double both the sidecar and
// what the frontend fetches). Everything is SAMPLED from the parser each
// frame and diffed here — never arithmetically reconstructed (the damage
// accumulator documents why arithmetic drifts: agg.capDamage). The only
// reconstructed player datum is the C4 carrier (analytics.bombStateAt),
// which this stream does not cover.
//
// # Raw stream layout (stateFormatVersion 1)
//
// state.bin decompresses to a concatenation of independent zstd frames
// (≤256 records each), each holding records:
//
//	frame       uvarint (LEB128) — ABSOLUTE frame index (positions stream
//	                              frame numbering). Absolute (not a delta
//	                              from the previous record) so every block,
//	                              and any filtered subsequence a range read
//	                              returns, decodes standalone with no
//	                              out-of-band baseline — costs ~1-2 B more
//	                              per record than deltas, measured below.
//	slot        uint8  — the POSITIONS sidecar slot table (meta.players),
//	                     reused verbatim; no second slot table
//	mask        uint8  — bit per present field (values follow in bit order)
//	  0x01 hp          uint8   0 = death (sampled, not inferred)
//	  0x02 armor       uint8   read as-is even when dead
//	  0x04 weapon      uint8   index into meta.weaponNames
//	  0x08 inventory   uint8 count, then count × uint8 name index
//	  0x10 magAmmo     uint16 LE (active weapon; Negev's 150 rounds rules
//	  0x20 reserveAmmo   out u8)
//	  0x40 attack      uint8 0/1 (ButtonAttack held)
//
// A record is emitted only when a sampled field CHANGED (or on a seed),
// so a field absent from a record keeps its previous value — piecewise
// constant between records, zero drift. Seeds are not defaults: extract
// forces one full record per playing participant on the first frame after
// every round start, so nothing downstream ever guesses a starting value.
// Weapon/ammo fields are only present while the sample is alive; after
// death they are the last-known values (documented as such), while HP is
// a fresh 0 every dead frame.
//
// # Files (added to the positions layout; both streams version
// independently — q16-v2 is untouched)
//
//	state.bin  concatenated independent zstd frames (≤256 records/block,
//	           EncodeAll — each block decompresses alone)
//	state.idx  fixed 16-byte entries per block: firstFrame uint32,
//	           byteOffset uint64, recordCount uint16, pad uint16
//	meta.json  + stateFormatVersion (absent = no state stream; readers
//	           fail soft) + weaponNames[] (the interned name table)
//
// MEASURED on the golden demo (TestGoldenStateStream, 136,948 frames /
// 23 rounds): 18,456 records — 150,286 B raw / 90,005 B zstd (~147 KB /
// ~88 KB), against 9,102,512 B raw / 2,559,642 B zstd for the positions
// stream — i.e. ~1.6% raw / ~3.5% zstd of the sidecar, inside the
// 100–400 KB raw per-match estimate. Absolute frame uvarints cost
// 53,369 B of that raw total; a frameDelta encoding would be 18,509 B —
// the 34,860 B raw saving (less after zstd) buys nothing: absolute
// frames keep every block and every range-filtered subsequence
// independently decodable (see the layout above), while deltas would
// need the baseline record a range read never fetched.
import (
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
)

// State stream constants recorded in meta.json.
const (
	// StateFormatVersion identifies the state record layout above; bump
	// when it changes. Matches imported before this stream carry no
	// stateFormatVersion (and no state.bin/idx) — capability detection
	// is the meta field, never a schema column.
	StateFormatVersion = 1
	// StateBlockRecords is the maximum number of records per zstd block.
	StateBlockRecords = 256

	// State field-mask bits (mask byte of every record).
	StateHP          uint8 = 1 << 0
	StateArmor       uint8 = 1 << 1
	StateWeapon      uint8 = 1 << 2
	StateInventory   uint8 = 1 << 3
	StateMagAmmo     uint8 = 1 << 4
	StateReserveAmmo uint8 = 1 << 5
	StateAttack      uint8 = 1 << 6
	// stateFields is the mask of every defined field bit; unknown bits
	// are corruption (forward-compatible readers must fail loudly).
	stateFields = StateHP | StateArmor | StateWeapon | StateInventory |
		StateMagAmmo | StateReserveAmmo | StateAttack
)

// State sidecar file names inside a match directory.
const (
	StateBinName = "state.bin"
	StateIdxName = "state.idx"

	// unknownWeaponName is interned at index 0 so the weapon table has a
	// stable "no weapon/unknown" entry (wepName's nil fallback uses the
	// same string); a table overflow maps extra names here, loudly.
	unknownWeaponName = "Unknown"
)

// ErrNoState reports that a match directory has no state stream (old
// import, or the stream was never wired) — callers treat it as "absent",
// not as a failure, exactly like ErrNoSidecar.
var ErrNoState = errors.New("sidecar: no state stream")

// StateRecord is one decoded sparse change record. Mask says which fields
// are present (State* bits); absent fields keep their previous value —
// use StateAt-style reconstruction, never zero defaults. Weapon/Inventory
// hold meta.weaponNames indices.
type StateRecord struct {
	Frame       int     // frame index (positions stream frame numbering)
	Slot        int     // positions sidecar slot
	Mask        uint8   // present fields
	HP          uint8   // present iff Mask&StateHP
	Armor       uint8   // present iff Mask&StateArmor
	Weapon      uint8   // meta.weaponNames index; present iff Mask&StateWeapon
	Inventory   []uint8 // name indices; present iff Mask&StateInventory
	MagAmmo     uint16  // present iff Mask&StateMagAmmo
	ReserveAmmo uint16  // present iff Mask&StateReserveAmmo
	Attack      bool    // present iff Mask&StateAttack
}

// Has reports whether the record carries field (a State* bit).
func (r StateRecord) Has(field uint8) bool { return r.Mask&field != 0 }

// stateSample is the clamped, comparable form of one extract.StatePlayer
// for the current frame. inventory aliases the sample's slice until the
// record is stored (clone then) — the extract slice is frame-scoped.
type stateSample struct {
	hp, armor    uint8
	weapon       string
	inventory    []string
	mag, reserve uint16
	attack       bool
	alive        bool
}

// newSampleState clamps one frame's sample onto the wire widths. The
// death rule: HP0 and no weapon/ammo fields while dead (they are only
// emitted for alive samples — last-known semantics live here).
func newSampleState(p extract.StatePlayer) stateSample {
	s := stateSample{
		hp:     u8Clamp(p.HP),
		armor:  u8Clamp(p.Armor),
		attack: p.Attack,
		alive:  p.Alive,
	}
	if !p.Alive {
		return s
	}
	s.weapon = p.Weapon
	if s.weapon == "" {
		s.weapon = unknownWeaponName
	}
	s.mag = u16Clamp(p.MagAmmo)
	s.reserve = u16Clamp(p.ReserveAmmo)
	if n := len(p.Inventory); n > 0 {
		if n > 255 {
			n = 255 // wire count is a uint8; real inventories are ≤ ~12
		}
		s.inventory = p.Inventory[:n:n]
	}
	return s
}

// clone deep-copies the inventory so the stored state never aliases the
// frame-scoped extract slice.
func (s stateSample) clone() stateSample {
	if len(s.inventory) > 0 {
		s.inventory = append([]string(nil), s.inventory...)
	}
	return s
}

// maskFor returns the field bits to emit for this sample: seed/first
// sighting emits everything the sample carries; otherwise only changed
// fields. Weapon/ammo/inventory diffs are suppressed while dead (the
// sample carries no fresh values there — emitting them would overwrite
// last-known with a guess).
func (prev stateSlot) maskFor(s stateSample, seed bool) uint8 {
	full := seed || !prev.valid
	var m uint8
	if full || s.hp != prev.hp {
		m |= StateHP
	}
	if full || s.armor != prev.armor {
		m |= StateArmor
	}
	if full || s.attack != prev.attack {
		m |= StateAttack
	}
	if !s.alive {
		return m
	}
	if full || s.weapon != prev.weapon {
		m |= StateWeapon
	}
	if full || !stringSlicesEqual(s.inventory, prev.inventory) {
		m |= StateInventory
	}
	if full || s.mag != prev.mag {
		m |= StateMagAmmo
	}
	if full || s.reserve != prev.reserve {
		m |= StateReserveAmmo
	}
	return m
}

// stateSlot is the writer's last emitted (or first observed) state of one
// slot; valid is false until the first sighting.
type stateSlot struct {
	valid bool
	stateSample
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func u8Clamp(v int) uint8 {
	switch {
	case v < 0:
		return 0
	case v > 255:
		return 255
	default:
		return uint8(v)
	}
}

func u16Clamp(v int) uint16 {
	switch {
	case v < 0:
		return 0
	case v > 65535:
		return 65535
	default:
		return uint16(v)
	}
}

// stateStream is the writer half: an append-only state.bin with its own
// block index, created lazily on the first AddState (a parse that never
// wires the state sink ships no state files at all — matches imported
// before this stream stay absent, not empty).
type stateStream struct {
	dir     string
	bin     *os.File
	enc     *zstd.Encoder // the Writer's shared encoder
	buf     []byte        // current block's raw records
	comp    []byte        // scratch for EncodeAll
	idx     []idxEntry
	offset  int64 // bytes written to state.bin
	rawLen  int64 // uncompressed record bytes (format-size measurement)
	records int   // total records
	frames  int   // AddState calls (lockstep with positions frames)

	blockFirst   int // frame window start of the current block (idx)
	blockRecords int

	last     [maxSlots]stateSlot
	intern   map[string]uint8
	names    []string
	overflow bool // table-full warning logged once
	skipped  map[uint64]bool
}

// ensureOpen creates state.bin on first use (stale files were already
// removed by NewWriter, so Create here can only start fresh).
func (st *stateStream) ensureOpen(dir string) error {
	if st.bin != nil {
		return nil
	}
	bin, err := os.Create(filepath.Join(dir, StateBinName))
	if err != nil {
		return fmt.Errorf("sidecar: create %s: %w", StateBinName, err)
	}
	st.bin = bin
	return nil
}

// AddState appends one frame's state samples as sparse change records
// (extract.StateSink). The slot table is the positions writer's — samples
// for SteamIDs it never locked are skipped with a log line instead of
// failing the parse. Duplicates inside one frame (bots share SteamID 0)
// keep the first sighting, mirroring AddFrame. seed forces full records.
// players must not be retained by the caller side — only read here.
func (w *Writer) AddState(seed bool, players []extract.StatePlayer) error {
	if w.closed {
		return errors.New("sidecar: add state after close")
	}
	st := &w.st
	if err := st.ensureOpen(w.dir); err != nil {
		return err
	}
	// Pre-flush keeps every block ≤ StateBlockRecords even if one frame
	// contributes up to maxSlots records.
	if st.blockRecords > 0 && st.blockRecords+len(players) > StateBlockRecords {
		if err := st.flushBlock(); err != nil {
			return err
		}
	}
	frame := st.frames
	var seen uint16
	for _, p := range players {
		slot, ok := w.slotOf[p.SteamID]
		if !ok {
			w.logStateSkip(p.SteamID, "not in first-frame slot table")
			continue
		}
		if seen&(1<<uint(slot)) != 0 {
			continue
		}
		seen |= 1 << uint(slot)
		s := newSampleState(p)
		mask := st.last[slot].maskFor(s, seed)
		if mask == 0 {
			continue // nothing changed — no record, no drift
		}
		start := len(st.buf)
		st.buf = appendStateRecord(st.buf, frame, uint8(slot), mask, s, st.internName)
		st.rawLen += int64(len(st.buf) - start)
		st.blockRecords++
		st.records++
		next := s.clone()
		if !s.alive {
			// Death records carry no weapon/ammo bits: keep the
			// last-known values in the stored state so it stays
			// byte-for-byte what a reader reconstructs (and the next
			// alive sample diffs against them, not against zeros).
			prev := st.last[slot]
			next.weapon, next.inventory = prev.weapon, prev.inventory
			next.mag, next.reserve = prev.mag, prev.reserve
		}
		st.last[slot] = stateSlot{valid: true, stateSample: next}
	}
	st.frames++
	return nil
}

// logStateSkip records an unusable SteamID once per Writer (the state
// stream's own log — the position stream's skips are its own line).
func (w *Writer) logStateSkip(steamID uint64, why string) {
	if w.st.skipped[steamID] {
		return
	}
	w.st.skipped[steamID] = true
	slog.Warn("sidecar: player skipped from state stream", "steamId", steamID, "reason", why)
}

// internName maps a weapon name onto its meta.weaponNames index (0 =
// "Unknown", always present). A name beyond the 256-entry table falls
// back to 0 with one warning — never a silent wrong index.
func (st *stateStream) internName(name string) uint8 {
	if name == "" {
		name = unknownWeaponName
	}
	if i, ok := st.intern[name]; ok {
		return i
	}
	if len(st.names) >= 256 {
		if !st.overflow {
			st.overflow = true
			slog.Warn("sidecar: weapon name table full, extra names map to Unknown", "first", name)
		}
		return 0
	}
	i := uint8(len(st.names))
	st.intern[name] = i
	st.names = append(st.names, name)
	return i
}

// appendStateRecord encodes one record (layout in the file doc); frame is
// the absolute frame index.
func appendStateRecord(dst []byte, frame int, slot, mask uint8, s stateSample, intern func(string) uint8) []byte {
	var varint [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(varint[:], uint64(frame))
	dst = append(dst, varint[:n]...)
	dst = append(dst, slot, mask)
	if mask&StateHP != 0 {
		dst = append(dst, s.hp)
	}
	if mask&StateArmor != 0 {
		dst = append(dst, s.armor)
	}
	if mask&StateWeapon != 0 {
		dst = append(dst, intern(s.weapon))
	}
	if mask&StateInventory != 0 {
		dst = append(dst, byte(len(s.inventory)))
		for _, name := range s.inventory {
			dst = append(dst, intern(name))
		}
	}
	if mask&StateMagAmmo != 0 {
		dst = binary.LittleEndian.AppendUint16(dst, s.mag)
	}
	if mask&StateReserveAmmo != 0 {
		dst = binary.LittleEndian.AppendUint16(dst, s.reserve)
	}
	if mask&StateAttack != 0 {
		if s.attack {
			dst = append(dst, 1)
		} else {
			dst = append(dst, 0)
		}
	}
	return dst
}

// flushBlock compresses the buffered records and appends them to
// state.bin, recording the block's index entry. firstFrame is the frame
// window the block starts at (the frames counter when the previous block
// flushed) — block i therefore covers frames [firstFrame_i,
// firstFrame_{i+1}), which is how ReadStateRange selects blocks.
func (st *stateStream) flushBlock() error {
	if len(st.buf) == 0 {
		return nil
	}
	st.comp = st.enc.EncodeAll(st.buf, st.comp[:0])
	n, err := st.bin.Write(st.comp)
	st.offset += int64(n)
	if err != nil {
		return fmt.Errorf("sidecar: write state block: %w", err)
	}
	st.idx = append(st.idx, idxEntry{
		firstFrame: uint32(st.blockFirst),
		byteOffset: uint64(st.offset - int64(n)),
		frameCount: uint16(st.blockRecords),
	})
	st.blockFirst = st.frames
	st.buf = st.buf[:0]
	st.blockRecords = 0
	return nil
}

// close flushes the final block and writes state.idx. Single-shot callers
// only (Writer.Close guards its own closed flag).
func (st *stateStream) close() error {
	if st.bin == nil {
		return nil // never used — no state files ship
	}
	if err := st.flushBlock(); err != nil {
		return err
	}
	var raw []byte
	for _, e := range st.idx {
		raw = appendIdxEntry(raw, e)
	}
	if err := os.WriteFile(filepath.Join(st.dir, StateIdxName), raw, 0o644); err != nil {
		return fmt.Errorf("sidecar: write %s: %w", StateIdxName, err)
	}
	return nil
}

// decodeStateRecordAt decodes the record starting at off (frame is the
// absolute uvarint), returning the decoded record and the byte after it.
// Shared by DecodeStateRecords and Reader.ReadStateRange (which needs the
// byte span to filter by frame).
func decodeStateRecordAt(b []byte, off int) (StateRecord, int, error) {
	var r StateRecord
	frame, n := binary.Uvarint(b[off:])
	if n <= 0 {
		return r, 0, errCorrupt("bad state frame")
	}
	off += n
	r.Frame = int(frame)
	if off+2 > len(b) {
		return r, 0, errCorrupt("truncated state record header")
	}
	r.Slot = int(b[off])
	r.Mask = b[off+1]
	off += 2
	if r.Slot >= maxSlots {
		return r, 0, errCorrupt("state slot out of range")
	}
	if r.Mask & ^stateFields != 0 {
		return r, 0, errCorrupt("unknown state field bits")
	}
	u8 := func() (uint8, error) {
		if off >= len(b) {
			return 0, errCorrupt("truncated state record")
		}
		v := b[off]
		off++
		return v, nil
	}
	u16 := func() (uint16, error) {
		if off+2 > len(b) {
			return 0, errCorrupt("truncated state record")
		}
		v := binary.LittleEndian.Uint16(b[off:])
		off += 2
		return v, nil
	}
	var err error
	if r.Has(StateHP) {
		if r.HP, err = u8(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateArmor) {
		if r.Armor, err = u8(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateWeapon) {
		if r.Weapon, err = u8(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateInventory) {
		count, e := u8()
		if e != nil {
			return r, 0, e
		}
		if off+int(count) > len(b) {
			return r, 0, errCorrupt("truncated state inventory")
		}
		r.Inventory = append([]uint8(nil), b[off:off+int(count)]...)
		off += int(count)
	}
	if r.Has(StateMagAmmo) {
		if r.MagAmmo, err = u16(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateReserveAmmo) {
		if r.ReserveAmmo, err = u16(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateAttack) {
		v, e := u8()
		if e != nil {
			return r, 0, e
		}
		if v > 1 {
			return r, 0, errCorrupt("bad attack flag")
		}
		r.Attack = v == 1
	}
	return r, off, nil
}

// DecodeStateRecords walks a decompressed state stream (the raw bytes a
// Reader.ReadStateRange returns) and decodes every record. Frames must be
// non-decreasing (corruption guard); weaponNames is NOT consulted —
// Weapon/Inventory stay meta.weaponNames indices (the route returns raw
// bytes; consumers pair them with meta.json). Truncated or misaligned
// data yields an error (partial output is not returned).
func DecodeStateRecords(b []byte) ([]StateRecord, error) {
	var out []StateRecord
	off, prev := 0, -1
	for off < len(b) {
		r, next, err := decodeStateRecordAt(b, off)
		if err != nil {
			return nil, err
		}
		if r.Frame < prev {
			return nil, errCorrupt("state frames not monotonic")
		}
		prev = r.Frame
		out = append(out, r)
		off = next
	}
	return out, nil
}
