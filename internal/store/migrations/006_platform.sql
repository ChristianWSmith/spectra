-- Milestone 5 (advanced platform): declarative plugin registry (plan M5
-- §2.7 v1). One row per installed plugin; invalid/missing bundles keep
-- their row with error set (ListPlugins never silently drops).
--
-- Plugin metrics live in the `metrics` table (created by 005_metrics.sql
-- with origin='plugin', plugin_id=<this id>) — this migration only owns
-- the registry. enable=1 ⇔ the plugin's metric rows are present.

CREATE TABLE IF NOT EXISTS plugins (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	version TEXT NOT NULL DEFAULT '',
	path TEXT NOT NULL DEFAULT '',
	hash TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1,
	error TEXT NOT NULL DEFAULT '',
	installed_at DATETIME
);
