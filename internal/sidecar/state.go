package sidecar

// The sparse player-state stream — state.bin/state.idx — rides alongside
// the position stream inside the same match directory. Player state
// (HP, armor, unspent money, helmet, active weapon, inventory,
// mag/reserve ammo, the stowed main weapon's ammo, trigger) is a step function: it changes a few times
// a second, so a PER-CHANGE record
// anchored to frame indices loses zero accuracy versus a fatter per-frame
// payload (+8 B/player/frame would roughly double both the sidecar and
// what the frontend fetches). Everything is SAMPLED from the parser each
// frame and diffed here — never arithmetically reconstructed (the damage
// accumulator documents why arithmetic drifts: agg.capDamage). The only
// reconstructed player datum is the C4 carrier (analytics.bombStateAt),
// which this stream does not cover.
//
// # Raw stream layout (stateFormatVersion 3)
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
//	mask        uvarint (LEB128) — bit per present field (values follow in
//	                     bit order). uvarint (v2 change; v1 was a single
//	                     uint8) because the mask ran out of bits: the seven
//	                     low bits (0x01..0x40) were all taken, money +
//	                     helmet need bits 7 and 8, and bit 8 (0x100) does
//	                     not fit a uint8 at all. A uvarint keeps every
//	                     mask below 0x80 a single byte — i.e. any record
//	                     without the new fields is byte-identical to its
//	                     v1 encoding — while a fixed uint16 would tax
//	                     every record +1 B. Masks ≥ 0x80 cost exactly
//	                     1 B extra. v3 added bits 9/10
//	                     (mainMag/mainReserve); masks stay two bytes
//	                     until 0x4000.
//	  0x001 hp          uint8   0 = death (sampled, not inferred)
//	  0x002 armor       uint8   read as-is even when dead
//	  0x004 weapon      uint8   index into meta.weaponNames
//	  0x008 inventory   uint8 count, then count × uint8 name index
//	  0x010 magAmmo     uint16 LE (active weapon; Negev's 150 rounds rules
//	  0x020 reserveAmmo   out u8)
//	  0x040 attack      uint8 0/1 (ButtonAttack held)
//	  0x080 money       uint16 LE — unspent account, 0..16000 in CS2
//	                     (clamped to u16). Like armor: read as-is even when
//	                     dead — the account lives on the player controller
//	                     and round-end cash lands while players are dead,
//	                     so it is diffed and emitted alive-or-dead.
//	  0x100 helmet      uint8 0/1 (m_bHasHelmet, pawn item services) —
//	                     like armor, read as-is even when dead (0/false on
//	                     a dead pawn is the sampled value, not a guess);
//	                     consumers gate on Alive.
//	  0x200 mainMag     uint16 LE — the MAIN (stowed) weapon's magazine:
//	                     the first primary, else the first secondary, of
//	                     pl.Weapons() order (extract.scanWeapons — the Go
//	                     twin of loadout.js mainWeaponOf with NO starter
//	                     fallback). Sampled alive like magAmmo (the death
//	                     gate suppresses it) and 0/0 when no firearm is
//	                     carried (knife round / dropped sidearm).
//	  0x400 mainReserve uint16 LE — the main weapon's reserve ammo; same
//	                     rules as mainMag.
//
// NOTE helmet deliberately rides its own bit: it CANNOT be derived from
// inventory — armor/helmet are pawn item-service props, not equipment
// entities, so pl.Weapons() never carries them (measured on the golden
// demo: 22 distinct inventory names, no "Kevlar Vest"/"Kevlar + Helmet",
// while 707,352 alive samples had helmet=true).
//
// Values are written in bit order, so the v3 fields are APPENDED after
// helmet: every v2 record's bytes are unchanged (its mask simply never
// sets bits 0x200/0x400) — TestStateRecordPinnedBytes pins that
// byte-identity.
//
// A record is emitted only when a sampled field CHANGED (or on a seed),
// so a field absent from a record keeps its previous value — piecewise
// constant between records, zero drift. Seeds are not defaults: extract
// forces one full record per playing participant on the first frame after
// every round start, so nothing downstream ever guesses a starting value.
// Weapon/ammo fields are only present while the sample is alive; after
// death they are the last-known values (documented as such), while HP is
// a fresh 0 every dead frame. Money/helmet follow the armor rule, not the
// weapon rule: fresh as-read values on every frame, alive or dead.
//
// VERSION POLICY (pre-release, AGENTS.md "No versioned migrations, no
// legacy-data fallbacks"): v1 AND v2 sidecars are NOT upgraded and NOT
// decoded — a reader seeing stateFormatVersion != 3 reports "no state
// stream" (Go: reader.openState fail-soft; frontend: stateCapable === 3),
// and the cards show unknown + the reprocess note. The decoder handles
// ONLY the layout above: v1 predates money/helmet, v2 predates the main-
// weapon fields (mainMag/mainReserve) — regaining state after this bump
// means REPROCESSING the match.
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
// 23 rounds): 18,834 records — 157,686 B raw / 95,744 B zstd (~154 KB /
// ~94 KB), against 9,102,512 B raw / 2,559,642 B zstd for the positions
// stream — i.e. ~1.7% raw / ~3.7% zstd of the sidecar, inside the
// 100–400 KB raw per-match estimate. (v2 money/helmet cost on that demo:
// +378 records, +7,400 B raw over v1's 18,456 / 150,286 B — money deltas
// from buys/kills/round-end rewards plus the extra seed bytes.) The
// quoted counts/sizes are the v2 BASELINE — they predate the v3 main-
// weapon fields (mainMag/mainReserve), which the test re-measures on
// every run (the record-count bounds it asserts still hold: the fields
// are diffed, so unchanged frames stay record-free). Absolute
// frame uvarints cost 54,467 B of that raw total; a frameDelta encoding
// would be 18,886 B — the 35,581 B raw saving (less after zstd) buys
// nothing: absolute frames keep every block and every range-filtered
// subsequence independently decodable (see the layout above), while
// deltas would need the baseline record a range read never fetched.
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
	// is the meta field, never a schema column. v1 (mask as uint8, no
	// money/helmet) and v2 (no main-weapon ammo) are retired, not
	// upgraded: openState treats any version other than the current one
	// as "no state stream" (pre-release no-migrations policy — see the
	// layout doc; matches must be reprocessed to regain state).
	StateFormatVersion = 3
	// StateBlockRecords is the maximum number of records per zstd block.
	StateBlockRecords = 256

	// State field-mask bits (mask uvarint of every record).
	StateHP          uint16 = 1 << 0
	StateArmor       uint16 = 1 << 1
	StateWeapon      uint16 = 1 << 2
	StateInventory   uint16 = 1 << 3
	StateMagAmmo     uint16 = 1 << 4
	StateReserveAmmo uint16 = 1 << 5
	StateAttack      uint16 = 1 << 6
	StateMoney       uint16 = 1 << 7
	StateHelmet      uint16 = 1 << 8
	StateMainMag     uint16 = 1 << 9
	StateMainReserve uint16 = 1 << 10
	// stateFields is the mask of every defined field bit; unknown bits
	// are corruption (forward-compatible readers must fail loudly).
	stateFields = StateHP | StateArmor | StateWeapon | StateInventory |
		StateMagAmmo | StateReserveAmmo | StateAttack | StateMoney | StateHelmet |
		StateMainMag | StateMainReserve
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
	Mask        uint16  // present fields
	HP          uint8   // present iff Mask&StateHP
	Armor       uint8   // present iff Mask&StateArmor
	Weapon      uint8   // meta.weaponNames index; present iff Mask&StateWeapon
	Inventory   []uint8 // name indices; present iff Mask&StateInventory
	MagAmmo     uint16  // present iff Mask&StateMagAmmo
	ReserveAmmo uint16  // present iff Mask&StateReserveAmmo
	Attack      bool    // present iff Mask&StateAttack
	Money       uint16  // unspent $; present iff Mask&StateMoney
	Helmet      bool    // present iff Mask&StateHelmet
	MainMag     uint16  // main (stowed) weapon magazine; present iff Mask&StateMainMag
	MainReserve uint16  // main (stowed) weapon reserve; present iff Mask&StateMainReserve
}

