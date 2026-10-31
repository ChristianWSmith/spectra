package extract

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
)

func TestRoundStateMachine(t *testing.T) {
	a := newAgg()
	if got := a.evRound(); got != 1 {
		t.Fatalf("evRound before first RoundStart = %d, want 1", got)
	}

	a.roundStart(1000, false, 115, "BOMB TARGET")
	a.roundEnd(1500, "ct", "CTWin", "Round over", 64)
	a.roundStart(2000, true, 115, "BOMB TARGET") // round 2: warmup
	a.roundEnd(2600, "t", "TerroristsWin", "", 64)
	a.roundStart(3000, false, 115, "BOMB TARGET")

	if len(a.rounds) != 3 {
		t.Fatalf("rounds = %d, want 3", len(a.rounds))
	}
	for i, r := range a.rounds {
		if r.number != i+1 {
			t.Errorf("round %d numbered %d, want %d", i, r.number, i+1)
		}
	}
	if !a.rounds[1].warmup {
		t.Error("round 2 should be flagged warmup")
	}
	if a.rounds[0].warmup || a.rounds[2].warmup {
		t.Error("only round 2 is warmup")
	}
	if a.warmupRounds != 1 || a.realRounds != 2 {
		t.Errorf("warmupRounds=%d realRounds=%d, want 1/2 (warmup counted but flagged)", a.warmupRounds, a.realRounds)
	}
	if a.rounds[0].winner != "ct" || a.rounds[0].reason != "CTWin" {
		t.Errorf("round 1 end state = %s/%s, want ct/CTWin", a.rounds[0].winner, a.rounds[0].reason)
	}
	wantDur := float64(500) / 64
	if math.Abs(a.rounds[0].durationSec-wantDur) > 1e-9 {
		t.Errorf("round 1 duration = %v, want %v", a.rounds[0].durationSec, wantDur)
	}
	if a.rounds[1].winner != "t" {
		t.Errorf("warmup round winner = %q, want t", a.rounds[1].winner)
	}

	// Side switch + half scores + final scores land in the match row.
	a.halfEnd(7, 4)
	a.sideSwitch()
	a.setFinalTeam("ct", teamFinal{score: 10})
	a.setFinalTeam("t", teamFinal{score: 13})

	m := a.build()
	if m.Match.HalfCT != 7 || m.Match.HalfT != 4 {
		t.Errorf("halves = %d/%d, want 7/4", m.Match.HalfCT, m.Match.HalfT)
	}
	if m.Match.SideSwitches != 1 {
		t.Errorf("sideSwitches = %d, want 1", m.Match.SideSwitches)
	}
	if m.Match.ScoreCT != 10 || m.Match.ScoreT != 13 {
		t.Errorf("score = %d/%d, want 10/13", m.Match.ScoreCT, m.Match.ScoreT)
	}
	if m.Match.WarmupRounds != 1 || m.Match.RealRounds != 2 {
		t.Errorf("match round counts = %d/%d, want 1/2", m.Match.WarmupRounds, m.Match.RealRounds)
	}
	if len(m.Teams) != 2 || m.Teams[0].Side != "ct" || m.Teams[1].Side != "t" {
		t.Errorf("teams = %+v, want ct then t", m.Teams)
	}

	// Round start/end events carry the extractor's round numbers.
	starts, ends := 0, 0
	for _, e := range m.Events {
		switch e.Kind {
		case models.EventRoundStart:
			starts++
			if e.Round != starts {
				t.Errorf("round_start #%d has round %d, want %d", starts, e.Round, starts)
			}
		case models.EventRoundEnd:
			ends++
		}
	}
	if starts != 3 || ends != 2 {
		t.Errorf("round events = %d starts / %d ends, want 3/2", starts, ends)
	}
}

func TestTradeKillWindow(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, 115, "BOMB TARGET")

	// A CT player dies at tick 100 (world death: no killer).
	a.kill(killInfo{tick: 100, tickRate: 64, victimKey: 2, victimName: "victim1", victimSide: "ct", weapon: "World"})

	// Teammate of the dead player trades 4 s later → inside the 5 s window.
	a.kill(killInfo{
		tick: 100 + 4*64, tickRate: 64,
		killerKey: 3, killerName: "trader", killerSide: "t",
		victimKey: 4, victimName: "victim2", victimSide: "ct",
		weapon: "AK-47",
	})
	if p := a.players[3]; p == nil || p.tradeKills != 1 {
		t.Fatalf("trade within 5s not counted: %+v", a.players[3])
	}

	// Kill 7 s after the last death → outside the window.
	a.kill(killInfo{
		tick: 100 + 4*64 + 7*64, tickRate: 64,
		killerKey: 5, killerName: "late", killerSide: "t",
		victimKey: 6, victimName: "victim3", victimSide: "ct",
		weapon: "AK-47",
	})
	if p := a.players[5]; p == nil || p.tradeKills != 0 {
		t.Fatalf("kill outside 5s window must not be a trade: %+v", a.players[5])
	}

	// The window resets at every RoundStart.
	a.kill(killInfo{tick: 1000, tickRate: 64, victimKey: 7, victimName: "victim4", victimSide: "ct", weapon: "World"})
	a.roundStart(1100, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 1100 + 7*64, tickRate: 64,
		killerKey: 8, killerName: "after", killerSide: "t",
		victimKey: 9, victimName: "victim5", victimSide: "ct",
		weapon: "AK-47",
	})
	if p := a.players[8]; p == nil || p.tradeKills != 0 {
		t.Fatalf("trade window must reset at RoundStart: %+v", a.players[8])
	}
}

