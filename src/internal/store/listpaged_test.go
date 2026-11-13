package store

// Characterization + correctness tests for ListMatchesPage, the Library
// list's keyset ("Load more") window: ties on the sort key must never
// skip or duplicate a row across windows, window boundaries are exact
// (the limit+1 probe reports HasNext), a cursor into the middle (or past
// the end) positions the next window correctly, NULL extracted_at rows
// (queued, never extracted) stay reachable under both directions, and the
// window carries the batched matchup rosters that replaced the view's
// per-row scoreboard fetches. ListMatches itself (the unbounded read the
// import dedupe and the pickers use) stays untouched — the ordering pins
// below read it as the reference order.

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// seedListRow inserts a bare lifecycle row — status queued, no teams, no
// players (a match whose extract never ran) — and, when at is non-nil,
// stamps extracted_at and flips the row to ready. n keeps path/sha256
// unique within a store.
func seedListRow(t *testing.T, s *Store, n int, at *time.Time) int64 {
	t.Helper()
	id, err := s.CreateMatchRow(fmt.Sprintf("/d/pg/%04d.dem", n), fmt.Sprintf("sha-pg-%06d", n), 1024)
	if err != nil {
		t.Fatalf("CreateMatchRow(%d): %v", n, err)
	}
	if at != nil {
		if _, err := s.db.Exec(
			`UPDATE matches SET extracted_at = ?, status = 'ready' WHERE id = ?`, *at, id,
		); err != nil {
			t.Fatalf("stamp extracted_at(%d): %v", n, err)
		}
	}
	return id
}

// walkPage drains every window from afterID, returning each window's row
// count and the concatenated ids in order. It fails the test on a
// runaway loop (a cursor that never advances would spin).
func walkPage(t *testing.T, s *Store, afterID int64, sortKey string, desc bool, limit int, filters ...MatchListFilter) (sizes []int, ids []int64) {
	t.Helper()
	seen := 0
	for {
		page, err := s.ListMatchesPage("", sortKey, desc, afterID, limit, filters...)
		if err != nil {
			t.Fatalf("ListMatchesPage(after=%d): %v", afterID, err)
		}
		sizes = append(sizes, len(page.Rows))
		for _, mm := range page.Rows {
			ids = append(ids, mm.ID)
		}
		if !page.HasNext {
			return sizes, ids
		}
		if len(page.Rows) == 0 {
			t.Fatalf("window after=%d reported HasNext with no rows", afterID)
		}
		afterID = page.Rows[len(page.Rows)-1].ID
		if seen++; seen > 1000 {
			t.Fatalf("paging did not terminate after 1000 windows")
		}
	}
}

// listOrder reads the unbounded ListMatches order — the reference every
// window walk is compared against (same sort, same direction).
func listOrder(t *testing.T, s *Store, sortKey string, desc bool, filters ...MatchListFilter) []int64 {
	t.Helper()
	rows, err := s.ListMatches("", sortKey, desc, filters...)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	ids := make([]int64, 0, len(rows))
	for _, mm := range rows {
		ids = append(ids, mm.ID)
	}
	return ids
}

func sameIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestListMatchesPageKeysetTies seeds 450 rows that share ONE
// extracted_at (the constant-collision case: a batch import lands every
// row on the same second) and pages through them at the default window
// size. The windows must tile the full list exactly — every id once, in
// ListMatches' order, window sizes 200/200/50 — because the cursor's
// tie-break mirrors the ORDER BY's `id DESC`.
func TestListMatchesPageKeysetTies(t *testing.T) {
	s := openMem(t)
	at := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	want := make([]int64, 0, 450)
	for i := range 450 {
		want = append(want, seedListRow(t, s, i, &at))
	}

	sizes, got := walkPage(t, s, 0, "extracted_at", true, 0)
	if len(sizes) != 3 || sizes[0] != 200 || sizes[1] != 200 || sizes[2] != 50 {
		t.Errorf("window sizes = %v, want [200 200 50]", sizes)
	}
	// All rows share one extracted_at, so the reference order is id DESC.
	for i, j := 0, len(want)-1; i < j; i, j = i+1, j-1 {
		want[i], want[j] = want[j], want[i]
	}
	if !sameIDs(got, want) {
		t.Errorf("paged ids = %v…, want ListMatches order %v…", got[:3], want[:3])
	}
	seen := map[int64]int{}
	for _, id := range got {
		seen[id]++
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("id %d appeared %d times across windows", id, n)
		}
	}
	if len(seen) != 450 {
		t.Errorf("paged %d distinct ids, want 450", len(seen))
	}
}