// Has reports whether the record carries field (a State* bit).
func (r StateRecord) Has(field uint16) bool { return r.Mask&field != 0 }

// stateSample is the clamped, comparable form of one extract.StatePlayer
// for the current frame. inventory aliases the sample's slice until the
// record is stored (clone then) — the extract slice is frame-scoped.
type stateSample struct {
	hp, armor    uint8
	weapon       string
	inventory    []string
	mag, reserve uint16
	mainMag      uint16
	mainReserve  uint16
	money        uint16
	attack       bool
	helmet       bool
	alive        bool
}

// newSampleState clamps one frame's sample onto the wire widths. The
// death rule: HP 0 and no weapon/ammo fields — active AND main — while
// dead (they are only emitted for alive samples — last-known semantics
// live here). Money and helmet deliberately do NOT follow that rule: they
// are as-read values that persist through death (money lives on the
// player controller and round-end cash lands while players are dead;
// helmet is the pawn item-service flag, 0/false on a dead pawn is the
// sampled value), so they are clamped and kept exactly like armor.
func newSampleState(p extract.StatePlayer) stateSample {
	s := stateSample{
		hp:     u8Clamp(p.HP),
		armor:  u8Clamp(p.Armor),
		money:  u16Clamp(p.Money),
		helmet: p.Helmet,
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
	s.mainMag = u16Clamp(p.MainMag)
	s.mainReserve = u16Clamp(p.MainReserve)
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
// fields. Money/helmet diff before the death gate (they are fresh as-read
// values while dead — see newSampleState); weapon/ammo (active and main)/
// inventory diffs are suppressed while dead (the sample carries no fresh
// values there — emitting them would overwrite last-known with a guess).
func (prev stateSlot) maskFor(s stateSample, seed bool) uint16 {
	full := seed || !prev.valid
	var m uint16
	if full || s.hp != prev.hp {
		m |= StateHP
	}
	if full || s.armor != prev.armor {
		m |= StateArmor
	}
	if full || s.attack != prev.attack {
		m |= StateAttack
	}
	if full || s.money != prev.money {
		m |= StateMoney
	}
	if full || s.helmet != prev.helmet {
		m |= StateHelmet
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
	if full || s.mainMag != prev.mainMag {
		m |= StateMainMag
	}
	if full || s.mainReserve != prev.mainReserve {
		m |= StateMainReserve
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
			// Money/helmet are NOT restored — their death-frame
			// samples are fresh as-read values (see newSampleState).
			prev := st.last[slot]
			next.weapon, next.inventory = prev.weapon, prev.inventory
			next.mag, next.reserve = prev.mag, prev.reserve
			next.mainMag, next.mainReserve = prev.mainMag, prev.mainReserve
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
// the absolute frame index, mask the uvarint field bitmask.
func appendStateRecord(dst []byte, frame int, slot uint8, mask uint16, s stateSample, intern func(string) uint8) []byte {
	var varint [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(varint[:], uint64(frame))
	dst = append(dst, varint[:n]...)
	dst = append(dst, slot)
	n = binary.PutUvarint(varint[:], uint64(mask))
	dst = append(dst, varint[:n]...)
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
	if mask&StateMoney != 0 {
		dst = binary.LittleEndian.AppendUint16(dst, s.money)
	}
	if mask&StateHelmet != 0 {
		if s.helmet {
			dst = append(dst, 1)
		} else {
			dst = append(dst, 0)
		}
	}
	// v3 fields APPENDED after helmet: a v2 record's bytes are unchanged
	// (its mask never sets these bits) — see the layout doc.
	if mask&StateMainMag != 0 {
		dst = binary.LittleEndian.AppendUint16(dst, s.mainMag)
	}
	if mask&StateMainReserve != 0 {
		dst = binary.LittleEndian.AppendUint16(dst, s.mainReserve)
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

// decodeStateRecordAt decodes the record starting at off (frame and mask
// are uvarints), returning the decoded record and the byte after it.
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
	if off+1 > len(b) {
		return r, 0, errCorrupt("truncated state record header")
	}
	r.Slot = int(b[off])
	off++
	if r.Slot >= maxSlots {
		return r, 0, errCorrupt("state slot out of range")
	}
	mask, n := binary.Uvarint(b[off:])
	if n <= 0 {
		return r, 0, errCorrupt("bad state mask")
	}
	off += n
	r.Mask = uint16(mask)
	if uint64(r.Mask) != mask || r.Mask & ^stateFields != 0 {
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
	if r.Has(StateMoney) {
		if r.Money, err = u16(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateHelmet) {
		v, e := u8()
		if e != nil {
			return r, 0, e
		}
		if v > 1 {
			return r, 0, errCorrupt("bad helmet flag")
		}
		r.Helmet = v == 1
	}
	if r.Has(StateMainMag) {
		if r.MainMag, err = u16(); err != nil {
			return r, 0, err
		}
	}
	if r.Has(StateMainReserve) {
		if r.MainReserve, err = u16(); err != nil {
			return r, 0, err
		}
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