func TestEntryOpeningAttribution(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, 115, "BOMB TARGET")

	a.kill(killInfo{
		tick: 128, tickRate: 64,
		killerKey: 10, killerName: "entry", killerSide: "ct",
		victimKey: 20, victimName: "firstdead", victimSide: "t",
		weapon: "AK-47",
	})

	kp, vp := a.players[10], a.players[20]
	if kp == nil || kp.entryKills != 1 || kp.openingKills != 1 {
		t.Fatalf("first-blood killer entry/opening = %+v, want 1/1", kp)
	}
	if vp == nil || vp.entryDeaths != 1 || vp.openingDeaths != 1 {
		t.Fatalf("first-blood victim entry/opening deaths = %+v, want 1/1", vp)
	}
	r := a.rounds[0]
	if r.firstKillSteam != "10" || r.firstDeathSteam != "20" {
		t.Fatalf("first blood = %s killed %s, want 10 killed 20", r.firstKillSteam, r.firstDeathSteam)
	}

	// Later kills do not re-attribute first blood.
	a.kill(killInfo{
		tick: 256, tickRate: 64,
		killerKey: 11, killerName: "second", killerSide: "ct",
		victimKey: 21, victimName: "seconddead", victimSide: "t",
		weapon: "AK-47",
	})
	if p := a.players[11]; p == nil || p.entryKills != 0 || p.openingKills != 0 {
		t.Fatalf("second kill must not count as entry: %+v", p)
	}
	if p := a.players[21]; p == nil || p.entryDeaths != 0 || p.openingDeaths != 0 {
		t.Fatalf("second death must not count as entry death: %+v", p)
	}
}

func TestStreakAcrossDeaths(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, 115, "BOMB TARGET")

	kill := func(killer, victim uint64, tick int) {
		a.kill(killInfo{
			tick: tick, tickRate: 64,
			killerKey: killer, killerName: "k", killerSide: "ct",
			victimKey: victim, victimName: "v", victimSide: "t",
			weapon: "AK-47",
		})
	}

	kill(1, 2, 10)
	kill(1, 3, 20)
	if p := a.players[1]; p.killStreak != 2 || p.bestStreak != 2 {
		t.Fatalf("after 2 kills streak=%d best=%d, want 2/2", p.killStreak, p.bestStreak)
	}

	kill(4, 1, 30) // player 1 dies
	if p := a.players[1]; p.killStreak != 0 || p.bestStreak != 2 {
		t.Fatalf("on death streak=%d best=%d, want 0/2 (best preserved)", p.killStreak, p.bestStreak)
	}

	kill(1, 5, 40)
	kill(1, 6, 50)
	kill(1, 7, 60)
	if p := a.players[1]; p.killStreak != 3 || p.bestStreak != 3 {
		t.Fatalf("after comeback streak=%d best=%d, want 3/3 (best tracks across deaths)", p.killStreak, p.bestStreak)
	}
}

func TestMultiKillCounts(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, 115, "BOMB TARGET")

	kill := func(tick int, victim uint64) {
		a.kill(killInfo{
			tick: tick, tickRate: 64,
			killerKey: 1, killerName: "ace", killerSide: "t",
			victimKey: victim, victimName: "x", victimSide: "ct",
			weapon: "AK-47",
		})
	}

	for i := 0; i < 5; i++ {
		kill(10*i+1, uint64(100+i))
	}
	p := a.players[1]
	if p.threeK != 1 || p.fourK != 1 || p.fiveK != 1 {
		t.Fatalf("after 5 rounds-worth of kills in one round: 3K/4K/5K = %d/%d/%d, want 1/1/1",
			p.threeK, p.fourK, p.fiveK)
	}

	kill(61, 105) // 6th kill: no new tier
	if p.threeK != 1 || p.fourK != 1 || p.fiveK != 1 {
		t.Fatalf("6th kill changed multi-kill counts: %d/%d/%d", p.threeK, p.fourK, p.fiveK)
	}

	// Per-round counter restarts with the round.
	a.roundStart(1000, false, 115, "BOMB TARGET")
	kill(1010, 200)
	kill(1020, 201)
	if p.threeK != 1 {
		t.Fatalf("2 kills in a new round must not add a 3K: threeK=%d", p.threeK)
	}
}

