package extract

import "testing"

// TestRoundEndMoneySamples pins the writer of the round-end money rows
// behind player_round_stats' money columns (owner ruling 2026-11-18):
// synthetic samples flow through agg.moneyEnd → build() as
// ExtractedMatch.RoundMoney with the round's DENSE counted number, a
// discarded (knife/warmup) round contributes no rows, and a zero-key
// sample is dropped. The values are handed through verbatim — the
// extractor never derives or rounds them (the props themselves are
// characterized by TestDiagRoundMoneyProps).
func TestRoundEndMoneySamples(t *testing.T) {
	a := newAgg()
	// Discarded warmup round first: its samples must never land.
	a.roundStart(1000, true, false, 115, "")
	a.moneyEnd([]moneyEndSample{
		{key: 1, startAccount: 800, equipStart: 200, spent: 650},
	})
	// Counted round 1 (chrono index 1 → dense 1).
	a.roundStart(2000, false, false, 115, "BOMB TARGET")
	a.moneyEnd([]moneyEndSample{
		{key: 1, startAccount: 800, equipStart: 200, spent: 650},
		{key: 2, startAccount: 800, equipStart: 4300, spent: 800},
		{key: 0, startAccount: 999, equipStart: 999, spent: 999}, // dropped
	})
	// A discarded round after a counted one (chrono gap): its samples
	// must not hang off the counted round either.
	a.roundStart(3000, true, false, 115, "")
	a.moneyEnd([]moneyEndSample{
		{key: 1, startAccount: 777, equipStart: 777, spent: 777},
	})
	// Counted round 2 — dense 2 after renumber.
	a.roundStart(4000, false, false, 115, "BOMB TARGET")
	a.moneyEnd([]moneyEndSample{
		{key: 1, startAccount: 16000, equipStart: 6500, spent: 0},
	})

	m := a.build()
	if len(m.RoundMoney) != 3 {
		t.Fatalf("RoundMoney rows = %d (%+v), want 3 (discard + zero-key dropped)", len(m.RoundMoney), m.RoundMoney)
	}
	want := []struct {
		round int
		key   string
		start int
		equip int
		spent int
	}{
		{1, "1", 800, 200, 650},
		{1, "2", 800, 4300, 800},
		{2, "1", 16000, 6500, 0},
	}
	for i, w := range want {
		got := m.RoundMoney[i]
		if got.Round != w.round || got.SteamID != w.key ||
			got.MoneyStart != w.start || got.Equip != w.equip || got.Spent != w.spent {
			t.Errorf("RoundMoney[%d] = %+v, want round=%d steam=%s start=%d equip=%d spent=%d",
				i, got, w.round, w.key, w.start, w.equip, w.spent)
		}
	}
	// The discarded round's values (777) must appear nowhere.
	for _, r := range m.RoundMoney {
		if r.MoneyStart == 777 || r.Equip == 777 || r.Spent == 777 {
			t.Errorf("discarded-round sample leaked into RoundMoney: %+v", r)
		}
	}
}
