package extract

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
)

func TestRoundStateMachine(t *testing.T) {
	a := newAgg()
	if got := a.evRound(); got != 1 {
		t.Fatalf("evRound before first RoundStart = %d, want 1", got)
	}

	a.roundStart(1000, false, false, 115, "BOMB TARGET")
	a.roundEnd(1500, "ct", "CTWin", "Round over", 64)
	a.roundStart(2000, true, false, 115, "BOMB TARGET") // round 2: warmup
	a.roundEnd(2600, "t", "TerroristsWin", "", 64)
	a.roundStart(3000, false, false, 115, "BOMB TARGET")

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
	// GameHalfEnded fires before the last round's score increment, so it
	// only marks the half pending; the first freeze-end after the switch
	// reads settled (already-swapped) scores and swaps them back.
	a.setHalfPending()
	a.sideSwitch()
	a.freezeEnd(3500, 0, 0, 4, 8, nil) // post-switch: CT 4 / T 8 → 8/4
	a.setFinalTeam("ct", teamFinal{score: 10})
	a.setFinalTeam("t", teamFinal{score: 13})

	m := a.build()
	if m.Match.HalfCT != 8 || m.Match.HalfT != 4 {
		t.Errorf("halves = %d/%d, want 8/4 (settled, swapped back)", m.Match.HalfCT, m.Match.HalfT)
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

	// Round start/end events carry the INGEST round numbers after build:
	// real rounds count 1..N while warmup/knife rounds take negative
	// indices (here: real, warmup, real → 1, -1, 2).
	wantRounds := []int{1, -1, 2}
	starts, ends := 0, 0
	for _, e := range m.Events {
		switch e.Kind {
		case models.EventRoundStart:
			if starts >= len(wantRounds) {
				t.Errorf("extra round_start #%d (round %d)", starts+1, e.Round)
			} else if e.Round != wantRounds[starts] {
				t.Errorf("round_start #%d has round %d, want %d", starts+1, e.Round, wantRounds[starts])
			}
			starts++
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
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	// A T player kills a CT at tick 100 — the CT's death enters the
	// trade window keyed by the dead player: {killed-by, tick, side}.
	a.kill(killInfo{
		tick: 100, tickRate: 64, real: true,
		killerKey: 3, killerName: "killer", killerSide: "t",
		victimKey: 2, victimName: "victim1", victimSide: "ct",
		weapon: "AK-47",
	})

	// The dead CT's teammate kills that T 4 s later → strict trade
	// (the victim is the player who killed a teammate of the killer).
	a.kill(killInfo{
		tick: 100 + 4*64, tickRate: 64, real: true,
		killerKey: 4, killerName: "trader", killerSide: "ct",
		victimKey: 3, victimName: "killer", victimSide: "t",
		weapon: "AK-47",
	})
	if p := a.players[4]; p == nil || p.tradeKills != 1 {
		t.Fatalf("trade of the teammate's killer within 5s not counted: %+v", a.players[4])
	}

	// A second CT death at tick 200 killed by T11…
	a.kill(killInfo{
		tick: 200, tickRate: 64, real: true,
		killerKey: 11, killerName: "t2", killerSide: "t",
		victimKey: 12, victimName: "ct2", victimSide: "ct",
		weapon: "AK-47",
	})
	// …and T11 is killed 11 s later: outside the 5 s window → not a trade.
	a.kill(killInfo{
		tick: 200 + 11*64, tickRate: 64, real: true,
		killerKey: 13, killerName: "late", killerSide: "ct",
		victimKey: 11, victimName: "t2", victimSide: "t",
		weapon: "AK-47",
	})
	if p := a.players[13]; p == nil || p.tradeKills != 0 {
		t.Fatalf("kill outside the 5s window must not be a trade: %+v", a.players[13])
	}

	// The window resets at every RoundStart: T3 (killer of CT2 in the
	// previous round) dies to a CT in the new round — no stale trade.
	a.roundStart(1100, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 1100 + 4*64, tickRate: 64, real: true,
		killerKey: 14, killerName: "after", killerSide: "ct",
		victimKey: 15, victimName: "fresh", victimSide: "t",
		weapon: "AK-47",
	})
	if p := a.players[14]; p == nil || p.tradeKills != 0 {
		t.Fatalf("trade window must reset at RoundStart: %+v", a.players[14])
	}
}

func TestEntryOpeningAttribution(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	a.kill(killInfo{
		tick: 128, tickRate: 64, real: true,
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
		tick: 256, tickRate: 64, real: true,
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
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	kill := func(killer, victim uint64, tick int) {
		a.kill(killInfo{
			tick: tick, tickRate: 64, real: true,
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

// statsFor finds one player's built stats row by accumulator key.
func statsFor(m *models.ExtractedMatch, key uint64) *models.PlayerStats {
	id := keyStr(key)
	for i := range m.PlayerStats {
		if m.PlayerStats[i].SteamID == id {
			return &m.PlayerStats[i]
		}
	}
	return nil
}

func TestMultiKillCounts(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	kill := func(tick int, victim uint64) {
		a.kill(killInfo{
			tick: tick, tickRate: 64, real: true,
			killerKey: 1, killerName: "ace", killerSide: "t",
			victimKey: victim, victimName: "x", victimSide: "ct",
			weapon: "AK-47",
		})
	}

	for i := 0; i < 5; i++ {
		kill(10*i+1, uint64(100+i))
	}
	kill(61, 105) // 6th kill: still one 5K (5+ counts once)

	// Per-round counter restarts with the round: 2 kills now add one 2K.
	a.roundStart(1000, false, false, 115, "BOMB TARGET")
	kill(1010, 200)
	kill(1020, 201)

	// Tiers resolve in build() from each round's final kill total.
	m := a.build()
	p := statsFor(m, 1)
	if p == nil {
		t.Fatal("killer missing from built player stats")
	}
	if p.TwoK != 1 || p.ThreeK != 0 || p.FourK != 0 || p.FiveK != 1 {
		t.Fatalf("2K/3K/4K/5K = %d/%d/%d/%d, want 1/0/0/1 (one 5+ round = one 5K, one 2-kill round = one 2K)",
			p.TwoK, p.ThreeK, p.FourK, p.FiveK)
	}
}

// A round counts at EXACTLY one multi-kill tier: a 4-kill round is one 4K
// and no 3K (the golden demo's official scoreboard: adamS 1×3K + 2×4K,
// FREELOOK 1×4K + 0×3K — cumulative counting gave adamS 3×3K). The same
// exclusivity holds at the 2K tier: a 3-kill round is a 3K, not a 2K.
func TestMultiKillTiersAreExact(t *testing.T) {
	a := newAgg()
	kill := func(tick int, victim uint64) {
		a.kill(killInfo{
			tick: tick, tickRate: 64, real: true,
			killerKey: 7, killerName: "entry", killerSide: "ct",
			victimKey: victim, victimName: "x", victimSide: "t",
			weapon: "M4A1-S",
		})
	}

	a.roundStart(0, false, false, 115, "BOMB TARGET")
	for i := 0; i < 4; i++ {
		kill(10*i+1, uint64(100+i))
	}
	a.roundStart(1000, false, false, 115, "BOMB TARGET")
	for i := 0; i < 3; i++ {
		kill(1010+10*i, uint64(200+i))
	}
	a.roundStart(2000, false, false, 115, "BOMB TARGET")
	kill(2010, 300)
	kill(2020, 301)
	kill(2030, 302)
	kill(2040, 303)
	kill(2050, 304)
	a.roundStart(3000, false, false, 115, "BOMB TARGET")
	kill(3010, 400)
	kill(3020, 401)

	m := a.build()
	p := statsFor(m, 7)
	if p == nil {
		t.Fatal("killer missing from built player stats")
	}
	// rounds: 4 kills → 4K only; 3 kills → 3K only; 5 kills → 5K only;
	// 2 kills → 2K only.
	if p.TwoK != 1 || p.ThreeK != 1 || p.FourK != 1 || p.FiveK != 1 {
		t.Fatalf("2K/3K/4K/5K = %d/%d/%d/%d, want exactly 1/1/1/1 across four rounds",
			p.TwoK, p.ThreeK, p.FourK, p.FiveK)
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

	a.roundStart(10, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 11, tickRate: 64, real: true,
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
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	kill := func(tick int, victim uint64, weapon string, hs bool) {
		a.kill(killInfo{
			tick: tick, tickRate: 64, real: true,
			killerKey: 1, killerName: "a", killerSide: "ct",
			victimKey: victim, victimName: "v", victimSide: "t",
			weapon: weapon, headshot: hs,
		})
	}
	kill(10, 100, "AK-47", true)
	kill(20, 101, "AK-47", false)
	kill(30, 102, "AWP", false)

	a.hurt(hurtInfo{
		tick: 15, real: true, attackerKey: 1, attackerName: "a",
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

// TestPregameRoundGating: pregame (knife) rounds never pollute stats —
// event rows still emit, but kills/damage/assists/participation skip and
// the round counts as neither warmup nor real.
func TestPregameRoundGating(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, true, 115, "BOMB TARGET") // knife round
	a.kill(killInfo{
		tick: 10, tickRate: 64, real: false,
		killerKey: 1, killerName: "k", killerSide: "t",
		victimKey: 2, victimName: "v", victimSide: "ct",
		assisterKey: 3, assisterName: "a", assisterSide: "t",
		weapon: "Knife",
	})
	a.hurt(hurtInfo{
		tick: 11, real: false, attackerKey: 1, attackerName: "k",
		victimKey: 2, victimName: "v", weapon: "Knife", healthDamage: 55,
	})
	if a.players[1] != nil || a.players[2] != nil || a.players[3] != nil {
		t.Fatalf("pregame kill created stat accumulators: %+v %+v %+v",
			a.players[1], a.players[2], a.players[3])
	}
	// The event rows themselves are still emitted.
	kills := 0
	for _, e := range a.events {
		if e.Kind == models.EventKill {
			kills++
		}
	}
	if kills != 1 {
		t.Fatalf("pregame kill event row missing: %+v", a.events)
	}

	// First REAL round counts and its stats land.
	a.roundStart(100, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 200, tickRate: 64, real: true,
		killerKey: 1, killerName: "k", killerSide: "t",
		victimKey: 2, victimName: "v", victimSide: "ct",
		weapon: "AK-47",
	})
	a.freezeEnd(110, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "k", side: "t", money: 800},
		{key: 2, name: "v", side: "ct", money: 800},
	})
	if p := a.players[1]; p == nil || p.kills != 1 {
		t.Fatalf("real kill not counted: %+v", p)
	}
	m := a.build()
	if m.Match.RealRounds != 1 || m.Match.WarmupRounds != 0 {
		t.Errorf("round counts = %d real / %d warmup, want 1/0", m.Match.RealRounds, m.Match.WarmupRounds)
	}
	if !m.Rounds[0].Pregame || m.Rounds[1].Pregame {
		t.Errorf("pregame flags = %v/%v, want true/false", m.Rounds[0].Pregame, m.Rounds[1].Pregame)
	}
	if rs := a.participation[1]; len(rs) != 1 || !rs[2] {
		t.Errorf("participation = %v, want only round 2", rs)
	}
}

// TestSuicideTeamkillCredit: suicides and teamkills never credit kills or
// first blood; deaths/suicides/teamkills still count.
func TestSuicideTeamkillCredit(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	a.kill(killInfo{
		tick: 10, tickRate: 64, real: true, samePlayer: true,
		killerKey: 1, killerName: "s", killerSide: "ct",
		victimKey: 1, victimName: "s", victimSide: "ct",
		weapon: "World",
	})
	p := a.players[1]
	if p == nil || p.kills != 0 || p.deaths != 1 || p.suicides != 1 {
		t.Fatalf("suicide accounting = %+v, want 0 kills / 1 death / 1 suicide", p)
	}
	if r := a.rounds[0]; r.firstKillSteam != "" || r.firstDeathSteam != "" {
		t.Fatalf("suicide must not open the round's first blood: %+v", r)
	}

	a.kill(killInfo{
		tick: 20, tickRate: 64, real: true,
		killerKey: 2, killerName: "tk", killerSide: "ct",
		victimKey: 3, victimName: "mate", victimSide: "ct",
		weapon: "M4A1",
	})
	if p := a.players[2]; p == nil || p.kills != 0 || p.teamkills != 1 {
		t.Fatalf("teamkill accounting = %+v, want 0 kills / 1 teamkill", p)
	}
	if p := a.players[3]; p == nil || p.deaths != 1 {
		t.Fatalf("teamkill victim accounting = %+v, want 1 death", p)
	}

	// First blood still opens on the first real enemy kill.
	a.kill(killInfo{
		tick: 30, tickRate: 64, real: true,
		killerKey: 4, killerName: "ek", killerSide: "t",
		victimKey: 5, victimName: "foe", victimSide: "ct",
		weapon: "AK-47",
	})
	if r := a.rounds[0]; r.firstKillSteam != "4" || r.firstDeathSteam != "5" {
		t.Fatalf("first blood = %q killed %q, want 4 killed 5", r.firstKillSteam, r.firstDeathSteam)
	}
}

// TestFlashAssistSplit: AssistedFlash assists land in flashAssists, not
// assists; cross-team only.
func TestFlashAssistSplit(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")

	a.kill(killInfo{
		tick: 10, tickRate: 64, real: true,
		killerKey: 1, killerName: "k", killerSide: "t",
		victimKey: 2, victimName: "v", victimSide: "ct",
		assisterKey: 3, assisterName: "flashy", assisterSide: "t",
		assistedFlash: true, weapon: "AK-47",
	})
	if p := a.players[3]; p == nil || p.assists != 0 || p.flashAssists != 1 {
		t.Fatalf("flash assist split = %+v, want 0 assists / 1 flashAssist", p)
	}

	a.kill(killInfo{
		tick: 20, tickRate: 64, real: true,
		killerKey: 1, killerName: "k", killerSide: "t",
		victimKey: 4, victimName: "v2", victimSide: "ct",
		assisterKey: 5, assisterName: "damager", assisterSide: "t",
		weapon: "AK-47",
	})
	if p := a.players[5]; p == nil || p.assists != 1 || p.flashAssists != 0 {
		t.Fatalf("normal assist = %+v, want 1 assist / 0 flashAssists", p)
	}

	// A same-side assister (teamkill assist) counts nothing.
	a.kill(killInfo{
		tick: 30, tickRate: 64, real: true,
		killerKey: 1, killerName: "k", killerSide: "t",
		victimKey: 4, victimName: "v2", victimSide: "ct",
		assisterKey: 6, assisterName: "victim-mate", assisterSide: "ct",
		weapon: "AK-47",
	})
	if p := a.players[6]; p != nil && (p.assists != 0 || p.flashAssists != 0) {
		t.Fatalf("same-side assister credited: %+v", p)
	}
}

// TestMVPScanDelta: MVPs come from per-round counter diffs at RoundEnd;
// warmup rounds never credit.
func TestMVPScanDelta(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, true, 115, "BOMB TARGET") // knife round (pregame)
	a.mvpScan(1, "ace", 1)                           // knife MVP — credited (game counter includes it)
	if p := a.players[1]; p == nil || p.mvps != 1 {
		t.Fatalf("pregame MVP not credited: %+v", p)
	}
	if a.rounds[0].mvp != "1" {
		t.Fatalf("round MVP = %q, want 1", a.rounds[0].mvp)
	}

	a.roundStart(100, true, false, 115, "BOMB TARGET") // warmup
	a.mvpScan(1, "ace", 2)                             // warmup MVP increase — dropped
	if p := a.players[1]; p.mvps != 1 {
		t.Fatalf("warmup MVP credited: %+v", p)
	}

	a.roundStart(200, false, false, 115, "BOMB TARGET") // real round
	a.mvpScan(1, "ace", 3)
	a.mvpScan(2, "other", 1)
	if p := a.players[1]; p == nil || p.mvps != 2 {
		t.Fatalf("real MVP delta = %+v, want 2", p)
	}
	if p := a.players[2]; p == nil || p.mvps != 1 {
		t.Fatalf("other player MVP = %+v, want 1", p)
	}
	if a.rounds[2].mvp != "1" {
		t.Fatalf("round 3 MVP = %q, want 1 (first observed)", a.rounds[2].mvp)
	}

	// The announcement fills reason but never double-counts.
	a.roundMVP(1, "ace", "MostEliminations")
	if p := a.players[1]; p.mvps != 2 {
		t.Fatalf("announcement double-counted MVP: %+v", p)
	}
	if a.rounds[2].mvpReason != "MostEliminations" {
		t.Fatalf("round MVP reason = %q", a.rounds[2].mvpReason)
	}
}

// TestFreezeEndSides: freeze-end samples persist per-round sides and
// update each player's last-observed (final) side; participation skips
// warmup/pregame rounds.
func TestFreezeEndSides(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, true, 115, "BOMB TARGET") // pregame
	a.freezeEnd(10, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "a", side: "ct", money: 800},
		{key: 2, name: "b", side: "t", money: 800},
	})
	a.roundStart(20, false, false, 115, "BOMB TARGET") // real, sides picked
	a.freezeEnd(30, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "a", side: "t", money: 3200},
		{key: 2, name: "b", side: "ct", money: 2400},
	})

	if len(a.roundSides) != 4 {
		t.Fatalf("round-side rows = %d, want 4", len(a.roundSides))
	}
	last := a.roundSides[len(a.roundSides)-1]
	if last.Round != 2 || last.SteamID != "2" || last.Side != "ct" {
		t.Fatalf("last round-side row = %+v, want round 2 / 2 / ct", last)
	}
	if p := a.players[1]; p == nil || p.side != "t" {
		t.Fatalf("last-observed side = %+v, want t", p)
	}
	if rs := a.participation[1]; len(rs) != 1 || !rs[2] {
		t.Fatalf("participation = %v, want only counted round 2", rs)
	}
	m := a.build()
	if len(m.RoundSides) != 4 || m.RoundSides[3].Side != "ct" {
		t.Fatalf("built round sides = %+v", m.RoundSides)
	}
}

// TestFreezeEndSpentDeltas: round_economy's Spent is the per-side sum of
// the participants' CUMULATIVE money-spent deltas since the previous
// freeze end — from 0 at the demo's first freeze end, only the delta on
// later ones, and from the current total when the counter goes down (a
// match restart resets it). A sample without a side updates its baseline
// but contributes spend only once a side is known.
func TestFreezeEndSpentDeltas(t *testing.T) {
	a := newAgg()

	// 1) No baseline yet (the demo's first freeze end) → delta from 0.
	a.roundStart(0, false, true, 115, "BOMB TARGET") // pregame knife
	a.freezeEnd(10, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "a", side: "ct", money: 800, spent: 3250},
		{key: 2, name: "b", side: "t", money: 800, spent: 3250},
	})

	// 2) Only the delta since the previous freeze end counts (the knife
	//    round's spend never lands in the pistol's).
	a.roundStart(20, false, false, 115, "BOMB TARGET")
	a.freezeEnd(30, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "a", side: "ct", money: 400, spent: 7250}, // +4000
		{key: 2, name: "b", side: "t", money: 100, spent: 6650},  // +3400
		{key: 3, name: "c", side: "", money: 0, spent: 9999},     // no side: baseline only
	})

	// 3) Counter reset (spend went DOWN) reads from the current total;
	//    key 3's earlier baseline spend lands now that a side is known.
	a.roundStart(40, false, false, 115, "BOMB TARGET")
	a.freezeEnd(50, 0, 0, 0, 0, []moneySample{
		{key: 1, name: "a", side: "ct", money: 800, spent: 700}, // reset → 700
		{key: 2, name: "b", side: "t", money: 800, spent: 6650}, // no buys → 0
		{key: 3, name: "c", side: "ct", money: 0, spent: 10100}, // +101
	})

	want := []struct{ round, ct, t int }{
		{1, 3250, 3250},
		{2, 4000, 3400},
		{3, 801, 0},
	}
	if len(a.economy) != 2*len(want) {
		t.Fatalf("economy rows = %d, want %d", len(a.economy), 2*len(want))
	}
	for i, w := range want {
		ct, tr := a.economy[2*i], a.economy[2*i+1]
		if ct.Round != w.round || ct.Side != "ct" || ct.Spent != w.ct {
			t.Errorf("round %d ct row = %+v, want round %d / ct / spent %d", w.round, ct, w.round, w.ct)
		}
		if tr.Round != w.round || tr.Side != "t" || tr.Spent != w.t {
			t.Errorf("round %d t row = %+v, want round %d / t / spent %d", w.round, tr, w.round, w.t)
		}
	}
	// The built extract carries the same numbers to the store writer.
	m := a.build()
	if len(m.RoundEconomy) != 6 || m.RoundEconomy[4].Spent != 801 {
		t.Fatalf("built round economy = %+v", m.RoundEconomy)
	}
}

