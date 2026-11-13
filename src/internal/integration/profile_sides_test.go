package integration_test

// Golden-demo acceptance for the profile's Sides card
// (store.GetPlayerSideSplits): per-side ROUND counts must reproduce the
// raw round_player_sides samples of every counted round — each round
// attributed to the side the player actually played THAT round, and
// CT + T = counted rounds played. The reporter's example (adamS) is
// pinned to literal constants derived from the raw samples, never from
// the query's own output.

import (
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// adamSSteamID is the Sides-card reporter's example player on the golden
// demo (de_cache, CT side at the end of the match).
const adamSSteamID = "76561197968389863"

// TestGoldenProfileSideSplits runs the full extract → store → analytics
// pipeline on the golden demo and pins the Sides card's aggregation:
//
//   - adamS's split is 11 CT / 12 T (hand-derived from the raw
//     round_player_sides samples: rounds 1–12 played on T, rounds 13–23
//     on CT — 23 counted rounds, the knife round -2 and warmup -1 are
//     not counted play);
//   - for EVERY player the GetPlayerSideSplits rows equal the raw
//     per-round side counts, and CT + T equals the counted rounds played
//     (23 for everyone on this demo);
//   - adamS's round-win counts match rounds.winner per attributed round
//     (CT: rounds 13, 14, 18, 20, 21, 22 → 6 of 11; T: rounds 1, 2, 9,
//     11 → 4 of 12).
//
// Skipped under -short and when the demo is absent or an LFS pointer,
// like every other golden-demo test here.
func TestGoldenProfileSideSplits(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}
	m := parseGolden(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "profile-sides.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-profile-sides", "sha-golden-profile-sides", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	cfg := analytics.ConfigFrom(models.AnalysisConfig{
		TradeWindowS: 5.0, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: store.DefaultConfig.TradeOppDistance, RuleVersion: 1,
	}, 0)
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute: %v", err)
	}

	// Counted rounds: every stored round is counted (knife/warmup rounds
	// are discarded at ingest), and the golden demo has 23 (score
	// 10–13).
	rounds, err := st.GetRoundInfos(id)
	if err != nil {
		t.Fatalf("GetRoundInfos: %v", err)
	}
	counted := map[int]bool{}
	for _, r := range rounds {
		counted[r.Number] = true
	}
	if len(counted) != 23 {
		t.Fatalf("counted rounds = %d, want 23 (golden demo baseline)", len(counted))
	}

	// Raw per-round side samples: round → steamID → side.
	sides, err := st.GetRoundPlayerSides(id)
	if err != nil {
		t.Fatalf("GetRoundPlayerSides: %v", err)
	}
	board, err := st.GetScoreboard(id, "name", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	// Every counted round must carry exactly one sample per player —
	// this completeness is what lets CT + T equal counted rounds played.
	for rn := range counted {
		if len(sides[rn]) != len(board) {
			t.Errorf("round %d: %d side samples, want %d (one per player)", rn, len(sides[rn]), len(board))
		}
	}

	// The reporter's example, derived from the RAW samples: adamS plays
	// rounds 1–12 on t and 13–23 on ct.
	rawCT, rawT := 0, 0
	for rn := range counted {
		switch sides[rn][adamSSteamID] {
		case "ct":
			rawCT++
		case "t":
			rawT++
		}
	}
	if rawCT != 11 || rawT != 12 {
		t.Fatalf("raw round_player_sides for adamS = ct %d / t %d, want 11 / 12 (rounds 1–12 t, 13–23 ct)", rawCT, rawT)
	}

	// The aggregation must reproduce the raw counts for every player.
	for _, p := range board {
		want := map[string]int{}
		for rn := range counted {
			if s, ok := sides[rn][p.SteamID]; ok && (s == "ct" || s == "t") {
				want[s]++
			}
		}
		splits, err := st.GetPlayerSideSplits(p.SteamID)
		if err != nil {
			t.Fatalf("GetPlayerSideSplits(%s): %v", p.Name, err)
		}
		got := map[string]int{}
		total := 0
		for _, sp := range splits {
			if _, dup := got[sp.Side]; dup {
				t.Errorf("player %s: duplicate %q row in %+v", p.Name, sp.Side, splits)
			}
			got[sp.Side] = sp.Rounds
			total += sp.Rounds
		}
		for _, side := range []string{"ct", "t"} {
			if got[side] != want[side] {
				t.Errorf("player %s: %s rounds = %d, raw round_player_sides = %d",
					p.Name, side, got[side], want[side])
			}
		}
		if total != len(counted) {
			t.Errorf("player %s: CT+T rounds = %d, counted rounds played = %d",
				p.Name, total, len(counted))
		}
	}

	// adamS's card row: counts AND round wins (rounds.winner per the side
	// the round was played on).
	splits, err := st.GetPlayerSideSplits(adamSSteamID)
	if err != nil {
		t.Fatalf("GetPlayerSideSplits(adamS): %v", err)
	}
	bySide := map[string]models.ProfileSideSplit{}
	for _, sp := range splits {
		bySide[sp.Side] = sp
	}
	ct, tr := bySide["ct"], bySide["t"]
	if ct.Rounds != 11 || tr.Rounds != 12 {
		t.Errorf("adamS splits = ct %d / t %d rounds, want 11 / 12", ct.Rounds, tr.Rounds)
	}
	if ct.Wins != 6 || tr.Wins != 4 {
		t.Errorf("adamS round wins = ct %d / t %d, want 6 / 4 (CT: 13,14,18,20,21,22; T: 1,2,9,11)", ct.Wins, tr.Wins)
	}
	if ct.Rounds+tr.Rounds != 23 {
		t.Errorf("adamS CT+T = %d, want 23 (counted rounds played)", ct.Rounds+tr.Rounds)
	}
}
