// Heatmap kind registry (frontend twin of Go's heatmap.go —
// grenadeHeatmapKinds — plus the core kinds AnalyticsService.GetHeatmap
// accepts): THE one list the Heatmaps kind selector renders, the one
// label spelling, and the one region-drill filter projection
// (heatRegionCats / heatRegionTakesBBox / heatRegionFilter). Unit
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
// existing kills+damage pairing, and the core position kinds project
// onto KILLS — the bbox drill must arrive with POSITION-BEARING rows,
// never the sparse default ['round_starts'] (round-start rows store no
// position, so a bbox on top of it excluded EVERYTHING: the guaranteed-
// empty arrival this table was fixed for). DEATHS projects onto the
// DEATHS category (the enabled-claim stamping flip): a death IS a kill
// row, but with Deaths claiming that kind the drill must arrive with
// cats=['deaths'] so the feed's kill rows PRESENT as deaths
// (landmarks.rowCategory) and killRoleFor derives the victim player
// role from the same category ids; the store's either-endpoint bbox
// (internal/store/queries.go) matches their victim positions either way.
// kd spans both views but keeps the kills projection (owner ruling).
// presence has NO event counterpart at all (a sampled position grid): no
// category, and heatRegionTakesBBox keeps its bbox out of the arrival as
// well.
export function heatRegionCats(kind) {
  if (kind.endsWith('_thrown')) return ['grenade_throws'];
  if (kind.endsWith('_det')) return ['grenade_dets'];
  if (kind === 'damage') return ['kills', 'damage'];
  if (kind === 'deaths') return ['deaths']; // the enabled-claim flip (rowCategory)
  if (kind === 'kills' || kind === 'kd') return ['kills'];
  return undefined; // presence (and any unknown id — never invented)
}

// heatRegionTakesBBox — whether this kind's region drill may carry its
// cell bbox at all. Every kind whose raster is splatted FROM event rows
// does; presence is the exception: its raster is a sampled position grid
// with no events behind it, so a bbox would guarantee an empty arrival —
// a presence region click arrives at the replay WITHOUT one (the
// mirrored settings below still ride along). Unknown ids take the bbox
// (the selector only offers HEAT_KINDS; a bbox is the region drill's
// whole point for anything with events behind it).
export function heatRegionTakesBBox(kind) {
  return kind !== 'presence';
}

// heatRegionFilter — THE heatmap-settings → landmark-filter projection:
// what the Heatmaps view's OWN selectors become in a region drill's
// arrival filter (lib/heatkinds.js is the canonical home — it already
// owns the heat→category mapping). Pure, no DOM — unit-tested by
// heatkinds.test.js.
//
//   kind      → cats via heatRegionCats (the fixed table above); no
//               projection = no cats key (the arrival keeps the feed's
//               sparse default categories).
//   settings  → { player, roundFrom, roundTo }:
//                 player    — the heatmap's player selector; '' (All
//                             players) → omitted.
//                 roundFrom/roundTo — the heatmap's `<0 = all` sentinel
//                             (-1) and the filter's `0 = open` bound
//                             (landmarks.DEFAULT_FILTER) both OMIT the
//                             key; a POSITIVE round number passes
//                             through (the selector only offers COUNTED
//                             rounds ≥ 1, so a knife/warmup number never
//                             occurs and a negative is the sentinel).
//
// Omitted keys serialize to nothing (serializeLandmarkFilter's
// default rule), so a drill with no settings set is a plain arrival and
// still non-default whenever ANY key lands — shouldRevealFeed picks the
// feed reveal up through that same serialization.
//
// NOT included: the heatmap's TEAM selector — the landmark filter has no
// side/team key yet (separate queued task), so a drill mirrors only what
// a key exists for rather than inventing one.
export function heatRegionFilter(kind, settings = {}) {
  const f = {};
  const cats = heatRegionCats(kind);
  if (cats) f.cats = cats;
  const player = settings.player == null ? '' : String(settings.player);
  if (player) f.steamId = player;
  for (const key of ['roundFrom', 'roundTo']) {
    const n = Number(settings[key]);
    // Non-finite or the heatmap's "<0 = all" sentinel → omitted; 0 is the
    // filter's own open bound → omitted too (it would serialize away).
    if (Number.isFinite(n) && n > 0) f[key] = n;
  }
  return f;
}
