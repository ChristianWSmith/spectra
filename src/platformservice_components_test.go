package main

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/plugin"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestBuildPluginBundleComponents: the bundle carries the user's components by name and source, and
// refuses a built-in or an unknown name.
func TestBuildPluginBundleComponents(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	svc := &PlatformService{st: st}

	if _, err := st.SaveComponent("", "bp_widget", "<p>hi</p>", store.ComponentRefs{}); err != nil {
		t.Fatalf("SaveComponent: %v", err)
	}
	out, err := svc.BuildPluginBundle("BP Plugin", "", nil, nil, []string{"bp_widget"})
	if err != nil {
		t.Fatalf("BuildPluginBundle: %v", err)
	}
	man, err := plugin.ValidateManifest([]byte(out))
	if err != nil {
		t.Fatalf("composed bundle fails the validator: %v", err)
	}
	if len(man.Components) != 1 || man.Components[0].Name != "bp_widget" || man.Components[0].Source != "<p>hi</p>" {
		t.Fatalf("components = %+v, want bp_widget with its source", man.Components)
	}

	names, err := st.BuiltinComponentNames()
	if err != nil || len(names) == 0 {
		t.Fatalf("BuiltinComponentNames = %v, %v", names, err)
	}
	if _, err := svc.BuildPluginBundle("BP Plugin", "", nil, nil, []string{names[0]}); err == nil {
		t.Errorf("a built-in component (%q) went into a bundle", names[0])
	}
	if _, err := svc.BuildPluginBundle("BP Plugin", "", nil, nil, []string{"bp_missing"}); err == nil || !strings.Contains(err.Error(), "bp_missing") {
		t.Errorf("an unknown component: err = %v, want it to name bp_missing", err)
	}
}
