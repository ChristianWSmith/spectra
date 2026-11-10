package sidecar

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// ErrNoVoiceIndex reports that a match holds no voice chunk index (the
// voice directory has no <steamid>.idx files). Absence is NOT corruption: a
// demo without voice — or a match imported before the index moved out of
// the database — yields it, and callers treat it as "no voice", exactly
// like ErrNoSidecar ("no replay data" is not a failure).
var ErrNoVoiceIndex = errors.New("sidecar: no voice index")

// errNoVoicePlayer reports that one player has no index file inside a match
// that does have one. Absent per player = no chunks for that player (the
// silence a non-speaking player already gets), never an error.
var errNoVoicePlayer = errors.New("sidecar: no voice index for player")

// VoicePlayerStat is one speaking player's summary (VoiceReader.Players).
type VoicePlayerStat struct {
	SteamID   string // decimal SteamID64 (the .idx/.opus file stem)
	Chunks    int    // index records
	FirstTick int    // lowest chunk tick (0 when Chunks == 0)
	LastTick  int    // highest chunk tick
	Bytes     int64  // payload bytes in <steamid>.opus
}

// VoiceReader serves one match's voice chunk index (the <steamid>.idx
// files VoiceWriter.Close writes beside the .opus payloads). The index
// IS the chunk source: rows carry Off/Len into that player's payload.
// Records are fixed-width and tick-sorted, so a range read (Chunks)
// binary-searches the file ON disk and pulls only the window's records —
// the whole-file reads (Players/Ticks/PlayersWithTicks) validate every
// record, a windowed read validates only the ones it returns. No cache is
// kept between requests.
//
// The reader only ever imports internal/models (never the store — the store
// must not depend on this package; that would be an import cycle).
type VoiceReader struct {
	dir     string   // the voice directory (<matchDir>/voice)
	players []string // steam IDs owning an index file, directory order
}

// OpenVoice opens the voice index inside dir, where dir is the MATCH
// directory — the same argument NewVoiceWriter takes. A missing directory
// or one with no *.idx files yields ErrNoVoiceIndex (no voice at all); a
// present-but-truncated index fails at the read that touches it, with a
// corruption error (corrupt ≠ absent: only files that exist can be corrupt).
// Open is a directory listing only — per-player index files are read by the
// accessors, so opening per request stays negligible.
func OpenVoice(dir string) (*VoiceReader, error) {
	voiceDir := filepath.Join(dir, VoiceDirName)
	entries, err := os.ReadDir(voiceDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNoVoiceIndex
		}
		return nil, fmt.Errorf("sidecar: read voice directory: %w", err)
	}
	players := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), voiceIdxExt) {
			continue
		}
		players = append(players, strings.TrimSuffix(e.Name(), voiceIdxExt))
	}
	if len(players) == 0 {
		return nil, ErrNoVoiceIndex
	}
	return &VoiceReader{dir: voiceDir, players: players}, nil
}

// Players returns one stat per index file: the chunk count (index size ÷
// 16 — a size that is not a multiple of 16 is corrupt), the first/last
// tick over the whole file, and the payload file's byte size. Whole-file
// validation: every record is checked against the payload size.
func (r *VoiceReader) Players() ([]VoicePlayerStat, error) {
	idx, err := r.PlayersWithTicks()
	if err != nil {
		return nil, err
	}
	out := make([]VoicePlayerStat, len(idx))
	for i, p := range idx {
		out[i] = p.VoicePlayerStat
	}
	return out, nil
}

// VoicePlayerIndex pairs one player's summary with every captured tick —
// the one-read metadata payload behind the voice listings: stats AND the
// lane-bucketing/window source from a single pass over the file, instead
// of Players() + Ticks() reading it twice.
type VoicePlayerIndex struct {
	VoicePlayerStat
	Ticks []int // every captured chunk tick, in index order
}

