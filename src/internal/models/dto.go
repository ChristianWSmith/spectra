package models

import "time"

// MatchSummary is one row of the library list (denormalized read model —
// includes both team names so the list shows the matchup without joins in
// the frontend).
type MatchSummary struct {
	ID          int64     `json:"id"`
	Path        string    `json:"path"`
	Map         string    `json:"map"`
	Size        int64     `json:"size"`
	ScoreCT     int       `json:"scoreCT"`
	ScoreT      int       `json:"scoreT"`
	CTName      string    `json:"ctName"`
	TName       string    `json:"tName"`
	RealRounds  int       `json:"realRounds"`
	DurationS   float64   `json:"durationS"`
	ExtractedAt time.Time `json:"extractedAt"`
	Status      string    `json:"status"`
	Error       string    `json:"error"`
	SHA256      string    `json:"sha256"`
	// CopyState is the fs-derived demo-copy state ("copied" | "external" |
	// "missing" — library.CopyState*). SERVICE-OWNED: the store never
	// fills it (no column, nothing to go stale); LibraryService.
	// ListMatchesPage stamps it per row from Importer.CopyState, and it
	// stays "" on every other projection (ListMatches and its
	// whole-library readers).
	CopyState string `json:"copyState"`
}

// MatchListPage is one keyset window of the library list (the "Load more"
// pagination): Rows is the window, HasNext reports whether another window
// follows it. Rosters carries the matchup-synthesis input for the window's
// rows that recorded NO team clan name — matchId → the human roster rows
// (models.PlayerRef) the frontend's canonical team_<player> synthesis
// (lib/teams.js teamNames) needs; ids whose teams rows carry both names
// are absent, and a match whose roster is empty is absent too (its
// Matchup cell stays the "—" placeholder). One page therefore answers a
// list load in a single IPC call instead of one scoreboard fetch per row.
type MatchListPage struct {
	Rows    []MatchSummary        `json:"rows"`
	HasNext bool                  `json:"hasNext"`
	Rosters map[int64][]PlayerRef `json:"rosters"`
}

// PlayerStatsRow is scoreboard output: stats joined with identity + the
// player's final-side. SortKey addresses either table's columns (the store
// whitelists it — never interpolate user input).
//
// K/D is deliberately NOT here: the stored `kd` metric row is THE K/D
// value every surface renders (dogfooding W4 — reports read it back,
// the scoreboard columns are metric-backed), so a Go-computed copy
// would be a second presentation of the same number. KDA stays (N1: the
// grammar cannot express (kills+assists)/deaths).
type PlayerStatsRow struct {
	SteamID           string  `json:"steamId"`
	Name              string  `json:"name"`
	IsBot             bool    `json:"isBot"`
	Side              string  `json:"side"`
	FinalStatePresent bool    `json:"finalStatePresent"` // provenance: false = absent from final snapshot (PRD §6.1)
	RoundsPlayed      int     `json:"roundsPlayed"`
	Kills             int     `json:"kills"`
	Deaths            int     `json:"deaths"`
	Assists           int     `json:"assists"`
	FlashAssists      int     `json:"flashAssists"`
	Headshots         int     `json:"headshots"`
	HSPct             float64 `json:"hsPct"`
	ADR               float64 `json:"adr"`
	KDA               float64 `json:"kda"`
	TotalDamage       int     `json:"totalDamage"`
	DamageTaken       int     `json:"damageTaken"`
	EntryKills        int     `json:"entryKills"`
	EntryDeaths       int     `json:"entryDeaths"`
	OpeningKills      int     `json:"openingKills"`
	OpeningDeaths     int     `json:"openingDeaths"`
	TradeKills        int     `json:"tradeKills"`
	BestStreak        int     `json:"bestStreak"`
	TwoK              int     `json:"twoK"`
	ThreeK            int     `json:"threeK"`
	FourK             int     `json:"fourK"`
	FiveK             int     `json:"fiveK"`
	UtilityDamage     int     `json:"utilityDamage"`
	EnemiesFlashed    int     `json:"enemiesFlashed"`
	FlashedTimes      int     `json:"flashedTimes"`
	BombPlants        int     `json:"bombPlants"`
	BombDefuses       int     `json:"bombDefuses"`
	MVPs              int     `json:"mvps"`
	Score             int     `json:"score"`
	Teamkills         int     `json:"teamkills"`
	Suicides          int     `json:"suicides"`
	MoneySpent        int     `json:"moneySpent"`
	KillsByWeapon     string  `json:"killsByWeapon"`
	DamageByWeapon    string  `json:"damageByWeapon"`
}

