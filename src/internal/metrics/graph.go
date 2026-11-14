package metrics

// The save-time dependency graph (design §2 cycle rejection). The walk
// is PURE — no DB, no store types — so the cycle rule is unit-testable
// on plain maps; the service only LOADS the edges (metric_deps joined to
// metrics by name) and calls this before any write.

// FindCycle walks the metric graph from `from` over edges (name → the
// names its current expression references) and returns the cycle as a
// path that starts and ends at the same name:
//
//	[a, a]      a references itself
//	[a, b, a]   a → b → a
//
// nil when no cycle is reachable from `from`. Only the reachable
// component matters: the save check asks "would SAVING this metric
// introduce a cycle", so an unrelated pre-existing cycle elsewhere (the
// pass turns hand-edited ones into failed metrics) is not this walk's
// business.
//
// `edges` is the graph AS IT WILL BE after the save: the caller unions
// the existing metric_deps edges with the saved metric's new refs
// (replacing that metric's own old out-edges — no edge may point at a
// superseded expression) and applies the rename's label substitution
// first, because the dependents' exprs are rewritten in the same tx.
func FindCycle(from string, edges map[string][]string) []string {
	onPath := map[string]bool{}
	done := map[string]bool{}
	path := make([]string, 0, 16)

	var visit func(n string) []string
	visit = func(n string) []string {
		if onPath[n] {
			// Found the closing edge: report the loop, not the prefix
			// that led into it.
			start := 0
			for i, m := range path {
				if m == n {
					start = i
					break
				}
			}
			cycle := make([]string, 0, len(path)-start+1)
			cycle = append(cycle, path[start:]...)
			return append(cycle, n)
		}
		if done[n] {
			return nil // already fully explored: no cycle through n
		}
		onPath[n] = true
		path = append(path, n)
		for _, dep := range edges[n] {
			if cycle := visit(dep); cycle != nil {
				return cycle
			}
		}
		path = path[:len(path)-1]
		onPath[n] = false
		done[n] = true
		return nil
	}
	return visit(from)
}