func TestNullByteNamesPassThrough(t *testing.T) {
	a := newAgg()

	// The store scrubs NUL bytes; extract must pass them through untouched.
	name := "bad\x00name"
	text := "hi\x00there"
	a.chat(42, "76561198000000001", name, text)
	if a.chatRows[0].Name != name {
		t.Errorf("chat name = %q, want unmodified %q", a.chatRows[0].Name, name)
	}
	if a.chatRows[0].Text != text {
		t.Errorf("chat text = %q, want unmodified %q", a.chatRows[0].Text, text)
	}

	a.roundStart(10, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 11, tickRate: 64,
		killerKey: 76561198000000001, killerName: name, killerSide: "ct",
		victimKey: 76561198000000002, victimName: "vic\x00tim", victimSide: "t",
		weapon: "AK-47", headshot: true,
	})
	if p := a.players[76561198000000001]; p == nil || p.name != name {
		t.Errorf("killer name = %q, want unmodified %q", p.name, name)
	}
	if p := a.players[76561198000000002]; p == nil || p.name != "vic\x00tim" {
		t.Errorf("victim name = %q, want unmodified %q", p.name, "vic\x00tim")
	}

	// Embedded NULs must stay valid JSON (escaped) in detail payloads.
	var killEvent *models.Event
	for i := range a.events {
		if a.events[i].Kind == models.EventKill {
			killEvent = &a.events[i]
		}
	}
	if killEvent == nil {
		t.Fatal("kill event missing")
	}
	if !json.Valid([]byte(killEvent.DetailJSON)) {
		t.Errorf("detail JSON with NUL bytes invalid: %s", killEvent.DetailJSON)
	}

	m := a.build()
	found := false
	for _, pl := range m.Players {
		if pl.SteamID == "76561198000000001" {
			found = true
			if pl.Name != name {
				t.Errorf("built player name = %q, want unmodified %q", pl.Name, name)
			}
		}
	}
	if !found {
		t.Error("player missing from build output")
	}
}

func TestProgressCallback(t *testing.T) {
	type call struct{ done, total int }

	var calls []call
	pt := &progressTracker{cb: func(done, total int) {
		calls = append(calls, call{done, total})
	}}
	for i := 1; i <= 3500; i++ {
		pt.frame(i, 5000)
	}
	pt.finish(3500, 5000)

	want := []call{{1000, 5000}, {2000, 5000}, {3000, 5000}, {3500, 5000}}
	if len(calls) != len(want) {
		t.Fatalf("progress calls = %v, want %v", calls, want)
	}
	for i, c := range calls {
		if c != want[i] {
			t.Errorf("progress call %d = %v, want %v", i, c, want[i])
		}
		if i > 0 && c.done <= calls[i-1].done {
			t.Errorf("progress done not increasing: %v", calls)
		}
	}

	// A nil callback is a no-op.
	var nilPT progressTracker
	nilPT.frame(1000, 2000)
	nilPT.finish(1500, 2000)

	// The final call is deduplicated when the throttle already reported it.
	var once []call
	pt2 := &progressTracker{cb: func(done, total int) {
		once = append(once, call{done, total})
	}}
	pt2.frame(1000, 1000)
	pt2.finish(1000, 1000)
	if len(once) != 1 || once[0].done != 1000 {
		t.Fatalf("dedup final call = %v, want single {1000 1000}", once)
	}

	// No frames at all still yields one final call.
	var zero []call
	pt3 := &progressTracker{cb: func(done, total int) {
		zero = append(zero, call{done, total})
	}}
	pt3.finish(0, 0)
	if len(zero) != 1 {
		t.Fatalf("zero-frame final calls = %v, want exactly one", zero)
	}
}

