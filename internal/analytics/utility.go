package analytics

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Utility pairing windows (seconds — converted with cfg.TickRate).
const (
	// utilPairWindowS pairs a grenade_throw with the nearest same-thrower /
	// same-kind detonation ≤ 30 s later in the same round.
	utilPairWindowS = 30.0
	// utilBurnWindowS bounds damage attribution after detonation:
	// molotov/incendiary burn 7 s; HE lands within ~3.3 s in the golden
	// demo (measured), so 4 s.
	utilBurnWindowS = 7.0
	utilHEWindowS   = 4.0
	// utilFlashWindowS bounds blind attribution after a flash detonation.
	utilFlashWindowS = 5.0
)

// utilKind normalizes a weapon string to the stored utility kind (pairing
// must treat Molotov ≡ Incendiary — the detonation event records the
// latter for both).
func utilKind(weapon string) string {
	switch strings.ToLower(weapon) {
	case "he grenade":
		return "he"
	case "flashbang":
		return "flash"
	case "smoke grenade":
		return "smoke"
	case "molotov", "incendiary grenade":
		return "molotov"
	case "decoy grenade":
		return "decoy"
	}
	return strings.ToLower(weapon)
}

// Utility pairs grenade throws with their detonations and attributes
// damage/flashes (plan M3 §2.4). One row is emitted per detonation:
//
//	Tick          detonation tick
//	Damage        Σ damage events of the matching weapon kind within the
//	              burn window after the detonation (HE 4 s — measured
//	              golden-demo spread; molotov/incendiary 7 s; smoke/flash/
//	              decoy none)
//	FlashMs       Σ flash durations (blind events by this thrower within 5 s
//	              of a flash detonation; duration from the extractor's
//	              flashDurationMs detail field)
//	Affected      JSON array of distinct victim SteamIDs (damage victims +
//	              blind victims in the attribution windows)
//	Site          the detonation event's site field ("" for grenades)
//	TrajectoryRef "" in v1 — M2 sidecar trajectories are streamed, not
//	              referenced per-grenade yet
//
// Throws that never detonate are skipped; detonations without a known
// throw still emit (thrower from the detonation event's attacker).
func Utility(events []models.Event, players []PlayerRef, cfg Config) []UtilityEvent {
	names := nameOf(players)
	sorted := sortedEvents(events)

	byRound := map[int][]models.Event{}
	for _, e := range sorted {
		byRound[e.Round] = append(byRound[e.Round], e)
	}

	pairWindow := cfg.ticks(utilPairWindowS)
	burnWindow := func(kind string) int {
		switch kind {
		case "molotov":
			return cfg.ticks(utilBurnWindowS)
		case "he":
			return cfg.ticks(utilHEWindowS)
		}
		return 0
	}
	flashWindow := cfg.ticks(utilFlashWindowS)

	var out []UtilityEvent
	for _, roundEvents := range byRound {
		var dets []models.Event
		var throws []models.Event
		for _, e := range roundEvents {
			switch e.Kind {
			case models.EventGrenade:
				dets = append(dets, e)
			case models.EventGrenadeThrow:
				throws = append(throws, e)
			}
		}
		for _, e := range dets {
			kind := utilKind(e.Weapon)
			// Nearest preceding same-thrower/same-kind throw within the
			// pair window (seq-sorted: last eligible wins).
			throwTick := -1
			for _, th := range throws {
				if th.Attacker != e.Attacker || utilKind(th.Weapon) != kind {
					continue
				}
				if th.Tick > e.Tick || e.Tick-th.Tick > pairWindow {
					continue
				}
				throwTick = th.Tick
			}
			thrower := e.Attacker
			if thrower == "" && throwTick >= 0 {
				for _, th := range throws {
					if th.Tick == throwTick {
						thrower = th.Attacker
						break
					}
				}
			}

			burn := burnWindow(kind)
			flash := kind == "flash"
			attributionEnd := e.Tick
			if burn > 0 {
				attributionEnd = e.Tick + burn
			}
			if flash {
				attributionEnd = e.Tick + flashWindow
			}
			damage, flashMs := 0, 0
			affectedSet := map[string]bool{}
			for _, ev := range roundEvents {
				if ev.Tick < e.Tick || ev.Tick > attributionEnd {
					continue
				}
				switch ev.Kind {
				case models.EventDamage:
					if burn > 0 && utilKind(ev.Weapon) == kind && ev.Victim != "" {
						damage += ev.Dmg
						affectedSet[ev.Victim] = true
					}
				case models.EventBlind:
					if flash && ev.Attacker == e.Attacker && ev.Victim != "" {
						affectedSet[ev.Victim] = true
						var detail struct {
							FlashDurationMs int `json:"flashDurationMs"`
						}
						if json.Unmarshal([]byte(ev.DetailJSON), &detail) == nil {
							flashMs += detail.FlashDurationMs
						}
					}
				}
			}
			affected := make([]string, 0, len(affectedSet))
			for sid := range affectedSet {
				affected = append(affected, sid)
			}
			sort.Strings(affected)
			affectedJSON, _ := json.Marshal(affected)

			out = append(out, UtilityEvent{
				Tick:        e.Tick,
				Round:       e.Round,
				Thrower:     thrower,
				ThrowerName: names[thrower],
				Kind:        kind,
				DetX:        e.PosX,
				DetY:        e.PosY,
				Damage:      damage,
				FlashMs:     flashMs,
				Affected:    string(affectedJSON),
				Site:        e.Site,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Round != out[j].Round {
			return out[i].Round < out[j].Round
		}
		return out[i].Tick < out[j].Tick
	})
	return out
}
