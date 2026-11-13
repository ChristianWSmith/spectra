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
	// The player-sound fader key the frontend's replay volume popover /
	// Settings Audio section reads (DEFAULT 0 = muted is a frontend read
	// default; the key registered here is the durable contract).
	if prefsFootstepsVolumeKey != "footsteps_volume" {
		t.Errorf("footsteps volume key = %q, want %q", prefsFootstepsVolumeKey, "footsteps_volume")
	}
}

// The copy toggle is one of the few prefs Go CONSUMES (library.Options
// CopyEnabled via copyOnImportPref, read per job) — but the string is
// still the durable contract: a rename silently orphans every stored
// choice and reverts the user to the default as soon as they have toggled
// it once.
func TestCopyOnImportPrefKey(t *testing.T) {
	if prefsCopyOnImportKey != "copy_on_import" {
		t.Errorf("copy-on-import key = %q, want %q", prefsCopyOnImportKey, "copy_on_import")
	}
}

// The parallel-work pref is Go-CONSUMED (the shared work-token
// budget's size — main sizes the budget with parallelWorkPref,
// LibraryService.SetParallelWork writes it) — the string is the durable
// contract: a rename silently orphans every stored choice and reverts
// the user to the default as soon as they have changed it once.
func TestParallelWorkPrefKey(t *testing.T) {
	if prefsParallelWorkKey != "parallel_work" {
		t.Errorf("parallel-work key = %q, want %q", prefsParallelWorkKey, "parallel_work")
	}
}

// Removal pin for the retired import-scoped concurrency setting: the
// machine-level "parallel work" knob subsumed it (ONE budget governs
// every heavy task — imports, rules re-runs, asset extraction), so the
// old key is orphaned and never read (pre-release no-migration policy).
// If this fails, someone is reintroducing a second, import-only knob —
// don't; there is exactly ONE budget and ONE setting for it.
func TestRetiredImportConcurrencyPrefGone(t *testing.T) {
	src, err := os.ReadFile("prefs.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, retired := range []string{"import_concurrency", "prefsImportConcurrencyKey", "maxConcurrentImports", "importConcurrencyPref"} {
		if strings.Contains(string(src), retired) {
			t.Errorf("prefs.go mentions %q — the import-scoped concurrency setting is retired; parallel_work is the one knob", retired)
		}
	}
}

// Removal pin for the retired knife/warmup display pref: the extractor
// discards knife/warmup/post-match rounds at ingest, so every stored
// round is a counted round and a visibility toggle has nothing to filter
// (a stale kvstore value is orphaned and ignored — no migration, per the
// pre-release policy). If this fails, someone is reintroducing the
// setting — don't; the rows it hid are never stored.
func TestRetiredKnifeWarmupRoundsPrefGone(t *testing.T) {
	src, err := os.ReadFile("prefs.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, retired := range []string{"show_knife_warmup_rounds", "prefsShowKnifeWarmupRoundsKey"} {
		if strings.Contains(string(src), retired) {
			t.Errorf("prefs.go mentions %q — the knife/warmup display pref is retired; its rows are discarded at ingest", retired)
		}
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
