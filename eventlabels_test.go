package main

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestGenericEventLabels pins THE generic-event labeler (eventlabels.go):
// the server_cvar payload shapes observed across game builds, the
// player_team shape, the who extraction, and the compact fallback. This
// is the single implementation, so these assertions are the only place
// convar/team parsing semantics are pinned.
func TestGenericEventLabels(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedPlatformMatch(t, st)

	lib := &LibraryService{st: st}

	// The three flat convar shapes + the {"convars":{…}} map shape, all
	// labelled from the one parser (seeded by seedPlatformMatch).
	rows, err := lib.GetGenericEvents(id, "server_cvar", -1, 100, 0)
	if err != nil {
		t.Fatalf("GetGenericEvents(server_cvar): %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("server_cvar rows = %d, want 4", len(rows))
	}
	want := map[int]string{
		0: "sv_alltalk = true",
		1: "mp_roundtime_defuse = 1.92",
		2: "fps_max = 400",
		3: "mp_freezetime=15, sv_cheats=0", // convars map, keys sorted
	}
	for i, w := range want {
		if rows[i].Label != w {
			t.Errorf("row %d label = %q, want %q", i, rows[i].Label, w)
		}
		if rows[i].Who != "" {
			t.Errorf("row %d who = %q, want empty (convars have no player)", i, rows[i].Who)
		}
		if rows[i].RowID == 0 {
			t.Errorf("row %d RowID = 0, want the SQLite rowid", i)
		}
	}

	// player_connect: who = the payload's player name; the who-keys are
	// stripped from the label so it never repeats the name column.
	connects, err := lib.GetGenericEvents(id, "player_connect", -1, 100, 0)
	if err != nil || len(connects) != 1 {
		t.Fatalf("GetGenericEvents(player_connect) = %d rows (err %v), want 1", len(connects), err)
	}
	if connects[0].Who != "late" {
		t.Errorf("connect who = %q, want %q", connects[0].Who, "late")
	}
	if connects[0].Label != "" {
		t.Errorf("connect label = %q, want empty (payload was only the who-key)", connects[0].Label)
	}
}

// TestLabelGenericEventShapes covers the labeler's pure shapes without a
// store: team changes, unknown names (compact fallback), and garbage
// payloads (never an error).
func TestLabelGenericEventShapes(t *testing.T) {
	cases := []struct {
		name    string
		ev      string
		payload string
		wantWho string
		wantLbl string
	}{
		{"player_team full", "player_team", `{"name":"donk","oldteam":"2","team":"3"}`, "donk", "team 2 → 3"},
		{"player_team no old", "player_team", `{"name":"donk","team":"2"}`, "donk", "team → 2"},
		{"player_team no team", "player_team", `{"name":"donk","userid":4}`, "donk", "userid=4"},
		{"unknown name compact", "anything_goes", `{"userid":3,"weapon":"ak47"}`, "", "userid=3 weapon=ak47"},
		{"who keys stripped", "anything_goes", `{"name":"karrigan","userid":3}`, "karrigan", "userid=3"},
		{"garbage payload", "anything_goes", `not-json`, "", ""},
		{"empty payload", "anything_goes", ``, "", ""},
		{"non-object payload", "anything_goes", `[1,2]`, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			who, lbl := labelGenericEvent(tc.ev, tc.payload)
			if who != tc.wantWho || lbl != tc.wantLbl {
				t.Errorf("labelGenericEvent = (%q, %q), want (%q, %q)", who, lbl, tc.wantWho, tc.wantLbl)
			}
		})
	}
	// server_cvar never takes a player from the payload — "name" there is
	// the convar name.
	who, lbl := labelGenericEvent("server_cvar", `{"name":"sv_cheats","value":"0"}`)
	if who != "" || lbl != "sv_cheats = 0" {
		t.Errorf("server_cvar label = (%q, %q), want (\"\", \"sv_cheats = 0\")", who, lbl)
	}
}
