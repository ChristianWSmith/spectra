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
// latter for both). The SET and the name→kind projection are canonical in
// models (models.IsUtilityWeapon / models.UtilityWeaponKind — shared with
// the util-dmg attribution and pinned to extract's equipment enum by
// extract.TestUtilityWeaponSetsIdentical); non-utility weapons keep their
// lowercased name as the pairing key.
func utilKind(weapon string) string {
	if kind := models.UtilityWeaponKind(weapon); kind != "" {
		return kind
	}
	return strings.ToLower(weapon)
}

// Utility pairs grenade throws with their detonations and attributes
// damage/flashes. One row is emitted per detonation:
//
//	Tick          detonation tick (a detonation is what emits the row)
//	ThrowTick     the paired throw's own tick — 0 when no throw paired
//	              (never an interpolated throw time)
//	ThrowX/ThrowY the paired throw's origin, nil when unknown/unpaired
//	Damage        Σ ENEMY damage events of the matching weapon kind
//	              within the burn window after the detonation (HE 4 s —
//	              measured golden-demo spread; molotov/incendiary 7 s;
//	              smoke/flash/decoy none) — detonation-derived by nature:
//	              the damage lands in the POST-blast window. Same-side
//	              damage leaves the sum (owner ruling 2026-11-17 — the
//	              same permissive predicate as the events.same_side
//	              stamp, player_stats.total_damage and the replay
//	              playhead's fold); an unknown side counts. Affected
//	              still lists every victim hit (it records who was hit,
//	              like the ungated flash branch), only the damage STAT
//	              is gated.
//	FlashMs       Σ flash durations (blind events by this thrower within 5 s
//	              of a flash detonation; duration from the extractor's
//	              flashDurationMs detail field) — likewise post-blast
//	Affected      JSON array of distinct victim SteamIDs (damage victims +
//	              blind victims in the attribution windows)
//	DetX/DetY     the detonation event's position — stored honestly; the
//	              row's PLACE cell reads the THROW origin instead
//	Site          the detonation event's site field ("" for grenades)
//	TrajectoryRef "" in v1 — M2 sidecar trajectories are streamed, not
//	              referenced per-grenade yet
//
// Everything with a time or place is THROW-based (the row's ordering key
// and every rendered tick/coordinate); damage/blind/affected stay
// detonation-derived because they occur in post-blast windows, kind
// because pairing already equates throw and detonation kinds
// (Molotov ≡ Incendiary), and thrower because it is the paired throw's
// attacker. Rows order within a round by EffectiveTick (the paired
// throw's tick, the detonation tick when unpaired) with the detonation
// tick as tiebreak.
//
// Throws that never detonate are skipped; detonations without a known
// throw still emit (thrower from the detonation event's attacker).
//
// blindDetails carries the blind events' detail_json keyed by event Seq
// (models.Event.Seq — the store's UNIQUE (match_id, seq) insertion order;
// store.GetBlindFlashDetails). The typed-column read (models.EventFromRow)
// never populates ev.DetailJSON, so the durations must arrive through this
// side channel; they are parsed ONCE here, not per attribution-loop hit.
//
// sides is the extractor's exact per-round freeze-end side samples (the
// same map PlayerRounds/Engagements take — resolveRoundSides
// per round): the damage sum's enemy gate reads it. A round without a
// stored sample leaves every side unknown → the permissive rule counts.
func Utility(events []models.Event, players []PlayerRef, cfg Config, sides map[int]map[string]string, blindDetails map[int]string) []UtilityEvent {
	names := nameOf(players)
	sorted := sortedEvents(events)

	// seq → flash duration (ms); blind rows without a readable
	// flashDurationMs detail contribute 0.
	flashMsBySeq := make(map[int]int, len(blindDetails))
	for seq, det := range blindDetails {
		var detail struct {
			FlashDurationMs int `json:"flashDurationMs"`
		}
		if json.Unmarshal([]byte(det), &detail) == nil {
			flashMsBySeq[seq] = detail.FlashDurationMs
		}
	}

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
	for round, roundEvents := range byRound {
		teamR := resolveRoundSides(sides, round)
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
			// pair window (seq-sorted: last eligible wins). The MATCHED
			// throw is captured — its own tick and origin are the row's
			// throw-side facts (owner ruling: everything with a time or
			// place is throw-based). The pairing rule itself is
			// unchanged: the existing 30 s same-thrower/same-kind/
			// same-round window, zero new rule and no side-channel.
			throwTick := -1
			var matched *models.Event
			for i := range throws {
				th := &throws[i]
				if th.Attacker != e.Attacker || utilKind(th.Weapon) != kind {
					continue
				}
				if th.Tick > e.Tick || e.Tick-th.Tick > pairWindow {
					continue
				}
				throwTick = th.Tick
				matched = th
			}
			// The thrower is already throw-based — the paired throw's
			// attacker (the pairing requires the same attacker, so a
			// paired row lands on the detonation's own attacker; an
			// unpaired row keeps it).
			thrower := e.Attacker
			if matched != nil {
				thrower = matched.Attacker
			}
			// The paired throw's origin, nil when unpaired or when the
			// throw carried no position — never a guessed coordinate.
			var throwX, throwY *float64
			if matched != nil {
				throwX, throwY = matched.PosX, matched.PosY
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
						// Enemy damage only (owner ruling
						// 2026-11-17): both sides known AND
						// equal → same-side → skip the STAT;
						// an unknown side counts (the
						// permissive rule — the same
						// predicate as the events.same_side
						// stamp and the rounds.go fold
						// above). The victim still lands in
						// affected — that list records who
						// was hit, like the flash branch.
						if !sameSide(teamR[ev.Attacker], teamR[ev.Victim]) {
							damage += ev.Dmg
						}
						affectedSet[ev.Victim] = true
					}
				case models.EventBlind:
					if flash && ev.Attacker == e.Attacker && ev.Victim != "" {
						affectedSet[ev.Victim] = true
						flashMs += flashMsBySeq[ev.Seq]
					}
				}
			}
			affected := make([]string, 0, len(affectedSet))
			for sid := range affectedSet {
				affected = append(affected, sid)
			}
			sort.Strings(affected)
			affectedJSON, _ := json.Marshal(affected)

			// An unpaired detonation stores throw_tick 0 and nil throw
			// coordinates: a throw that was never observed is never
			// invented (owner ruling — every cell stays individually
			// true; the render falls back to the detonation tick and
			// dashes the place cell).
			storedThrowTick := 0
			if throwTick >= 0 {
				storedThrowTick = throwTick
			}
			out = append(out, UtilityEvent{
				Tick:        e.Tick,
				ThrowTick:   storedThrowTick,
				Round:       e.Round,
				Thrower:     thrower,
				ThrowerName: names[thrower],
				Kind:        kind,
				ThrowX:      throwX,
				ThrowY:      throwY,
				DetX:        e.PosX,
				DetY:        e.PosY,
				Damage:      damage,
				FlashMs:     flashMs,
				Affected:    string(affectedJSON),
				Site:        e.Site,
			})
		}
	}
	// Within a round the rows order by the EFFECTIVE throw tick — the
	// paired throw's tick, the detonation tick for an unpaired row (the
	// honest fallback, never an interpolated throw time) — with the
	// detonation tick as the secondary tiebreak (two rows sharing one
	// throw keep their detonation order). Stable, so equal keys keep
	// emission order. `seq` is written from this slice order by
	// store.ReplaceUtility, so it now follows THROW chronology rather
	// than detonation chronology; its consumers are display order and the
	// (match_id, seq) PK only — nothing assumes seq ≈ detonation ticks.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Round != out[j].Round {
			return out[i].Round < out[j].Round
		}
		if ei, ej := out[i].EffectiveTick(), out[j].EffectiveTick(); ei != ej {
			return ei < ej
		}
		return out[i].Tick < out[j].Tick
	})
	return out
}
