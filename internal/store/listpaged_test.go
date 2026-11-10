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

// pageIDList is the window's ids in row order.
func pageIDList(p *models.MatchListPage) []int64 {
	ids := make([]int64, 0, len(p.Rows))
	for _, mm := range p.Rows {
		ids = append(ids, mm.ID)
	}
	return ids
}
