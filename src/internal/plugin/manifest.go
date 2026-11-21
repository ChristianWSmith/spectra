// Package plugin implements the M5 §2.7 declarative plugin model v1: a
// bundle is spectra-plugin.json (optionally alongside data files) that
// registers metric definitions and report templates — NO scripting (the
// goja/gopher-lua sandbox and loopback API are descoped by the M5 status
// note). Trust model: capability whitelist + hash pinning for shared
// bundles; installs are user-driven, never auto-updated.
//
// Manifest metrics get only a structural sanity check here (name + expr
// non-empty); full expression validation belongs to the metrics engine
// when the metric is previewed/used (no cross-service dependency on
// internal/metrics — the plugin metric call budget lives there).
package plugin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ManifestName is the bundle manifest file name.
const ManifestName = "spectra-plugin.json"

// slugRe is the plugin-id/title-slug contract (2–40 chars, lowercase
// letters/digits/hyphen).
var slugRe = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)

// ValidSlug reports whether s satisfies the plugin-id / report-template-id
// slug contract (slugRe). It is THE shared shape check for any id that
// must stay bundle-able as a plugin manifest entry: manifests validate
// with it, and platformservice.go mints user report-template ids against
// it so a saved template never needs re-shaping to be bundled later.
func ValidSlug(s string) bool { return slugRe.MatchString(s) }

// metricNameRe is looser than slugRe: metric names are column keys, so
// snake_case (and a 64-char ceiling) is allowed.
var metricNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// allowedCapabilities is the v1 capability whitelist (metrics + report
// templates only). Manifests parsed into a raw map must
// not name any other capability — unknown keys are a hard install error,
// not a warning.
var allowedCapabilities = map[string]bool{
	"metrics":          true,
	"report_templates": true,
}

// MetricDef is one manifest metric definition (JSON shape is the shared
// metric-definition contract — models.MetricRow minus createdAt/id
// stamps; id/origin/pluginId are loader-assigned). A plugin declares no
// scope: it is derived from the statement's binds like any metric's
// (dogfood/PLAN.md ruling 51).
type MetricDef struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Expr     string `json:"expr"`
	Format   string `json:"format"`
	Doc      string `json:"doc"`
	Origin   string `json:"origin"`
	PluginID string `json:"pluginId"`
}

// ReportTemplate is one manifest report template (JSON shape matches the
// frontend ReportTemplate contract; Origin is set by the loader).
type ReportTemplate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Scope  string `json:"scope"`  // match|player|round
	Format string `json:"format"` // md|html
	Origin string `json:"origin"`
	Body   string `json:"body"`
}

// Manifest is the spectra-plugin.json contract.
type Manifest struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	Author      string            `json:"author,omitempty"`
	Description string            `json:"description,omitempty"`
	Hash        string            `json:"hash,omitempty"`
	Metrics     []MetricDef       `json:"metrics,omitempty"`
	ReportTpls  []ReportTemplate  `json:"reportTpls,omitempty"`
	Extra       map[string]string `json:"extra,omitempty"`
}

// ValidateManifest parses + validates one spectra-plugin.json payload.
// Errors are user-facing install failures.
func ValidateManifest(data []byte) (Manifest, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return Manifest{}, fmt.Errorf("plugin manifest is not valid JSON: %w", err)
	}
	// Capability validation (§2.7): the optional "capabilities" object may
	// only name whitelisted keys. Parsed as a raw map first so unknown
	// keys are diffed, not silently dropped by struct decoding.
	if capRaw, ok := raw["capabilities"]; ok {
		var caps map[string]json.RawMessage
		if err := json.Unmarshal(capRaw, &caps); err != nil {
			return Manifest{}, fmt.Errorf("plugin capabilities must be an object: %w", err)
		}
		for k := range caps {
			if !allowedCapabilities[k] {
				return Manifest{}, fmt.Errorf("unknown capability %q (only metrics and report templates are supported)", k)
			}
		}
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("couldn't read the plugin manifest: %w", err)
	}
	if !slugRe.MatchString(m.ID) {
		return Manifest{}, fmt.Errorf("plugin id %q must match %s", m.ID, slugRe.String())
	}
	if strings.TrimSpace(m.Name) == "" {
		return Manifest{}, fmt.Errorf("plugin %q: name is required", m.ID)
	}
	if strings.TrimSpace(m.Version) == "" {
		return Manifest{}, fmt.Errorf("plugin %q: version is required", m.ID)
	}
	for i, d := range m.Metrics {
		if !metricNameRe.MatchString(d.Name) {
			return Manifest{}, fmt.Errorf("plugin %q: metrics[%d] name %q must match %s", m.ID, i, d.Name, metricNameRe.String())
		}
		// Structural sanity only — the metrics engine fully validates the
		// expression when the metric is previewed/used (documented above).
		if strings.TrimSpace(d.Expr) == "" {
			return Manifest{}, fmt.Errorf("plugin %q: metric %q has an empty expr", m.ID, d.Name)
		}
	}
	for i, r := range m.ReportTpls {
		if !slugRe.MatchString(r.ID) {
			return Manifest{}, fmt.Errorf("plugin %q: reportTpls[%d] id %q must match %s", m.ID, i, r.ID, slugRe.String())
		}
		if r.Scope != "match" && r.Scope != "player" && r.Scope != "round" {
			return Manifest{}, fmt.Errorf("plugin %q: reportTpls[%d] scope %q must be match|player|round", m.ID, i, r.Scope)
		}
		if r.Format != "md" && r.Format != "html" {
			return Manifest{}, fmt.Errorf("plugin %q: reportTpls[%d] format %q must be md|html", m.ID, i, r.Format)
		}
		if strings.TrimSpace(r.Body) == "" {
			return Manifest{}, fmt.Errorf("plugin %q: reportTpls[%d] has an empty body", m.ID, i)
		}
	}
	return m, nil
}

// ComputeBundleHash returns the sha256 hex digest of a bundle manifest
// FILE — the file's bytes as-is (the install source is file-only since
// w27). This is the share/pin format recorded in manifest.hash and the
// registry; a single file cannot pin its OWN digest (the digest covers
// the pin field), so a manifest carrying a pin can never verify and is
// refused on install — BuildPluginBundle therefore ships hash empty.
func ComputeBundleHash(sourcePath string) (string, error) {
	h := sha256.New()
	f, err := os.Open(sourcePath)
	if err != nil {
		return "", fmt.Errorf("couldn't open %s: %w", sourcePath, err)
	}
	defer func() { _ = f.Close() }()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("couldn't read %s: %w", sourcePath, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// LoadManifest reads + validates the manifest at sourcePath: an installed
// bundle FOLDER (the registry's stored path — the installed layout is
// always a folder holding spectra-plugin.json) or a single manifest JSON
// file (the install source, which Install refuses to take as a folder).
func LoadManifest(sourcePath string) (Manifest, error) {
	st, err := os.Stat(sourcePath)
	if err != nil {
		return Manifest{}, fmt.Errorf("couldn't read %s: %w", sourcePath, err)
	}
	mp := sourcePath
	if st.IsDir() {
		mp = filepath.Join(sourcePath, ManifestName)
	}
	data, err := os.ReadFile(mp)
	if err != nil {
		return Manifest{}, fmt.Errorf("couldn't read the plugin manifest: %w", err)
	}
	return ValidateManifest(data)
}
