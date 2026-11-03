// Landmark/event-kind vocabulary for the replay surfaces — the one place
// three consumers used to each hold their own copy:
//   - FilterBar's Kind <select> (Timeline) → LANDMARK_KINDS, its
//     hardcoded list that mirrors Go's models.EventKind
//     (internal/models/models.go — keep in sync).
//   - renderer.setLandmarks' bucketing (grenade throw/detonation, smoke,
//     fire, bomb plant/explode/defuse) → classifyLandmark.
//   - Replay's scrubber marker classes (kill / plant / det) →
//     classifyLandmark.
// Unit-tested by src/lib/landmarks.test.js (the lib test glob is
// src/lib/*.test.js, so the fixture lives one level up).

// The authoritative kind list: every events.kind value the timeline can
// filter on (mirror of models.EventKind — Go side).
export const LANDMARK_KINDS = [
  'kill',
  'damage',
  'blind',
  'bomb_plant',
  'bomb_defuse',
  'bomb_explode',
  'bomb_drop',
  'bomb_pickup',
  'grenade_throw',
  'grenade',
  'round_start',
  'round_end',
  'player_connect',
  'player_disconnect',
];

// classifyLandmark normalizes a kind string into the bucket the replay
// surfaces draw from. Case-insensitive; unknown/empty kinds return ''
// (each consumer decides what "unclassified" means for it — the
// renderer skips it, the scrubber skips it). The substring branches
// (smoke/fire/molotov) predate this module and stay: they bucket
// extended kind spellings the same way.
export function classifyLandmark(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'kill') return 'kill';
  if (k === 'grenade_throw') return 'throw';
  if (k === 'grenade') return 'detonation';
  if (k.includes('smoke')) return 'smoke';
  if (k.includes('fire') || k.includes('molotov')) return 'fire';
  if (k === 'bomb_plant') return 'plant';
  if (k === 'bomb_explode') return 'explode';
  if (k === 'bomb_defuse') return 'defuse';
  return '';
}
