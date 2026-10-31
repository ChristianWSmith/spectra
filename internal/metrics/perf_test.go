package metrics

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// This file measures the plan §6 targets against a GENERATED 100-match
// corpus (in-test, not committed — the committed seed stays the tiny 3-match
// eyeball fixture). Skipped under -short (CI runs make test = go test
// -short); run `go test ./internal/metrics -run Perf -v` to see the
// numbers:
//
//	preview (library, 100 matches) < 1 s
//	compiled metric as SQL         < 3 s (compile-only; parsing 1000
//	                                matches is not a thing — SQL text does
//	                                not depend on row counts)

// generateCorpus mirrors testdata/seed.sql's formulas for n matches,
// batched into multi-row INSERTs so the setup itself stays fast.
func generateCorpus(n int) string {
	var b strings.Builder
	names := []string{"Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi"}
	maps := []string{"de_mirage", "de_dust2", "de_inferno"}
	weapons := []string{"ak47", "awp", "m4a1", "deagle", "usp"}
	sid := func(i int) string { return fmt.Sprintf("%d", 76561198000000000+i) }
	const chunk = 100

	emit := func(table, cols string, rows []string) {
		for i := 0; i < len(rows); i += chunk {
			end := i + chunk
			if end > len(rows) {
				end = len(rows)
			}
			fmt.Fprintf(&b, "INSERT INTO %s (%s) VALUES %s;\n", table, cols, strings.Join(rows[i:end], ","))
		}
	}

	var (
		matches, teams, players, pstats, rounds, econ, events, prows, engs, utils, voices, chats []string
	)
	for m := 1; m <= n; m++ {
		mapName := maps[(m-1)%len(maps)]
		matches = append(matches, fmt.Sprintf(
			"('/seed/m%d.dem','seed%06d',1024,'%s',64.0,307200,4800.0,72000,'s','g','csgo','1',0,24,12,12,12,12,0,'v6','2026-01-01T00:00:00Z',100,0,'ready')",
			m, m, mapName))
		teams = append(teams, fmt.Sprintf("(%d,'ct','Alpha','',12)", m), fmt.Sprintf("(%d,'t','Beta','',12)", m))
		for i := 1; i <= 8; i++ {
			side := "ct"
			if i > 4 {
				side = "t"
			}
			players = append(players, fmt.Sprintf("(%d,'%s','%s',0,'%s')", m, sid(i), names[i-1], side))
			pstats = append(pstats, fmt.Sprintf(
				"(%d,'%s','%s','%s',%d,%d,0,%d,1,%d,%d,%d,%g,50.0,24,%d,%d,150000)",
				m, sid(i), side, names[i-1], 2*i, i, i, i*5, i*100, i*50, 50.0+5.0*float64(i), i, i))
		}
		for r := 1; r <= 24; r++ {
			winner := "t"
			if r%2 == 1 {
				winner = "ct"
			}
			start := (r - 1) * 128
			rounds = append(rounds, fmt.Sprintf(
				"(%d,%d,'%s','elimination',%d,%d,%d,0,'%s',2500,2000,%d,'%s','%s')",
				m, r, winner, 100+r, start, start+120, sid(((r-1)%8)+1), start+5,
				sid(((r-1)%4)+1), sid(((r-1)%4)+5)))
			econ = append(econ,
				fmt.Sprintf("(%d,%d,'ct',2500,10000,5)", m, r),
				fmt.Sprintf("(%d,%d,'t',2000,8000,4)", m, r))

			for i := 0; i < 5; i++ {
				atk, vic := (i%4)+1, (i%4)+5
				if r%2 == 0 {
					atk, vic = (i%4)+5, (i%4)+1
				}
				events = append(events, fmt.Sprintf(
					"(%d,%d,%d,%d,'kill','%s','%s','%s',%d,%d,%d,%d,%d,%d,'chest',100)",
					m, (r-1)*27+i, r*3000+i*10, r, sid(atk), sid(vic), weapons[i],
					btoi(i%2 == 0), btoi(i%2 == 1), btoi(i == 2), btoi(i%4 == 1), btoi(i%3 == 0), 40+30*i))
			}
			for d := 0; d < 20; d++ {
				a := (d + r) % 8
				events = append(events, fmt.Sprintf(
					"(%d,%d,%d,%d,'damage','%s','%s','ak47',0,0,0,0,0,25,'',%d)",
					m, (r-1)*27+5+d, r*3000+100+d, r, sid(a+1), sid((a+4)%8+1), 10*((d%10)+1)))
			}
			for f := 0; f < 2; f++ {
				a := (r + f) % 8
				events = append(events, fmt.Sprintf(
					"(%d,%d,%d,%d,'blind','%s','%s','flashbang',0,0,0,0,0,15,'',0)",
					m, (r-1)*27+25+f, r*3000+200+f, r, sid(a+1), sid((a+4)%8+1)))
			}

			base := ((r - 1) % 4) + 1
			openA, openWon := base, "ct"
			tradeA, tradeWon := base+4, "t"
			if r%2 == 0 {
				openA, openWon = base+4, "t"
				tradeA, tradeWon = base, "ct"
			}
			engs = append(engs,
				fmt.Sprintf("(%d,%d,%d,%d,'opening','%s','%s',%d,'%s')", m, (r-1)*3, r*3000+5, r, sid(openA), sid(openA+4), 100+r, openWon),
				fmt.Sprintf("(%d,%d,%d,%d,'trade','%s','%s',%d,'%s')", m, (r-1)*3+1, r*3000+5, r, sid(tradeA), sid(((tradeA-1+4)%8)+1), 100+r, tradeWon),
				fmt.Sprintf("(%d,%d,%d,%d,'untraded','%s','%s',%d,'%s')", m, (r-1)*3+2, r*3000+5, r, sid(openA), sid(openA+4), 100+r, openWon))

			for k, uk := range []string{"he", "flash", "smoke"} {
				t := ((r + k) % 8) + 1
				dmg, flashMS := 0, 0
				switch uk {
				case "he":
					dmg = 20
				case "flash":
					flashMS = 600
				}
				utils = append(utils, fmt.Sprintf("(%d,%d,%d,%d,'%s','%s','%s',%d,%d,'a')",
					m, (r-1)*3+k, r*3000+300+k*50, r, sid(t), names[t-1], uk, dmg, flashMS))
			}

			for i := 1; i <= 8; i++ {
				dies := (r % 4) == (i % 4)
				deaths, traded := 0, 0
				if dies {
					deaths = 1
					if r <= 12 {
						traded = 1
					}
				}
				prows = append(prows, fmt.Sprintf("(%d,%d,'%s','%s',%d,0,%d,%d,%d,%d,%d,0,8000,3500,%d,1)",
					m, r, sid(i), names[i-1], (i+r)%3, deaths, traded, 1-deaths,
					btoi((i+r)%2 == 0), 50+((i+r)%3)*10, 1000+((i+r)%4)*500))
			}
		}
		for s := 0; s < 12; s++ {
			voices = append(voices, fmt.Sprintf("(%d,%d,'%s',%d,%d,%d,320,%d,0)",
				m, s, sid(s%8+1), s*1000, s%24+1, s*320, btoi(s == 0)))
		}
		for c := 0; c < 4; c++ {
			chats = append(chats, fmt.Sprintf("(%d,%d,%d,'%s','%s','gg wp','all')",
				m, c*400+50, c+1, sid(c+1), names[c]))
		}
	}

	emit("matches", "path,sha256,size,map,tick_rate,duration_ticks,playback_time_s,frames,server_name,client_name,game_dir,net_proto,warmup_rounds,real_rounds,score_ct,score_t,half_ct,half_t,side_switches,parser_version,extracted_at,parse_ms,warnings_count,status", matches)
	emit("teams", "match_id,side,name,flag,score", teams)
	emit("players", "match_id,steam_id,name,is_bot,side", players)
	emit("player_stats", "match_id,steam_id,side,name,kills,deaths,assists,headshots,mvps,score,total_damage,damage_taken,adr,hs_pct,rounds_played,opening_kills,trade_kills,money_spent_total", pstats)
	emit("rounds", "match_id,number,winner,reason,duration_s,start_tick,end_tick,warmup,mvp,equip_ct,equip_t,freeze_end_tick,first_kill_steam,first_death_steam", rounds)
	emit("round_economy", "match_id,round,side,equip_value,money_sampled_sum,money_samples", econ)
	emit("events", "match_id,seq,tick,round,kind,attacker,victim,weapon,headshot,wallbang,through_smoke,attacker_blind,assisted_flash,distance,hitgroup,dmg", events)
	emit("player_round_stats", "match_id,round,steam_id,name,kills,assists,deaths,traded,survived,kast,dmg,util_dmg,money_start,equip,spent,rule_version", prows)
	emit("engagements", "match_id,seq,tick,round,kind,a_steam,b_steam,distance,won_by", engs)
	emit("utility_events", "match_id,seq,tick,round,thrower,thrower_name,kind,damage,flash_ms,site", utils)
	emit("voice_chunks", "match_id,seq,steam_id,tick,round,byte_off,len,caster,section", voices)
	emit("chat", "match_id,tick,round,steam_id,name,text,kind", chats)
	return b.String()
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// seedPerfStore builds a file store seeded with the generated corpus.
func seedPerfStore(t *testing.T, matches int) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "perf.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() {
		_ = st.CloseRO()
		_ = st.Close()
	})
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	script := generateCorpus(matches)
	start := time.Now()
	if _, err := db.Exec(script); err != nil {
		t.Fatalf("seed corpus: %v", err)
	}
	_ = db.Close()
	t.Logf("generated %d-match corpus (%d bytes) seeded in %s", matches, len(script), time.Since(start).Round(time.Millisecond))
	return st
}

