package store

import "fmt"

// SettleMatchRows finishes the per-match tick rows once the match and round
// rows are saved. It runs from the import path after SaveExtracted and drops
// player_ticks rows after the final counted round's end_tick (the match is
// already decided). Post-round ticks in earlier rounds are kept on purpose.
//
// round_player_money.money_start is NOT touched here: the extractor sets it
// to the player's first tick sample of each round (extract.applyFirstTickMoney,
// the pre-buy account; the game's m_iStartAccount is stale in an overtime
// sub-half's first round), falling back to m_iStartAccount when no tick row
// exists.
//
// Idempotent: a second run changes nothing.
func (s *Store) SettleMatchRows(matchID int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("settling the match rows: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

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
