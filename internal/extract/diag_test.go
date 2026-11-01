package extract

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
)

// TestDiagGolden is a throwaway diagnostic against the golden demo. Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagGolden -v
//
// It re-parses the demo with its own handlers (no extract state) and dumps
// round lifecycle, per-player split stats (warmup / pregame-knife / real),
// enemy vs team damage, observed sides per round, and the game's own MVP
// counter deltas, so numbers can be compared against an external scoreboard.
func TestDiagGolden(t *testing.T) {
	if os.Getenv("SPECTRA_DIAG") == "" {
		t.Skip("set SPECTRA_DIAG=1")
	}
	path := "../../donk.dem.zst"
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(f, magic); err != nil {
		t.Fatal(err)
	}
	src := io.MultiReader(magicReader(magic), f)
	r := src
	if magic[0] == 0x28 && magic[1] == 0xb5 && magic[2] == 0x2f && magic[3] == 0xfd {
		dec, err := zstd.NewReader(src)
		if err != nil {
			t.Fatal(err)
		}
		defer dec.Close()
		r = dec
	}

	p := demoinfocs.NewParser(r)
	defer func() { _ = p.Close() }()

	type pstat struct {
		name, steam                            string
		kReal, dReal, aReal, hsReal            int
		aFlashReal                             int
		kPregame, dPregame, aPregame           int
		kWarm, dWarm                           int
		dmgEnemy, dmgTeam, dmgPregame, dmgWarm int
		dmgTaken                               int
		dmgEnemyTaken                          int
		dmgR1Raw, dmgR1Taken                   int
		knifeDmg                               int
		mvpDeltas                              []int
		lastMVP                                int
		sidesByRound                           map[int]string
		weaponDmg                              map[string]int
	}
	stats := map[uint64]*pstat{}
	sideOf := map[uint64]string{}
	get := func(pl *common.Player) *pstat {
		if pl == nil {
			return nil
		}
		s := stats[pl.SteamID64]
		if s == nil {
			s = &pstat{name: pl.Name, steam: fmt.Sprintf("%d", pl.SteamID64), sidesByRound: map[int]string{}, weaponDmg: map[string]int{}}
			stats[pl.SteamID64] = s
		}
		return s
	}

	curRound := 0
	curWarmup := false
	curMatch := false
	fmt.Println("== rounds ==")
	p.RegisterEventHandler(func(e events.RoundStart) {
		gs := p.GameState()
		curRound++
		curWarmup = gs.IsWarmupPeriod()
		curMatch = gs.IsMatchStarted()
		fmt.Printf("roundStart #%d tick=%d warmup=%v matchStarted=%v phase=%d totalPlayed=%d\n",
			curRound, gs.IngameTick(), curWarmup, curMatch, int(gs.GamePhase()), gs.TotalRoundsPlayed())
	})
	p.RegisterEventHandler(func(e events.RoundFreezetimeChanged) {
		if e.NewIsFreezetime {
			return
		}
		gs := p.GameState()
		ct, t := 0, 0
		if s := gs.TeamCounterTerrorists(); s != nil {
			ct = s.Score()
		}
		if s := gs.TeamTerrorists(); s != nil {
			t = s.Score()
		}
		fmt.Printf("  freezeEnd #%d tick=%d score ct/t=%d/%d\n", curRound, gs.IngameTick(), ct, t)
		for _, pl := range gs.Participants().Playing() {
			s := get(pl)
			if s != nil {
				s.sidesByRound[curRound] = sideString(pl.Team)
				sideOf[pl.SteamID64] = sideString(pl.Team)
			}
		}
	})
	p.RegisterEventHandler(func(e events.RoundEnd) {
		gs := p.GameState()
		ct, t := 0, 0
		if s := gs.TeamCounterTerrorists(); s != nil {
			ct = s.Score()
		}
		if s := gs.TeamTerrorists(); s != nil {
			t = s.Score()
		}
		fmt.Printf("roundEnd   #%d tick=%d winner=%s reason=%v scoreAtEnd ct/t=%d/%d\n",
			curRound, gs.IngameTick(), sideString(e.Winner), int(e.Reason), ct, t)
		// game's own MVP counter deltas per round
		for _, pl := range gs.Participants().Playing() {
			s := get(pl)
			if s == nil {
				continue
			}
			m := pl.MVPs()
			if m > s.lastMVP {
				s.mvpDeltas = append(s.mvpDeltas, curRound)
				s.lastMVP = m
			}
		}
	})
	p.RegisterEventHandler(func(events.GameHalfEnded) {
		gs := p.GameState()
		ct, t := 0, 0
		if s := gs.TeamCounterTerrorists(); s != nil {
			ct = s.Score()
		}
		if s := gs.TeamTerrorists(); s != nil {
			t = s.Score()
		}
		fmt.Printf("GameHalfEnded tick=%d score ct/t=%d/%d totalPlayed=%d\n", gs.IngameTick(), ct, t, gs.TotalRoundsPlayed())
	})
	p.RegisterEventHandler(func(events.TeamSideSwitch) {
		fmt.Printf("TeamSideSwitch tick=%d\n", p.GameState().IngameTick())
	})

	p.RegisterEventHandler(func(e events.Kill) {
		gs := p.GameState()
		warm, match := gs.IsWarmupPeriod(), gs.IsMatchStarted()
		ks, vs := get(e.Killer), get(e.Victim)
		var tag string
		switch {
		case warm:
			tag = "warm"
		case !match:
			tag = "pregame"
		default:
			tag = "real"
		}
		fmt.Printf("kill #%d tick=%d [%s] %q -> %q asst=%q flashAsst=%v wpn=%s hs=%v\n", curRound, gs.IngameTick(), tag, killerName(e.Killer), victimName(e.Victim), killerName(e.Assister), e.AssistedFlash, wepName(e.Weapon), e.IsHeadshot)
		if ks != nil {
			switch tag {
			case "warm":
				ks.kWarm++
			case "pregame":
				ks.kPregame++
			default:
				ks.kReal++
				if e.IsHeadshot {
					ks.hsReal++
				}
			}
		}
		if vs != nil {
			switch tag {
			case "warm":
				vs.dWarm++
			case "pregame":
				vs.dPregame++
			default:
				vs.dReal++
			}
		}
		if as := get(e.Assister); as != nil {
			switch tag {
			case "pregame":
				as.aPregame++
			default:
				if e.AssistedFlash {
					as.aFlashReal++
				} else {
					as.aReal++
				}
			}
		}
	})
	p.RegisterEventHandler(func(e events.PlayerHurt) {
		gs := p.GameState()
		warm, match := gs.IsWarmupPeriod(), gs.IsMatchStarted()
		as, vs := get(e.Attacker), get(e.Player)
		if vs != nil {
			vs.dmgTaken += e.HealthDamage
		}
		if as != nil && e.Player != nil {
			team := e.Attacker != nil && e.Player != nil && e.Attacker.Team == e.Player.Team && e.Player.Team != common.TeamUnassigned
			wn := wepName(e.Weapon)
			if e.WeaponString != "" && (e.Weapon == nil || e.Weapon.Type == common.EqUnknown) {
				wn = e.WeaponString
			}
			switch {
			case warm:
				as.dmgWarm += e.HealthDamage
			case !match:
				as.dmgPregame += e.HealthDamage
			case team:
				as.dmgTeam += e.HealthDamage
			default:
				as.dmgEnemy += e.HealthDamage
				as.dmgEnemyTaken += e.HealthDamageTaken
				if curRound == 1 {
					as.dmgR1Raw += e.HealthDamage
					as.dmgR1Taken += e.HealthDamageTaken
				}
				as.weaponDmg[wn] += e.HealthDamage
				if wn == "Knife" {
					as.knifeDmg += e.HealthDamage
				}
			}
		}
	})

	if err := p.ParseToEnd(context.Background()); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		t.Fatalf("parse: %v", err)
	}

	fmt.Println("== final participants ==")
	for _, pl := range p.GameState().Participants().Playing() {
		fmt.Printf("  %q steam=%d team=%s alive=%v kills=%d deaths=%d assists=%d mvp=%d\n",
			pl.Name, pl.SteamID64, sideString(pl.Team), pl.IsAlive(), pl.Kills(), pl.Deaths(), pl.Assists(), pl.MVPs())
	}
	gs := p.GameState()
	if s := gs.TeamCounterTerrorists(); s != nil {
		fmt.Printf("final team CT %q score=%d\n", s.ClanName(), s.Score())
	}
	if s := gs.TeamTerrorists(); s != nil {
		fmt.Printf("final team T  %q score=%d\n", s.ClanName(), s.Score())
	}

	fmt.Println("== per-player ==")
	keys := make([]uint64, 0, len(stats))
	for k := range stats {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return stats[keys[i]].name < stats[keys[j]].name })
	for _, k := range keys {
		s := stats[k]
		realTakenExR1 := s.dmgEnemyTaken - s.dmgR1Taken
		realRawExR1 := s.dmgEnemy - s.dmgR1Raw
		fmt.Printf("%-12s steam=%s sides=%v K/D/A real=%d/%d/%d (flashA=%d) pregame=%d/%d/%d warm=%d/%d hs=%d dmg(enemy/team/pregame/warm)=%d/%d/%d/%d taken=%d enemyTaken=%d r1Raw=%d r1Taken=%d knifeRaw=%d realTakenExR1=%d realRawExR1=%d mvpRounds=%v\n",
			s.name, s.steam, fmtSides(s.sidesByRound), s.kReal, s.dReal, s.aReal, s.aFlashReal,
			s.kPregame, s.dPregame, s.aPregame, s.kWarm, s.dWarm, s.hsReal,
			s.dmgEnemy, s.dmgTeam, s.dmgPregame, s.dmgWarm, s.dmgTaken, s.dmgEnemyTaken, s.dmgR1Raw, s.dmgR1Taken, s.knifeDmg, realTakenExR1, realRawExR1, s.mvpDeltas)
		wkeys := make([]string, 0, len(s.weaponDmg))
		for w := range s.weaponDmg {
			wkeys = append(wkeys, w)
		}
		sort.Strings(wkeys)
		parts := ""
		for _, w := range wkeys {
			parts += fmt.Sprintf("%s=%d ", w, s.weaponDmg[w])
		}
		fmt.Printf("    enemydmg-by-weapon: %s\n", parts)
	}
}

func magicReader(b []byte) io.Reader { return &oneReader{b: b} }

type oneReader struct{ b []byte }

func (o *oneReader) Read(p []byte) (int, error) {
	if len(o.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, o.b)
	o.b = o.b[n:]
	return n, nil
}

func killerName(e *common.Player) string {
	if e == nil {
		return "<nil>"
	}
	return e.Name
}

func victimName(e *common.Player) string {
	if e == nil {
		return "<nil>"
	}
	return e.Name
}

func fmtSides(m map[int]string) string {
	// compress consecutive identical sides: 1:ct 2:ct ... -> ranges
	nums := make([]int, 0, len(m))
	for k := range m {
		nums = append(nums, k)
	}
	sort.Ints(nums)
	out := ""
	for i := 0; i < len(nums); {
		j := i
		for j+1 < len(nums) && m[nums[j+1]] == m[nums[i]] {
			j++
		}
		if i == j {
			out += fmt.Sprintf("%d:%s ", nums[i], m[nums[i]])
		} else {
			out += fmt.Sprintf("%d-%d:%s ", nums[i], nums[j], m[nums[i]])
		}
		i = j + 1
	}
	return out
}
