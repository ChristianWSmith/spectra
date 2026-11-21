package metrics

import (
	"fmt"
	"testing"
)

// TestRawPlayerRoundDeathsMatchesOracle runs raw_player_round_deaths (ruling
// 41, the Economy's per-round deaths) through the sweep's own unit on the
// synthetic corpus and compares every stored (match, round, player, side)
// value with an independent oracle: a correlated count of the kill events
// whose victim is the player, in that round, minus the disconnect-time
// World self-kill the analyzer excludes (analytics/rounds.go). The oracle
// is written without the statement's CTEs, so a copy error in the statement
// cannot pass unnoticed. Every player with a player_round_stats row must
// have a stored row (a 0 is a real zero, never absent).
func TestRawPlayerRoundDeathsMatchesOracle(t *testing.T) {
	st := seededStore(t)
	m, err := st.GetMetricByName("raw_player_round_deaths")
	if err != nil {
		t.Fatalf("GetMetricByName: %v", err)
	}
	if err := runRawMetric(t.Context(), st, m, 0); err != nil {
		t.Fatalf("runRawMetric: %v", err)
	}

	keys, err := st.ReadyRounds()
	if err != nil {
		t.Fatalf("ReadyRounds: %v", err)
	}
	if len(keys) == 0 {
		t.Fatal("the synthetic corpus has no ready rounds")
	}
	checked := 0
	for _, k := range keys {
		stored, err := st.RunReadOnly(
			`SELECT subject_key, dim, value FROM metric_values
			 WHERE metric_id = ? AND match_id = ? AND scope_round = ? AND scope_steam_id = ''`,
			[]any{m.ID, k.MatchID, k.Round}, 500, 5000,
		)
		if err != nil {
			t.Fatalf("read stored rows (match %d round %d): %v", k.MatchID, k.Round, err)
		}
		got := map[string]float64{}
		for _, r := range stored.Rows {
			if r[2] == nil {
				t.Errorf("match %d round %d subject %v: NULL value on a player row", k.MatchID, k.Round, r[0])
				continue
			}
			got[fmt.Sprintf("%v|%v", r[0], r[1])] = toFloat(r[2])
		}

		oracle, err := st.RunReadOnly(`
			SELECT prs.steam_id, prs.side,
			  (SELECT COUNT(*) FROM events e
			    WHERE e.match_id = prs.match_id AND e.round = prs.round AND e.kind = 'kill'
			      AND e.post_match = 0 AND e.victim = prs.steam_id
			      AND NOT (e.attacker = e.victim AND e.weapon = 'World' AND EXISTS (
			        SELECT 1 FROM events d WHERE d.match_id = e.match_id AND d.kind = 'player_disconnect'
			          AND d.attacker = e.victim AND d.tick = e.tick))) AS deaths
			FROM player_round_stats prs
			JOIN players p ON p.match_id = prs.match_id AND p.steam_id = prs.steam_id
			WHERE prs.match_id = ? AND prs.round = ? AND p.is_bot = 0`,
			[]any{k.MatchID, k.Round}, 500, 5000,
		)
		if err != nil {
			t.Fatalf("oracle (match %d round %d): %v", k.MatchID, k.Round, err)
		}
		if len(oracle.Rows) != len(got) {
			t.Errorf("match %d round %d: %d stored rows, oracle has %d players", k.MatchID, k.Round, len(got), len(oracle.Rows))
		}
		for _, r := range oracle.Rows {
			key := fmt.Sprintf("%v|%v", r[0], r[1])
			want := toFloat(r[2])
			v, ok := got[key]
			if !ok {
				t.Errorf("match %d round %d player %v side %v: no stored row (want %v)", k.MatchID, k.Round, r[0], r[1], want)
				continue
			}
			if v != want {
				t.Errorf("match %d round %d player %v side %v: stored %v, oracle %v", k.MatchID, k.Round, r[0], r[1], v, want)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no player-rounds were compared")
	}
}
