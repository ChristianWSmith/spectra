package sidecar

import (
	"bytes"
	"errors"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// voiceStream is a synthetic 3-player chunk stream with deterministic
// payloads (byte i of chunk n = xuid*10 + n) so read-back slices prove
// byte-accurate offsets.
func voiceStream() []extract.VoiceChunk {
	xuids := []uint64{76561198000000001, 76561198000000002, 76561198000000003}
	var chunks []extract.VoiceChunk
	for n := 0; n < 30; n++ {
		x := xuids[n%len(xuids)]
		payload := bytes.Repeat([]byte{byte(x*10 + uint64(n))}, 3+n%5)
		chunks = append(chunks, extract.VoiceChunk{
			Tick:    1000 + n*3,
			XUID:    x,
			Payload: payload,
			Caster:  n == 7, // exactly one caster chunk
			Section: uint32(n / len(xuids)),
		})
	}
	return chunks
}

func TestVoiceWriterRoundtrip(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	chunks := voiceStream()
	for _, c := range chunks {
		if err := w.Add(c); err != nil {
			t.Fatalf("Add(tick=%d xuid=%d): %v", c.Tick, c.XUID, err)
		}
	}
	meta, rows, err := w.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}

	wantBytes := 0
	for _, c := range chunks {
		wantBytes += len(c.Payload)
	}
	if meta.Chunks != len(chunks) || meta.Players != 3 || meta.Casters != 1 || meta.Bytes != wantBytes {
		t.Errorf("meta = %+v, want {Chunks:%d Players:3 Casters:1 Bytes:%d}",
			meta, len(chunks), wantBytes)
	}
	if len(rows) != len(chunks) {
		t.Fatalf("rows = %d, want %d", len(rows), len(chunks))
	}

	// Rows are in capture order with per-player offsets; SteamIDs decimal.
	offOf := map[string]int64{}
	for i, r := range rows {
		c := chunks[i]
		wantSteam := strconv.FormatUint(c.XUID, 10)
		if r.SteamID != wantSteam {
			t.Errorf("rows[%d].SteamID = %s, want %s", i, r.SteamID, wantSteam)
		}
		if r.Tick != c.Tick {
			t.Errorf("rows[%d].Tick = %d, want %d", i, r.Tick, c.Tick)
		}
		if r.Caster != c.Caster {
			t.Errorf("rows[%d].Caster = %v, want %v", i, r.Caster, c.Caster)
		}
		if r.Section != c.Section {
			t.Errorf("rows[%d].Section = %d, want %d", i, r.Section, c.Section)
		}
		if r.Off != offOf[r.SteamID] {
			t.Errorf("rows[%d].Off = %d, want %d (player %s append offset)", i, r.Off, offOf[r.SteamID], r.SteamID)
		}
		if r.Len != int64(len(c.Payload)) {
			t.Errorf("rows[%d].Len = %d, want %d", i, r.Len, len(c.Payload))
		}
		offOf[r.SteamID] = r.Off + r.Len

		// Byte-accurate read-back: Off..Off+Len slices the player file to
		// exactly this chunk's payload.
		path := filepath.Join(dir, VoiceDirName, r.SteamID+".opus")
		raw, err := os.ReadFile(path) //nolint:gosec // test-controlled temp path
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		got := raw[r.Off : r.Off+r.Len]
		if !bytes.Equal(got, c.Payload) {
			t.Errorf("rows[%d] payload mismatch: got %d bytes %x, want %x", i, len(got), got[:min(8, len(got))], c.Payload[:min(8, len(c.Payload))])
		}
	}

	// Per-player files exist and their sizes equal the player's total bytes.
	for xuid, final := range offOf {
		fi, err := os.Stat(filepath.Join(dir, VoiceDirName, xuid+".opus"))
		if err != nil {
			t.Fatalf("stat player file %s: %v", xuid, err)
		}
		if fi.Size() != final {
			t.Errorf("player %s file size = %d, want %d", xuid, fi.Size(), final)
		}
	}

	// Close also writes the index: one .idx per player, and the reader
	// returns exactly the writer's rows — byte-accurate Off/Len, ticks
	// sorted (capture order here: each player's ticks are increasing).
	rd, err := OpenVoice(dir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}
	stats, err := rd.Players()
	if err != nil {
		t.Fatalf("Players: %v", err)
	}
	if len(stats) != 3 {
		t.Fatalf("player stats = %d, want 3", len(stats))
	}
	bySteam := map[string]int{}
	for _, st := range stats {
		if st.Bytes != offOf[st.SteamID] {
			t.Errorf("player %s bytes = %d, want payload size %d", st.SteamID, st.Bytes, offOf[st.SteamID])
		}
		if st.Chunks == 0 {
			t.Errorf("player %s has 0 chunks", st.SteamID)
		}
		bySteam[st.SteamID] = st.Chunks
	}
	for _, r := range rows {
		if bySteam[r.SteamID] == 0 {
			t.Fatalf("no index stats for player %s", r.SteamID)
		}
	}
	for _, want := range []string{"76561198000000001", "76561198000000002", "76561198000000003"} {
		got, err := rd.Chunks(want, -1<<30, 1<<30)
		if err != nil {
			t.Fatalf("Chunks(%s): %v", want, err)
		}
		var wantRows []models.VoiceIndexRow
		for _, r := range rows {
			if r.SteamID == want {
				wantRows = append(wantRows, r)
			}
		}
		if len(got) != len(wantRows) {
			t.Fatalf("chunks(%s) = %d, want %d", want, len(got), len(wantRows))
		}
		for i := range wantRows {
			g, w := got[i], wantRows[i]
			if g.Tick != w.Tick || g.Off != w.Off || g.Len != w.Len ||
				g.Caster != w.Caster || g.Section != w.Section || g.SteamID != w.SteamID {
				t.Errorf("chunks(%s)[%d] = %+v, want %+v", want, i, g, w)
			}
		}
		ticks, err := rd.Ticks(want)
		if err != nil {
			t.Fatalf("Ticks(%s): %v", want, err)
		}
		for i := 1; i < len(ticks); i++ {
			if ticks[i] < ticks[i-1] {
				t.Fatalf("Ticks(%s) not sorted: %v", want, ticks)
			}
		}
	}

	// Close is single-shot (positions.Writer.Close convention).
	if _, _, err := w.Close(); err == nil {
		t.Error("second Close: err = nil, want already-closed error")
	}
}