// TestFreezeEndFreePistolValue: round_economy.free_pistol_value is the
// per-side sum of the participants' held FREE spawn-issued default
// pistols at that freeze end (extract.freeSpawnPistolValue) — granted,
// not bought, so net worth can subtract it and both pistol-round sides
// read their starting money. Samples without a side contribute nothing.
func TestFreezeEndFreePistolValue(t *testing.T) {
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")
	a.freezeEnd(10, 4000, 3600, 0, 0, []moneySample{
		{key: 1, name: "a", side: "ct", money: 600, freePistol: 600},  // 3 USP-S held
		{key: 2, name: "b", side: "ct", money: 200, freePistol: 0},    // upgraded sidearm
		{key: 3, name: "c", side: "t", money: 1400, freePistol: 1000}, // 5 Glocks held
		{key: 4, name: "d", side: "", money: 0, freePistol: 400},      // no side: dropped
	})

	if len(a.economy) != 2 {
		t.Fatalf("economy rows = %d, want 2", len(a.economy))
	}
	ct, tr := a.economy[0], a.economy[1]
	if ct.Side != "ct" || ct.FreePistolValue != 600 {
		t.Errorf("ct row = %+v, want free_pistol_value 600", ct)
	}
	if tr.Side != "t" || tr.FreePistolValue != 1000 {
		t.Errorf("t row = %+v, want free_pistol_value 1000", tr)
	}
	m := a.build()
	if len(m.RoundEconomy) != 2 || m.RoundEconomy[0].FreePistolValue != 600 || m.RoundEconomy[1].FreePistolValue != 1000 {
		t.Fatalf("built round economy = %+v, want 600/1000", m.RoundEconomy)
	}
}

