-- Milestone 2 (tactical replay): position sidecar mirror columns on matches
-- and per-event world positions (NULL when the source event had none).

ALTER TABLE matches ADD COLUMN position_format INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN position_frames INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN pos_x REAL;
ALTER TABLE events ADD COLUMN pos_y REAL;
ALTER TABLE events ADD COLUMN pos_z REAL;
