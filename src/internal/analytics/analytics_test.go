package analytics

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

func pf(v float64) *float64 { return &v }

// exactSides builds the per-round side map new imports store in
// round_player_sides: every player's side in every COUNTED round (the
// extractor stamps them from the freeze-end samples).
func exactSides(rounds []RoundInfo, players []PlayerRef) map[int]map[string]string {
	out := map[int]map[string]string{}
	for _, r := range CountedRounds(rounds) {
		m := make(map[string]string, len(players))
		for _, p := range players {
			m[p.SteamID] = p.Side
		}
		out[r.Number] = m
	}
	return out
}

var testCfg = Config{TradeWindowS: 5.0, EcoFullBuy: 4000, EcoForce: 2000, RuleVersion: 1, TickRate: 64}

func ev(seq, tick, round int, kind, attacker, victim string, extra ...func(*models.Event)) models.Event {
	e := models.Event{Seq: seq, Tick: tick, Round: round, Kind: kind, Attacker: attacker, Victim: victim}
	for _, f := range extra {
		f(&e)
	}
	return e
}

func withWeapon(w string) func(*models.Event) {
	return func(e *models.Event) { e.Weapon = w }
}

func withDmg(d int) func(*models.Event) {
	return func(e *models.Event) { e.Dmg = d }
}

// withHurt is a player_hurt carrying both the damage dealt and the
// game-sampled victim health the extractor stores in detail_json.health.
func withHurt(dmg, health int) func(*models.Event) {
	return func(e *models.Event) {
		e.Dmg = dmg
		e.DetailJSON = `{"health":` + strconv.Itoa(health) + `}`
	}
}

func withAssister(a string) func(*models.Event) {
	return func(e *models.Event) { e.Assister = a }
}

func TestBuyClassThresholds(t *testing.T) {
	cfg := Config{EcoFullBuy: 4000, EcoForce: 2000}
	cases := []struct {
		name      string
		equip     int
		prevWon   bool
		prevEquip int
		pistol    bool
		want      string
	}{
		{"pistol overrides", 800, false, 0, true, "pistol"},
		{"full at threshold", 4000, false, 0, false, "full"},
		{"full above", 5200, false, 0, false, "full"},
		{"force at threshold", 2000, false, 0, false, "force"},
		{"force below full", 3999, false, 0, false, "force"},
		{"eco below force", 1999, true, 4500, false, "eco"},
		{"save after lost full", 1500, false, 4500, false, "save"},
		{"eco after lost force", 1500, false, 3000, false, "eco"},
		{"eco after win", 1500, true, 4500, false, "eco"},
		{"eco first round", 1200, false, 0, false, "eco"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, why := buyClass(tc.equip, tc.prevWon, tc.prevEquip, cfg, tc.pistol)
			if got != tc.want {
				t.Errorf("buyClass(%d, prevWon=%v, prevEquip=%d, pistol=%v) = %q, want %q",
					tc.equip, tc.prevWon, tc.prevEquip, tc.pistol, got, tc.want)
			}
			if why == "" {
				t.Error("explanation string is REQUIRED (transparent rules)")
			}
		})
	}
}

