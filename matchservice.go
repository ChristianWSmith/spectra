package main

import (
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// MatchService is the frontend-facing read surface for one match's
// extracted data: header, scoreboard, rounds, timeline events and chat.
// Every method is a thin delegate over internal/store; store.ErrNotFound
// surfaces as an error (the bindings turn it into a JS exception).
type MatchService struct {
	st *store.Store
}

// GetMatch returns one match header row.
func (s *MatchService) GetMatch(id int64) (*models.Match, error) {
	return s.st.GetMatch(id)
}

// GetScoreboard returns a match's player aggregates, sorted by a
// whitelisted sortKey.
func (s *MatchService) GetScoreboard(id int64, sortKey string, desc bool) ([]models.PlayerStatsRow, error) {
	return s.st.GetScoreboard(id, sortKey, desc)
}

// GetRounds returns a match's rounds by number ASC.
func (s *MatchService) GetRounds(id int64) ([]models.RoundRow, error) {
	return s.st.GetRounds(id)
}

// GetRoundDetail returns one round with economy, events and chat.
func (s *MatchService) GetRoundDetail(id int64, round int) (*models.RoundDetail, error) {
	return s.st.GetRoundDetail(id, round)
}

// GetEvents returns timeline rows for a filter (EventFilter.Round < 0 =
// all rounds).
func (s *MatchService) GetEvents(f models.EventFilter) ([]models.EventRow, error) {
	return s.st.GetEvents(f)
}

// GetEvent returns one event with its detail/raw JSON payloads.
func (s *MatchService) GetEvent(id int64) (*models.EventDetail, error) {
	return s.st.GetEvent(id)
}

// GetChat returns a match's chat lines; round < 0 selects all rounds.
func (s *MatchService) GetChat(matchID int64, round int) ([]models.ChatRow, error) {
	return s.st.GetChat(matchID, round)
}

// GetMatchSummary returns ONE match's library-list row (the ListMatches
// projection for a single id — store.ErrNotFound for an unknown match).
func (s *MatchService) GetMatchSummary(matchID int64) (models.MatchSummary, error) {
	return s.st.GetMatchSummary(matchID)
}

// TeamNames is a match's two score-line team display names. The names
// identify TEAMS, never sides (sides switch at halftime); both are "" when
// the extract recorded none.
type TeamNames struct {
	CT string `json:"ct"`
	T  string `json:"t"`
}

// GetTeamNames returns a match's CT/T display names (thin delegate over
// store.GetTeamNames; store.ErrNotFound surfaces as an error, like every
// sibling method).
func (s *MatchService) GetTeamNames(matchID int64) (TeamNames, error) {
	ct, t, err := s.st.GetTeamNames(matchID)
	if err != nil {
		return TeamNames{}, err
	}
	return TeamNames{CT: ct, T: t}, nil
}
