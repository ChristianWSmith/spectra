-- Buy-threshold defaults corrected to TEAM equipment scale: the seeded
-- 4000/2000 were per-player magnitudes, so any round with a team equip of
-- $4k+ classified as a full buy. Rows still at the seeded old defaults move
-- to the corrected defaults and bump rule_version exactly like "Save rules"
-- does (stored rows keep the version they were computed with — recompute
-- applies the new rules).

UPDATE analysis_config
   SET eco_full_buy = 20000, eco_force = 10000, rule_version = rule_version + 1
 WHERE eco_full_buy = 4000 AND eco_force = 2000;
