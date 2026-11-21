package store

import "fmt"

// roundSteam keys one player's round in the round fold map.
type roundSteam struct {
	round int
	steam string
}

// roundFolds reads the per-round folds of one match (steamID "" = every
// player) from the event rows, keyed by round and player. The fold values
// are event-derived (playerRoundFoldsAll); they are not stored columns.
func (s *Store) roundFolds(matchID int64, steamID string) (map[roundSteam]roundFold, error) {
	q := `SELECT prs.round, prs.steam_id, prs.kills, prs.assists, prs.deaths, prs.dmg, prs.util_dmg, prs.survived
		 FROM ` + playerRoundFoldsAll + ` prs
		 WHERE prs.match_id = ?`
	args := []any{matchID}
	if steamID != "" {
		q += ` AND prs.steam_id = ?`
		args = append(args, steamID)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the per-round folds: %w", err)
	}
	defer rows.Close()
	out := map[roundSteam]roundFold{}
	for rows.Next() {
		var round, kills, assists, deaths, dmg, util, survived int
		var steam string
		if err := rows.Scan(&round, &steam, &kills, &assists, &deaths, &dmg, &util, &survived); err != nil {
			return nil, fmt.Errorf("couldn't load the per-round folds: %w", err)
		}
		out[roundSteam{round, steam}] = roundFold{Kills: kills, Assists: assists, Deaths: deaths,
			DMG: dmg, UtilDmg: util, Survived: survived != 0}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the per-round folds: %w", err)
	}
	return out, nil
}

// roundFold is one player-round's folds.
type roundFold struct {
	Kills    int
	Assists  int
	Deaths   int
	DMG      int
	UtilDmg  int
	Survived bool
}
