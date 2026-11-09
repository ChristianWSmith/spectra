package main

import (
	"os"
	"strings"
	"testing"
)

func TestSavedWindowSize(t *testing.T) {
	tests := []struct {
		name         string
		w, h         any
		defW, defH   int
		wantW, wantH int
	}{
		{"both missing", nil, nil, 480, 270, 480, 270},
		{"valid roundtrip (float64 from JSON)", float64(800), float64(600), 480, 270, 800, 600},
		{"valid ints", 800, 600, 480, 270, 800, 600},
		{"zero width falls back", float64(0), float64(600), 480, 270, 480, 270},
		{"absurd height falls back", float64(800), float64(99999), 480, 270, 480, 270},
		{"fractional falls back", 800.5, 600, 480, 270, 480, 270},
		{"wrong type falls back", "800", "600", 480, 270, 480, 270},
		{"boundary minimum is kept", float64(200), float64(200), 480, 270, 200, 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotW, gotH := savedWindowSize(tt.w, tt.h, tt.defW, tt.defH)
			if gotW != tt.wantW || gotH != tt.wantH {
				t.Fatalf("savedWindowSize(%v, %v) = (%d, %d), want (%d, %d)",
					tt.w, tt.h, gotW, gotH, tt.wantW, tt.wantH)
			}
		})
	}
}

func TestShouldCheckUpdate(t *testing.T) {
	if shouldCheckUpdate("dev") {
		t.Error("dev builds must never hit the network on startup")
	}
	if shouldCheckUpdate("") {
		t.Error("empty version must never hit the network on startup")
	}
	if !shouldCheckUpdate("1.2.3") {
		t.Error("stamped builds should check for updates on startup")
	}
}

// The frontend reads/writes these kvstore keys by their literal strings
// through the kvstore service (Go never consumes them), so the strings ARE
// the contract — a rename here silently breaks the Settings tab.
func TestFrontendPrefKeyStrings(t *testing.T) {
	if prefsFontSizeKey != "font_size" {
		t.Errorf("font-size key = %q, want %q", prefsFontSizeKey, "font_size")
	}
	if prefsShowKnifeWarmupRoundsKey != "show_knife_warmup_rounds" {
		t.Errorf("knife/warmup key = %q, want %q",
			prefsShowKnifeWarmupRoundsKey, "show_knife_warmup_rounds")
	}
	// The replay volume popover and Settings' Audio & voice section share
	// these — one key rename would silently split the two surfaces.
	if prefsVoiceVolumeKey != "voice_volume" {
		t.Errorf("voice volume key = %q, want %q", prefsVoiceVolumeKey, "voice_volume")
	}
	if prefsGunsVolumeKey != "guns_volume" {
		t.Errorf("guns volume key = %q, want %q", prefsGunsVolumeKey, "guns_volume")
	}
	if prefsUtilityVolumeKey != "utility_volume" {
		t.Errorf("utility volume key = %q, want %q", prefsUtilityVolumeKey, "utility_volume")
	}
	if prefsC4VolumeKey != "c4_volume" {
		t.Errorf("C4 volume key = %q, want %q", prefsC4VolumeKey, "c4_volume")
	}
	if prefsAnnouncerVolumeKey != "announcer_volume" {
		t.Errorf("announcer volume key = %q, want %q", prefsAnnouncerVolumeKey, "announcer_volume")
	}
}

// Removal pin for the retired prompt-suppression pref: the launch prompt
// is presence-driven (it re-opens on EVERY launch until the assets
// exist — "Not now" is session-only), so there is deliberately no
// durable declined/done state to store. If this fails, someone is
// reintroducing a suppression pref — don't; change the gate instead.
func TestRetiredPromptSuppressionPrefGone(t *testing.T) {
	src, err := os.ReadFile("prefs.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, retired := range []string{"mappack_prompt_state", "prefsMapPackPromptKey"} {
		if strings.Contains(string(src), retired) {
			t.Errorf("prefs.go mentions %q — the prompt gate is presence-driven; nothing about it may be persisted", retired)
		}
	}
}