// TestFreeSpawnPistolValue: only the free spawn-issued default sidearms
// (USP-S, P2000, Glock-18) count, at $200 each (the value the game's
// equipment value assigns them — CS2.md "Free spawn-issued default
// pistol"); every other weapon — knife, bought pistol, rifle, nil entry
// — is worth 0 here.
func TestFreeSpawnPistolValue(t *testing.T) {
	weaps := func(types ...common.EquipmentType) []*common.Equipment {
		out := make([]*common.Equipment, 0, len(types))
		for _, ty := range types {
			out = append(out, &common.Equipment{Type: ty})
		}
		return out
	}
	cases := []struct {
		name string
		weps []*common.Equipment
		want int
	}{
		{"empty", nil, 0},
		{"knife only", weaps(common.EqKnife), 0},
		{"one USP-S", weaps(common.EqKnife, common.EqUSP), 200},
		{"P2000", weaps(common.EqP2000), 200},
		{"Glock", weaps(common.EqGlock, common.EqKnife), 200},
		{"bought pistol not free", weaps(common.EqP250, common.EqDeagle), 0},
		{"rifle + free Glock", weaps(common.EqAK47, common.EqGlock), 200},
		{"nil entry skipped", append(weaps(common.EqUSP), nil), 200},
	}
	for _, c := range cases {
		if got := freeSpawnPistolValue(c.weps); got != c.want {
			t.Errorf("%s: freeSpawnPistolValue = %d, want %d", c.name, got, c.want)
		}
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
