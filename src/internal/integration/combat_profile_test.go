package integration_test

// Golden-demo acceptance for the two profile/combat read models this
// package's fixtures do not cover end-to-end: the Combat tab's
// distance-gated "Missed trades" column (analysis_config default) and
// the profile's per-weapon headshots / K-D surfaces. Both assertions are
// regressions guards for "the value is silently 0 for everyone".

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// parseGolden parses the zstd golden demo (skip-if-absent, like TestGolden).
func parseGolden(t *testing.T) *models.ExtractedMatch {
	t.Helper()
	f, err := os.Open(demoPath) //nolint:gosec // path is the fixed repo-root golden demo
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, len(zstdMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		t.Fatalf("sniff demo magic: %v", err)
	}
	reader := io.MultiReader(bytes.NewReader(head), f)
	if bytes.Equal(head, zstdMagic[:]) {
		zr, zerr := zstd.NewReader(reader)
		if zerr != nil {
			t.Fatalf("zstd.NewReader: %v", zerr)
		}
		defer zr.Close()
		reader = zr
	}
	m, err := extract.Parse(context.Background(), reader, extract.ParseOptions{})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	return m
}

// TestGoldenCombatProfileSurfaces runs the full extract → store →
// analytics pipeline on the golden demo and pins the read models the
// profile/combat views render:
//
//   - the missed-trades count must be a strict, non-empty subset of the
//     untraded-deaths count for EVERY player at the default
//     trade-opportunity distance (the metric degenerated to all-zero
//     when the gate radius sat inside the range where teammates trade
//     automatically) — both counts read directly from their stored rows
//     (the retired combat read carried neither field).
//   - The folded per-weapon headshots must equal player_stats.headshots
//     per player (same eligibility extract used to credit them).
//   - The profile trend series kd/hs must be non-zero — the values are
//     the STORED match-scope metric rows since dogfooding W3 (design
//     §3.5's D13 conversion), so the sweep runs above before the read.
func TestGoldenCombatProfileSurfaces(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}
	m := parseGolden(t)

	st, err := store.Open(t.TempDir() + "/combat-profile.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.CloseRO(); _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-cp", "sha-golden-cp", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// The seeded default is the calibration under test — do not SetConfig.
	// Production always passes the stored config row into Compute
	// (library.analyze, RecomputeAnalysis): mirror that here so the
	// analyze-time trade-opp gate runs under the seeded radius.
	seeded, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if seeded.TradeOppDistance != store.DefaultConfig.TradeOppDistance {
		t.Fatalf("stored trade_opp_distance = %d, want the %du default",
			seeded.TradeOppDistance, store.DefaultConfig.TradeOppDistance)
	}
	cfg := analytics.ConfigFrom(seeded, 0)
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute: %v", err)
	}
	// The profile trend reads the STORED match-scope metric rows since
	// dogfooding W3 (design §3.5's D13 conversion), so the sweep
	// production runs in the import/analyze job body has to run here too
	// — without it the trend would honestly read an empty series and the
	// kd/hs assertions below could never see a value.
	if _, err := metrics.Sweep(context.Background(), st, nil, nil); err != nil {
		t.Fatalf("metrics.Sweep: %v", err)
	}

	// W2b: the Combat tab's "Missed trades" / "Untraded deaths" columns
	// are fixed metric slots now (m:missed_trades / m:untraded_deaths),
	// and the combat read that once carried neither field retired with
	// the m3 migration (plan §7 M3). The GATE meaning is
	// unchanged — the two counts are re-pinned here as direct stored
	// reads over the same rows the seeds read: missed =
	// match_trade_opps.missed (analytics.Compute's analyze-time gate),
	// untraded = COUNT(*) of kind='untraded' engagement rows grouped by
	// the victim (b_steam — the untraded_deaths seed's source). The
	// roster the per-player assertions walk is the scoreboard's
	// humans-only rows (names for the messages).
	board, err := st.GetScoreboard(id, "", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	if len(board) == 0 {
		t.Fatal("no scoreboard rows")
	}
	missedRes, err := st.RunReadOnly(
		`SELECT steam_id, missed FROM match_trade_opps WHERE match_id = ?`,
		[]any{id}, 500, 5000,
	)
	if err != nil {
		t.Fatalf("read match_trade_opps: %v", err)
	}
	untradedRes, err := st.RunReadOnly(
		`SELECT b_steam, COUNT(*) FROM engagements
		 WHERE match_id = ? AND kind = 'untraded' AND b_steam <> ''
		 GROUP BY b_steam`,
		[]any{id}, 500, 5000,
	)
	if err != nil {
		t.Fatalf("read untraded engagements: %v", err)
	}
	// Enemy headshot kills by attacker, from the event rows (the stored
	// headshots column is retired): the same-side gate of the fold.
	headshotsRes, err := st.RunReadOnly(
		`SELECT e.attacker, COUNT(*) FROM events e
		 WHERE e.match_id = ? AND e.kind = 'kill' AND e.headshot = 1 AND e.post_match = 0
		   AND e.attacker <> '' AND e.attacker <> e.victim
		   AND NOT EXISTS (SELECT 1 FROM round_player_sides a
		     JOIN round_player_sides v ON v.match_id = a.match_id AND v.round = a.round AND v.steam_id = e.victim
		     WHERE a.match_id = e.match_id AND a.round = e.round AND a.steam_id = e.attacker AND a.side = v.side)
		 GROUP BY e.attacker`,
		[]any{id}, 500, 5000,
	)
	if err != nil {
		t.Fatalf("read enemy headshot kills: %v", err)
	}
	storedCount := func(v any) int {
		t.Helper()
		switch n := v.(type) {
		case int64:
			return int(n)
		case float64:
			return int(n)
		case int:
			return n
		default:
			t.Fatalf("stored count: unexpected value %T (%v)", v, v)
			return 0
		}
	}
	countBySteam := func(res store.ROResult, what string) map[string]int {
		t.Helper()
		out := map[string]int{}
		for _, row := range res.Rows {
			if len(row) != 2 {
				t.Fatalf("%s row = %#v, want 2 columns", what, row)
			}
			sid, ok := row[0].(string)
			if !ok {
				t.Fatalf("%s key = %T (%v), want a steam id", what, row[0], row[0])
			}
			out[sid] = storedCount(row[1])
		}
		return out
	}
	missedBy := countBySteam(missedRes, "match_trade_opps")
	untradedBy := countBySteam(untradedRes, "untraded engagements")
	headshotsBy := countBySteam(headshotsRes, "enemy headshot kills")

	var oppTotal, untradedTotal int
	for _, r := range board {
		missed, untraded := missedBy[r.SteamID], untradedBy[r.SteamID]
		oppTotal += missed
		untradedTotal += untraded
		if missed <= 0 {
			t.Errorf("player %s: missed = 0 (untraded %d) — gated metric degenerated",
				r.Name, untraded)
		}
		if missed > untraded {
			t.Errorf("player %s: missed %d > untraded %d",
				r.Name, missed, untraded)
		}
	}
	if oppTotal == 0 || oppTotal >= untradedTotal {
		t.Errorf("trade opp total = %d of %d untraded deaths, want a non-empty strict subset",
			oppTotal, untradedTotal)
	}
	if oppTotal < untradedTotal/4 {
		t.Errorf("trade opp total = %d of %d untraded deaths — gate admits under a quarter",
			oppTotal, untradedTotal)
	}
	t.Logf("trade opp missed: %d of %d untraded deaths across %d players", oppTotal, untradedTotal, len(board))

	// Per-weapon headshots: the folded JSON must reproduce the headshots
	// extract credited to player_stats for every player (the scoreboard
	// roster fetched above).
	anyWeaponHS := 0
	for _, p := range board {
		rows, err := st.GetPlayerWeaponJSONs(p.SteamID)
		if err != nil {
			t.Fatalf("GetPlayerWeaponJSONs(%s): %v", p.SteamID, err)
		}
		sum := 0
		for _, r := range rows {
			if r.HeadshotsByWeapon == "" {
				continue
			}
			var m map[string]int
			if err := json.Unmarshal([]byte(r.HeadshotsByWeapon), &m); err != nil {
				t.Fatalf("player %s: headshots JSON %q: %v", p.Name, r.HeadshotsByWeapon, err)
			}
			for _, n := range m {
				sum += n
			}
		}
		anyWeaponHS += sum
		if sum != headshotsBy[p.SteamID] {
			t.Errorf("player %s: folded per-weapon headshots = %d, player_stats.headshots = %d",
				p.Name, sum, headshotsBy[p.SteamID])
		}
		if sum > p.Kills {
			t.Errorf("player %s: folded headshots %d > kills %d", p.Name, sum, p.Kills)
		}
	}
	if anyWeaponHS == 0 {
		t.Error("no per-weapon headshots derived for any player")
	}

	// Profile trend series: kd and hs_pct must be non-zero for every
	// player (GetTrend takes the metric NAME — the retired "hs" button
	// name is no longer a key).
	for _, p := range board {
		for _, metric := range []string{"kd", "hs_pct"} {
			pts, err := st.GetTrend(p.SteamID, metric)
			if err != nil {
				t.Fatalf("GetTrend(%s, %s): %v", p.Name, metric, err)
			}
			if len(pts) == 0 {
				t.Errorf("player %s: empty %s trend", p.Name, metric)
				continue
			}
			for _, pt := range pts {
				if pt.Value <= 0 {
					t.Errorf("player %s: %s trend value = %v, want > 0", p.Name, metric, pt.Value)
				}
			}
		}
	}
}