// PlayersWithTicks reads each player's index ONCE and yields the summary
// plus every captured tick (the union of Players + Ticks with one file
// read per player instead of two — the match-load walk). Whole-file
// validation, exactly like Players.
func (r *VoiceReader) PlayersWithTicks() ([]VoicePlayerIndex, error) {
	out := make([]VoicePlayerIndex, 0, len(r.players))
	for _, steamID := range r.players {
		recs, payload, err := r.readPlayer(steamID)
		if err != nil {
			return nil, err
		}
		p := VoicePlayerIndex{
			VoicePlayerStat: VoicePlayerStat{SteamID: steamID, Chunks: len(recs), Bytes: payload},
			Ticks:           make([]int, 0, len(recs)),
		}
		// Min/max rather than first/last: honest even if a hand-edited
		// index ever lost its tick order (the writer sorts at Close).
		for _, rec := range recs {
			t := int(rec.Tick)
			p.Ticks = append(p.Ticks, t)
			if len(p.Ticks) == 1 {
				p.FirstTick, p.LastTick = t, t
				continue
			}
			if t < p.FirstTick {
				p.FirstTick = t
			}
			if t > p.LastTick {
				p.LastTick = t
			}
		}
		out = append(out, p)
	}
	return out, nil
}

// Ticks returns every captured chunk tick for one player, in index order
// (tick-sorted, ties in capture order) — the lane-bucketing source, no
// decode involved. A player without an index file yields no ticks (not an
// error: they simply never spoke).
func (r *VoiceReader) Ticks(steamID string) ([]int, error) {
	recs, _, err := r.readPlayer(steamID)
	if err != nil {
		if errors.Is(err, errNoVoicePlayer) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]int, 0, len(recs))
	for _, rec := range recs {
		out = append(out, int(rec.Tick))
	}
	return out, nil
}

// Chunks returns one player's index records with from <= tick <= to, in
// index order — the PCM/WAV decode source (rows carry Off/Len into that
// player's .opus file). The index is tick-sorted by contract, so the
// window's record range is located by two on-disk binary searches and
// pulled with ONE ReadAt: only those records are parsed and validated
// against the payload size (corruption outside the requested window is
// the whole-file readers' job — Players/Ticks/PlayersWithTicks). A player
// without an index file yields no chunks.
func (r *VoiceReader) Chunks(steamID string, from, to int) ([]models.VoiceIndexRow, error) {
	// Same stem guard as readPlayer: a non-decimal stem — notably a path
	// segment arriving in a query string — reads as "that player has no
	// index" and can never leave the voice directory.
	if !decimalSteamID(steamID) {
		return nil, nil
	}
	f, err := os.Open(filepath.Join(r.dir, steamID+voiceIdxExt)) //nolint:gosec // stem is decimal-checked above
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("sidecar: read voice index %s: %w", steamID, err)
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("sidecar: stat voice index %s: %w", steamID, err)
	}
	size := fi.Size()
	if size%voiceIdxRecordSize != 0 {
		return nil, errCorrupt(fmt.Sprintf(
			"voice index %s length %d is not a multiple of %d", steamID, size, voiceIdxRecordSize))
	}
	// The payload bound every returned record's Off/Len must stay inside:
	// an index without its payload is a torn pair — fail loud, exactly
	// like readPlayer (corrupt ≠ absent: the index exists).
	payload, err := os.Stat(filepath.Join(r.dir, steamID+voicePayloadExt)) //nolint:gosec // stem is decimal-checked above
	if err != nil {
		return nil, fmt.Errorf("sidecar: voice index %s has no payload: %w", steamID, err)
	}
	paySize := payload.Size()
	// First record with tick >= from, then the first with tick > to — both
	// probes read only 4 bytes per step off disk (log2 of the record count).
	lo, err := searchIndexTick(f, int(size/voiceIdxRecordSize), func(t int) bool { return t >= from })
	if err != nil {
		return nil, fmt.Errorf("sidecar: search voice index %s: %w", steamID, err)
	}
	hi, err := searchIndexTick(f, int(size/voiceIdxRecordSize), func(t int) bool { return t > to })
	if err != nil {
		return nil, fmt.Errorf("sidecar: search voice index %s: %w", steamID, err)
	}
	if lo >= hi {
		return nil, nil
	}
	raw := make([]byte, (hi-lo)*voiceIdxRecordSize)
	if _, err := f.ReadAt(raw, int64(lo)*voiceIdxRecordSize); err != nil {
		return nil, fmt.Errorf("sidecar: read voice index %s records [%d,%d): %w", steamID, lo, hi, err)
	}
	out := make([]models.VoiceIndexRow, 0, hi-lo)
	for off := 0; off < len(raw); off += voiceIdxRecordSize {
		rec := decodeVoiceIdxRecord(raw[off : off+voiceIdxRecordSize])
		if rec.Off+rec.Len > paySize {
			return nil, errCorrupt(fmt.Sprintf(
				"voice index %s record %d spans %d+%d beyond payload %d bytes",
				steamID, lo+off/voiceIdxRecordSize, rec.Off, rec.Len, paySize))
		}
		out = append(out, models.VoiceIndexRow{
			Tick:    int(rec.Tick),
			SteamID: steamID,
			Off:     rec.Off,
			Len:     rec.Len,
			Caster:  rec.Caster,
			Section: rec.Section,
		})
	}
	return out, nil
}

