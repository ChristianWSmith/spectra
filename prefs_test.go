package main

import "testing"

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
