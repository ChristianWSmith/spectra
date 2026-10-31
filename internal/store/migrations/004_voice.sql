-- Milestone 4 (communications): voice chunk index + presence, encrypted-
-- chat provenance columns. Every voice table FKs to matches(id) ON DELETE
-- CASCADE so delete/reprocess stay one-pass (they join childTables).
--
-- Deviation from plan §3, deliberate: there is NO voice_players table and NO
-- chunks.idx sidecar file — players are a read-time GROUP BY over
-- voice_chunks and the DB rows below are the whole chunk index.

-- Match header mirror: svc_EncryptedData count seen during the parse.
ALTER TABLE matches ADD COLUMN enc_messages INTEGER NOT NULL DEFAULT 0;

-- Chat decryption provenance (M4). v1 always writes decrypted=0 — the
-- extractor cannot distinguish demoinfocs-decrypted rows from plaintext
-- ones (decryption dispatches inner messages as ordinary chat events);
-- presence.key_found + matches.enc_messages carry the honest state.
ALTER TABLE chat ADD COLUMN decrypted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat ADD COLUMN key_source TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS voice_presence (
	match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
	chunk_count INTEGER NOT NULL DEFAULT 0,
	player_count INTEGER NOT NULL DEFAULT 0,
	caster_count INTEGER NOT NULL DEFAULT 0,
	key_found INTEGER NOT NULL DEFAULT 0,
	out_sample_rate INTEGER NOT NULL DEFAULT 16000
);

CREATE TABLE IF NOT EXISTS voice_chunks (
	match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	tick INTEGER NOT NULL DEFAULT 0,
	round INTEGER NOT NULL DEFAULT 0,
	byte_off INTEGER NOT NULL DEFAULT 0,
	len INTEGER NOT NULL DEFAULT 0,
	caster INTEGER NOT NULL DEFAULT 0,
	section INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_voice_chunks_player_tick ON voice_chunks(match_id, steam_id, tick);
CREATE INDEX IF NOT EXISTS idx_voice_chunks_match_tick ON voice_chunks(match_id, tick);
