package extract

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestFirstTickMoney pins the money_start rule applied at build time: each
// player's money_start is the account at their first tick sample of the
// round, a later sample never replaces it, a player with no tick sample
// keeps m_iStartAccount, and the rule is keyed by the dense counted-round
// index the tick sink receives.
func TestFirstTickMoney(t *testing.T) {
	a := &agg{}
	// Round 1: A's first sample (tick 100) reads 800; a later sample (101)
	// must not replace it. B first appears at tick 101.
	a.noteTickMoney(100, 1, []models.TickSample{{SteamID: "A", Money: 800}})
	a.noteTickMoney(101, 1, []models.TickSample{{SteamID: "A", Money: 900}, {SteamID: "B", Money: 2000}})
	// Round 2: A's first sample reads 1200.
	a.noteTickMoney(200, 2, []models.TickSample{{SteamID: "A", Money: 1200}})

	rows := []models.RoundPlayerMoney{
		{Round: 1, SteamID: "A", MoneyStart: 5000},
		{Round: 1, SteamID: "B", MoneyStart: 2000},
		{Round: 1, SteamID: "C", MoneyStart: 700}, // no tick sample: keeps startAccount
		{Round: 2, SteamID: "A", MoneyStart: 3000},
		{Round: 3, SteamID: "C", MoneyStart: 4000},
	}
	// A sample noted after the rows exist (the RoundEnd frame's own tick
	// arrives after the RoundEnd event) still counts when it is the first.
	a.noteTickMoney(300, 3, []models.TickSample{{SteamID: "C", Money: 9999}})

	applyFirstTickMoney(rows, a.firstMoney)

	want := []int{800, 2000, 700, 1200, 9999}
	for i := range want {
		if rows[i].MoneyStart != want[i] {
			t.Errorf("row %d (%+v) money_start = %d, want %d", i, rows[i], rows[i].MoneyStart, want[i])
		}
	}
}