// searchIndexTick binary-searches the first record index whose tick
// satisfies pred (ticks ascend by index — the writer's Close sort), probing
// the on-disk record's 4-byte tick field only: log2(records) small reads,
// never the whole file. Read errors abort the search (returned, never
// silently mis-ordered).
func searchIndexTick(f *os.File, records int, pred func(tick int) bool) (int, error) {
	lo, hi := 0, records
	var buf [4]byte
	for lo < hi {
		mid := lo + (hi-lo)/2
		if _, err := f.ReadAt(buf[:], int64(mid)*voiceIdxRecordSize); err != nil {
			return 0, err
		}
		if pred(int(int32(binary.LittleEndian.Uint32(buf[:])))) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo, nil
}

// voiceIdxRecord is one decoded <steamid>.idx record (the layout written
// by VoiceWriter.Close — see voice.go).
type voiceIdxRecord struct {
	Tick    int32
	Off     int64
	Len     int64
	Section uint32
	Caster  bool
}

// decodeVoiceIdxRecord decodes one fixed-width record — THE record
// decoder, shared by the whole-file readers and the windowed read (never
// a second field layout).
func decodeVoiceIdxRecord(raw []byte) voiceIdxRecord {
	return voiceIdxRecord{
		Tick:    int32(binary.LittleEndian.Uint32(raw[0:4])),
		Off:     int64(binary.LittleEndian.Uint32(raw[4:8])),
		Section: binary.LittleEndian.Uint32(raw[8:12]),
		Len:     int64(binary.LittleEndian.Uint16(raw[12:14])),
		Caster:  raw[14]&voiceIdxFlagCaster != 0,
	}
}

// readPlayer reads and validates one player's whole index plus the payload
// size it must stay inside. errNoVoicePlayer when the player has no index
// file (absence, callers fail soft).
func (r *VoiceReader) readPlayer(steamID string) ([]voiceIdxRecord, int64, error) {
	// Every real stem is strconv.FormatUint decimal (see VoiceWriter.Add),
	// so a non-decimal — notably a path segment arriving in a query string
	// — can never leave the voice directory, and reads as "that player has
	// no index".
	if !decimalSteamID(steamID) {
		return nil, 0, errNoVoicePlayer
	}
	raw, err := os.ReadFile(filepath.Join(r.dir, steamID+voiceIdxExt)) //nolint:gosec // stem is decimal-checked above
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, errNoVoicePlayer
		}
		return nil, 0, fmt.Errorf("sidecar: read voice index %s: %w", steamID, err)
	}
	if len(raw)%voiceIdxRecordSize != 0 {
		return nil, 0, errCorrupt(fmt.Sprintf(
			"voice index %s length %d is not a multiple of %d", steamID, len(raw), voiceIdxRecordSize))
	}
	payload, err := os.Stat(filepath.Join(r.dir, steamID+voicePayloadExt)) //nolint:gosec // stem is decimal-checked above
	if err != nil {
		// An index without its payload is a torn pair, not a match
		// without voice — the index exists, so fail loud.
		return nil, 0, fmt.Errorf("sidecar: voice index %s has no payload: %w", steamID, err)
	}
	size := payload.Size()
	recs := make([]voiceIdxRecord, 0, len(raw)/voiceIdxRecordSize)
	for off := 0; off < len(raw); off += voiceIdxRecordSize {
		rec := decodeVoiceIdxRecord(raw[off : off+voiceIdxRecordSize])
		if rec.Off+rec.Len > size {
			return nil, 0, errCorrupt(fmt.Sprintf(
				"voice index %s record %d spans %d+%d beyond payload %d bytes",
				steamID, len(recs), rec.Off, rec.Len, size))
		}
		recs = append(recs, rec)
	}
	return recs, size, nil
}

// decimalSteamID reports whether s is a plausible per-player file stem:
// non-empty and all ASCII digits (every stem the writer emits is
// strconv.FormatUint of the XUID).
func decimalSteamID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