func TestClassifyPistolAndLabels(t *testing.T) {
	// 3 counted rounds: pistol by position, then label =
	// lower-equip side's buy class. (Knife/warmup rounds are discarded at
	// ingest — a non-counted round never reaches this pass.)
	rounds := []RoundInfo{
		{Number: 1, Winner: "ct", EquipCT: 800, EquipT: 800},
		{Number: 2, Winner: "ct", EquipCT: 5200, EquipT: 1400},
		{Number: 3, Winner: "t", EquipCT: 2500, EquipT: 4200},
	}
	got, gotSides := Classify(nil, rounds, testCfg)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	// The SAME pass derives the per-side rows (round_side_classes): two
	// per counted round, round ASC, ct before t.
	if len(gotSides) != 6 {
		t.Errorf("side rows = %d, want 6 (2 × 3 counted rounds)", len(gotSides))
	}
	for i, r := range got {
		if gotSides[2*i].Round != r.Round || gotSides[2*i].Side != "ct" ||
			gotSides[2*i+1].Round != r.Round || gotSides[2*i+1].Side != "t" {
			t.Errorf("side rows %d/%d = %+v/%+v, want round %d ct then t",
				2*i, 2*i+1, gotSides[2*i], gotSides[2*i+1], r.Round)
		}
		if gotSides[2*i].Class == "" || gotSides[2*i].Why == "" ||
			gotSides[2*i+1].Class == "" || gotSides[2*i+1].Why == "" {
			t.Errorf("round %d side rows = %+v/%+v, class and why are REQUIRED",
				r.Round, gotSides[2*i], gotSides[2*i+1])
		}
	}
	if got[0].Round != 1 || got[0].Label != "pistol" {
		t.Errorf("round 1 = %+v, want pistol", got[0])
	}
	if got[1].Round != 2 || got[1].Label != "eco" {
		t.Errorf("round 2 = %+v, want eco (T 1400 is the lower-equip side)", got[1])
	}
	if got[2].Round != 3 || got[2].Label != "force" {
		t.Errorf("round 3 = %+v, want force (CT 2500 lower-equip side is force)", got[2])
	}
	for _, c := range got {
		if c.Confidence != 1.0 {
			t.Errorf("round %d confidence = %v, want 1.0", c.Round, c.Confidence)
		}
		if c.RuleVersion != testCfg.RuleVersion {
			t.Errorf("round %d ruleVersion = %d, want %d", c.Round, c.RuleVersion, testCfg.RuleVersion)
		}
		if !strings.Contains(c.Explanation, "CT:") || !strings.Contains(c.Explanation, "T:") {
			t.Errorf("round %d explanation missing side reasoning: %q", c.Round, c.Explanation)
		}
	}
}

func TestClassifyPistolStride12(t *testing.T) {
	// MR12: pistols at counted indexes 0 and 12.
	var rounds []RoundInfo
	for i := 0; i < 13; i++ {
		rounds = append(rounds, RoundInfo{Number: i + 1, Winner: "ct", EquipCT: 5000, EquipT: 4500})
	}
	got, _ := Classify(nil, rounds, testCfg)
	if got[0].Label != "pistol" || got[12].Label != "pistol" {
		t.Errorf("pistols at idx 0/12: got %q / %q", got[0].Label, got[12].Label)
	}
	// idx 1: T equip 4500 ≥ full threshold → "full" (no save path: the
	// current buy itself clears the full-buy line).
	if got[1].Label != "full" {
		t.Errorf("idx 1 label = %q, want full (T 4500 ≥ 4000)", got[1].Label)
	}
}

func TestPlayerRoundsKASTTruthTable(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Name: "Alice", Side: "ct"},
		{SteamID: "B", Name: "Bob", Side: "ct"},
		{SteamID: "C", Name: "Cal", Side: "t"},
		{SteamID: "D", Name: "Dee", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "A", "C", withAssister("B")),
		ev(1, 150, 1, models.EventKill, "C", "A"),
		ev(2, 200, 1, models.EventKill, "B", "D"), // trade kill: B's teammate A died at 150
		ev(3, 250, 1, models.EventDamage, "C", "B", withDmg(40)),
		ev(4, 260, 1, models.EventDamage, "A", "X", withDmg(30), withWeapon("HE Grenade")),
	}
	got := PlayerRounds(events, rounds, players, testCfg, exactSides(rounds, players))
	byID := map[string]PlayerRound{}
	for _, r := range got {
		byID[r.SteamID] = r
	}
	// A: kill + death (killer C alive → not traded), no survival → KAST via K.
	if a := byID["A"]; !a.KAST || a.Kills != 1 || a.Deaths != 1 || a.Traded || a.Survived {
		t.Errorf("A = %+v", a)
	}
	if a := byID["A"]; a.UtilDmg != 30 {
		t.Errorf("A utilDmg = %d, want 30", a.UtilDmg)
	}
	// B: kill + assist (assister on kill 0) + survived → KAST.
	if b := byID["B"]; !b.KAST || b.Kills != 1 || b.Assists != 1 || !b.Survived || b.Traded {
		t.Errorf("B = %+v", b)
	}
	// C: kill + death; killer B survives → not traded, but K via kill.
	if c := byID["C"]; !c.KAST || c.Kills != 1 || c.Deaths != 1 {
		t.Errorf("C = %+v", c)
	}
	// D: death only; killer B survives → untraded, no K/A → NO KAST.
	if d := byID["D"]; d.KAST {
		t.Errorf("D = %+v, want no KAST (death untraded)", d)
	}
	if len(got) != 4 {
		t.Errorf("rows = %d, want 4 (every player × counted round)", len(got))
	}
	// Money/equip/spent are documented zeros in v1.
	if a := byID["A"]; a.MoneyStart != 0 || a.Equip != 0 || a.Spent != 0 {
		t.Errorf("A money fields = %d/%d/%d, want documented zeros", a.MoneyStart, a.Equip, a.Spent)
	}
}

