package analytics

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

func pf(v float64) *float64 { return &v }

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
			got, why := BuyClass(tc.equip, tc.prevWon, tc.prevEquip, cfg, tc.pistol)
			if got != tc.want {
				t.Errorf("BuyClass(%d, prevWon=%v, prevEquip=%d, pistol=%v) = %q, want %q",
					tc.equip, tc.prevWon, tc.prevEquip, tc.pistol, got, tc.want)
			}
			if why == "" {
				t.Error("explanation string is REQUIRED (transparent rules)")
			}
		})
	}
}

func TestClassifyPistolAndLabels(t *testing.T) {
	// 3 non-warmup rounds + 1 warmup: pistol by position, then label =
	// lower-equip side's buy class.
	rounds := []RoundInfo{
		{Number: 0, Warmup: true},
		{Number: 1, Winner: "ct", EquipCT: 800, EquipT: 800},
		{Number: 2, Winner: "ct", EquipCT: 5200, EquipT: 1400},
		{Number: 3, Winner: "t", EquipCT: 2500, EquipT: 4200},
	}
	got := Classify(nil, rounds, testCfg)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 (warmup excluded)", len(got))
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
	// MR12: pistols at non-warmup indexes 0 and 12.
	var rounds []RoundInfo
	for i := 0; i < 13; i++ {
		rounds = append(rounds, RoundInfo{Number: i + 1, Winner: "ct", EquipCT: 5000, EquipT: 4500})
	}
	got := Classify(nil, rounds, testCfg)
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
	got := PlayerRounds(events, rounds, players, testCfg)
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
		t.Errorf("rows = %d, want 4 (every player × non-warmup round)", len(got))
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
	got := PlayerRounds(events, rounds, players, testCfg)
	for _, r := range got {
		if r.SteamID == "A" && !r.Traded {
			t.Errorf("A traded = false at exact window edge (%d ticks), want true", window)
		}
	}

	events[1].Tick = 100 + window + 1
	got = PlayerRounds(events, rounds, players, testCfg)
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
	got := Clutches(events, rounds, players, testCfg)
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
	got := Clutches(events, rounds, players, testCfg)
	// B's lost 1v1 and X's won 1v1 — both sides transitioned into exactly-1.
	if len(got) != 2 {
		t.Fatalf("clutches = %d (%+v), want 2", len(got), got)
	}
	for _, c := range got {
		if c.BombState != "planted" {
			t.Errorf("clutch %+v bombState = %q, want planted", c, c.BombState)
		}
		if c.SteamID == "B" && (c.Won || c.Size != 1 || c.HPLeft != 100) {
			t.Errorf("B clutch = %+v, want lost 1v1 with hpLeft 100", c)
		}
		if c.SteamID == "X" && !c.Won {
			t.Errorf("X clutch = %+v, want won", c)
		}
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
		ev(1, 150, 1, models.EventKill, "Y", "A"), // trade (X died within window)
		ev(2, 200, 1, models.EventKill, "Y", "B"), // trade (X died within window)
		ev(3, 250, 1, models.EventKill, "C", "Y"), // Y's death untraded
	}
	got := Engagements(events, rounds, testCfg, players)
	counts := map[string]int{}
	for _, e := range got {
		counts[e.Kind]++
	}
	// C's kill of Y is ALSO a trade under the prompt's rule (C's teammate
	// B died ≤ window before — Y literally killed B).
	if counts[KindOpening] != 1 || counts[KindTrade] != 3 || counts[KindUntraded] != 1 {
		t.Errorf("engagement counts = %v, want opening=1 trade=3 untraded=1 (rows: %+v)", counts, got)
	}
	// Opening row: A killed X.
	for _, e := range got {
		if e.Kind == KindOpening && (e.ASteam != "A" || e.BSteam != "X" || e.WonBy != "ct") {
			t.Errorf("opening row = %+v", e)
		}
		if e.Kind == KindUntraded && (e.ASteam != "C" || e.BSteam != "Y") {
			t.Errorf("untraded row = %+v, want killer C victim Y", e)
		}
	}
}