// TestListMatchesPageWindowBoundaries pins the exact boundary: 200 rows
// is ONE window with HasNext false (the limit+1 probe found no row), 201
// rows splits 200/1 with HasNext flipping correctly, and limit 0 selects
// the default window size.
func TestListMatchesPageWindowBoundaries(t *testing.T) {
	s := openMem(t)
	at := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)
	for i := range 200 {
		seedListRow(t, s, i, &at)
	}

	page, err := s.ListMatchesPage("", "extracted_at", true, 0, 0)
	if err != nil {
		t.Fatalf("ListMatchesPage: %v", err)
	}
	if len(page.Rows) != 200 || page.HasNext {
		t.Errorf("200 rows → %d rows, HasNext=%v; want 200, false", len(page.Rows), page.HasNext)
	}

	// The 201st row: the first window now reports a successor.
	seedListRow(t, s, 200, &at)
	full := listOrder(t, s, "extracted_at", true)
	first, err := s.ListMatchesPage("", "extracted_at", true, 0, 200)
	if err != nil {
		t.Fatalf("ListMatchesPage(first): %v", err)
	}
	if len(first.Rows) != 200 || !first.HasNext {
		t.Fatalf("201 rows → first window %d rows, HasNext=%v; want 200, true", len(first.Rows), first.HasNext)
	}
	if !sameIDs(pageIDList(first), full[:200]) {
		t.Errorf("first window = %v…, want the first 200 reference ids", pageIDList(first)[:3])
	}
	cursor := first.Rows[len(first.Rows)-1].ID
	second, err := s.ListMatchesPage("", "extracted_at", true, cursor, 200)
	if err != nil {
		t.Fatalf("ListMatchesPage(second): %v", err)
	}
	if len(second.Rows) != 1 || second.HasNext {
		t.Errorf("201 rows → second window %d rows, HasNext=%v; want 1, false", len(second.Rows), second.HasNext)
	}
	if !sameIDs(pageIDList(second), full[200:]) {
		t.Errorf("second window = %v, want the final reference id %v", pageIDList(second), full[200:])
	}
}

// TestListMatchesPageCursorPositions covers a cursor into the middle of
// the list, a cursor at the very last row (empty window, HasNext false —
// never an error), and a cursor row that no longer exists (ErrNotFound,
// never a silently mis-placed page).
func TestListMatchesPageCursorPositions(t *testing.T) {
	s := openMem(t)
	at := time.Date(2026, 3, 3, 9, 0, 0, 0, time.UTC)
	for i := range 250 {
		seedListRow(t, s, i, &at)
	}
	// One shared extracted_at → the DESC order is insertion-id descending.
	full := listOrder(t, s, "extracted_at", true)

	// Cursor at the 100th row in order → the remaining 150.
	cursor := full[99]
	page, err := s.ListMatchesPage("", "extracted_at", true, cursor, 200)
	if err != nil {
		t.Fatalf("ListMatchesPage(mid): %v", err)
	}
	if len(page.Rows) != 150 || page.HasNext {
		t.Errorf("mid cursor → %d rows, HasNext=%v; want 150, false", len(page.Rows), page.HasNext)
	}
	if !sameIDs(pageIDList(page), full[100:]) {
		t.Errorf("mid cursor rows = %v…, want the 150 ids after the cursor", pageIDList(page)[:3])
	}

	// Cursor at the last row → an empty window, no successor.
	last := full[len(full)-1]
	page, err = s.ListMatchesPage("", "extracted_at", true, last, 200)
	if err != nil {
		t.Fatalf("ListMatchesPage(end): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("end cursor → %d rows, HasNext=%v; want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("empty window rows = nil, want an empty (non-nil) slice for the JSON []")
	}

	// A cursor row that was deleted → ErrNotFound.
	if _, err := s.ListMatchesPage("", "extracted_at", true, 999999, 200); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing cursor err = %v, want store.ErrNotFound", err)
	}
}

