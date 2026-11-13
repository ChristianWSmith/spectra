package library

import "sync"

// shaGate hands out ONE lock per content hash. With concurrent workers
// two import jobs can hash identical bytes from different paths, and an
// import can race a reprocess's re-copy of the same content; the
// pipeline's sha-critical section (dedupe check → copy-on-import →
// CreateMatchRow, or the reprocess re-copy — see Importer.process) must
// run one job at a time per sha. The loser waits, then sees the winner's
// match row and takes the clean "already imported (match N)" path instead
// of racing the UNIQUE matches.sha256 insert (a raw constraint error in
// the jobs list) or the managed-copy rename.
//
// Entries are reference-counted: refs counts every holder AND waiter for
// a sha, and the last one out deletes the map entry — so the map never
// grows past the hashes currently in flight.
type shaGate struct {
	mu      sync.Mutex
	entries map[string]*shaEntry
}

// shaEntry is one hash's gate: refs is guarded by the map mutex (shaGate.mu),
// mu serializes the critical sections themselves.
type shaEntry struct {
	mu   sync.Mutex
	refs int
}

func newSHAGate() *shaGate {
	return &shaGate{entries: map[string]*shaEntry{}}
}

// lock acquires sha's gate and returns the release func (idempotence is
// the caller's concern — call the returned func exactly once). refs is
// bumped under the map lock BEFORE waiting on the entry, so a releaser
// can never delete an entry a waiter is still queued on.
func (g *shaGate) lock(sha string) (release func()) {
	g.mu.Lock()
	e, ok := g.entries[sha]
	if !ok {
		e = &shaEntry{}
		g.entries[sha] = e
	}
	e.refs++
	g.mu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		g.mu.Lock()
		e.refs--
		if e.refs == 0 {
			delete(g.entries, sha)
		}
		g.mu.Unlock()
	}
}