func TestEngagementsSkipsWarmup(t *testing.T) {
	players := []PlayerRef{{SteamID: "A", Side: "ct"}, {SteamID: "X", Side: "t"}}
	rounds := []RoundInfo{{Number: 0, Warmup: true}, {Number: 1}}
	events := []models.Event{
		ev(0, 10, 0, models.EventKill, "A", "X"),
		ev(1, 100, 1, models.EventKill, "A", "X"),
	}
	got := Engagements(events, rounds, testCfg, players)
	// Warmup produces no rows; the round-1 kill yields opening + untraded
	// (X's death has no teammate revenge).
	if len(got) != 2 {
		t.Fatalf("engagements = %+v, want 2 rows from the round-1 kill", got)
	}
	kinds := map[string]bool{}
	for _, e := range got {
		if e.Round != 1 {
			t.Errorf("row from warmup round: %+v", e)
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
	detail := func(ms int) func(*models.Event) {
		return func(e *models.Event) {
			e.DetailJSON = `{"flashDurationMs":` + itoa(ms) + `}`
		}
	}
	events := []models.Event{
		ev(0, 100, 1, models.EventGrenadeThrow, "A", "", withWeapon("HE Grenade")),
		ev(1, 150, 1, models.EventGrenade, "A", "", withWeapon("HE Grenade")),
		ev(2, 151, 1, models.EventDamage, "A", "X", withWeapon("HE Grenade"), withDmg(30)),
		ev(3, 160, 1, models.EventDamage, "A", "Y", withWeapon("HE Grenade"), withDmg(20)),
		ev(4, 155, 1, models.EventDamage, "A", "X", withWeapon("AK-47"), withDmg(99)), // wrong weapon
		ev(5, 200, 1, models.EventGrenadeThrow, "A", "", withWeapon("Flashbang")),
		ev(6, 240, 1, models.EventGrenade, "A", "", withWeapon("Flashbang")),
		ev(7, 245, 1, models.EventBlind, "A", "X", detail(500)),
		ev(8, 250, 1, models.EventBlind, "A", "Y", detail(300)),
		ev(9, 251, 1, models.EventBlind, "B", "X", detail(999)), // wrong attacker
		ev(10, 300, 1, models.EventGrenadeThrow, "A", "", withWeapon("Smoke Grenade")),
		// throw with no detonation → no row
	}
	got := Utility(events, players, testCfg)
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
	got := Utility(events, players, testCfg)
	if len(got) != 1 || got[0].Kind != "smoke" || got[0].Thrower != "A" {
		t.Errorf("rows = %+v, want one smoke row keyed on the detonation", got)
	}
	if got[0].DetX == nil || *got[0].DetX != 10 {
		t.Errorf("det position = %v, want x=10", got[0].DetX)
	}
}

func TestCombatStats(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Name: "Alice", Side: "ct"},
		{SteamID: "X", Side: "t"},
		{SteamID: "B", Side: "ct"}, // A's teammate — the FF victim
	}
	stats := []models.PlayerStats{
		{SteamID: "A", Name: "Alice", EntryKills: 2, TradeKills: 3, Deaths: 4, RoundsPlayed: 10},
	}
	events := []models.Event{
		ev(0, 10, 1, models.EventKill, "A", "X"),
		ev(1, 10, 1, models.EventDamage, "A", "X", withDmg(60)), // on-kill damage
		ev(2, 20, 1, models.EventDamage, "A", "X", withDmg(30)), // damage without kill
		ev(3, 30, 1, models.EventDamage, "A", "B", withDmg(10)), // friendly fire (final sides)
	}
	engs := []Engagement{
		{Kind: KindUntraded, BSteam: "A"},
		{Kind: KindUntraded, BSteam: "A"},
	}
	prs := []PlayerRound{
		{SteamID: "A", KAST: true}, {SteamID: "A", KAST: false}, {SteamID: "A", KAST: true},
	}
	got := CombatStats(events, players, nil, prs, engs, stats, testCfg)
	if len(got) != 1 {
		t.Fatalf("rows = %d, want 1", len(got))
	}
	r := got[0]
	if r.DMGNoKill != 40 {
		t.Errorf("dmgNoKill = %d, want 40", r.DMGNoKill)
	}
	if r.DMGConvPct < 59.9 || r.DMGConvPct > 60.1 {
		t.Errorf("dmgConvPct = %v, want 60", r.DMGConvPct)
	}
	if r.FFDamage != 10 {
		t.Errorf("ffDamage = %d, want 10", r.FFDamage)
	}
	if r.EntryRate != 0.2 {
		t.Errorf("entryRate = %v, want 0.2", r.EntryRate)
	}
	if r.TradeRate != 0.75 {
		t.Errorf("tradeRate = %v, want 0.75", r.TradeRate)
	}
	if r.UntradedDeaths != 2 || r.TradeOppMissed != 2 {
		t.Errorf("untraded/oppMissed = %d/%d, want 2/2", r.UntradedDeaths, r.TradeOppMissed)
	}
	if r.KASTPct < 66.6 || r.KASTPct > 66.8 {
		t.Errorf("kastPct = %v, want ~66.67", r.KASTPct)
	}
}