// TestPerfPreview100Matches measures plan §6: preview < 1 s @ 100 matches.
func TestPerfPreview100Matches(t *testing.T) {
	if testing.Short() {
		t.Skip("perf measurement (run without -short)")
	}
	st := seedPerfStore(t, 100)

	// Sanity: corpus scale.
	res, err := st.RunReadOnly("SELECT COUNT(*) FROM events", nil, 1, 10000)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	events := res.Rows[0][0].(int64)
	if events != 64800 {
		t.Fatalf("events = %d, want 64800 (100 × 648)", events)
	}

	previewCases := []struct {
		name string
		def  Def
	}{
		{"grouped count by player", Def{Expr: "from events: count(where kind='kill')", GroupBy: "player"}},
		{"ungrouped rate + denominator", Def{Expr: "from player_round_stats: count(where deaths=1 and traded=0)", Denominator: "rounds"}},
		{"grouped avg by round", Def{Expr: "from events: avg(where kind='damage', dmg)", GroupBy: "round"}},
		{"percentile p95 (raw fetch + Go compute)", Def{Expr: "from events: percentile(0.95, dmg)"}},
		{"ratio of counts", Def{Expr: "from events: ratio(count(where kind='kill' and headshot), count(where kind='kill'))"}},
	}
	for _, c := range previewCases {
		start := time.Now()
		pv, perr, err := RunPreview(st, c.def, "", 200)
		el := time.Since(start)
		if perr != nil || err != nil {
			t.Fatalf("%s: %v %v", c.name, perr, err)
		}
		t.Logf("preview %-42s rows=%-3d truncated=%-5v %s", c.name, len(pv.Rows), pv.Truncated, el.Round(time.Millisecond))
		if el >= time.Second {
			t.Errorf("%s: preview took %s, want < 1s (plan §6)", c.name, el)
		}
	}
}

// TestPerfCompile measures the compile path alone (plan §6: compiled
// metric as SQL < 3 s — trivially, since compilation never sees row
// counts; 1000 compiles stand in for the 1000-match budget).
func TestPerfCompile(t *testing.T) {
	exprs := []struct{ expr, group, denom string }{
		{"from events: count(where kind='kill' and headshot)", "player", ""},
		{"from player_round_stats: ratio(count(where deaths=1 and traded=0), count(where deaths=1))", "player", ""},
		{"from rounds: ratio(count(where winner='ct'), count())", "", ""},
		{"from events: stddev(where kind='damage', dmg)", "round", ""},
	}
	const iterations = 1000
	start := time.Now()
	for i := 0; i < iterations; i++ {
		e := exprs[i%len(exprs)]
		if _, perr := Compile(e.expr, e.group, e.denom, ""); perr != nil {
			t.Fatalf("compile: %v", perr)
		}
	}
	el := time.Since(start)
	t.Logf("compiled %d expressions in %s (avg %s)", iterations, el.Round(time.Microsecond), (el / iterations).Round(time.Microsecond))
	if el >= 3*time.Second {
		t.Errorf("compile of %d expressions took %s, want < 3s (plan §6)", iterations, el)
	}
}
