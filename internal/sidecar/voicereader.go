package sidecar

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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
// IS the chunk source: rows carry Off/Len into that player's payload, so
// a range read is a whole-file read plus a binary search — a player's
// index is ≤ ~900 KB, well under the millisecond budget, and no cache is
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
// tick over the whole file, and the payload file's byte size.
func (r *VoiceReader) Players() ([]VoicePlayerStat, error) {
	out := make([]VoicePlayerStat, 0, len(r.players))
	for _, steamID := range r.players {
		recs, payload, err := r.readPlayer(steamID)
		if err != nil {
			return nil, err
		}
		stat := VoicePlayerStat{SteamID: steamID, Chunks: len(recs), Bytes: payload}
		// Min/max rather than first/last: honest even if a hand-edited
		// index ever lost its tick order (the writer sorts at Close).
		if len(recs) > 0 {
			stat.FirstTick, stat.LastTick = int(recs[0].Tick), int(recs[0].Tick)
			for _, rec := range recs[1:] {
				if int(rec.Tick) < stat.FirstTick {
					stat.FirstTick = int(rec.Tick)
				}
				if int(rec.Tick) > stat.LastTick {
					stat.LastTick = int(rec.Tick)
				}
			}
		}
		out = append(out, stat)
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
// player's .opus file). Binary search for the window start, then a slice
// walk; a player without an index file yields no chunks.
func (r *VoiceReader) Chunks(steamID string, from, to int) ([]models.VoiceIndexRow, error) {
	recs, _, err := r.readPlayer(steamID)
	if err != nil {
		if errors.Is(err, errNoVoicePlayer) {
			return nil, nil
		}
		return nil, err
	}
	// First record with tick >= from (index is tick-sorted by contract).
	start := sort.Search(len(recs), func(i int) bool { return int(recs[i].Tick) >= from })
	var out []models.VoiceIndexRow
	for i := start; i < len(recs) && int(recs[i].Tick) <= to; i++ {
		rec := recs[i]
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

// voiceIdxRecord is one decoded <steamid>.idx record (the layout written
// by VoiceWriter.Close — see voice.go).
type voiceIdxRecord struct {
	Tick    int32
	Off     int64
	Len     int64
	Section uint32
	Caster  bool
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
		rec := voiceIdxRecord{
			Tick:    int32(binary.LittleEndian.Uint32(raw[off : off+4])),
			Off:     int64(binary.LittleEndian.Uint32(raw[off+4 : off+8])),
			Section: binary.LittleEndian.Uint32(raw[off+8 : off+12]),
			Len:     int64(binary.LittleEndian.Uint16(raw[off+12 : off+14])),
			Caster:  raw[off+14]&voiceIdxFlagCaster != 0,
		}
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