func TestPlayerRoundsTradeWindowBoundary(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"},
		{SteamID: "X", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	window := testCfg.ticks(5.0) // 320
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "X", "A"),
		ev(1, 100+window, 1, models.EventKill, "B", "X"), // exactly at the window edge
	}
	got := PlayerRounds(events, rounds, players, testCfg, exactSides(rounds, players))
	for _, r := range got {
		if r.SteamID == "A" && !r.Traded {
			t.Errorf("A traded = false at exact window edge (%d ticks), want true", window)
		}
	}

	events[1].Tick = 100 + window + 1
	got = PlayerRounds(events, rounds, players, testCfg, exactSides(rounds, players))
	for _, r := range got {
		if r.SteamID == "A" && r.Traded {
			t.Errorf("A traded = true beyond window, want false")
		}
	}
}

func TestClutches1v3Won(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Name: "Alice", Side: "ct"},
		{SteamID: "B", Name: "Bob", Side: "ct"},
		{SteamID: "C", Name: "Cal", Side: "ct"},
		{SteamID: "X", Side: "t"},
		{SteamID: "Y", Side: "t"},
		{SteamID: "Z", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct", EquipCT: 15000, EquipT: 12000, EndTick: 900}}
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "A", "X"),
		ev(1, 200, 1, models.EventKill, "Y", "A"),
		ev(2, 300, 1, models.EventKill, "Y", "B"), // C now solo 1v2, start=300
		ev(3, 400, 1, models.EventDamage, "Y", "C", withDmg(30)),
		ev(4, 500, 1, models.EventKill, "C", "Y"),
		ev(5, 600, 1, models.EventKill, "C", "Z"), // opponents wiped → won at 600
	}
	got := Clutches(events, rounds, players, exactSides(rounds, players))
	// Both sides of the endgame record their own instance: C's won 1v2 and
	// Z's lost 1v1 (Z transitions into exactly-1 when Y dies — the spec's
	// "2v1 then 1v1" symmetric accounting).
	if len(got) != 2 {
		t.Fatalf("clutches = %d (%+v), want 2", len(got), got)
	}
	var c1v2, z1v1 *Clutch
	for i := range got {
		switch got[i].SteamID {
		case "C":
			c1v2 = &got[i]
		case "Z":
			z1v1 = &got[i]
		}
	}
	if c1v2 == nil || z1v1 == nil {
		t.Fatalf("clutches = %+v, want records for C and Z", got)
	}
	c := *c1v2
	if c.Size != 2 || c.StartTick != 300 || c.EndTick != 600 {
		t.Errorf("clutch = %+v, want C 1v2 start=300 end=600", c)
	}
	if !c.Won {
		t.Error("won = false, want true (round winner = CT)")
	}
	if c.HPLeft != 70 {
		t.Errorf("hpLeft = %d, want 70 (100 - 30 after start)", c.HPLeft)
	}
	if c.Equip != 15000 {
		t.Errorf("equip = %d, want 15000 (CT equip)", c.Equip)
	}
	if c.BombState != "carried" {
		t.Errorf("bombState = %q, want carried", c.BombState)
	}
	var ticks []int
	if err := json.Unmarshal([]byte(c.KillTicks), &ticks); err != nil {
		t.Fatalf("killTicks not JSON: %v", c.KillTicks)
	}
	if len(ticks) != 2 || ticks[0] != 500 || ticks[1] != 600 {
		t.Errorf("killTicks = %v, want [500 600]", ticks)
	}
	if c.ReplayAnchor != c.StartTick {
		t.Errorf("replayAnchor = %d, want start tick %d", c.ReplayAnchor, c.StartTick)
	}
}