// TestListMatchesPageNullExtractedAt: a queued match has no extracted_at
// (SQL NULL), which sorts smallest — last under DESC, first under ASC.
// Both directions must page through NULL rows exactly once; without the
// explicit IS NULL arms a `<`/`>` comparison would hide them forever.
func TestListMatchesPageNullExtractedAt(t *testing.T) {
	s := openMem(t)
	at := time.Date(2026, 3, 4, 9, 0, 0, 0, time.UTC)
	for i := range 15 {
		seedListRow(t, s, i, &at)
	}
	for i := 15; i < 25; i++ {
		seedListRow(t, s, i, nil) // queued, extracted_at NULL
	}

	descSizes, descIDs := walkPage(t, s, 0, "extracted_at", true, 8)
	if len(descSizes) != 4 || descSizes[3] != 1 {
		t.Errorf("DESC window sizes = %v, want [8 8 8 1]", descSizes)
	}
	if !sameIDs(descIDs, listOrder(t, s, "extracted_at", true)) {
		t.Errorf("DESC paging diverged from the full list order")
	}
	// The 10 queued (NULL) rows sort LAST under DESC: the tail of the walk.
	for i, id := range descIDs[15:] {
		var extracted sql.NullTime
		if err := s.db.QueryRow(`SELECT extracted_at FROM matches WHERE id = ?`, id).Scan(&extracted); err != nil {
			t.Fatalf("read extracted_at: %v", err)
		}
		if extracted.Valid {
			t.Errorf("DESC tail row %d (id %d) has an extracted_at — NULL rows must sort last", i, id)
		}
	}

	ascSizes, ascIDs := walkPage(t, s, 0, "extracted_at", false, 8)
	if len(ascIDs) != 25 || len(ascSizes) != 4 {
		t.Errorf("ASC walk = %d ids in %d windows, want 25 in 4", len(ascIDs), len(ascSizes))
	}
	if !sameIDs(ascIDs, listOrder(t, s, "extracted_at", false)) {
		t.Errorf("ASC paging diverged from the full list order")
	}
	// NULL first under ASC: the first 10 rows are the queued ones.
	for i, id := range ascIDs[:10] {
		var v any
		if err := s.db.QueryRow(`SELECT extracted_at FROM matches WHERE id = ?`, id).Scan(&v); err != nil {
			t.Fatalf("read extracted_at: %v", err)
		}
		if v != nil {
			t.Errorf("ASC lead row %d (id %d) is not NULL — queued rows must sort first", i, id)
		}
	}
}

