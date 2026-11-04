package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// eventlabels.go — THE one generic-event labeler.
//
// Generic events (generic_events table) arrive as untyped payload blobs.
// The Replay landmark feed shows them as one-line labels; this file is
// the only place those payloads are parsed for display. It used to live
// in two copies (Go's parseConVarPayload for the Explorer's ConVar table
// and a JavaScript flatter in the retired Context view) — when the
// landmark consolidation folded both surfaces into Replay, the JS copy
// was deleted and everything moved here.

// labelGenericEvent builds the display fields for one generic event:
// who = the payload's player name when it has one ("" otherwise), label =
// a one-line detail string for the known categories (server_cvar,
// player_team) and "" for everything else (the UI falls back to the event
// name). Payload shapes vary by game build — the parsers below handle the
// shapes observed in real libraries; unparsable payloads degrade to the
// compact k=v fallback, never to an error.
func labelGenericEvent(name, payload string) (who, label string) {
	m := parsePayloadObject(payload)
	switch name {
	case "server_cvar":
		// No player attribution — and "name" is the CONVAR name in the
		// {"name","value"} payload shape, never a player.
		if pairs := parseConVarPayload(payload); len(pairs) > 0 {
			return "", joinConVarPairs(pairs)
		}
		return "", compactPayload(m, whoKeys...)
	case "player_team":
		who = payloadFirstString(m, whoKeys...)
		team := payloadFirstString(m, "team", "newteam")
		if team != "" {
			old := payloadFirstString(m, "oldteam")
			if old != "" {
				return who, "team " + old + " → " + team
			}
			return who, "team → " + team
		}
		return who, compactPayload(m, whoKeys...)
	}
	return payloadFirstString(m, whoKeys...), compactPayload(m, whoKeys...)
}

// joinConVarPairs renders parsed (name, value) pairs as a label: a single
// pair reads "name = value" (the common CS2 shape), multiple pairs (the
// {"convars":{…}} map shape) join as "k=v, k=v".
func joinConVarPairs(pairs [][2]string) string {
	if len(pairs) == 1 {
		return pairs[0][0] + " = " + pairs[0][1]
	}
	parts := make([]string, len(pairs))
	for i, kv := range pairs {
		parts[i] = kv[0] + "=" + kv[1]
	}
	return strings.Join(parts, ", ")
}

// parsePayloadObject parses a generic-event payload blob into a map; a
// blob that is not a JSON object yields an empty map (labels degrade to
// the compact fallback, never to an error).
func parsePayloadObject(payload string) map[string]any {
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// payloadFirstString returns the first present string-ish value among
// keys (used for the player-name and team fields).
func payloadFirstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s := conVarValueString(v); s != "" {
				return s
			}
		}
	}
	return ""
}

// whoKeys are the payload keys that name a player (never a convar).
var whoKeys = []string{"name", "playername", "player"}

// compactPayload flattens a payload map to "k=v k=v …" (payload order,
// keys in skip removed — the who-keys are already rendered as the row's
// name column) — the fallback label when no known shape matched. Nested
// values render as compact JSON.
func compactPayload(m map[string]any, skip ...string) string {
	if len(m) == 0 {
		return ""
	}
	skipped := map[string]bool{}
	for _, k := range skip {
		skipped[k] = true
	}
	parts := make([]string, 0, len(m))
	for k, v := range m {
		if skipped[k] {
			continue
		}
		switch t := v.(type) {
		case string:
			parts = append(parts, k+"="+t)
		default:
			b, err := json.Marshal(t)
			if err != nil {
				parts = append(parts, k+"="+fmt.Sprint(t))
			} else {
				parts = append(parts, k+"="+string(b))
			}
		}
	}
	// Map iteration is random — stable output for equal payloads.
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

// parseConVarPayload extracts (name, value) pairs from one server_cvar
// payload blob; unparsable payloads contribute nothing (the raw blob
// remains available as the record's payload). The M1 extractor records
// payload shapes that vary by game build — the parser handles the shapes
// observed in real libraries: {"cvarname","cvarvalue"} (what CS2 emits
// today), {"name","value"}, {"cvar"[,"value"]}, and
// {"convars":{name:value,…}} maps.
func parseConVarPayload(payload string) [][2]string {
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return nil
	}
	if sub, ok := m["convars"].(map[string]any); ok {
		out := make([][2]string, 0, len(sub))
		for k, v := range sub {
			out = append(out, [2]string{k, conVarValueString(v)})
		}
		// Stable order for equal ticks (map iteration is random).
		sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
		return out
	}
	name := conVarFirstString(m, "cvarname", "name", "cvar")
	if name == "" {
		return nil
	}
	return [][2]string{{name, conVarFirstString(m, "cvarvalue", "value")}}
}

// conVarFirstString returns the first present string-ish value among keys.
func conVarFirstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s := conVarValueString(v); s != "" {
				return s
			}
		}
	}
	return ""
}

// conVarValueString stringifies a JSON scalar (convar values are strings
// in CS2 payloads, but numbers/bools are tolerated).
func conVarValueString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprint(t)
		}
		return string(b)
	}
}