func TestClutchesLostWithBombPlanted(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"},
		{SteamID: "X", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "t", EndTick: 800}}
	events := []models.Event{
		ev(0, 100, 1, models.EventBombPlant, "X", ""),
		ev(1, 200, 1, models.EventKill, "X", "A"), // B solo 1v1, bomb planted
		ev(2, 300, 1, models.EventKill, "X", "B"), // lost
	}
	got := Clutches(events, rounds, players, exactSides(rounds, players))
	// B's lost 1v1 and X's won 1v1 — both sides transitioned into exactly-1.
	if len(got) != 2 {
		t.Fatalf("clutches = %d (%+v), want 2", len(got), got)
	}
	for _, c := range got {
		if c.BombState != "planted" {
			t.Errorf("clutch %+v bombState = %q, want planted", c, c.BombState)
		}
		if c.SteamID == "B" && (c.Won || c.Size != 1 || c.HPLeft != 0) {
			t.Errorf("B clutch = %+v, want lost 1v1 with hpLeft 0 (B died — a dead solo is never clamped up to 1)", c)
		}
		if c.SteamID == "X" && !c.Won {
			t.Errorf("X clutch = %+v, want won", c)
		}
	}
}

// TestClutchHPSeedsFromPreStartDamage pins the HPLeft fix: the seed is
// the sampled victim-health at the clutch start (detail_json.health), so
// damage taken BEFORE the solo became solo counts — including a hit AT
// the start tick (counted by the seed, never by dmgTook). The old
// 100-based reconstruction displayed 90 here.
func TestClutchHPSeedsFromPreStartDamage(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"},
		{SteamID: "X", Side: "t"}, {SteamID: "Y", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct", EndTick: 900}}
	events := []models.Event{
		ev(0, 150, 1, models.EventDamage, "X", "B", withHurt(60, 40)), // pre-start: 40 left
		ev(1, 200, 1, models.EventKill, "X", "A"),                     // B solo 1v2, start=200
		ev(2, 200, 1, models.EventDamage, "X", "B", withHurt(5, 35)),  // same tick → seed, not dmgTook
		ev(3, 300, 1, models.EventDamage, "Y", "B", withDmg(10)),      // post-start → dmgTook
		ev(4, 400, 1, models.EventKill, "B", "X"),
		ev(5, 500, 1, models.EventKill, "B", "Y"), // opponents wiped → won
	}
	got := Clutches(events, rounds, players, exactSides(rounds, players))
	var b *Clutch
	for i := range got {
		if got[i].SteamID == "B" {
			b = &got[i]
		}
	}
	if b == nil {
		t.Fatalf("clutches = %+v, want a record for B", got)
	}
	if !b.Won || b.HPLeft != 25 {
		t.Errorf("B clutch = %+v, want won with hpLeft 25 (35 sampled at start − 10 after)", b)
	}
}

// TestClutchHPSeedFallsBackToPreStartDamage: a pre-start hit with no
// detail_json.health (synthetic fixture / legacy row) seeds the
// reconstruction arithmetically (100 − pre-start damage) instead of
// silently assuming full health.
func TestClutchHPSeedFallsBackToPreStartDamage(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"},
		{SteamID: "X", Side: "t"}, {SteamID: "Y", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct", EndTick: 900}}
	events := []models.Event{
		ev(0, 150, 1, models.EventDamage, "X", "B", withDmg(30)), // no detail row
		ev(1, 200, 1, models.EventKill, "X", "A"),                // B solo 1v2, start=200
		ev(2, 300, 1, models.EventDamage, "Y", "B", withDmg(10)),
		ev(3, 400, 1, models.EventKill, "B", "X"),
		ev(4, 500, 1, models.EventKill, "B", "Y"), // opponents wiped → won
	}
	got := Clutches(events, rounds, players, exactSides(rounds, players))
	var b *Clutch
	for i := range got {
		if got[i].SteamID == "B" {
			b = &got[i]
		}
	}
	if b == nil {
		t.Fatalf("clutches = %+v, want a record for B", got)
	}
	if !b.Won || b.HPLeft != 60 {
		t.Errorf("B clutch = %+v, want won with hpLeft 60 (100 − 30 pre-start − 10 after)", b)
	}
}

func TestEngagementsKinds(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"}, {SteamID: "C", Side: "ct"},
		{SteamID: "X", Side: "t"}, {SteamID: "Y", Side: "t"}, {SteamID: "Z", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "A", "X", withWeapon("AK-47")),
		ev(1, 150, 1, models.EventKill, "Y", "A"), // trade: Y is A, who killed Y's teammate X
		ev(2, 200, 1, models.EventKill, "Y", "B"), // NOT a trade (B never killed a T teammate) — but answered → traded row
		ev(3, 250, 1, models.EventKill, "C", "Y"), // trade: C traded teammate A; Y's death untraded
	}
	got := Engagements(events, rounds, testCfg, players, exactSides(rounds, players))
	counts := map[string]int{}
	for _, e := range got {
		counts[e.Kind]++
	}
	// Strict rule: only kills whose VICTIM killed one of the killer's
	// teammates inside the window count as trades — Y→B is NOT a trade.
	// Coverage rule: Y→B still gets its victim-side row with kind
	// `traded` (it was answered by C→Y at tick 250).
	if counts[KindOpening] != 1 || counts[KindTrade] != 2 || counts[KindTraded] != 3 || counts[KindUntraded] != 1 {
		t.Errorf("engagement counts = %v, want opening=1 trade=2 traded=3 untraded=1 (rows: %+v)", counts, got)
	}
	// Opening row: A killed X.
	tradedB := false
	for _, e := range got {
		if e.Kind == KindOpening && (e.ASteam != "A" || e.BSteam != "X" || e.WonBy != "ct") {
			t.Errorf("opening row = %+v", e)
		}
		if e.BSteam == "B" {
			// Y killing B: present with kind traded (answered by C→Y),
			// but never a trade row (B never killed a T teammate).
			if e.Kind != KindTraded || e.ASteam != "Y" || e.WonBy != "t" {
				t.Errorf("Y killing B row = %+v, want kind traded from killer Y", e)
			}
			tradedB = true
		}
		if e.Kind == KindTrade && e.BSteam == "B" {
			t.Errorf("Y killing B must NOT be a trade row: %+v", e)
		}
		if e.Kind == KindUntraded && (e.ASteam != "C" || e.BSteam != "Y") {
			t.Errorf("untraded row = %+v, want killer C victim Y", e)
		}
	}
	if !tradedB {
		t.Errorf("rows = %+v, want the answered Y→B kill present with kind traded", got)
	}
}

// TestEngagementsEveryKillHasARow pins the COVERAGE invariant: every
// counted kill with known sides appears in ≥1 output row — exactly one
// victim-side row (traded when a teammate of the victim answered inside
// the window, untraded otherwise) plus optional opening/trade
// killer-side rows. The fixture is shaped like golden-demo round 1:
// A→X opens (and stays untraded — X is never answered), Y→Z (Z = A's
// teammate) is answered by A→Y inside the window, and A→Y is both the
// trade (Y killed Y's killer's teammate Z) and an untraded death (Y's
// killer A never dies). Before the KindTraded fix the answered Y→Z kill
// emitted ZERO rows — the gap the Combat card's "one row per kill"
// contract exposed.
func TestEngagementsEveryKillHasARow(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Side: "ct"}, {SteamID: "B", Side: "ct"}, {SteamID: "Z", Side: "ct"},
		{SteamID: "X", Side: "t"}, {SteamID: "Y", Side: "t"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "ct"}}
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "A", "X"), // opening; X's death unanswered → untraded
		ev(1, 200, 1, models.EventKill, "Y", "Z"), // answered by A→Y → traded (was: no row)
		ev(2, 300, 1, models.EventKill, "A", "Y"), // trade + untraded (A never dies)
	}
	got := Engagements(events, rounds, testCfg, players, exactSides(rounds, players))

	// (a) Every kill event (round, tick, killer, victim) is present in ≥1 row.
	kills := 0
	for _, e := range events {
		if e.Kind != models.EventKill || e.Victim == "" || e.Attacker == "" || e.Attacker == e.Victim {
			continue
		}
		kills++
		found := false
		for _, g := range got {
			if g.Round == e.Round && g.Tick == e.Tick && g.ASteam == e.Attacker && g.BSteam == e.Victim {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("kill %s→%s at tick %d (round %d) has no engagement row (rows: %+v)",
				e.Attacker, e.Victim, e.Tick, e.Round, got)
		}
	}
	if kills != 3 {
		t.Fatalf("fixture kills = %d, want 3", kills)
	}

	// (b)+(c) Exact output: the traded row for the answered kill exists,
	// and the four rows that existed before the fix are byte-identical.
	want := []Engagement{
		{Tick: 100, Round: 1, Kind: KindOpening, ASteam: "A", BSteam: "X", WonBy: "ct"},
		{Tick: 100, Round: 1, Kind: KindUntraded, ASteam: "A", BSteam: "X", WonBy: "ct"},
		{Tick: 200, Round: 1, Kind: KindTraded, ASteam: "Y", BSteam: "Z", WonBy: "t"},
		{Tick: 300, Round: 1, Kind: KindTrade, ASteam: "A", BSteam: "Y", WonBy: "ct"},
		{Tick: 300, Round: 1, Kind: KindUntraded, ASteam: "A", BSteam: "Y", WonBy: "ct"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("engagements =\n %+v\nwant\n %+v", got, want)
	}
}

// TestEngagementsSkipsRoundlessKills: a kill stamped to a round with NO
// stored round row produces no engagement rows. The knife/warmup discard
// means such kills never reach events at all (extract.agg.roundStart
// discards the round); this pins the pass's own round guard, which is
// what used to express the warmup filter (the retired
// TestEngagementsSkipsWarmup — its subject died with the discard).
func TestEngagementsSkipsRoundlessKills(t *testing.T) {
	players := []PlayerRef{{SteamID: "A", Side: "ct"}, {SteamID: "X", Side: "t"}}
	rounds := []RoundInfo{{Number: 1}}
	events := []models.Event{
		ev(0, 10, 0, models.EventKill, "A", "X"), // round 0 has no round row
		ev(1, 100, 1, models.EventKill, "A", "X"),
	}
	got := Engagements(events, rounds, testCfg, players, exactSides(rounds, players))
	// The round-less kill produces no rows; the round-1 kill yields
	// opening + untraded (X's death has no teammate revenge).
	if len(got) != 2 {
		t.Fatalf("engagements = %+v, want 2 rows from the round-1 kill", got)
	}
	kinds := map[string]bool{}
	for _, e := range got {
		if e.Round != 1 {
			t.Errorf("row from a round with no round row: %+v", e)
		}
		kinds[e.Kind] = true
	}
	if !kinds[KindOpening] || !kinds[KindUntraded] {
		t.Errorf("kinds = %v, want opening + untraded", kinds)
	}
}

func TestUtilityPairingAndFlash(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Name: "Alice", Side: "ct"},
		{SteamID: "X", Side: "t"},
		{SteamID: "Y", Side: "t"},
	}
	// Blind payloads arrive as a side-channel map keyed by event Seq
	// (the typed-column read never populates ev.DetailJSON).
	blindDetails := map[int]string{
		7: `{"flashDurationMs":500}`,
		8: `{"flashDurationMs":300}`,
		9: `{"flashDurationMs":999}`,
	}
	events := []models.Event{
		ev(0, 100, 1, models.EventGrenadeThrow, "A", "", withWeapon("HE Grenade")),
		ev(1, 150, 1, models.EventGrenade, "A", "", withWeapon("HE Grenade")),
		ev(2, 151, 1, models.EventDamage, "A", "X", withWeapon("HE Grenade"), withDmg(30)),
		ev(3, 160, 1, models.EventDamage, "A", "Y", withWeapon("HE Grenade"), withDmg(20)),
		ev(4, 155, 1, models.EventDamage, "A", "X", withWeapon("AK-47"), withDmg(99)), // wrong weapon
		ev(5, 200, 1, models.EventGrenadeThrow, "A", "", withWeapon("Flashbang")),
		ev(6, 240, 1, models.EventGrenade, "A", "", withWeapon("Flashbang")),
		ev(7, 245, 1, models.EventBlind, "A", "X"),
		ev(8, 250, 1, models.EventBlind, "A", "Y"),
		ev(9, 251, 1, models.EventBlind, "B", "X"), // wrong attacker
		ev(10, 300, 1, models.EventGrenadeThrow, "A", "", withWeapon("Smoke Grenade")),
		// throw with no detonation → no row
	}
	got := Utility(events, players, testCfg, blindDetails)
	if len(got) != 2 {
		t.Fatalf("utility rows = %d (%+v), want 2 (HE + flash; un-detonated smoke skipped)", len(got), got)
	}
	var he, flash *UtilityEvent
	for i := range got {
		switch got[i].Kind {
		case "he":
			he = &got[i]
		case "flash":
			flash = &got[i]
		}
	}
	if he == nil || flash == nil {
		t.Fatalf("rows = %+v, want he + flash", got)
	}
	if he.Damage != 50 {
		t.Errorf("HE damage = %d, want 50 (30+20; AK excluded)", he.Damage)
	}
	if he.Thrower != "A" || he.ThrowerName != "Alice" || he.Tick != 150 {
		t.Errorf("HE row = %+v, want thrower A/Alice tick 150", he)
	}
	var affected []string
	if err := json.Unmarshal([]byte(he.Affected), &affected); err != nil || len(affected) != 2 {
		t.Errorf("HE affected = %q, want 2 victims", he.Affected)
	}
	if flash.FlashMs != 800 {
		t.Errorf("flash ms = %d, want 800 (500+300; wrong attacker excluded)", flash.FlashMs)
	}
	var faffected []string
	if err := json.Unmarshal([]byte(flash.Affected), &faffected); err != nil || len(faffected) != 2 {
		t.Errorf("flash affected = %q, want [X Y]", flash.Affected)
	}
}

