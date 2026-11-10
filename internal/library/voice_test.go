package library

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
	"google.golang.org/protobuf/proto"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
)

func TestInfoCompanionCandidates(t *testing.T) {
	cases := []struct {
		demo string
		want []string
	}{
		{"/demos/match730_1.dem.zst", []string{"/demos/match730_1.info", "/demos/match730_1.dem.zst.info", "/demos/match730_1.dem.zst.info"}},
		{"/demos/match730_1.dem", []string{"/demos/match730_1.dem.info", "/demos/match730_1.info", "/demos/match730_1.dem.info"}},
	}
	for _, c := range cases {
		got := infoCompanionCandidates(c.demo)
		if len(got) != len(c.want) {
			t.Fatalf("candidates(%s) = %v, want %v", c.demo, got, c.want)
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Errorf("candidates(%s)[%d] = %q, want %q", c.demo, i, got[i], c.want[i])
			}
		}
	}
}

func TestFindInfoFile(t *testing.T) {
	t.Run("none", func(t *testing.T) {
		if got := findInfoFile(filepath.Join(t.TempDir(), "solo.dem.zst")); got != "" {
			t.Errorf("findInfoFile(no companions) = %q, want empty", got)
		}
	})

	t.Run("zst demo picks trimmed .info first", func(t *testing.T) {
		dir := t.TempDir()
		demo := filepath.Join(dir, "m.dem.zst")
		trimmed := filepath.Join(dir, "m.info")      // candidate 1
		full := filepath.Join(dir, "m.dem.zst.info") // candidates 2/3
		for _, p := range []string{demo, trimmed, full} {
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := findInfoFile(demo); got != trimmed {
			t.Errorf("findInfoFile = %q, want %q (candidate 1 wins)", got, trimmed)
		}
	})

	t.Run("raw dem picks dem.info before trimmed", func(t *testing.T) {
		dir := t.TempDir()
		demo := filepath.Join(dir, "m.dem")
		demInfo := filepath.Join(dir, "m.dem.info") // candidate 1
		trimmed := filepath.Join(dir, "m.info")     // candidate 2
		for _, p := range []string{demo, demInfo, trimmed} {
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := findInfoFile(demo); got != demInfo {
			t.Errorf("findInfoFile = %q, want %q (candidate 1 wins)", got, demInfo)
		}
	})

	t.Run("candidate 1 absent falls through to path.info", func(t *testing.T) {
		dir := t.TempDir()
		// .dem.zst demo: candidate 1 (trimmed .info) is absent, so the
		// first hit is candidate 2/3 — path+".info".
		zst := filepath.Join(dir, "z.dem.zst")
		onlyThird := filepath.Join(dir, "z.dem.zst.info")
		for _, p := range []string{zst, onlyThird} {
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := findInfoFile(zst); got != onlyThird {
			t.Errorf("findInfoFile = %q, want %q (candidate 2/3)", got, onlyThird)
		}
	})
}

func TestNetKeyFromInfoFile(t *testing.T) {
	t.Run("valid key", func(t *testing.T) {
		dir := t.TempDir()
		demo := filepath.Join(dir, "m.dem")
		if err := os.WriteFile(demo, []byte("demo"), 0o600); err != nil {
			t.Fatal(err)
		}
		keyPub := uint64(0x0123456789abcdef)
		raw, err := proto.Marshal(&msg.CDataGCCStrike15V2_MatchInfo{
			Watchablematchinfo: &msg.WatchableMatchInfo{
				ClDecryptdataKeyPub: &keyPub,
			},
		})
		if err != nil {
			t.Fatalf("marshal MatchInfo: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "m.dem.info"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		key := netKeyFromInfoFile(demo)
		if string(key) != "0123456789ABCDEF" {
			t.Errorf("key = %q (len %d), want %q (16 bytes)", key, len(key), "0123456789ABCDEF")
		}
	})

	t.Run("garbage info never panics, no key", func(t *testing.T) {
		dir := t.TempDir()
		demo := filepath.Join(dir, "m.dem")
		if err := os.WriteFile(demo, []byte("demo"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "m.dem.info"), []byte("not a protobuf \xff\xfe"), 0o600); err != nil {
			t.Fatal(err)
		}
		if key := netKeyFromInfoFile(demo); key != nil {
			t.Errorf("key = %x, want nil (garbage companion)", key)
		}
	})

	t.Run("no companion", func(t *testing.T) {
		if key := netKeyFromInfoFile(filepath.Join(t.TempDir(), "missing.dem")); key != nil {
			t.Errorf("key = %x, want nil (no companion)", key)
		}
	})
}

// voiceParse feeds the wired VoiceSink a small deterministic stream and
// returns the same minimal ExtractedMatch as fakeParse.
func voiceParse(ctx context.Context, r io.Reader, opts extract.ParseOptions) (*models.ExtractedMatch, error) {
	if _, err := io.ReadAll(r); err != nil {
		return nil, err
	}
	if opts.Voice != nil {
		for i := 0; i < 6; i++ {
			xuid := uint64(100 + i%2)
			payload := bytes.Repeat([]byte{byte(i + 1)}, 10+i)
			if err := opts.Voice.Add(extract.VoiceChunk{
				Tick: 1000 + i*64, XUID: xuid, Payload: payload, Section: uint32(i / 2),
			}); err != nil {
				return nil, err
			}
		}
	}
	return &models.ExtractedMatch{Match: models.Match{Map: "de_test", TickRate: 64}}, nil
}

// TestImportWritesVoice proves the M4 import wiring end to end with a fake
// parser: voice dir + per-player .opus payloads + .idx chunk index land in
// the sidecar dir, and the store carries the voice_presence header (the
// index itself is never in SQLite).
func TestImportWritesVoice(t *testing.T) {
	im, st := newTestImporter(t, voiceParse)
	path := writeDemo(t, "voice.dem", "not-really-a-demo")

	ids := im.Enqueue([]string{path})
	if len(ids) != 1 {
		t.Fatalf("Enqueue returned %d ids, want 1", len(ids))
	}
	job := waitStatus(t, st, ids[0], models.JobDone)
	if job.MatchID == 0 {
		t.Fatal("job has no match link")
	}

	presence, err := st.GetVoicePresence(job.MatchID)
	if err != nil {
		t.Fatalf("GetVoicePresence: %v", err)
	}
	if presence.ChunkCount != 6 || presence.PlayerCount != 2 || presence.CasterCount != 0 {
		t.Errorf("presence = %+v, want chunks 6 players 2 casters 0", presence)
	}
	if presence.KeyFound {
		t.Error("KeyFound = true, want false (no .info companion)")
	}
	if presence.OutSampleRate != models.VoiceOutSampleRate {
		t.Errorf("OutSampleRate = %d, want %d", presence.OutSampleRate, models.VoiceOutSampleRate)
	}

	matchDir := filepath.Join(im.sidecarDir, strconv.FormatInt(job.MatchID, 10))
	rd, err := sidecar.OpenVoice(matchDir)
	if err != nil {
		t.Fatalf("OpenVoice: %v", err)
	}
	stats, err := rd.Players()
	if err != nil {
		t.Fatalf("Players: %v", err)
	}
	if len(stats) != 2 {
		t.Fatalf("index players = %d, want 2", len(stats))
	}
	ticks := 0
	for _, p := range stats {
		playerTicks, err := rd.Ticks(p.SteamID)
		if err != nil {
			t.Fatalf("Ticks(%s): %v", p.SteamID, err)
		}
		ticks += len(playerTicks)
	}
	if ticks != 6 {
		t.Fatalf("ticks = %d, want 6", ticks)
	}

	// Per-player payload files exist with byte-accurate index rows.
	for _, steamID := range []string{"100", "101"} {
		rows, err := rd.Chunks(steamID, 0, 1<<30)
		if err != nil {
			t.Fatalf("Chunks(%s): %v", steamID, err)
		}
		if len(rows) != 3 {
			t.Fatalf("rows(%s) = %d, want 3", steamID, len(rows))
		}
		voicePath := filepath.Join(matchDir, sidecar.VoiceDirName, steamID+".opus")
		f, err := os.Open(voicePath)
		if err != nil {
			t.Fatalf("open voice file %s: %v", steamID, err)
		}
		raw, err := io.ReadAll(f)
		_ = f.Close()
		if err != nil {
			t.Fatalf("read voice file: %v", err)
		}
		var want int64
		for _, r := range rows {
			want += r.Len
			if r.Off+r.Len > int64(len(raw)) {
				t.Fatalf("row off+len %d+%d beyond file %d", r.Off, r.Len, len(raw))
			}
		}
		if int64(len(raw)) != want {
			t.Errorf("file %s size = %d, want %d (sum of row lengths)", steamID, len(raw), want)
		}
	}
}
