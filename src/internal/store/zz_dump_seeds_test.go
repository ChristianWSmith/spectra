package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestZZDumpSeeds(t *testing.T) {
	out := os.Getenv("SEED_DUMP")
	if out == "" {
		t.Skip()
	}
	st, err := Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	rows, err := st.ListMetrics()
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for _, m := range rows {
		if m.Origin == "builtin" {
			b.WriteString("== " + m.Name + "\n" + m.Expr + "\n")
		}
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}
