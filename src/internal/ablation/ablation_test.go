package ablation

// Opt-in driver for the S03 ablation harness. Skipped unless
// ABLATION_SNAPSHOT is set, so a plain `go test ./...` never runs it.
//
//	ABLATION_SNAPSHOT  library DB to copy (never opened for writing)      required
//	ABLATION_OUT       output directory (copy, dump, summary, diff)       required
//	ABLATION_NAME      run label, used in the output file names           default "run"
//	ABLATION_SQL       file of SQL run on the copy before the sweep (a variant)
//	ABLATION_BASELINE  baseline dump (<name>.dump.json of an earlier run) to diff against
//	ABLATION_EXPECT    "identical" or "differs": fail the test unless the diff matches
//	ABLATION_WORKERS   unit parallelism for the sweep (S14); 1 is sequential
//
// Each run: copy the snapshot, open it through store.Open, apply the variant,
// clear every metric's stored rows and run records and unhold every metric
// (so the sweep recomputes all of them), run metrics.Sweep with no
// cancellation context, dump metric_values, and diff against the baseline.

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"

	_ "modernc.org/sqlite"
)

func TestAblation(t *testing.T) {
	snap := os.Getenv("ABLATION_SNAPSHOT")
	if snap == "" {
		t.Skip("ablation harness is opt-in: set ABLATION_SNAPSHOT (and ABLATION_OUT)")
	}
	out := os.Getenv("ABLATION_OUT")
	if out == "" {
		t.Fatal("ABLATION_OUT is required")
	}
	name := envOr("ABLATION_NAME", "run")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}

	// The snapshot must be checkpointed: a non-empty -wal holds rows that a
	// plain file copy would miss.
	if fi, err := os.Stat(snap + "-wal"); err == nil && fi.Size() > 0 {
		t.Fatalf("%s-wal is non-empty; checkpoint the snapshot before ablating", snap)
	}
	srcBefore, err := os.Stat(snap)
	if err != nil {
		t.Fatal(err)
	}

	dbPath := filepath.Join(out, name+".db")
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		_ = os.Remove(p)
	}
	copyStart := time.Now()
	if err := copyFile(snap, dbPath); err != nil {
		t.Fatalf("copy snapshot: %v", err)
	}
	copyDur := time.Since(copyStart)

	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open copy: %v", err)
	}
	defer st.Close()
	raw, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()

	if p := os.Getenv("ABLATION_SQL"); p != "" {
		stmt, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec(string(stmt)); err != nil {
			t.Fatalf("variant SQL %s: %v", p, err)
		}
	}

	var held int
	if err := raw.QueryRow(`SELECT COUNT(*) FROM metrics WHERE held = 1`).Scan(&held); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`UPDATE metrics SET held = 0`,
		`DELETE FROM metric_runs`,
		`DELETE FROM metric_values`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}

	sweepStart := time.Now()
	// ABLATION_WORKERS sets the per-metric unit parallelism (S14); unset keeps
	// the default. The sequential baseline is ABLATION_WORKERS=1.
	if w := os.Getenv("ABLATION_WORKERS"); w != "" {
		n, err := strconv.Atoi(w)
		if err != nil || n < 1 {
			t.Fatalf("ABLATION_WORKERS=%q: want a positive integer", w)
		}
		metrics.SetUnitWorkers(n)
	}
	res, err := metrics.Sweep(t.Context(), st, nil, nil)
	sweepDur := time.Since(sweepStart)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}

	rows, err := Dump(raw)
	if err != nil {
		t.Fatal(err)
	}
	dumpPath := filepath.Join(out, name+".dump.json")
	if err := WriteDump(dumpPath, rows); err != nil {
		t.Fatal(err)
	}

	srcAfter, err := os.Stat(snap)
	if err != nil {
		t.Fatal(err)
	}
	srcUnchanged := srcBefore.Size() == srcAfter.Size() && srcBefore.ModTime().Equal(srcAfter.ModTime())

	var sum strings.Builder
	fmt.Fprintf(&sum, "run=%s snapshot=%s\n", name, snap)
	fmt.Fprintf(&sum, "copy=%s sweep=%s metrics attempted=%d succeeded=%d failed=%d skipped=%d held-cleared=%d\n",
		copyDur.Round(time.Millisecond), sweepDur.Round(time.Millisecond),
		len(res.Attempted), len(res.Succeeded), len(res.Failed), len(res.Skipped), held)
	fmt.Fprintf(&sum, "metric_values rows=%d dump=%s\n", len(rows), dumpPath)
	fmt.Fprintf(&sum, "snapshot untouched (size and mtime): %v\n", srcUnchanged)
	for id, msg := range res.Failed {
		fmt.Fprintf(&sum, "FAILED metric id=%d: %s\n", id, msg)
	}
	if !srcUnchanged {
		t.Errorf("snapshot %s changed during the run", snap)
	}

	verdict := ""
	if base := os.Getenv("ABLATION_BASELINE"); base != "" {
		baseRows, err := ReadDump(base)
		if err != nil {
			t.Fatal(err)
		}
		rep := Diff(baseRows, rows)
		text := rep.Text()
		if err := os.WriteFile(filepath.Join(out, name+".diff.txt"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		sum.WriteString(text)
		if rep.Identical {
			verdict = "identical"
		} else {
			verdict = "differs"
		}
	}
	if err := os.WriteFile(filepath.Join(out, name+".summary.txt"), []byte(sum.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Log("\n" + sum.String())

	if want := os.Getenv("ABLATION_EXPECT"); want != "" {
		if verdict == "" {
			t.Fatalf("ABLATION_EXPECT=%s needs ABLATION_BASELINE", want)
		}
		if verdict != want {
			t.Fatalf("expected the diff to be %s, got %s", want, verdict)
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, in); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
