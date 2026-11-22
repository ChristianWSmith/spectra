package store

import "fmt"

// SettleMatchRows finishes the per-match tick rows once the match and round
// rows are saved. Two rules, both run from the import path after SaveExtracted:
//
//   - Post-match ticks are dropped: player_ticks rows after the final counted
//     round's end_tick (the match is already decided). Post-round ticks in
//     earlier rounds are kept on purpose.
//   - round_player_money.money_start takes the player's first tick of that
//     round (the pre-buy account). The game's m_iStartAccount is stale in an
//     overtime sub-half's first round (it carries the previous round's final
//     money). The first tick reads the reset value there and matches
//     m_iStartAccount in every other round on the snapshot. Players with no
//     tick row keep the extractor's value.
//
// Idempotent: a second run changes nothing.
func (s *Store) SettleMatchRows(matchID int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("settling the match rows: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`
		UPDATE round_player_money SET money_start = (
			SELECT pt.money FROM player_ticks pt
			WHERE pt.match_id = round_player_money.match_id
			  AND pt.round = round_player_money.round
			  AND pt.steam_id = round_player_money.steam_id
			ORDER BY pt.tick LIMIT 1)
		WHERE match_id = ?
		  AND EXISTS (SELECT 1 FROM player_ticks pt
			WHERE pt.match_id = round_player_money.match_id
			  AND pt.round = round_player_money.round
			  AND pt.steam_id = round_player_money.steam_id)`, matchID); err != nil {
		return fmt.Errorf("settling the match rows: %w", err)
	}

	if _, err := tx.Exec(`
		DELETE FROM player_ticks WHERE match_id = ?
		  AND tick > (SELECT r.end_tick FROM rounds r
			WHERE r.match_id = player_ticks.match_id
			  AND r.number = (SELECT MAX(x.number) FROM rounds x WHERE x.match_id = player_ticks.match_id))`,
		matchID); err != nil {
		return fmt.Errorf("settling the match rows: %w", err)
	}
	return tx.Commit()
}
