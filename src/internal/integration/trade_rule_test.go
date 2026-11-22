package integration_test

// Trade-rule unification acceptance: analytics.Compute must rewrite
// player_stats.trade_kills from the cfg-aware kill tags pass so the
// frozen extractor column (import-time hardcoded 5 s) becomes
// analysis_config-aware — WITHOUT changing it at the default window.

import (
	"bytes"
	"context"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestTradeKillsMatchExtractorAtDefault pins option (a) on real data:
// at TradeWindowS = 5 (default) the recomputed per-player trade_kills
// equals the extractor's stored output for EVERY player of the golden
// demo, and a non-default window changes the values (configurability
// end-to-end). Skipped under -short / without the LFS demo, like
// TestGolden.
func TestTradeKillsMatchExtractorAtDefault(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}

	f, err := os.Open(demoPath) //nolint:gosec // path is the fixed repo-root golden demo
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
	m, err := extract.Parse(context.Background(), reader, extract.ParseOptions{})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}

	st, err := store.Open(t.TempDir() + "/trade.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-trade", "sha-golden-trade", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	// The extractor's stored output (import-time hardcoded 5 s rule).
	want := map[string]int{}
	var wantTotal int
	for _, ps := range m.PlayerStats {
		want[ps.SteamID] = ps.TradeKills
		wantTotal += ps.TradeKills
	}
	if wantTotal == 0 {
		t.Fatal("extractor trade_kills total = 0, fixture too weak to compare")
	}

	// Default config: the recompute must be a no-op for the column.
	cfg := analytics.ConfigFrom(models.AnalysisConfig{
		TradeWindowS: 5.0, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: store.DefaultConfig.TradeOppDistance, RuleVersion: 1,
	}, 0)
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute(5s): %v", err)
	}
	got := tradeKillsByPlayer(t, st, id)
	for sid, w := range want {
		if got[sid] != w {
			t.Errorf("player %s: recomputed trade_kills = %d, extractor stored %d (default config must not change)", sid, got[sid], w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("recomputed players = %d, extractor players = %d", len(got), len(want))
	}

	// Non-default window: the values must follow the config.
	cfg.TradeWindowS = 1.0
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute(1s): %v", err)
	}
	narrow := tradeKillsByPlayer(t, st, id)
	changed := false
	var narrowTotal int
	for _, n := range narrow {
		narrowTotal += n
	}
	for sid, w := range want {
		if narrow[sid] != w {
			changed = true
			break
		}
	}
	if !changed {
		t.Errorf("TradeWindowS 1s produced identical trade_kills (%d total) — window not applied", narrowTotal)
	}
	t.Logf("trade_kills: extractor@5s total=%d, recomputed@1s total=%d", wantTotal, narrowTotal)
}

// tradeKillsByPlayer reads the stored trade_kills column per SteamID —
// the scoreboard DTO no longer carries the seed-backed passthroughs
// (2026-11-18), so the raw column is read directly.
func tradeKillsByPlayer(t *testing.T, st *store.Store, id int64) map[string]int {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT steam_id, trade_kills FROM player_stats WHERE match_id = ?`,
		[]any{id}, 500, 5000)
	if err != nil {
		t.Fatalf("read player_stats.trade_kills: %v", err)
	}
	out := map[string]int{}
	for _, row := range res.Rows {
		sid, ok := row[0].(string)
		if !ok {
			t.Fatalf("trade_kills row = %#v, want (steam_id, count)", row)
		}
		n, ok := row[1].(int64)
		if !ok {
			t.Fatalf("trade_kills value = %T (%v), want an integer", row[1], row[1])
		}
		out[sid] = int(n)
	}
	return out
}