// TestListMatchesPageRosters pins the batched matchup fallback: rows
// whose teams recorded no clan name come back with their human roster
// (the team_<player> synthesis input), rows with real clan names come
// back WITHOUT an entry, empty rosters (a never-extracted row) are absent
// too, and bots are filtered by the canonical Go rule (HumanOnly).
func TestListMatchesPageRosters(t *testing.T) {
	s := openMem(t)
	tA := time.Date(2026, 3, 5, 10, 0, 0, 0, time.UTC)
	tB := time.Date(2026, 3, 5, 11, 0, 0, 0, time.UTC)

	// A: a complete extract — teams alpha/beta recorded, so NO roster entry.
	idA := saveTestMatch(t, s, "/d/pg/with-names.dem", "sha-pg-names", tA)

	// B: the extract recorded no team clan names (Teams empty) but has a
	// roster — including a BOT, which must not reach the synthesis input.
	em := testExtracted("sha-pg-nonames", tB)
	em.Teams = nil
	em.Players = append(em.Players, models.Player{
		SteamID: "900", Name: "Crew", IsBot: true, Side: "ct", FinalStatePresent: true,
	})
	idB, err := s.CreateMatchRow("/d/pg/nonames.dem", "sha-pg-nonames", 2048)
	if err != nil {
		t.Fatalf("CreateMatchRow(B): %v", err)
	}
	if err := s.SaveExtracted(idB, em); err != nil {
		t.Fatalf("SaveExtracted(B): %v", err)
	}

	// C: never extracted — no teams, no roster.
	idC := seedListRow(t, s, 90, nil)

	page, err := s.ListMatchesPage("", "extracted_at", true, 0, 10)
	if err != nil {
		t.Fatalf("ListMatchesPage: %v", err)
	}
	if got, want := pageIDList(page), []int64{idB, idA, idC}; !sameIDs(got, want) {
		t.Fatalf("window ids = %v, want %v (newest first, NULL last)", got, want)
	}
	if _, ok := page.Rosters[idA]; ok {
		t.Errorf("row with recorded team names carries a roster entry (%+v)", page.Rosters[idA])
	}
	if _, ok := page.Rosters[idC]; ok {
		t.Errorf("never-extracted row carries a roster entry (%+v)", page.Rosters[idC])
	}
	refs := page.Rosters[idB]
	if len(refs) != 2 {
		t.Fatalf("roster for the nameless row = %+v, want the 2 human players (bot dropped)", refs)
	}
	byID := map[string]models.PlayerRef{}
	for _, r := range refs {
		byID[r.SteamID] = r
	}
	if r := byID["100"]; r.Name != "alice" || r.Side != "ct" || r.IsBot {
		t.Errorf("ref 100 = %+v, want alice/ct/human (NUL bytes scrubbed on write)", r)
	}
	if r := byID["200"]; r.Name != "bob" || r.Side != "t" {
		t.Errorf("ref 200 = %+v, want bob/t", r)
	}
	if _, ok := byID["900"]; ok {
		t.Error("bot ref reached the roster — HumanOnly must filter it")
	}
}

// TestListMatchesPageOtherSortKeyAndFilter: the keyset is generic over
// the sort whitelist (the Library's headers keep working past the first
// window), ties on a TEXT sort key are broken by id DESC like the ORDER
// BY, and the structured filter rides the paged read unchanged.
func TestListMatchesPageOtherSortKeyAndFilter(t *testing.T) {
	s := openMem(t)
	for i := range 6 {
		id := seedListRow(t, s, i, nil)
		if _, err := s.db.Exec(`UPDATE matches SET map = 'de_mirage' WHERE id = ?`, id); err != nil {
			t.Fatalf("set map: %v", err)
		}
	}
	for i := 6; i < 9; i++ {
		id := seedListRow(t, s, i, nil)
		if _, err := s.db.Exec(`UPDATE matches SET map = 'de_nuke' WHERE id = ?`, id); err != nil {
			t.Fatalf("set map: %v", err)
		}
	}

	f := MatchListFilter{Map: "mirage"}
	sizes, got := walkPage(t, s, 0, "map", true, 4, f)
	if len(sizes) != 2 || sizes[0] != 4 || sizes[1] != 2 {
		t.Errorf("filtered map windows = %v, want [4 2]", sizes)
	}
	if !sameIDs(got, listOrder(t, s, "map", true, f)) {
		t.Errorf("paged ids %v diverged from the filtered reference order", got)
	}
	for _, id := range got {
		var m string
		if err := s.db.QueryRow(`SELECT map FROM matches WHERE id = ?`, id).Scan(&m); err != nil {
			t.Fatalf("read map: %v", err)
		}
		if m != "de_mirage" {
			t.Errorf("row %d map = %q — the nuke rows must be filtered out", id, m)
		}
	}
}

