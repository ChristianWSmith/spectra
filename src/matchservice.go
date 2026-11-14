package main

import (
	"sort"

	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// MatchService is the frontend-facing read surface for one match's
// extracted data: header, scoreboard, rounds, timeline events and chat.
// Methods are thin delegates over internal/store — GetMatch additionally
// stamps the fs-derived demo CopyState (service-owned; the store never
// fills it) — and store.ErrNotFound surfaces as an error (the bindings
// turn it into a JS exception).
type MatchService struct {
	st *store.Store
	// imp resolves CopyState for GetMatch. Wired in main.go; nil only in
	// read tests that don't exercise it — those rows keep "" (unstamped).
	imp *library.Importer
}

// GetMatch returns one match header row with its demo-copy state filled
// in (library.CopyStateCopied / External / Missing).
func (s *MatchService) GetMatch(id int64) (*models.Match, error) {
	m, err := s.st.GetMatch(id)
	if err != nil {
		return nil, err
	}
	if s.imp != nil {
		m.CopyState = s.imp.CopyState(m.SHA256, m.Path)
	}
	return m, nil
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

// GetEvents returns timeline rows for a filter (the round range open on
// both sides = all rounds).
func (s *MatchService) GetEvents(f models.EventFilter) ([]models.EventRow, error) {
	return s.st.GetEvents(f)
}

// GetEventKeys returns every matching event's identity/tick/kind for the
// SAME filter — the replay's scrubber-marker answer (thin delegate over
// store.GetEventKeys, which shares eventWhere with GetEvents: ONE
// matcher for the list and the markers). No paging: the marker set is
// the whole answer, never a page of it (store.GetEventKeys' doc owns the
// semantics).
func (s *MatchService) GetEventKeys(f models.EventFilter) ([]models.EventKey, error) {
	return s.st.GetEventKeys(f)
}

// GetEvent returns one event with its detail/raw JSON payloads.
func (s *MatchService) GetEvent(id int64) (*models.EventDetail, error) {
	return s.st.GetEvent(id)
}

// GetEventDetails returns the events for ids with their JSON payloads in
// INPUT ORDER (unknown ids skipped, empty input → empty result) — the
// bulk twin of GetEvent the replay's grenade-entity hydration reads
// through (one chunked IPC call instead of one round trip per row; a
// thin delegate over store.GetEventDetails, whose doc owns the exact
// semantics).
func (s *MatchService) GetEventDetails(ids []int64) ([]models.EventDetail, error) {
	return s.st.GetEventDetails(ids)
}

// BlindDuration is one blind event's flash length for the replay's
// flash-white overlay: Seq is the events.seq key the frontend joins the
// blind row on, Ms the flashDurationMs the extractor recorded on
// detail_json (models.EventRow stays payload-free — the narrow payload
// side channel store.GetBlindFlashDurations reads).
type BlindDuration struct {
	Seq int `json:"seq"`
	Ms  int `json:"ms"`
}

// GetBlindDurations returns every blind event's flash duration for a
// match in events.seq order (thin delegate over
// store.GetBlindFlashDurations). A match with no blind rows — or an
// unknown match — returns an empty slice, never an error (unlike the
// header reads): the overlay is optional by contract.
func (s *MatchService) GetBlindDurations(matchID int64) ([]BlindDuration, error) {
	bySeq, err := s.st.GetBlindFlashDurations(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]BlindDuration, 0, len(bySeq))
	for seq, ms := range bySeq {
		out = append(out, BlindDuration{Seq: seq, Ms: ms})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}

// GetDropDetails returns every death-drop row's cat/mag/reserve payload
// projection for a match in events.seq order (thin delegate over
// store.GetDropDetails). A match with no weapon_drop rows — or an
// unknown match — returns an empty slice, never an error: the replay's
// drop layer is optional by contract (same rule as GetBlindDurations).
// The frontend joins these onto the DRAW_KINDS rows by seq — the join
// that carries the STORED gun|util classification and the dropped gun's
// ammo state to the renderer (models.EventRow stays payload-free).
func (s *MatchService) GetDropDetails(matchID int64) ([]models.DropDetail, error) {
	return s.st.GetDropDetails(matchID)
}

// GetChat returns a match's chat lines; round < 0 selects all rounds,
// player "" all senders (the landmark feed passes the active scope).
func (s *MatchService) GetChat(matchID int64, round int, player string) ([]models.ChatRow, error) {
	return s.st.GetChat(matchID, round, player)
}

// GetSoundEvents returns a match's player sounds (footsteps/lands/jumps/
// fall damage — sound_events) in an INCLUSIVE tick window; either bound
// <= 0 is open, so (0, 0) reads the whole match (thin delegate over
// store.GetSoundEvents — its doc owns the exact semantics).
func (s *MatchService) GetSoundEvents(matchID int64, fromTick, toTick int) ([]models.SoundEvent, error) {
	return s.st.GetSoundEvents(matchID, fromTick, toTick)
}

// GetSoundEventPresence returns the match's sound-event counts by kind —
// the "does this match have footstep data" signal (Total 0 = none). A
// match with no rows or an unknown id yields the zero presence, never an
// error (optional-read contract, same as the blind/drop payload reads).
func (s *MatchService) GetSoundEventPresence(matchID int64) (models.SoundEventPresence, error) {
	return s.st.GetSoundEventPresence(matchID)
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
// GetPlayerRefs returns one match's participants (identity + final side
// + bot flag) — the roster read model (store.GetPlayerRefs), never the
// 37-column scoreboard. Reports' metrics appendix uses it to label the
// stored metric_values rows of THIS match (the canonical value read
// carries steam ids only — labels stay a roster concern).
func (s *MatchService) GetPlayerRefs(matchID int64) ([]models.PlayerRef, error) {
	return s.st.GetPlayerRefs(matchID)
}

func (s *MatchService) GetTeamNames(matchID int64) (TeamNames, error) {
	ct, t, err := s.st.GetTeamNames(matchID)
	if err != nil {
		return TeamNames{}, err
	}
	return TeamNames{CT: ct, T: t}, nil
}
