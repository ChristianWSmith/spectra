package analytics

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// PlayerRounds stat-gate rulings (lead 2026-11-17, owner's
// reconnect-takeover report): no self-kill is ever kill credit, a
// disconnect-time World self-kill is not a death, and bots carry no
// per-round rows. Seeded []models.Event only — the repro demo is never a
// test dependency.

func TestSelfKillWithUnknownSidesEarnsNoKillCredit(t *testing.T) {
	players := []PlayerRef{{SteamID: "1", Name: "s"}}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	// NO sides map: every side resolves unknown, so the old permissive
	// path counted the attacker's own kill (the repro's fake disconnect
	// deaths gave bvcket 2 kill credits in round 12 exactly this way).
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "1", "1", withWeapon("AK-47")),
	}
	got := PlayerRounds(events, rounds, players, testCfg, nil, nil)
	if len(got) != 1 {
		t.Fatalf("rows = %d, want 1", len(got))
	}
	if got[0].Kills != 0 {
		t.Errorf("self-kill kill credit = %d, want 0 (attacker != victim is unconditional)", got[0].Kills)
	}
	if got[0].Deaths != 1 {
		t.Errorf("self-kill death = %d, want 1 (a real suicide still dies)", got[0].Deaths)
	}
}

func TestPostMatchDisconnectDeathsAgreeWithExtractor(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "1", Name: "leaver"},
		{SteamID: "2", Name: "stayer"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	events := []models.Event{
		// The post-match pattern (repro ticks 170714/170812/170847;
		// golden's trailing World suicides): a World self-kill on the
		// SAME tick as the victim's player_disconnect. The extractor
		// never counts it in player_stats (post-match real gate; the
		// same-tick criterion for in-match leaves) — player_round_stats
		// must not either, or the two tables disagree by exactly these
		// rows.
		ev(0, 900, 1, models.EventKill, "1", "1", withWeapon(WorldWeapon)),
		ev(1, 900, 1, models.EventDisconnect, "1", ""),
		// A real death in the same round still counts — the exclusion is
		// the pair (World self-kill AND same-tick disconnect), never the
		// weapon alone.
		ev(2, 950, 1, models.EventKill, "2", "1", withWeapon("AK-47")),
		// A World self-kill WITHOUT a same-tick disconnect is a genuine
		// world-hazard death and stays counted.
		ev(3, 960, 1, models.EventKill, "2", "2", withWeapon(WorldWeapon)),
	}
	got := PlayerRounds(events, rounds, players, testCfg, nil, nil)
	byID := map[string]PlayerRound{}
	for _, r := range got {
		byID[r.SteamID] = r
	}
	if d := byID["1"]; d.Deaths != 1 {
		t.Errorf("leaver deaths = %d, want 1 (disconnect World self-kill excluded, real death counted)", d.Deaths)
	}
	if k := byID["2"]; k.Kills != 1 {
		t.Errorf("stayer kills = %d, want 1", k.Kills)
	}
	if d := byID["2"]; d.Deaths != 1 {
		t.Errorf("stayer deaths = %d, want 1 (genuine World self-kill, no disconnect)", d.Deaths)
	}
	// The input rows are never mutated — the feed keeps its record.
	if len(events) != 4 {
		t.Errorf("events mutated: %d rows, want 4", len(events))
	}
}

func TestBotsCarryNoPlayerRoundRows(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "1", Name: "human"},
		{SteamID: "18374686479671623693", Name: "Ricksaw", IsBot: true},
		{SteamID: "18374686479671623694", Name: "Rebel", IsBot: true},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	got := PlayerRounds(nil, rounds, players, testCfg, nil, nil)
	// (d) ruling 2026-11-17: the roster×rounds matrix is a HUMAN stats
	// surface — a bot's row claimed survived/kast for rounds it never
	// existed (the repro: 22 rows × 3 bots), and every consumer of
	// player_round_stats is per-player-addressed with no picker able to
	// address a bot. Bots keep their player_stats row; here they get no
	// per-round row at all.
	if len(got) != 1 || got[0].SteamID != "1" {
		t.Fatalf("rows = %+v, want only the human's row", got)
	}
	if !got[0].Survived || !got[0].KAST {
		t.Errorf("human row = %+v, want survived+kast (no events → survived)", got[0])
	}
}
