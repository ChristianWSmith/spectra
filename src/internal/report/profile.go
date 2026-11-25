package report

import (
	"errors"
	"fmt"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ProfileReport is the profile-scope data map: one player's career across every match they played.
// Matches is the profile page's match history, most recent first. Metrics holds the career values by
// metric name (career_adr, career_kd, ...), each formatted in its metric's own format; a value with no
// data reads as a dash, never as zero. Metric names are the keys a template reads with
// (index .Metrics "career_adr").
type ProfileReport struct {
	SteamID     string
	Name        string
	Matches     []models.ProfileHistoryRow
	Metrics     map[string]string
	GeneratedAt time.Time
}

// profileMetricNames are the career metrics a profile report carries: the profile page's own card set
// (metricorder.js DEFAULT_CARDS.profile). A name the catalog does not hold reads as a dash.
var profileMetricNames = []string{
	"career_matches",
	"win_pct",
	"career_adr",
	"career_adr_sigma",
	"career_kd",
	"career_hs_pct",
	"career_kast",
	"career_opening_rate",
	"career_trade_rate",
	"career_clutches",
	"career_clutch_win_rate",
	"career_avg_enemies_flashed",
	"career_avg_util_damage",
}

// BuildProfileData composes the profile-scope data for one player: their name, their match history and
// their stored career values. Only fresh stored values are read; nothing is calculated.
func BuildProfileData(st *store.Store, steamID string) (*ProfileReport, error) {
	if steamID == "" {
		return nil, fmt.Errorf("no player was selected for this report")
	}
	hist, err := st.GetPlayerHistory(steamID)
	if err != nil {
		return nil, err
	}
	if hist == nil {
		hist = []models.ProfileHistoryRow{}
	}
	name := ""
	players, err := st.ListPlayers("")
	if err != nil {
		return nil, err
	}
	for _, p := range players {
		if p.SteamID == steamID {
			name = p.Name
			break
		}
	}
	cells := make(map[string]string, len(profileMetricNames))
	type resolved struct{ name, format string }
	byID := map[int64]resolved{}
	ids := []int64{}
	for _, n := range profileMetricNames {
		cells[n] = reportCellDash
		def, err := st.GetMetricByName(n)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		byID[def.ID] = resolved{name: n, format: def.Format}
		ids = append(ids, def.ID)
	}
	if len(ids) > 0 {
		values, err := st.GetMetricValuesForPlayer(steamID, ids)
		if err != nil {
			return nil, err
		}
		for _, v := range values {
			w, ok := byID[v.MetricID]
			if !ok || v.Value == nil {
				continue // NULL is no data: the cell stays a dash, never 0
			}
			cells[w.name] = reportCell(*v.Value, w.format)
		}
	}
	return &ProfileReport{
		SteamID: steamID, Name: name, Matches: hist, Metrics: cells, GeneratedAt: time.Now().UTC(),
	}, nil
}