// RoundRow is the round-browser row (round joined with display names).
// Number is the dense counted-round index — knife/warmup rounds are
// discarded at ingest, so no flag distinguishes them anymore (the
// frontend's r.warmup/r.pregame reads are retired with the discard,
// Phase 3).
type RoundRow struct {
	Number          int     `json:"number"`
	Winner          string  `json:"winner"`
	Reason          string  `json:"reason"`
	DurationS       float64 `json:"durationS"`
	BombSite        string  `json:"bombSite"`
	MVP             string  `json:"mvp"`
	MVPName         string  `json:"mvpName"`
	MVPReason       string  `json:"mvpReason"`
	EquipCT         int     `json:"equipCT"`
	EquipT          int     `json:"equipT"`
	Kills           int     `json:"kills"`
	FirstKillSteam  string  `json:"firstKillSteam"`
	FirstKillName   string  `json:"firstKillName"`
	FirstDeathSteam string  `json:"firstDeathSteam"`
	FirstDeathName  string  `json:"firstDeathName"`
	StartTick       int     `json:"startTick"`
	EndTick         int     `json:"endTick"`
	FreezeEndTick   int     `json:"freezeEndTick"`
}

// RoundDetail is the round drill-down: the round + its economy + its
// kill-feed (typed events), + chat lines that happened in the round.
type RoundDetail struct {
	Round   RoundRow       `json:"round"`
	Economy []RoundEconomy `json:"economy"`
	Events  []EventRow     `json:"events"`
	Chat    []ChatRow      `json:"chat"`
}

// EventRow is one timeline row — typed columns only, no payloads (fetch
// EventDetail on click so a 50 k-event filter stays cheap on the wire).
// PosX/PosY/PosZ mirror events.pos_* (nil when the event has no position);
// EventDetail embeds this row so it carries the same fields.
type EventRow struct {
	ID            int64    `json:"id"`
	Seq           int      `json:"seq"`
	Tick          int      `json:"tick"`
	Round         int      `json:"round"`
	Kind          string   `json:"kind"`
	Attacker      string   `json:"attacker"`
	AttackerName  string   `json:"attackerName"`
	Victim        string   `json:"victim"`
	VictimName    string   `json:"victimName"`
	Assister      string   `json:"assister"`
	AssisterName  string   `json:"assisterName"`
	Weapon        string   `json:"weapon"`
	Headshot      bool     `json:"headshot"`
	Wallbang      bool     `json:"wallbang"`
	Noscope       bool     `json:"noscope"`
	ThroughSmoke  bool     `json:"throughSmoke"`
	AttackerBlind bool     `json:"attackerBlind"`
	AssistedFlash bool     `json:"assistedFlash"`
	Distance      float64  `json:"distance"`
	Hitgroup      string   `json:"hitgroup"`
	Dmg           int      `json:"dmg"`
	Site          string   `json:"site"`
	PosX          *float64 `json:"posX,omitempty"`
	PosY          *float64 `json:"posY,omitempty"`
	PosZ          *float64 `json:"posZ,omitempty"`
	// AttackerPos* mirrors events.apos_* — the attacker's position on
	// kill events (nil otherwise); the kills heatmap plots it while
	// Pos* keeps the victim/hit position.
	AttackerPosX *float64 `json:"attackerPosX,omitempty"`
	AttackerPosY *float64 `json:"attackerPosY,omitempty"`
	AttackerPosZ *float64 `json:"attackerPosZ,omitempty"`
	// AttackerInAir mirrors events.attacker_inair — the payload-only
	// kill flag (see models.Event.AttackerInAir).
	AttackerInAir bool `json:"attackerInAir"`
}