// TestVoiceIndexTickSortedWithTies pins the on-disk order: records are
// sorted by tick at Close, and equal ticks KEEP CAPTURE ORDER (the stable
// sort) — the reader's binary search depends on the first, and a burst of
// same-tick speech must replay in the order it was captured.
func TestVoiceIndexTickSortedWithTies(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	// Capture order deliberately NOT tick order; one player, 1-byte
	// payloads so Off is the capture index.
	stream := []extract.VoiceChunk{
		{Tick: 300, XUID: 7, Payload: []byte{0xAA}}, // off 0
		{Tick: 100, XUID: 7, Payload: []byte{0xBB}}, // off 1
		{Tick: 100, XUID: 7, Payload: []byte{0xCC}}, // off 2
		{Tick: 200, XUID: 7, Payload: []byte{0xDD}}, // off 3
		{Tick: 100, XUID: 7, Payload: []byte{0xEE}}, // off 4
	}
	for _, c := range stream {
		if err := w.Add(c); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	rd, err := OpenVoice(dir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}
	rows, err := rd.Chunks("7", 0, 1<<30)
	if err != nil {
		t.Fatalf("Chunks: %v", err)
	}
	wantTicks := []int{100, 100, 100, 200, 300}
	wantOffs := []int64{1, 2, 4, 3, 0} // ties in capture order
	if len(rows) != len(wantTicks) {
		t.Fatalf("rows = %d, want %d", len(rows), len(wantTicks))
	}
	for i := range wantTicks {
		if rows[i].Tick != wantTicks[i] || rows[i].Off != wantOffs[i] {
			t.Errorf("row[%d] = tick %d off %d, want tick %d off %d",
				i, rows[i].Tick, rows[i].Off, wantTicks[i], wantOffs[i])
		}
	}

	// Window read: [100,200] is the three ties plus the 200 chunk.
	win, err := rd.Chunks("7", 100, 200)
	if err != nil {
		t.Fatalf("Chunks(window): %v", err)
	}
	if len(win) != 4 {
		t.Fatalf("window = %d rows, want 4", len(win))
	}
	// Beyond the last chunk is an empty window, not an error.
	empty, err := rd.Chunks("7", 1<<30, 1<<31)
	if err != nil || len(empty) != 0 {
		t.Errorf("Chunks(out of range) = %v, %v; want empty, nil", empty, err)
	}
}

func TestVoiceWriterTruncatesOnRewrite(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	big := bytes.Repeat([]byte{0xAA}, 64)
	for i := 0; i < 5; i++ {
		if err := w.Add(extract.VoiceChunk{Tick: i, XUID: 42, Payload: big}); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	path := filepath.Join(dir, VoiceDirName, "42.opus")
	if fi, err := os.Stat(path); err != nil || fi.Size() != 320 {
		t.Fatalf("pre-rewrite size = %v %v, want 320", fi, err)
	}
	idxPath := filepath.Join(dir, VoiceDirName, "42.idx")
	if fi, err := os.Stat(idxPath); err != nil || fi.Size() != 5*voiceIdxRecordSize {
		t.Fatalf("pre-rewrite index size = %v %v, want %d", fi, err, 5*voiceIdxRecordSize)
	}

	// Rewrite: NewVoiceWriter + os.Create must truncate the stale payload,
	// and Close must truncate the stale index in place (os.WriteFile).
	w2, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter (rewrite): %v", err)
	}
	if err := w2.Add(extract.VoiceChunk{Tick: 99, XUID: 42, Payload: []byte{1, 2, 3}}); err != nil {
		t.Fatalf("Add (rewrite): %v", err)
	}
	meta, rows, err := w2.Close()
	if err != nil {
		t.Fatalf("Close (rewrite): %v", err)
	}
	if meta.Chunks != 1 || meta.Bytes != 3 {
		t.Errorf("rewrite meta = %+v, want {Chunks:1 Bytes:3}", meta)
	}
	raw, err := os.ReadFile(path) //nolint:gosec // test-controlled temp path
	if err != nil {
		t.Fatalf("read rewritten file: %v", err)
	}
	if !bytes.Equal(raw, []byte{1, 2, 3}) {
		t.Errorf("rewritten file = %x, want 010203", raw)
	}
	if rows[0].Off != 0 || rows[0].Len != 3 {
		t.Errorf("rewrite row = %+v, want Off=0 Len=3", rows[0])
	}

	// The rewritten index carries exactly the one new record.
	rd, err := OpenVoice(dir)
	if err != nil {
		t.Fatalf("OpenVoice (rewrite): %v", err)
	}
	got, err := rd.Chunks("42", -1<<30, 1<<30)
	if err != nil {
		t.Fatalf("Chunks (rewrite): %v", err)
	}
	if len(got) != 1 || got[0].Tick != 99 || got[0].Off != 0 || got[0].Len != 3 {
		t.Errorf("rewritten index = %+v, want one tick-99 record Off 0 Len 3", got)
	}
}

func TestVoiceWriterAddAfterClose(t *testing.T) {
	w, err := NewVoiceWriter(t.TempDir())
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.Add(extract.VoiceChunk{XUID: 1, Payload: []byte{0}}); err == nil {
		t.Error("Add after Close: err = nil, want error")
	}
}

// TestVoiceChunksRangeEqualsFull pins the windowed read against the
// whole-file read: for random AND boundary windows Chunks(from, to)
// returns exactly the full-range rows with from <= tick <= to — the range
// read (item: on-disk binary search + one ReadAt) may only change WHICH
// bytes are touched, never the rows it yields.
func TestVoiceChunksRangeEqualsFull(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	// One player: 200 chunks folded into 1000 ticks (many same-tick ties)
	// plus two far outliers — windows land on record boundaries, inside
	// gaps, on ties and outside the range entirely.
	for n := 0; n < 200; n++ {
		tick := (n * 37) % 1000
		switch n {
		case 0:
			tick = 0
		case 199:
			tick = 999999
		}
		if err := w.Add(extract.VoiceChunk{
			Tick:    tick,
			XUID:    7,
			Payload: []byte{byte(n), byte(n >> 8)},
		}); err != nil {
			t.Fatalf("Add(n=%d): %v", n, err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	rd, err := OpenVoice(dir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}
	full, err := rd.Chunks("7", -1<<30, 1<<30)
	if err != nil {
		t.Fatalf("Chunks(full): %v", err)
	}
	if len(full) != 200 {
		t.Fatalf("full read = %d rows, want 200", len(full))
	}
	// The whole-file parse is the reference the windowed read must match.
	rowsEqual := func(got, want []models.VoiceIndexRow) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	filter := func(from, to int) []models.VoiceIndexRow {
		var out []models.VoiceIndexRow
		for _, r := range full {
			if r.Tick >= from && r.Tick <= to {
				out = append(out, r)
			}
		}
		return out
	}
	check := func(from, to int) {
		t.Helper()
		got, err := rd.Chunks("7", from, to)
		if err != nil {
			t.Fatalf("Chunks(%d,%d): %v", from, to, err)
		}
		if want := filter(from, to); !rowsEqual(got, want) {
			t.Fatalf("Chunks(%d,%d) = %+v, want %+v", from, to, got, want)
		}
	}
	// Deterministic pseudo-random windows (fixed seed): empties, gaps,
	// inverted ranges and spans over the whole tick domain.
	rng := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < 400; i++ {
		from := rng.IntN(1300) - 150
		to := from + rng.IntN(600) - 100
		check(from, to)
	}
	// Boundary windows pinned around real chunk ticks: exact point, both
	// neighbours, and the two-point spans that include/exclude one edge.
	for _, r := range []models.VoiceIndexRow{full[0], full[1], full[100], full[199]} {
		check(r.Tick, r.Tick)
		check(r.Tick-1, r.Tick)
		check(r.Tick, r.Tick+1)
		check(r.Tick+1, r.Tick) // from > to → empty
	}
	// Degenerate and out-of-range windows.
	check(5, 4)
	check(1<<30, 1<<31)
	check(-1<<31, -1<<30)
}

// TestVoicePlayersWithTicksMatchesPlayersAndTicks pins the merged one-pass
// read: it must yield exactly what Players() + Ticks() returned (stats and
// ticks alike) — the match-load walk reads each file once instead of twice.
func TestVoicePlayersWithTicksMatchesPlayersAndTicks(t *testing.T) {
	dir := t.TempDir()
	w, err := NewVoiceWriter(dir)
	if err != nil {
		t.Fatalf("NewVoiceWriter: %v", err)
	}
	for _, c := range voiceStream() {
		if err := w.Add(c); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if _, _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	rd, err := OpenVoice(dir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}
	merged, err := rd.PlayersWithTicks()
	if err != nil {
		t.Fatalf("PlayersWithTicks: %v", err)
	}
	stats, err := rd.Players()
	if err != nil {
		t.Fatalf("Players: %v", err)
	}
	if len(merged) != len(stats) {
		t.Fatalf("PlayersWithTicks = %d players, Players = %d", len(merged), len(stats))
	}
	for i, m := range merged {
		if m.VoicePlayerStat != stats[i] {
			t.Errorf("player %d stat = %+v, want %+v", i, m.VoicePlayerStat, stats[i])
		}
		wantTicks, err := rd.Ticks(m.SteamID)
		if err != nil {
			t.Fatalf("Ticks(%s): %v", m.SteamID, err)
		}
		if len(m.Ticks) != len(wantTicks) {
			t.Fatalf("player %s ticks = %d, want %d", m.SteamID, len(m.Ticks), len(wantTicks))
		}
		for j := range wantTicks {
			if m.Ticks[j] != wantTicks[j] {
				t.Errorf("player %s tick[%d] = %d, want %d", m.SteamID, j, m.Ticks[j], wantTicks[j])
			}
		}
	}
}

// TestVoiceReaderNoIndex: absence is ErrNoVoiceIndex — both "no voice
// directory" and "empty voice directory" mean the match has no voice, and
// neither is reported as corruption.
func TestVoiceReaderNoIndex(t *testing.T) {
	dir := t.TempDir()
	if _, err := OpenVoice(dir); !errors.Is(err, ErrNoVoiceIndex) {
		t.Errorf("OpenVoice(no voice dir) = %v, want ErrNoVoiceIndex", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, VoiceDirName), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenVoice(dir); !errors.Is(err, ErrNoVoiceIndex) {
		t.Errorf("OpenVoice(empty voice dir) = %v, want ErrNoVoiceIndex", err)
	}
	// Payloads without an index (a crash before Close) is still absence:
	// nothing can be addressed without the index.
	if err := os.WriteFile(filepath.Join(dir, VoiceDirName, "7.opus"), []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenVoice(dir); !errors.Is(err, ErrNoVoiceIndex) {
		t.Errorf("OpenVoice(payload only) = %v, want ErrNoVoiceIndex", err)
	}
}

// TestVoiceReaderCorruptGuards: an index that EXISTS must fail loud —
// corrupt is never mistaken for absent (ErrNoVoiceIndex) and the match's
// other players stay readable only through the error path, not silently
// short.
func TestVoiceReaderCorruptGuards(t *testing.T) {
	// A valid baseline: one player, one 4-byte chunk.
	writeIndex := func(t *testing.T, payload []byte, idx []byte) string {
		t.Helper()
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, VoiceDirName), 0o755); err != nil {
			t.Fatal(err)
		}
		vd := filepath.Join(dir, VoiceDirName)
		if err := os.WriteFile(filepath.Join(vd, "7.opus"), payload, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(vd, "7"+voiceIdxExt), idx, 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	valid := func() []byte {
		return appendVoiceIdxRecord(nil, models.VoiceIndexRow{Tick: 5, SteamID: "7", Off: 0, Len: 4})
	}

	t.Run("misaligned index size", func(t *testing.T) {
		dir := writeIndex(t, []byte{1, 2, 3, 4}, append(valid(), 0xAB))
		rd, err := OpenVoice(dir)
		if err != nil {
			t.Fatalf("OpenVoice (listing only): %v", err)
		}
		if _, err := rd.Players(); err == nil || errors.Is(err, ErrNoVoiceIndex) {
			t.Fatalf("Players(misaligned) = %v, want a corruption error (not ErrNoVoiceIndex)", err)
		}
	})

	t.Run("record beyond payload", func(t *testing.T) {
		// Off 0 + Len 64 against a 4-byte payload.
		bad := appendVoiceIdxRecord(nil, models.VoiceIndexRow{Tick: 5, SteamID: "7", Off: 0, Len: 64})
		dir := writeIndex(t, []byte{1, 2, 3, 4}, bad)
		rd, err := OpenVoice(dir)
		if err != nil {
			t.Fatalf("OpenVoice: %v", err) // Open is a listing only
		}
		if _, err := rd.Chunks("7", 0, 1<<30); err == nil || errors.Is(err, ErrNoVoiceIndex) {
			t.Fatalf("Chunks(beyond payload) = %v, want a corruption error", err)
		}
	})

	t.Run("index without payload", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, VoiceDirName), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, VoiceDirName, "7"+voiceIdxExt), valid(), 0o644); err != nil {
			t.Fatal(err)
		}
		rd, err := OpenVoice(dir)
		if err != nil {
			t.Fatalf("OpenVoice: %v", err)
		}
		if _, err := rd.Ticks("7"); err == nil {
			t.Fatal("Ticks(no payload) = nil, want an error")
		}
	})

	t.Run("player without index is empty, not an error", func(t *testing.T) {
		dir := writeIndex(t, []byte{1, 2, 3, 4}, valid())
		rd, err := OpenVoice(dir)
		if err != nil {
			t.Fatalf("OpenVoice: %v", err)
		}
		if rows, err := rd.Chunks("999", 0, 100); err != nil || len(rows) != 0 {
			t.Errorf("Chunks(unknown player) = %v, %v; want empty, nil", rows, err)
		}
		if ticks, err := rd.Ticks("999"); err != nil || len(ticks) != 0 {
			t.Errorf("Ticks(unknown player) = %v, %v; want empty, nil", ticks, err)
		}
		// A non-decimal stem (a path segment arriving in a query string)
		// never leaves the voice directory — it reads as "no such player".
		if rows, err := rd.Chunks("../../etc/passwd", 0, 100); err != nil || len(rows) != 0 {
			t.Errorf("Chunks(path segment) = %v, %v; want empty, nil", rows, err)
		}
	})
}