// TestListMatchesPageBehindFacet pages the BEHIND set: the window walk
// over {Behind: true} tiles exactly ListMatches' behind order (the SAME
// matchListWhere predicate + keyset), skips the current-stamp row and the
// non-ready row, and CountMatches labels the walk's total — the k/N the
// re-run button shows must equal what the page windows actually serve.
func TestListMatchesPageBehindFacet(t *testing.T) {
	s := openMem(t)
	at := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	// Five ready rows sharing one extracted_at (the tie case), plus a
	// queued row that is never behind (not re-runnable).
	ids := make([]int64, 0, 5)
	for i := range 5 {
		ids = append(ids, seedListRow(t, s, i, &at))
	}
	queued := seedListRow(t, s, 90, nil)

	// Live rules at v1: rows 1..4 start at stamp 0 (behind). Make row 1
	// current and row 3 non-ready → the behind set is rows 4, 2, 0.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: 1000, RuleVersion: 1,
	}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if err := s.SetMatchRuleVersion(ids[1], 1); err != nil {
		t.Fatalf("stamp current: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE matches SET status = 'failed' WHERE id = ?`, ids[3]); err != nil {
		t.Fatalf("flip failed: %v", err)
	}
	want := []int64{ids[4], ids[2], ids[0]} // extracted_at DESC → id DESC tie-break

	f := MatchListFilter{Behind: true}
	sizes, got := walkPage(t, s, 0, "extracted_at", true, 2, f)
	if len(sizes) != 2 || sizes[0] != 2 || sizes[1] != 1 {
		t.Errorf("behind windows = %v, want [2 1]", sizes)
	}
	if !sameIDs(got, want) {
		t.Errorf("paged behind ids %v, want %v", got, want)
	}
	if !sameIDs(got, listOrder(t, s, "extracted_at", true, f)) {
		t.Errorf("paged ids %v diverged from the unbounded reference order", got)
	}
	if n, err := s.CountMatches("", f); err != nil || n != 3 {
		t.Errorf("CountMatches(behind) = %d, %v; want 3 (the walk's total)", n, err)
	}
	// The excluded rows really are excluded: current (1) and failed (3)
	// never appear, and the queued row is invisible to both lists.
	for _, id := range []int64{ids[1], ids[3], queued} {
		for _, paged := range got {
			if paged == id {
				t.Errorf("row %d must not be in the behind walk %v", id, got)
			}
		}
	}
	if n, err := s.CountMatches(""); err != nil || n != 6 {
		t.Errorf("unfiltered count = %d, %v; want 6", n, err)
	}
}

