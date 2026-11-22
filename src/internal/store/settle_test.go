package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestSettleMatchRows pins the two import-time rules: ticks after the final
// round's end are dropped (post-round ticks in earlier rounds are kept), and
// money_start takes the first tick of its round. A second run changes nothing.
func TestSettleMatchRows(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/settle.dem", "sha-settle", time.Now())
	em := testExtracted("sha-settle", time.Now())
	em.Match.RealRounds = 2
	em.Rounds = []models.Round{
		{Number: 1, Winner: "ct", StartTick: 100, EndTick: 200},
		{Number: 2, Winner: "t", StartTick: 201, EndTick: 300},
	}
	em.RoundSides = nil
	em.RoundEconomy = nil
	em.RoundMoney = []models.RoundPlayerMoney{
		{Round: 2, SteamID: "100", MoneyStart: 6150, Equip: 200, Spent: 4800},
	}
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// Round 1 post-round tick (250, after its end, before the final end),
	// round 2 first tick (201, the reset value 10000), a round 2 mid tick,
	// and a post-match tick (350, after the final round's end 300).
	for _, r := range []struct {
		tick  int
		round int
		money int
	}{{150, 1, 900}, {250, 1, 900}, {201, 2, 10000}, {260, 2, 5200}, {350, 2, 5200}} {
		if _, err := s.db.Exec(`INSERT INTO player_ticks (match_id, tick, steam_id, round, side, alive, hp, money)
			VALUES (?, ?, '100', ?, 'ct', 1, 100, ?)`, id, r.tick, r.round, r.money); err != nil {
			t.Fatal(err)
		}
	}
	count := func(q string, args ...any) int {
		var n int
		if err := s.db.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for run := 0; run < 2; run++ {
		if err := s.SettleMatchRows(id); err != nil {
			t.Fatalf("SettleMatchRows run %d: %v", run, err)
		}
		if got := count(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ?`, id); got != 4 {
			t.Errorf("run %d: tick rows = %d, want 4 (350 dropped, 250 kept)", run, got)
		}
		if got := count(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ? AND tick = 350`, id); got != 0 {
			t.Errorf("run %d: post-match tick 350 survived", run)
		}
		if got := count(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ? AND tick = 250`, id); got != 1 {
			t.Errorf("run %d: post-round tick 250 was dropped", run)
		}
		if got := count(`SELECT money_start FROM round_player_money WHERE match_id = ? AND round = 2`, id); got != 10000 {
			t.Errorf("run %d: money_start = %d, want 10000 (first tick)", run, got)
		}
	}
}