func TestEconomyRowsFillsClasses(t *testing.T) {
	rows := []models.EconomyRow{
		{Round: 1, Winner: "ct", EquipCT: 800, EquipT: 800, WonCT: true, WonT: false, Label: "pistol"},
		{Round: 2, Winner: "ct", EquipCT: 5200, EquipT: 1400, WonCT: true, WonT: false},
		{Round: 3, Winner: "ct", EquipCT: 3000, EquipT: 1500, WonCT: true, WonT: false},
	}
	got := EconomyRows(rows, testCfg)
	if !got[0].PistolRound || got[0].ClassCT != "pistol" || got[0].ClassT != "pistol" {
		t.Errorf("round 1 = %+v, want pistol classes", got[0])
	}
	if got[1].ClassCT != "full" || got[1].ClassT != "eco" {
		t.Errorf("round 2 classes = %q/%q, want full/eco", got[1].ClassCT, got[1].ClassT)
	}
	// T lost round 2 after a full-ish buy? T had 1400 in r2 (eco, not full
	// after pistol) → r3 T 1500 is eco, not save.
	if got[2].ClassT != "eco" {
		t.Errorf("round 3 T class = %q, want eco", got[2].ClassT)
	}
	if got[1].ClassWhyCT == "" || got[1].ClassWhyT == "" {
		t.Error("per-side explanations are REQUIRED")
	}
}

// itoa avoids strconv import churn in the synthetic detail payloads.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestRecoverSides(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A", Name: "A", Side: "ct"}, // known final side
		{SteamID: "B", Name: "B"},             // unknown — same group as A
		{SteamID: "X", Name: "X", Side: "t"},  // known final side
		{SteamID: "Y", Name: "Y"},             // unknown — same group as X
		{SteamID: "Z", Name: "Z"},             // unknown — same group as X
	}
	rounds := []RoundInfo{{Number: 1, Winner: "t"}}
	// Dense true-enemy edges (like a real match): the teamkill lie edge
	// X→Y cannot dominate the coloring when redundant enemy paths exist
	// (documented: sparse graphs with teamkill lies are ambiguous).
	events := []models.Event{
		ev(0, 100, 1, models.EventKill, "A", "X"),
		ev(1, 110, 1, models.EventKill, "A", "Y"),
		ev(2, 120, 1, models.EventKill, "B", "X"),
		ev(3, 130, 1, models.EventKill, "B", "Y"),
		ev(4, 140, 1, models.EventKill, "Z", "A"),
		ev(5, 150, 1, models.EventKill, "Z", "B"),
		ev(6, 160, 1, models.EventKill, "X", "Y"), // teamkill edge — skipped
	}
	got := RecoverSides(events, rounds, players)
	side := map[string]string{}
	for _, p := range got {
		side[p.SteamID] = p.Side
	}
	if side["B"] != "ct" || side["Y"] != "t" || side["Z"] != "t" {
		t.Errorf("recovered sides = %v, want B=ct (grouped with A), Y/Z=t (grouped with X)", side)
	}
	// Anchors untouched.
	if side["A"] != "ct" || side["X"] != "t" {
		t.Errorf("anchors changed: %v", side)
	}
}

func TestRecoverSidesBombAnchor(t *testing.T) {
	players := []PlayerRef{
		{SteamID: "A"}, {SteamID: "B"}, {SteamID: "X"}, {SteamID: "Y"},
	}
	rounds := []RoundInfo{{Number: 1, Winner: "t"}}
	events := []models.Event{
		ev(0, 50, 1, models.EventKill, "A", "X"),
		ev(1, 60, 1, models.EventKill, "B", "Y"),
		ev(2, 100, 1, models.EventBombPlant, "X", ""), // X planted → X's group is T
	}
	got := RecoverSides(events, rounds, players)
	side := map[string]string{}
	for _, p := range got {
		side[p.SteamID] = p.Side
	}
	if side["X"] != "t" || side["Y"] != "t" || side["A"] != "ct" || side["B"] != "ct" {
		t.Errorf("bomb-anchored sides = %v, want X/Y=t A/B=ct", side)
	}
}

func TestSideAtFlipsBeforeSwitch(t *testing.T) {
	if got := sideAt("ct", Config{HalfSwitchRound: 13}, 1); got != "t" {
		t.Errorf("sideAt(ct, r1) = %q, want t (first half flipped)", got)
	}
	if got := sideAt("ct", Config{HalfSwitchRound: 13}, 13); got != "ct" {
		t.Errorf("sideAt(ct, r13) = %q, want ct (second half)", got)
	}
	if got := sideAt("ct", Config{}, 1); got != "ct" {
		t.Errorf("sideAt(ct, no switch) = %q, want ct", got)
	}
	if got := sideAt("", Config{}, 1); got != "" {
		t.Errorf("sideAt(unknown) = %q, want empty", got)
	}
}
