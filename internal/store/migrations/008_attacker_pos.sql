-- Attacker world position on typed events (kill events): the kills heatmap
-- plots where the KILLER was, while pos_x/pos_y/pos_z keep the victim/hit
-- position the source event exposes. NULL when the source had no position
-- (world kills, legacy imports).

ALTER TABLE events ADD COLUMN apos_x REAL;
ALTER TABLE events ADD COLUMN apos_y REAL;
ALTER TABLE events ADD COLUMN apos_z REAL;
