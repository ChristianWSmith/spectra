package query

// Schema provenance notes ("schema browser sidebar (tables,
// columns, parser schema notes)"). One line per known table; column notes
// only where the meaning is not obvious from the name. Unknown tables and
// columns keep "" (contract) — that is also the path for plugin/virtual
// tables this package has never seen.

// tableNotes maps table → one-line purpose.
var tableNotes = map[string]string{
	// M1 core library.
	"matches":            "imported demo files: identity (sha256), parse metadata, score/outcome, sidecar position meta",
	"teams":              "per-match team rows by side (name, flag, score, spend)",
	"players":            "per-match player roster: SteamID64, name, final side (label source for metric previews)",
	"player_stats":       "per-match scoreboard rollup per player (K/D/A, ADR, openings, trades, weapon JSON)",
	"rounds":             "per-round outcome + timing (winner, reason, ticks, first kill, MVP) — one row per COUNTED round (knife/warmup rounds are discarded at ingest)",
	"round_player_sides": "per-round player sides from freeze-end samples (exact side per round — halftime switches)",
	"round_economy":      "per-round per-side equipment value + money samples + spend (spent = Σ over the side's players of the freeze-time-end delta in the cumulative cash-spent counter; buy classification input) + free spawn-issued default-pistol value held at freeze end (free_pistol_value — granted pistols count inside equipment value, so net worth includes them)",
	"events":             "normalized game events (kill/damage/blind/bomb/…) with tick, actors, weapon flags, positions",
	"generic_events":     "raw parser events not in the normalized taxonomy (name/tick/payload JSON)",
	"chat":               "in-game chat/user messages (with decryption provenance columns)",
	"warnings":           "parser warnings captured during extraction, per match, ordered",
	"jobs":               "import job queue state (queued/running/done/failed + progress)",

	// M3 analytics (derived rows).
	"round_classifications": "per-round buy classification with rule_version + human explanation",
	"round_side_classes":    "per-round per-SIDE stored buy class + why (the eco rule's output — full|force|eco|save|pistol) — written by analytics.Compute at analyze time, read verbatim by GetEconomy",
	"player_round_stats":    "per-player per-round stats: KAST components, traded/survived, damage, spend",
	"clutches":              "detected 1vN clutch attempts + outcome",
	"engagements":           "detected opening/trade/traded/untraded engagements between two players",
	"utility_events":        "grenade throws/detonations: damage, flash ms, site",
	"match_trade_opps":      "per-match stored trade-opportunity counts per player (opps = profile Trade-rate denominator, missed = Combat badge) — written by analytics.Compute under the match's rule version",
	"player_career":         "cross-match career rollup per SteamID64 (rebuilt after imports)",
	"saved_filters":         "saved analytics filter presets",
	"analysis_config":       "single-row analysis rule thresholds (trade window, eco, rule version)",

	// M4 communications.
	"voice_presence": "per-match voice index summary (chunk/player/caster counts, key_found)",

	// M5 (this milestone).
	"metrics":       "custom metric definitions (origin builtin|user|plugin; declarative metric grammar)",
	"metric_values": "stored metric VALUES: one number per saved metric per player — match grain (match_id > 0) or career grain (match_id = 0); value 0 always beside n (sample size), a group the statement did not produce has no row",
	"metric_deps":   "metric→metric dependency edges (which metrics each metric's expression references by name)",
	"saved_queries": "named SQL console queries (unique names; each row's name is its display label and its description is the muted second line in the console list)",
	"query_history": "SQL console run history (sql/ms/rows/ok, capped at 100 newest)",
	"plugins":       "declarative plugin registry",
}

// columnNotes maps table → column → note.
var columnNotes = map[string]map[string]string{
	"events": {
		"kind":           "taxonomy: kill|damage|blind|bomb_*|weapon_drop|weapon_pickup|grenade_*|round_*|player_connect|player_disconnect",
		"attacker":       "SteamID64 of the actor ('' = world/no actor)",
		"victim":         "SteamID64 of the affected player",
		"assisted_flash": "kill was flash-assisted (victim blinded by the assister's flash)",
		"headshot":       "0/1 kill flag",
		"pos_x":          "world position when the event carried one (NULL otherwise; sidecar has full tracks)",
		"detail_json":    "per-kind payload JSON; kill events carry nearDist = the nearest living teammate of the victim to the killer at the death tick (world units, -1 sentinel when unmeasurable) — the trade-opportunity distance gate",
	},
	"rounds": {
		"winner": "ct|t|'' (empty = unresolved)",
		"mvp":    "SteamID64 of the round MVP",
	},
	"round_player_sides": {
		"side": "player's side in that round (ct|t) — freeze-end sample; sides switch at halftime, so this is the exact per-round truth",
	},
	"player_round_stats": {
		"traded":   "victim's death was answered inside the trade window",
		"survived": "player was alive at round end",
		"kast":     "KAST round component: kill/assist/traded-death/survived",
	},
	"engagements": {
		"kind":    "opening|trade|traded|untraded (a = killer, b = victim)",
		"won_by":  "side that won the engagement (ct|t)",
		"a_steam": "SteamID64 of the acting player (killer for all kinds)",
		"b_steam": "SteamID64 of the counterpart (victim for all kinds)",
	},
	"matches": {
		"status": "queued|parsing|ready|failed",
		"map":    "map name as extracted (source for groupBy=map)",
	},
	"chat": {
		"channel":   "chat channel: 'all' (renders [ALL]) | 'team' (renders the speaker's side [T]/[CT]) | '' for system messages",
		"decrypted": "chat considered decrypted (always 0 — presence.key_found and matches.enc_messages carry the real state)",
	},
	"utility_events": {
		"kind": "he|flash|smoke|molotov|incendiary|decoy",
	},
	"player_stats": {
		"trade_kills":     "kills answering a teammate death inside the trade window",
		"opening_kills":   "first-kill attributions (extractor rule)",
		"assists":         "cross-team assists, AssistedFlash excluded (external-scoreboard convention)",
		"flash_assists":   "AssistedFlash assists, split out of assists (the game's m_iAssists includes them)",
		"kills_by_weapon": "JSON object (excluded from the metrics expression whitelist)",
	},
	"metrics": {
		"origin":      "builtin|user|plugin — the builtin origin ships seeded with the app (exactly one row: trade_rate)",
		"short_name":  "optional user-entered short label — read ONLY at width-constrained metric column headers (short_name || title || name; title || name everywhere else)",
		"expr":        "metric grammar: from <table>[, <secondary>...]: <aggregations> (extra sources join engine-side)",
		"scope":       "'match'|'profile' — where the metric is addressed: this player in one match, or this player's career",
		"denominator": "scalar subquery source: ''|rounds|matches",
	},
}

// columnNote returns the column note ("" when unknown).
func columnNote(table, column string) string {
	if m, ok := columnNotes[table]; ok {
		return m[column]
	}
	return ""
}