// EventDetail is one event with its JSON payloads (detail pane).
type EventDetail struct {
	EventRow
	DetailJSON string `json:"detailJson"`
	RawJSON    string `json:"rawJson"`
}

// DropDetail is ONE weapon_drop row's detail_json projection for the
// replay's drop layer — the payload side channel in the exact shape of
// the blind one (store.GetBlindFlashDurations → MatchService.
// GetBlindDurations): EventRow stays payload-free, so the stored
// classification (cat, stamped at extract time by models.IsUtilityWeapon
// / models.IsKit / the firearm sets — the frontend never re-derives the
// util or the kit rule) and the gun's ammo/mag
// state at death reach the renderer through a narrow seq-keyed read
// (store.GetDropDetails), joined onto the DRAW_KINDS rows by seq.
// Cat "" / Mag 0 mean "payload missing" — the consumer draws nothing,
// never a guessed classification.
type DropDetail struct {
	Seq     int    `json:"seq"`
	Cat     string `json:"cat"` // "gun" | "util" | "kit" | "" (missing payload)
	Mag     int    `json:"mag"`
	Reserve int    `json:"reserve"`
}

// EventFromRow is THE EventRow → Event conversion (the typed-columns read
// shape onto the domain event): every field the two share moves across;
// the row id and the joined display names stay with the read DTO, and the
// JSON payloads are never on EventRow (they stay in SQLite — the analytics
// pass reads typed columns only), so DetailJSON/RawJSON are "" here.
// analytics.Compute uses this, never a hand-rolled literal.
func EventFromRow(r EventRow) Event {
	return Event{
		Seq: r.Seq, Tick: r.Tick, Round: r.Round, Kind: r.Kind,
		Attacker: r.Attacker, Victim: r.Victim, Assister: r.Assister,
		Weapon: r.Weapon, Headshot: r.Headshot, Wallbang: r.Wallbang,
		Noscope: r.Noscope, ThroughSmoke: r.ThroughSmoke,
		AttackerBlind: r.AttackerBlind, AttackerInAir: r.AttackerInAir,
		AssistedFlash: r.AssistedFlash,
		Distance:      r.Distance, Hitgroup: r.Hitgroup, Dmg: r.Dmg, Site: r.Site,
		PosX: r.PosX, PosY: r.PosY, PosZ: r.PosZ,
		AttackerPosX: r.AttackerPosX, AttackerPosY: r.AttackerPosY, AttackerPosZ: r.AttackerPosZ,
	}
}

