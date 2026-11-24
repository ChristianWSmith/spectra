package store

// The per-match rollup is the output contract of a match-grain metric: one row
// per subject (subject_key, dim = ”, value), read from an inner query that
// names its subject column grp and its match column mid, then restricted to
// the bound match. These two fragments hold that contract once. The inner
// query between them (its aggregate and FROM) is the metric's own.
const (
	rollupOpenSQL  = "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT "
	rollupCloseSQL = "GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id"
	// rollupMatchOpenSQL opens a match-grain rollup whose subject is the match
	// itself (subject_key ''), closed by rollupCloseSQL like the others.
	rollupMatchOpenSQL = "SELECT '' AS subject_key, '' AS dim, v AS value FROM (SELECT "
)

// Placeholders for the two fragments inside a schema.sql metric expr.
const (
	rollupOpenPlaceholder      = "{{ROLLUP_OPEN}}"
	rollupClosePlaceholder     = "{{ROLLUP_CLOSE}}"
	rollupMatchOpenPlaceholder = "{{ROLLUP_MATCH_OPEN}}"
)