func TestUtilityDetWithoutThrow(t *testing.T) {
	players := []PlayerRef{{SteamID: "A", Side: "ct"}}
	events := []models.Event{
		ev(0, 500, 1, models.EventGrenade, "A", "", withWeapon("Smoke Grenade"), func(e *models.Event) {
			e.PosX, e.PosY = pf(10), pf(-20)
		}),
	}
	got := Utility(events, players, testCfg, nil)
	if len(got) != 1 || got[0].Kind != "smoke" || got[0].Thrower != "A" {
		t.Errorf("rows = %+v, want one smoke row keyed on the detonation", got)
	}
	if got[0].DetX == nil || *got[0].DetX != 10 {
		t.Errorf("det position = %v, want x=10", got[0].DetX)
	}
}

// TestUtilKindUsesModelsUtilitySet pins analytics' side of the utility
// set: utilKind and the util-dmg attribution both go through models, so
// every canonical grenade normalizes to the stored kind and nothing else
// does (the set itself is pinned in extract.TestUtilityWeaponSetsIdentical).
func TestUtilKindUsesModelsUtilitySet(t *testing.T) {
	for _, tc := range []struct{ weapon, kind string }{
		{"HE Grenade", "he"},
		{"Flashbang", "flash"},
		{"Smoke Grenade", "smoke"},
		{"Molotov", "molotov"},
		{"Incendiary Grenade", "molotov"},
		{"Decoy Grenade", "decoy"},
	} {
		if !models.IsUtilityWeapon(tc.weapon) {
			t.Errorf("IsUtilityWeapon(%q) = false, want true", tc.weapon)
		}
		if got := utilKind(tc.weapon); got != tc.kind {
			t.Errorf("utilKind(%q) = %q, want %q", tc.weapon, got, tc.kind)
		}
	}
	for _, weapon := range []string{"AK-47", "AWP", "knife", "weapon_hegrenade"} {
		if models.IsUtilityWeapon(weapon) {
			t.Errorf("IsUtilityWeapon(%q) = true, want false", weapon)
		}
		if got := utilKind(weapon); got != strings.ToLower(weapon) {
			t.Errorf("utilKind(%q) = %q, want the lowercased pairing key %q",
				weapon, got, strings.ToLower(weapon))
		}
	}
}

// Combat-stats semantics (including the documented SQL decisions) are
// pinned in internal/store/analytics_test.go: TestGetCombatStatsFromStoredRows
// and TestGetCombatStatsSQLDecisions.

// Per-side buy classes (pistol/full/force/eco/save + the REQUIRED why
// strings) are pinned in eco_equivalence_test.go: the STORED
// round_side_classes rows against the retired read-time fill
// (analytics.EconomyRows) kept there as a reference oracle — the read
// path itself was retired 2026-11-12 (AGENTS.md "Analysis-rule derived
// values"), so this package no longer fills economy rows at read time.
