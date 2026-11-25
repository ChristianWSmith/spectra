package store

import (
	"strings"
	"testing"
)

func hasComponent(rows []ComponentRow, name string) (ComponentRow, bool) {
	for _, r := range rows {
		if r.Name == name {
			return r, true
		}
	}
	return ComponentRow{}, false
}

// TestPluginComponentLifecycle: a plugin's components list as plugin rows, refuse a second
// plugin's clash, refuse a direct delete, and go with the plugin.
func TestPluginComponentLifecycle(t *testing.T) {
	s := openMem(t)
	defs := []PluginComponentDef{{Name: "pc_widget", Source: "<p/>"}}
	if err := s.CheckPluginComponentNames("pc-plugin", defs); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := s.ReplacePluginComponents("pc-plugin", defs); err != nil {
		t.Fatalf("replace: %v", err)
	}
	rows, err := s.ListComponents()
	if err != nil {
		t.Fatalf("ListComponents: %v", err)
	}
	if r, ok := hasComponent(rows, "pc_widget"); !ok || r.Origin != "plugin" || r.PluginID != "pc-plugin" {
		t.Fatalf("listed row = %+v (found %v), want a plugin row owned by pc-plugin", r, ok)
	}

	// A reinstall of the same plugin keeps its own name; another plugin cannot take it.
	if err := s.CheckPluginComponentNames("pc-plugin", defs); err != nil {
		t.Errorf("reinstall of the same plugin refused: %v", err)
	}
	if err := s.CheckPluginComponentNames("pc-other", defs); err == nil || !strings.Contains(err.Error(), "pc-plugin") {
		t.Errorf("second plugin's clash: err = %v, want it to name pc-plugin", err)
	}

	// Plugin components are read-only here: the delete says where it comes from.
	if err := s.DeleteComponent("pc_widget"); err == nil || !strings.Contains(err.Error(), "plugin") {
		t.Errorf("direct delete of a plugin component: err = %v, want a refusal naming the plugin", err)
	}

	// Disabling or removing the plugin takes its components with it.
	if err := s.DeletePluginComponents("pc-plugin"); err != nil {
		t.Fatalf("DeletePluginComponents: %v", err)
	}
	rows, err = s.ListComponents()
	if err != nil {
		t.Fatalf("ListComponents: %v", err)
	}
	if _, ok := hasComponent(rows, "pc_widget"); ok {
		t.Error("pc_widget still listed after its plugin was removed")
	}
}

// TestPluginComponentNameClashes: a built-in name and one of the user's own both refuse an install.
func TestPluginComponentNameClashes(t *testing.T) {
	s := openMem(t)
	names, err := s.BuiltinComponentNames()
	if err != nil || len(names) == 0 {
		t.Fatalf("BuiltinComponentNames = %v, %v; want the seeded built-ins", names, err)
	}
	if err := s.CheckPluginComponentNames("pc-x", []PluginComponentDef{{Name: names[0], Source: "<p/>"}}); err == nil {
		t.Errorf("a built-in name (%q) was accepted", names[0])
	}
	if _, err := s.SaveComponent("", "pc_mine", "<p/>", ComponentRefs{}); err != nil {
		t.Fatalf("SaveComponent: %v", err)
	}
	if err := s.CheckPluginComponentNames("pc-x", []PluginComponentDef{{Name: "pc_mine", Source: "<p/>"}}); err == nil || !strings.Contains(err.Error(), "rename yours") {
		t.Errorf("a clash with the user's own component: err = %v, want the rename hint", err)
	}
}

// TestSetPluginComponentRefsGuardsMetrics: recorded references keep a metric from being deleted or
// disabled, and clear with the plugin.
func TestSetPluginComponentRefsGuardsMetrics(t *testing.T) {
	s := openMem(t)
	up := mustToggleMetric(t, s, "pr_up")
	if err := s.ReplacePluginComponents("pr-plugin", []PluginComponentDef{{Name: "pr_widget", Source: "<p/>"}}); err != nil {
		t.Fatalf("ReplacePluginComponents: %v", err)
	}

	// Only the plugin's own components can record references.
	if err := s.SetPluginComponentRefs("pr-plugin", []PluginComponentRefRow{{Name: "nope"}}); err == nil {
		t.Error("references recorded for a name the plugin does not supply")
	}

	if err := s.SetPluginComponentRefs("pr-plugin", []PluginComponentRefRow{
		{Name: "pr_widget", Refs: ComponentRefs{Metrics: []string{"pr_up"}}},
	}); err != nil {
		t.Fatalf("SetPluginComponentRefs: %v", err)
	}
	if err := s.DeleteMetric(up.ID); err == nil {
		t.Error("a metric a plugin component reads was deleted")
	}
	if err := s.SetMetricEnabled(up.ID, false); err == nil {
		t.Error("a metric a plugin component reads was disabled")
	}

	// Removing the plugin clears its references, so the metric is free again.
	if err := s.DeletePluginComponents("pr-plugin"); err != nil {
		t.Fatalf("DeletePluginComponents: %v", err)
	}
	if err := s.SetMetricEnabled(up.ID, false); err != nil {
		t.Errorf("disable after the plugin was removed: %v", err)
	}
}
