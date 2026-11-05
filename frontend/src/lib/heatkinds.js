// Heatmap kind registry (frontend twin of Go's heatmap.go —
// grenadeHeatmapKinds — plus the core kinds AnalyticsService.GetHeatmap
// accepts): THE one list the Heatmaps kind selector renders, the one
// label spelling, and the one region-drill category projection. Unit
// tested by heatkinds.test.js, which pins the grenade ids to the Go
// registry so the two lists can never drift.
//
// Grenade ids are "<util>_<flavor>":
//   *_thrown → where the grenade was thrown (events.grenade_throw pos_*)
//   *_det    → where it detonated     (events.grenade pos_*)
// The util half is the stored utility kind (models.UtilityWeaponKind):
// "molotov" covers Molotov AND Incendiary Grenade — one type, one pair of
// heatmaps — and "decoy" is the fifth stored kind.

// Core kinds: the kd id is the signed combine (its own Go entry point,
// GetHeatmapKD); everything else shares GetHeatmap.
export const HEAT_CORE_KINDS = ['presence', 'kills', 'deaths', 'damage', 'kd'];

export const HEAT_GRENADE_TYPES = ['he', 'flash', 'smoke', 'molotov', 'decoy'];
export const HEAT_GRENADE_THROW_KINDS = HEAT_GRENADE_TYPES.map((t) => `${t}_thrown`);
export const HEAT_GRENADE_DET_KINDS = HEAT_GRENADE_TYPES.map((t) => `${t}_det`);

export const HEAT_KINDS = [
  ...HEAT_CORE_KINDS,
  ...HEAT_GRENADE_THROW_KINDS,
  ...HEAT_GRENADE_DET_KINDS,
];

// Display names for the grenade types — "molotov" says both spellings
// because the type IS both (Molotov ≡ Incendiary).
const TYPE_LABELS = {
  he: 'HE',
  flash: 'Flash',
  smoke: 'Smoke',
  molotov: 'Molotov/Incendiary',
  decoy: 'Decoy',
};

// heatKindLabel — selector text for a raw kind id: "kd" reads "K/D",
// grenade ids read "<Type> thrown" / "<Type> detonation", anything else
// reads as-is (presence/kills/deaths/damage already read as their ids).
export function heatKindLabel(kind) {
  if (kind === 'kd') return 'K/D';
  const i = kind.lastIndexOf('_');
  if (i > 0) {
    const type = TYPE_LABELS[kind.slice(0, i)];
    const flavor = kind.slice(i + 1);
    if (type && (flavor === 'thrown' || flavor === 'det')) {
      return `${type} ${flavor === 'thrown' ? 'thrown' : 'detonation'}`;
    }
  }
  return kind;
}

// heatRegionCats — landmark categories (lib/replay/landmarks.js
// CATEGORIES ids) a map-region drill of this kind opens: a grenade
// throw/detonation region shows that flavour's events, damage keeps the
// existing kills+damage pairing, and the rest narrow nothing (presence
// has no event category; kd spans kills AND deaths, so it narrows
// neither).
export function heatRegionCats(kind) {
  if (kind.endsWith('_thrown')) return ['grenade_throws'];
  if (kind.endsWith('_det')) return ['grenade_dets'];
  if (kind === 'damage') return ['kills', 'damage'];
  return undefined;
}
