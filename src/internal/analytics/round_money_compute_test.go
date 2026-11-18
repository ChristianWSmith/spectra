package analytics

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestPlayerRoundMoneyColumnsFromSamples pins the money-column writer
// path END-TO-END (owner ruling 2026-11-18 "implement the per-round
// money data"): extractor-shaped round-end samples (models.RoundPlayerMoney,
// synthetic stand-ins for m_iStartAccount / m_unRoundStartEquipmentValue /
// m_iCashSpentThisRound) flow through SaveExtracted → round_player_money →
// Compute → PlayerRounds into player_round_stats and come back through
// GetPlayerRounds UNCHANGED and non-zero — the values the player report's
// per-round Money start / Equip / Spent columns render. A player-round
// WITHOUT a sample keeps the absence-as-zero default (Xim below).
func TestPlayerRoundMoneyColumnsFromSamples(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	em := tradeFixture()
	em.Match.Path = "/d/round-money.dem"
	em.Match.SHA256 = "sha-round-money"
	// Hand-computed sample values, distinct per column and per player so
	// a swapped column or a stale zero default cannot pass.
	em.RoundMoney = []models.RoundPlayerMoney{
		{Round: 1, SteamID: "A", MoneyStart: 800, Equip: 200, Spent: 650},
		{Round: 1, SteamID: "B", MoneyStart: 16000, Equip: 6500, Spent: 0},
		// X deliberately has NO sample → absence-as-zero.
	}

	id, err := st.CreateMatchRow(em.Match.Path, em.Match.SHA256, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	cfg := Config{TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000, TradeOppDistance: 1000, RuleVersion: 1}
	if err := Compute(st, id, cfg); err != nil {
		t.Fatalf("Compute: %v", err)
	}

	prs, err := st.GetPlayerRounds(id, "")
	if err != nil {
		t.Fatalf("GetPlayerRounds: %v", err)
	}
	byID := map[string]models.PlayerRoundStat{}
	for _, r := range prs {
		byID[r.SteamID] = r
	}
	got, ok := byID["A"]
	if !ok {
		t.Fatalf("no player_round_stats row for A (rows: %d)", len(prs))
	}
	if got.MoneyStart != 800 || got.Equip != 200 || got.Spent != 650 {
		t.Errorf("A money columns = start/equip/spent %d/%d/%d, want 800/200/650 (round-tripped from the sample)",
			got.MoneyStart, got.Equip, got.Spent)
	}
	if b, ok := byID["B"]; !ok {
		t.Error("no player_round_stats row for B")
	} else if b.MoneyStart != 16000 || b.Equip != 6500 || b.Spent != 0 {
		t.Errorf("B money columns = %d/%d/%d, want 16000/6500/0", b.MoneyStart, b.Equip, b.Spent)
	}
	// A spent value of 0 must be the SAMPLE's 0 (B bought nothing), never
	// a lost sample: B's non-zero siblings prove the fold read the row.
	if x, ok := byID["X"]; !ok {
		t.Error("no player_round_stats row for X")
	} else if x.MoneyStart != 0 || x.Equip != 0 || x.Spent != 0 {
		t.Errorf("X money columns = %d/%d/%d, want absence-as-zero (no sample stored)",
			x.MoneyStart, x.Equip, x.Spent)
	}
}