// TestListMatchesScoreSortKeys: the split score sort — winner_score is
// MAX(score_ct, score_t), loser_score is MIN(...) — gives each Library
// score column its own axis. The fixture covers the shapes each axis
// must order: a decisive win (13-1), a close loss (12-16), a draw
// (12-12), equal-W-different-L rows (13-1 / 13-9 / 13-9 / 4-13 — all
// W13) and an exact full tie (the two 13-9 rows), plus a never-extracted
// 0-0 row. winner desc lists decisive finishes first (equal W ties break
// by id DESC like every other key); loser asc lists stomps first (a low
// loser score either way); the
// keyset windows tile BOTH orders exactly — no row skipped or duplicated
// across a tie — and the retired composite "score" key (the scoreline
// SUM, total rounds) is off the whitelist: it falls back to the default
// extracted_at like any unknown key.
func TestListMatchesScoreSortKeys(t *testing.T) {
	s := openMem(t)
	// Seed bare rows and stamp the scoreline straight onto them — no
	// extract needed for an order-by pin. ids ascend in seed order.
	seed := func(n, ct, tr int) int64 {
		t.Helper()
		id := seedListRow(t, s, n, nil)
		if _, err := s.db.Exec(
			`UPDATE matches SET score_ct = ?, score_t = ? WHERE id = ?`, ct, tr, id,
		); err != nil {
			t.Fatalf("set score(%d): %v", n, err)
		}
		return id
	}
	decisive := seed(0, 13, 1)         // W13 L1 — a stomp, won
	closeLoss := seed(1, 12, 16)       // W16 L12 — lost close
	draw := seed(2, 12, 12)            // W12 L12 — both columns the same
	tieA := seed(3, 13, 9)             // W13 L9
	tieB := seed(4, 13, 9)             // exact tie with tieA
	bigWin := seed(5, 4, 13)           // W13 L4 — same W, lowest L
	never := seedListRow(t, s, 6, nil) // never extracted: 0-0 → W0 L0

	// winner desc: 16 first, then the four W13 rows in id DESC (their L
	// differs but the W key ties them), then the draw, then the 0-0 row.
	wantWinner := []int64{closeLoss, bigWin, tieB, tieA, decisive, draw, never}
	if got := listOrder(t, s, "winner_score", true); !sameIDs(got, wantWinner) {
		t.Errorf("winner_score desc = %v, want %v", got, wantWinner)
	}
	// loser asc: the never-extracted 0-0 row first (its L is honestly 0,
	// like every other zero-default sort), then 1, 4, the L9 tie (id
	// DESC), then the L12 pair (close loss after the draw, id DESC).
	wantLoser := []int64{never, decisive, bigWin, tieB, tieA, draw, closeLoss}
	if got := listOrder(t, s, "loser_score", false); !sameIDs(got, wantLoser) {
		t.Errorf("loser_score asc = %v, want %v", got, wantLoser)
	}

	// The keyset tiles both orders across the ties: windows of 3 must
	// equal the reference list order exactly (cursor = stored MAX/MIN
	// value + id DESC tie-break, like every other whitelisted key).
	for _, c := range []struct {
		name  string
		key   string
		desc  bool
		sizes []int
	}{
		{"winner desc windows", "winner_score", true, []int{3, 3, 1}},
		{"loser asc windows", "loser_score", false, []int{3, 3, 1}},
	} {
		sizes, got := walkPage(t, s, 0, c.key, c.desc, 3)
		if len(sizes) != len(c.sizes) {
			t.Errorf("%s window sizes = %v, want %v", c.name, sizes, c.sizes)
			continue
		}
		for i := range sizes {
			if sizes[i] != c.sizes[i] {
				t.Errorf("%s window sizes = %v, want %v", c.name, sizes, c.sizes)
				break
			}
		}
		if !sameIDs(got, listOrder(t, s, c.key, c.desc)) {
			t.Errorf("%s paged ids %v diverged from the reference order", c.name, got)
		}
		seen := map[int64]int{}
		for _, id := range got {
			seen[id]++
		}
		for id, n := range seen {
			if n != 1 {
				t.Errorf("%s: id %d appeared %d times across windows", c.name, id, n)
			}
		}
	}

	// The retired composite key: "score" is no longer whitelisted, so it
	// behaves like any unknown key — the extracted_at default (all rows
	// NULL here → id DESC), NOT either score axis.
	fallback, err := s.ListMatches("", "score", true)
	if err != nil {
		t.Fatalf("ListMatches(score): %v", err)
	}
	def, err := s.ListMatches("", "extracted_at", true)
	if err != nil {
		t.Fatalf("ListMatches(extracted_at): %v", err)
	}
	var gotIDs, defIDs []int64
	for i := range fallback {
		gotIDs = append(gotIDs, fallback[i].ID)
	}
	for i := range def {
		defIDs = append(defIDs, def[i].ID)
	}
	if !sameIDs(gotIDs, defIDs) {
		t.Errorf("retired score key order = %v, want the extracted_at fallback %v", gotIDs, defIDs)
	}
	if sameIDs(gotIDs, wantWinner) {
		t.Errorf("retired score key still orders by a score axis: %v", gotIDs)
	}
}

// pageIDList is the window's ids in row order.
func pageIDList(p *models.MatchListPage) []int64 {
	ids := make([]int64, 0, len(p.Rows))
	for _, mm := range p.Rows {
		ids = append(ids, mm.ID)
	}
	return ids
}
