package extract

import (
	"context"
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
)

// TestDiagRoundMoneyProps characterizes the per-round money props the
// player_round_stats money columns need: m_iStartAccount (money at round
// start), m_unRoundStartEquipmentValue (carried gear before buys) and
// m_iCashSpentThisRound (the game's per-round spend counter). It checks
// availability, the freeze-end identity
//
//	startAccount − cashSpentThisRound == account
//
// (no income is possible between round start and freeze end), stability
// across the round, the round-1/13 $800 reset under COUNTED numbering,
// whether pawn props survive to RoundEnd for dead players (which decides
// the sample point), and whether money can be spent between RoundEnd and
// the next RoundStart (which would make a RoundEnd sample undercount).
// Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagRoundMoneyProps -v
func TestDiagRoundMoneyProps(t *testing.T) {
	if os.Getenv("SPECTRA_DIAG") == "" {
		t.Skip("set SPECTRA_DIAG=1")
	}
	f, err := os.Open("../../../golden/de_cache.dem.zst")
	if err != nil {
		t.Fatalf("open golden: %v", err)
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

	type playerRead struct {
		name       string
		round      int
		startAcct  int // m_iStartAccount (-1 = prop absent)
		account    int // m_iAccount
		spentRound int // m_iCashSpentThisRound (-1 = absent)
		totalSpent int // m_iTotalCashSpent (cumulative)
		equipStart int // m_unRoundStartEquipmentValue (-1 = absent)
		equipFTE   int // m_unFreezetimeEndEquipmentValue
		pawnAlive  bool
	}
	var freezeReads, roundEndReads, roundStartReads []playerRead
	round := 0 // counted rounds only (mirror ingest discard)
	discard := false

	read := func(pl *common.Player) playerRead {
		pr := playerRead{name: pl.Name, round: round, startAcct: -1, spentRound: -1, equipStart: -1}
		if pl.Entity != nil {
			if v, ok := pl.Entity.PropertyValue("m_pInGameMoneyServices.m_iStartAccount"); ok && v.Any != nil {
				pr.startAcct = v.Int()
			}
			pr.account = pl.Money()
			if v, ok := pl.Entity.PropertyValue("m_pInGameMoneyServices.m_iCashSpentThisRound"); ok && v.Any != nil {
				pr.spentRound = v.Int()
			}
			pr.totalSpent = pl.MoneySpentTotal()
		}
		pawn := pl.PlayerPawnEntity()
		pr.pawnAlive = pawn != nil
		if pawn != nil {
			if v, ok := pawn.PropertyValue("m_unRoundStartEquipmentValue"); ok && v.Any != nil {
				pr.equipStart = int(v.UInt64()) //#nosec G115
			}
			pr.equipFTE = pl.EquipmentValueFreezeTimeEnd()
		}
		return pr
	}

	p.RegisterEventHandler(func(e events.RoundStart) {
		gs := p.GameState()
		warmup := gs.IsWarmupPeriod()
		discard = warmup || !realPeriod(gs)
		if discard {
			return
		}
		round++
		for _, pl := range gs.Participants().Playing() {
			if pl == nil {
				continue
			}
			roundStartReads = append(roundStartReads, read(pl))
		}
	})
	p.RegisterEventHandler(func(e events.RoundFreezetimeChanged) {
		if e.NewIsFreezetime || discard {
			return
		}
		for _, pl := range p.GameState().Participants().Playing() {
			if pl == nil {
				continue
			}
			freezeReads = append(freezeReads, read(pl))
		}
	})
	p.RegisterEventHandler(func(e events.RoundEnd) {
		if discard {
			return
		}
		for _, pl := range p.GameState().Participants().Playing() {
			if pl == nil {
				continue
			}
			roundEndReads = append(roundEndReads, read(pl))
		}
	})

	if err := p.ParseToEnd(context.Background()); err != nil {
		t.Fatalf("parse: %v", err)
	}

	// ---- availability + freeze-end identity ----
	absentStart, absentSpent, absentEquip := 0, 0, 0
	identityBad := 0
	for _, r := range freezeReads {
		if r.startAcct < 0 {
			absentStart++
		}
		if r.spentRound < 0 {
			absentSpent++
		}
		if r.equipStart < 0 {
			absentEquip++
		}
		if r.startAcct >= 0 && r.startAcct-r.spentRound != r.account {
			identityBad++
			if identityBad <= 5 {
				t.Logf("IDENTITY round %d %s: start %d − spent %d = %d, account %d",
					r.round, r.name, r.startAcct, r.spentRound, r.startAcct-r.spentRound, r.account)
			}
		}
	}
	t.Logf("freeze-end reads=%d countedRounds=%d absent(startAccount)=%d absent(cashSpentThisRound)=%d absent(roundStartEquip)=%d identityMismatch=%d",
		len(freezeReads), round, absentStart, absentSpent, absentEquip, identityBad)

	// ---- round-1 / round-13 reset check (counted numbering) ----
	for _, r := range freezeReads {
		if r.round == 1 || r.round == 13 {
			t.Logf("RESET round %d %s: startAccount=%d account=%d spentRound=%d equipStart=%d equipFTE=%d",
				r.round, r.name, r.startAcct, r.account, r.spentRound, r.equipStart, r.equipFTE)
		}
	}

	// ---- RoundStart reads: what does the counter hold BEFORE the freeze
	// buys? startAccount must equal the game's start money (800 on
	// pistol rounds), spentRound must be 0 (or carry a between-rounds
	// buy if one is even possible). ----
	startSpentNonZero := 0
	startAcctMismatch := 0
	for _, r := range roundStartReads {
		if r.round == 1 || r.round == 13 {
			t.Logf("ROUNDSTART round %d %s: startAccount=%d account=%d spentRound=%d equipStart=%d",
				r.round, r.name, r.startAcct, r.account, r.spentRound, r.equipStart)
		}
		if r.spentRound > 0 {
			startSpentNonZero++
			if startSpentNonZero <= 10 {
				t.Logf("ROUNDSTART-SPENT round %d %s: spentRound=%d account=%d",
					r.round, r.name, r.spentRound, r.account)
			}
		}
		if r.startAcct != r.account {
			// At RoundStart the account should equal startAccount
			// (no buys yet — freeze time just began).
			startAcctMismatch++
			if startAcctMismatch <= 10 {
				t.Logf("ROUNDSTART-MISMATCH round %d %s: start=%d account=%d",
					r.round, r.name, r.startAcct, r.account)
			}
		}
	}
	t.Logf("round-start reads=%d spentNonZero=%d startVsAccountMismatch=%d",
		len(roundStartReads), startSpentNonZero, startAcctMismatch)

	// ---- freeze end vs round end: stability + pawn survival + post-freeze buys ----
	byEnd := map[int]map[string]playerRead{}
	for _, r := range roundEndReads {
		if byEnd[r.round] == nil {
			byEnd[r.round] = map[string]playerRead{}
		}
		byEnd[r.round][r.name] = r
	}
	pawnGone := 0
	startDrift := 0
	equipDrift := 0
	postFreezeBuys := 0
	var driftSamples []string
	for _, fr := range freezeReads {
		er, ok := byEnd[fr.round][fr.name]
		if !ok {
			continue
		}
		if fr.pawnAlive && !er.pawnAlive {
			pawnGone++
		}
		if fr.startAcct != er.startAcct {
			startDrift++
			if len(driftSamples) < 5 {
				driftSamples = append(driftSamples, fmt.Sprintf("r%d %s start %d→%d", fr.round, fr.name, fr.startAcct, er.startAcct))
			}
		}
		if fr.equipStart != er.equipStart {
			equipDrift++
			if len(driftSamples) < 10 {
				driftSamples = append(driftSamples, fmt.Sprintf("r%d %s equipStart %d→%d", fr.round, fr.name, fr.equipStart, er.equipStart))
			}
		}
		if er.spentRound > fr.spentRound {
			postFreezeBuys++
			if postFreezeBuys <= 10 {
				t.Logf("POST-FREEZE BUY round %d %s: spent %d → %d", fr.round, fr.name, fr.spentRound, er.spentRound)
			}
		}
	}
	for _, s := range driftSamples {
		t.Logf("DRIFT %s", s)
	}
	t.Logf("paired=%d pawnGoneAtRoundEnd=%d startAcctDrift=%d equipStartDrift=%d postFreezeBuyPlayers=%d",
		len(freezeReads), pawnGone, startDrift, equipDrift, postFreezeBuys)

	// ---- round-1 carried equip: free spawn pistol inside or not? ----
	for _, r := range freezeReads {
		if r.round == 1 {
			t.Logf("PISTOL r1 %s: equipStart=%d equipFTE=%d start=%d", r.name, r.equipStart, r.equipFTE, r.startAcct)
		}
	}

	// ---- per-round equipStart series: does m_unRoundStartEquipmentValue
	// update EVERY round (carried gear) or go stale? ----
	series := map[string]map[int]int{}
	for _, r := range freezeReads {
		if series[r.name] == nil {
			series[r.name] = map[int]int{}
		}
		series[r.name][r.round] = r.equipStart
	}
	for name, m := range series {
		line := fmt.Sprintf("SERIES %s:", name)
		for rn := 1; rn <= round; rn++ {
			line += fmt.Sprintf(" r%d=%d", rn, m[rn])
		}
		t.Log(line)
	}

	// ---- between-rounds spend: does m_iTotalCashSpent grow between
	// RoundEnd(N) and RoundStart(N+1)? If yes, a RoundEnd sample of
	// m_iCashSpentThisRound undercounts that round's buys. ----
	endByRound := map[string]map[int]int{}
	for _, r := range roundEndReads {
		if endByRound[r.name] == nil {
			endByRound[r.name] = map[int]int{}
		}
		endByRound[r.name][r.round] = r.totalSpent
	}
	gapBuys := 0
	for _, r := range roundStartReads {
		if r.round <= 1 {
			continue
		}
		prev, ok := endByRound[r.name][r.round-1]
		if !ok {
			continue
		}
		if r.totalSpent > prev {
			gapBuys++
			t.Logf("GAP-BUY %s round %d→%d: totalSpent %d → %d", r.name, r.round-1, r.round, prev, r.totalSpent)
		}
	}
	t.Logf("between-rounds gap buys=%d", gapBuys)
}