// EventFilter selects timeline rows. RoundFrom/RoundTo bound e.round
// INCLUSIVELY and are a PARTIAL range: 0 = open on that side (round 0
// never exists — extract numbers stored rounds 1.., so 0 is the only
// correct "unset" sentinel), both unset = every round of the match.
// Negative bounds stay ordinary bounds of the same open range (a range
// flag, not a warmup concept — no stored round carries them since the
// knife/warmup discard). Round detail reads are NOT a filter
// — store.GetRoundDetail matches its round EXACTLY through
// store.queryEvents' exactRound, see
// that function. Kind "" = all kinds; SteamID matches attacker OR
// victim (kind="kill" rows may be narrowed to ONE endpoint by KillRole —
// see that field). Offset/Limit paginate (Limit <= 0 means "no limit" —
// the store still applies a hard cap).
type EventFilter struct {
	MatchID int64 `json:"matchId"`
	// RoundFrom/RoundTo: inclusive round bounds, 0 = open on that side.
	RoundFrom int    `json:"roundFrom,omitempty"`
	RoundTo   int    `json:"roundTo,omitempty"`
	Kind      string `json:"kind"`
	SteamID   string `json:"steamId"`
	Offset    int    `json:"offset"`
	Limit     int    `json:"limit"`
	// Kinds is the multi-kind form of Kind — an IN filter over several
	// event kinds at once (the Replay landmark feed fetches a category's
	// whole kind set in one query). Non-empty Kinds takes precedence over
	// Kind; empty = fall through to the single-Kind clause.
	Kinds []string `json:"kinds,omitempty"`
	// M3 advanced filters. Zero/""/nil = unconstrained; the distance
	// bounds are a PARTIAL range over e.distance (units of the event's
	// own distance column) — either side may be open, <= 0 = open.
	Weapon       string  `json:"weapon,omitempty"`
	DistanceMin  float64 `json:"distanceMin,omitempty"`
	DistanceMax  float64 `json:"distanceMax,omitempty"`
	HeadshotOnly bool    `json:"headshotOnly,omitempty"`
	// BBox is a world-space EITHER-ENDPOINT position filter — see BBox.
	BBox *BBox `json:"bbox,omitempty"`
	// KillRole narrows the SteamID clause to ONE endpoint of kind="kill"
	// rows only: "attacker" = X's kills, "victim" = X's deaths — the FE's
	// killRoleFor(cats) derivation over the CATEGORY ids (Kills-only /
	// Deaths-only; both or neither → "any"/"" = no clause, today's
	// either-endpoint match). Every OTHER kind keeps attacker-OR-victim
	// regardless ("involved in" for damage/blinds), and with SteamID
	// empty the role never fires (a role with no player selected is a
	// no-op). queryEvents applies it as its own clause, structurally
	// separate from the round range and the bbox predicate.
	KillRole string `json:"killRole,omitempty"`
	// Side is the side AT the event's round — the exact per-round
	// freeze-end sample (round_player_sides), which swaps at halftime —
	// mirrored from the heatmap's Team selector (analyticservice.
	// heatmapEvents side-checks the same party at the same round, so a
	// feed filtered Side=ct is the population a Side=CT heatmap was
	// generated from). "" | "ct" | "t"; any other literal is ignored
	// (no clause — never a guessed filter). Only the endpoint(s) the
	// heatmap's party rule names are constrained — see queryEvents.
	Side string `json:"side,omitempty"`
	// Team is the team IDENTITY of the endpoint: the side that player
	// OPENED the match on (players.side flipped through rules.StartSide
	// over the match's side-switch count — constant across halftime,
	// unlike Side). "" | "ct" | "t"; any other literal is ignored. The
	// heatmap has no identity notion (its selector is side-at-round), so
	// Team mirrors Side's ENDPOINTS with the start-side value.
	Team string `json:"team,omitempty"`
}

// BBox is a world-coordinate rectangle; an event matches when EITHER of
// its endpoints falls inside it — the victim/hit position (events.pos_*)
// OR the attacker position (events.apos_*). The region drill surrounds
// what the heatmap RASTERIZED, and the kills heatmap plots the KILLER's
// position (AnalyticsService.GetHeatmap), so a victim-only predicate
// would drop every non-point-blank kill of a clicked cell.
type BBox struct {
	MinX float64 `json:"minX"`
	MinY float64 `json:"minY"`
	MaxX float64 `json:"maxX"`
	MaxY float64 `json:"maxY"`
}

// EventKey is ONE matching event's identity for a keys-only read
// (MatchService.GetEventKeys): Id is the landmark key's `e:<id>` half,
// Tick its position on the scrubber, Kind the bucket derivation's
// input. Nothing else — the read answers "WHICH rows does this filter
// match" (the replay's scrubber-marker set), never "show me those rows".
type EventKey struct {
	ID   int64  `json:"id"`
	Tick int    `json:"tick"`
	Kind string `json:"kind"`
}

// ChatRow is one chat line with display name (chat table join players).
// Decrypted marks a row recovered from svc_EncryptedData via the .dem.info
// key — v1 always stores false (see models.Chat for the provenance note).
type ChatRow struct {
	ID        int64  `json:"id"`
	Tick      int    `json:"tick"`
	Round     int    `json:"round"`
	SteamID   string `json:"steamId"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	Kind      string `json:"kind"`
	Channel   string `json:"channel"` // "all" | "team" | "" (system/unknown) — see models.Chat
	Decrypted bool   `json:"decrypted"`
}

// NameCount is one histogram bucket (generic event name → occurrences).
type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