func TestWeaponMapJSONShape(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, 115, "BOMB TARGET")

	kill := func(tick int, victim uint64, weapon string, hs bool) {
		a.kill(killInfo{
			tick: tick, tickRate: 64,
			killerKey: 1, killerName: "a", killerSide: "ct",
			victimKey: victim, victimName: "v", victimSide: "t",
			weapon: weapon, headshot: hs,
		})
	}
	kill(10, 100, "AK-47", true)
	kill(20, 101, "AK-47", false)
	kill(30, 102, "AWP", false)

	a.hurt(hurtInfo{
		tick: 15, attackerKey: 1, attackerName: "a",
		victimKey: 100, victimName: "v",
		weapon: "AK-47", healthDamage: 34, healthDamageTaken: 30, health: 66, hitgroup: "Chest",
	})

	m := a.build()

	var st, victim *models.PlayerStats
	for i := range m.PlayerStats {
		switch m.PlayerStats[i].SteamID {
		case "1":
			st = &m.PlayerStats[i]
		case "100":
			victim = &m.PlayerStats[i]
		}
	}
	if st == nil || victim == nil {
		t.Fatalf("missing player stats: %d rows", len(m.PlayerStats))
	}

	var kb map[string]int
	if err := json.Unmarshal([]byte(st.KillsByWeapon), &kb); err != nil {
		t.Fatalf("KillsByWeapon is not a JSON object: %q (%v)", st.KillsByWeapon, err)
	}
	if kb["AK-47"] != 2 || kb["AWP"] != 1 || len(kb) != 2 {
		t.Errorf("KillsByWeapon = %v, want AK-47:2 AWP:1", kb)
	}

	var db map[string]int
	if err := json.Unmarshal([]byte(st.DamageByWeapon), &db); err != nil {
		t.Fatalf("DamageByWeapon is not a JSON object: %q (%v)", st.DamageByWeapon, err)
	}
	if db["AK-47"] != 34 {
		t.Errorf("DamageByWeapon = %v, want AK-47:34", db)
	}
	if st.TotalDamage != 34 || st.Hits != 1 || st.Kills != 3 || st.Headshots != 1 {
		t.Errorf("damage/hit/kill stats wrong: %+v", st)
	}
	if math.Abs(st.HSPct-33.333333) > 0.01 {
		t.Errorf("HSPct = %v, want ~33.3", st.HSPct)
	}

	// A player with no weapon rows still gets an empty object, never "null".
	if victim.KillsByWeapon != "{}" || victim.DamageByWeapon != "{}" {
		t.Errorf("victim weapon maps = %q/%q, want {}", victim.KillsByWeapon, victim.DamageByWeapon)
	}
	if victim.DamageTaken != 30 {
		t.Errorf("victim damageTaken = %d, want 30", victim.DamageTaken)
	}
}

func TestRawPayloadPairing(t *testing.T) {
	a := newAgg()

	// Sync dispatch: typed event first, its generic payload right after.
	a.addEvent(models.Event{Tick: 1, Kind: models.EventKill}, "player_death")
	a.genericEvent("player_death", 1, `{"userid":7}`)
	a.flushRaw()
	if a.events[0].RawJSON != `{"userid":7}` {
		t.Errorf("sync pairing raw = %q, want payload", a.events[0].RawJSON)
	}

	// Delayed dispatch: payload first, typed event later in the same frame.
	a.genericEvent("player_blind", 2, `{"a":1}`)
	a.addEvent(models.Event{Tick: 2, Kind: models.EventBlind}, "player_blind")
	a.flushRaw()
	if got := a.events[1].RawJSON; got != `{"a":1}` {
		t.Errorf("delayed pairing raw = %q, want payload", got)
	}

	// Payload-less sources stay empty; generic rows always keep their payload.
	a.addEvent(models.Event{Tick: 3, Kind: models.EventConnect}, "")
	a.flushRaw()
	if a.events[2].RawJSON != "" {
		t.Errorf("payload-less event raw = %q, want empty", a.events[2].RawJSON)
	}
	if len(a.generic) != 2 || a.generic[0].PayloadJSON == "" {
		t.Errorf("generic rows lost payloads: %+v", a.generic)
	}

	// Rows before the first RoundStart are attributed to round 1.
	if a.events[0].Round != 1 || a.generic[0].Round != 1 {
		t.Errorf("pre-round rows got round 0: events=%d generic=%d", a.events[0].Round, a.generic[0].Round)
	}
}

func TestGameEventPayloadJSON(t *testing.T) {
	s := "hello"
	i := int32(42)
	f := float32(1.5)
	b := true
	u := uint64(1234567890123)
	data := map[string]*msg.CMsgSource1LegacyGameEventKeyT{
		"str":   {ValString: &s},
		"int":   {ValLong: &i},
		"float": {ValFloat: &f},
		"bool":  {ValBool: &b},
		"uint":  {ValUint64: &u},
		"nil":   nil,
	}

	got := gameEventPayloadJSON(data)
	var out map[string]any
	if err := json.Unmarshal([]byte(got), &out); err != nil {
		t.Fatalf("payload JSON invalid: %q (%v)", got, err)
	}
	if out["str"] != "hello" || out["int"] != float64(42) || out["float"] != 1.5 || out["bool"] != true {
		t.Errorf("payload values = %v", out)
	}
	if out["uint"] != float64(u) {
		t.Errorf("uint value = %v, want %d", out["uint"], u)
	}
	if v, ok := out["nil"]; !ok || v != nil {
		t.Errorf("nil value = %v (present=%v), want JSON null", v, ok)
	}
	if got := gameEventPayloadJSON(nil); got != "{}" {
		t.Errorf("empty payload = %q, want {}", got)
	}
}
