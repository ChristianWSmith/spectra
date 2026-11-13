package store

import (
	"errors"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// botSteamID is the synthetic 0xFF-prefixed identity the extractor hands
// bots (extract.playerKey / isBotKey — no SteamID64, entity-derived;
// the decimal spelling of 0xFF00000000000000|entityID).
const botSteamID = "18374686479671623692"

// withBot returns testExtracted plus one extra participant: a CT bot with
// its own stats row — the nuke golden demo's Crew shape (a bot that
// joined mid-match to fill a disconnected player's slot).
func withBot(em *models.ExtractedMatch) *models.ExtractedMatch {
	em.Players = append(em.Players, models.Player{
		SteamID: botSteamID, Name: "Crew", Side: "ct", IsBot: true, FinalStatePresent: true,
	})
	em.PlayerStats = append(em.PlayerStats, models.PlayerStats{
		SteamID: botSteamID, Side: "ct", Name: "Crew", Kills: 3, Deaths: 1,
		Assists: 0, ADR: 40, HSPct: 33, RoundsPlayed: 2,
		KillsByWeapon: `{"ak47":3}`, DamageByWeapon: `{"ak47":300}`,
	})
	return em
}

// seedBotMatch saves a match whose roster carries one human + one bot.
func seedBotMatch(t *testing.T, s *Store) int64 {
	t.Helper()
	id, err := s.CreateMatchRow("/d/bots.dem", "sha-bots", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := withBot(testExtracted("sha-bots", time.Now()))
	// The bot is the round MVP and the victim of a kill — event-shaped
	// rows must KEEP its name (the product rule's exception).
	em.Rounds[0].MVP = botSteamID
	em.Events = append(em.Events, models.Event{
		Tick: 400, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: botSteamID,
		Weapon: "ak47",
	})
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return id
}

// TestBotsExcludedFromRosterReads pins the product rule: a bot never
// appears on a roster/aggregate/selection surface (scoreboard, combat
// base rows, the career rollup + list, the library player facet), while
// event-shaped reads (round MVP/first-blood names, kill-feed attacker/
// victim cells) KEEP it and the replay roster carries it WITH its is_bot
// flag (the replay exception needs the flag to pair the bot with the
// player it replaces).
func TestBotsExcludedFromRosterReads(t *testing.T) {
	s := openMem(t)
	id := seedBotMatch(t, s)

	t.Run("scoreboard roster", func(t *testing.T) {
		board, err := s.GetScoreboard(id, "", false)
		if err != nil {
			t.Fatalf("GetScoreboard: %v", err)
		}
		if hasSteam(board, botSteamID) {
			t.Errorf("GetScoreboard lists the bot (%d rows), want humans only", len(board))
		}
		// No over-filtering: both humans stay.
		if len(board) != 2 || !hasSteam(board, "100") || !hasSteam(board, "200") {
			t.Errorf("GetScoreboard = %+v, want the two human rows", board)
		}
	})

	t.Run("combat base rows", func(t *testing.T) {
		rows, err := s.GetCombatStats(id)
		if err != nil {
			t.Fatalf("GetCombatStats: %v", err)
		}
		if hasCombatSteam(rows, botSteamID) {
			t.Errorf("GetCombatStats lists the bot (%d rows), want humans only", len(rows))
		}
		if len(rows) != 2 {
			t.Errorf("GetCombatStats rows = %d, want 2 humans", len(rows))
		}
	})

	t.Run("career rollup and list", func(t *testing.T) {
		if err := s.RebuildCareer(); err != nil {
			t.Fatalf("RebuildCareer: %v", err)
		}
		if c, err := s.GetCareer(botSteamID); !errors.Is(err, ErrNotFound) {
			t.Errorf("GetCareer(bot) = %+v, %v; want ErrNotFound", c, err)
		}
		list, err := s.ListPlayers("")
		if err != nil {
			t.Fatalf("ListPlayers: %v", err)
		}
		if hasCareerSteam(list, botSteamID) {
			t.Errorf("ListPlayers lists the bot (%d rows), want humans only", len(list))
		}
		if len(list) != 2 {
			t.Errorf("ListPlayers = %+v, want the two humans", list)
		}
		// Querying the bot by name must not surface it either…
		if byName, err := s.ListPlayers("Crew"); err != nil || len(byName) != 0 {
			t.Errorf("ListPlayers(Crew) = %+v, %v; want no rows", byName, err)
		}
		// …while a human name still matches (no over-filtering).
		if byName, err := s.ListPlayers("alice"); err != nil || len(byName) != 1 || byName[0].SteamID != "100" {
			t.Errorf("ListPlayers(alice) = %+v, %v; want alice", byName, err)
		}
	})

	t.Run("library player facet", func(t *testing.T) {
		for _, q := range []string{botSteamID, "crew"} {
			listed, err := s.ListMatches("", "", false, MatchListFilter{Player: q})
			if err != nil {
				t.Fatalf("ListMatches(player=%q): %v", q, err)
			}
			if len(listed) != 0 {
				t.Errorf("player facet %q = %+v, want no match (bots are not players)", q, listed)
			}
		}
		// A human facet still finds it.
		listed, err := s.ListMatches("", "", false, MatchListFilter{Player: "alice"})
		if err != nil || len(listed) != 1 || listed[0].ID != id {
			t.Errorf("player facet alice = %+v, %v; want the match", listed, err)
		}
	})

	t.Run("replay roster keeps the bot with its flag", func(t *testing.T) {
		refs, err := s.GetPlayerRefs(id)
		if err != nil {
			t.Fatalf("GetPlayerRefs: %v", err)
		}
		var bot *models.PlayerRef
		for i := range refs {
			if refs[i].SteamID == botSteamID {
				bot = &refs[i]
			}
		}
		if bot == nil {
			t.Fatalf("GetPlayerRefs dropped the bot — the replay exception needs it (%+v)", refs)
		}
		if !bot.IsBot {
			t.Errorf("GetPlayerRefs bot IsBot = false, want true")
		}
		if bot.Name != "Crew" || bot.Side != "ct" {
			t.Errorf("GetPlayerRefs bot = %+v, want Crew/ct", *bot)
		}
	})

	t.Run("event-shaped rows keep the bot name", func(t *testing.T) {
		rounds, err := s.GetRounds(id)
		if err != nil {
			t.Fatalf("GetRounds: %v", err)
		}
		if len(rounds) < 1 || rounds[0].MVPName != "Crew" {
			t.Fatalf("round MVP name = %+v, want Crew kept", rounds)
		}
		evs, err := s.GetEvents(models.EventFilter{MatchID: id, Kind: models.EventKill})
		if err != nil {
			t.Fatalf("GetEvents: %v", err)
		}
		found := false
		for _, e := range evs {
			if e.Victim == botSteamID && e.VictimName == "Crew" {
				found = true
			}
		}
		if !found {
			t.Errorf("kill-feed victim cell lost the bot name (%+v)", evs)
		}
	})
}

// hasSteam reports whether a scoreboard carries the id.
func hasSteam(rows []models.PlayerStatsRow, sid string) bool {
	for _, r := range rows {
		if r.SteamID == sid {
			return true
		}
	}
	return false
}

// hasCombatSteam reports whether a combat-stats result carries the id.
func hasCombatSteam(rows []models.CombatStat, sid string) bool {
	for _, r := range rows {
		if r.SteamID == sid {
			return true
		}
	}
	return false
}

// hasCareerSteam reports whether a career list carries the id.
func hasCareerSteam(rows []models.CareerSummary, sid string) bool {
	for _, r := range rows {
		if r.SteamID == sid {
			return true
		}
	}
	return false
}

// TestCareerRebuildDropsBotRowsFromExistingData pins the purge: a
// player_career table that ALREADY contains a bot row (a rebuild run
// before this rule, or a dev DB imported under it) loses it on the next
// RebuildCareer, and ListPlayers hides it in the meantime.
func TestCareerRebuildDropsBotRowsFromExistingData(t *testing.T) {
	s := openMem(t)
	seedBotMatch(t, s)
	// Simulate pre-rule data: a bot row already in player_career.
	if _, err := s.db.Exec(
		`INSERT INTO player_career (steam_id, name, matches, wins, adr_avg, adr_std, kd,
			hs_pct, kast_pct, openings, opener_wins, trades, clutches, updated_at)
		 VALUES (?, 'Crew', 1, 0, 40, 0, 3, 33, 50, 0, 0, 0, 0, ?)`,
		botSteamID, time.Now(),
	); err != nil {
		t.Fatalf("seed stale bot career row: %v", err)
	}
	if list, err := s.ListPlayers(""); err != nil || hasCareerSteam(list, botSteamID) {
		t.Fatalf("ListPlayers before rebuild = %+v (err %v), want the stale bot row already hidden", list, err)
	}
	if err := s.RebuildCareer(); err != nil {
		t.Fatalf("RebuildCareer: %v", err)
	}
	if _, err := s.GetCareer(botSteamID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCareer(bot) after rebuild err = %v, want ErrNotFound", err)
	}
	if list, err := s.ListPlayers(""); err != nil || hasCareerSteam(list, botSteamID) {
		t.Errorf("ListPlayers after rebuild = %+v (err %v), want no bot row", list, err)
	}
}
