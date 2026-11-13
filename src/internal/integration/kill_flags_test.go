package integration_test

// Round-4 kill-flag acceptance: the typed AttackerInAir column is derived
// from the raw player_death payload at extract time (agg.pairRaw — seam (b),
// chosen because demoinfocs dispatches the typed events.Kill BEFORE the
// events.GenericGameEvent for the same game event: a golden-parse probe on
// 2026-11-08 counted kill-first 170 / generic-first 0, so the Kill handler
// can never read the payload). This test proves the property on a real
// parse: for EVERY kill row the typed flag equals raw_json.attackerinair.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// openGoldenDemo opens the repo-root golden demo as a raw .dem stream
// (zstd-sniffed, same rule as TestGolden). Skips when absent/an LFS
// pointer — the helper assumes the caller already ran shouldSkip.
func openGoldenDemo(t *testing.T) io.Reader {
	t.Helper()
	f, err := os.Open(demoPath) //nolint:gosec // fixed repo-root golden demo
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	t.Cleanup(func() { _ = f.Close() })

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
		t.Cleanup(func() { zr.Close() })
		reader = zr
	}
	return reader
}

// TestGoldenKillAttackerInAirMatchesRawPayload is the golden equality test
// for the round-4 kill flag. Skipped under -short and when the demo is
// absent or an LFS pointer, like every other golden parse.
func TestGoldenKillAttackerInAirMatchesRawPayload(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}

	m, err := extract.Parse(context.Background(), openGoldenDemo(t), extract.ParseOptions{})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	if m == nil {
		t.Fatal("extract.Parse returned nil ExtractedMatch")
	}

	kills, withKey, truePayload, trueTyped, mismatched := 0, 0, 0, 0, 0
	for _, e := range m.Events {
		if e.Kind != models.EventKill {
			continue
		}
		kills++
		var raw map[string]any
		if err := json.Unmarshal([]byte(e.RawJSON), &raw); err != nil {
			t.Errorf("kill tick=%d seq=%d: raw_json is not a JSON object: %q (%v)", e.Tick, e.Seq, e.RawJSON, err)
			continue
		}
		v, ok := raw["attackerinair"]
		if !ok {
			// Pairing failure would show up here: every player_death
			// payload carries the key (golden census: 162/162 — the 8
			// knife/warmup kills are discarded at ingest and never reach
			// this loop).
			t.Errorf("kill tick=%d seq=%d: raw_json has no attackerinair key (%s)", e.Tick, e.Seq, e.RawJSON)
			continue
		}
		withKey++
		want, isBool := v.(bool)
		if !isBool {
			t.Errorf("kill tick=%d seq=%d: attackerinair = %T (%v), want bool", e.Tick, e.Seq, v, v)
			continue
		}
		if want {
			truePayload++
		}
		if e.AttackerInAir {
			trueTyped++
		}
		if e.AttackerInAir != want {
			mismatched++
			t.Errorf("kill tick=%d seq=%d: typed attackerInAir = %v, raw_json.attackerinair = %v",
				e.Tick, e.Seq, e.AttackerInAir, want)
		}
	}

	// Safety nets (always, independent of the per-row loop): the golden
	// baseline has 162 kills (170 minus the 8 knife/warmup kills the
	// discard drops) and every one of them carries the key, so an
	// unpaired/stale payload or a payload-shape change fails loudly even if
	// every flag happens to be false.
	if kills != 162 {
		t.Errorf("kill rows = %d, want 162 (golden baseline — knife/warmup kills discarded)", kills)
	}
	if withKey != kills {
		t.Errorf("kills with an attackerinair payload key = %d, want %d (every kill)", withKey, kills)
	}
	if mismatched != 0 {
		t.Errorf("%d kill rows disagree with their raw payload", mismatched)
	}
	// Equality of the two tallies (per-row equality implies it, but state
	// the contract explicitly): the typed column is a projection of the
	// payload, never an independent guess.
	if trueTyped != truePayload {
		t.Errorf("typed true count = %d, payload true count = %d", trueTyped, truePayload)
	}
	t.Logf("kills=%d withKey=%d attackerInAir true (payload/typed)=%d/%d",
		kills, withKey, truePayload, trueTyped)
}
