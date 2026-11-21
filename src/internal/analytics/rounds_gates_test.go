package analytics

// PlayerRounds stat-gate rulings (lead 2026-11-17, owner's
// reconnect-takeover report): no self-kill is ever kill credit, a
// disconnect-time World self-kill is not a death, and bots carry no
// per-round rows. Seeded []models.Event only — the repro demo is never a
// test dependency.
