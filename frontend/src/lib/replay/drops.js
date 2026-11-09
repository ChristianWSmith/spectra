// Canonical dropped-gun / dropped-utility evidence module — THE one
// place the replay-time ground-item reconstruction lives for
// weapon_drop / weapon_pickup rows (the map's optional drop layer).
//
//   dropEvidenceAt(ev, tick) — THE drop reconstruction rule, the
//     structural sibling of bomb.js bombEvidenceAt (the DROPPED-C4
//     reconstruction) but its OWN module: bomb.js is the C4
//     lifecycle's home, this one is the death-drop layer's.
//
// Rule, over an evidence bundle of pre-bucketed landmark rows
// { drops, pickups, roundEnds } (landmarks.js normalizeEvent output —
// kind / round / tick / weapon plus x/y/z aliased from the stored
// posX/posY/posZ):
//
//   For tick T, with d = the LAST weapon_drop at/before T:
//     1. no d → null (nothing dropped yet at T);
//     2. d's round ended at/before T → null — the round-end cleanup
//        parity with killEndTick / bombEvidenceAt: a previous round's
//        drop must never anchor the current frame;
//     3. a weapon_pickup of the SAME weapon name in the SAME round with
//        d.tick < pickup ≤ T → null (somebody took it off the ground);
//     4. d carries a stored position → visible AT that position
//        ({state: 'dropped'}); no position → null (draw nothing, never
//        extrapolate).
//
// Duplicate-name matching is deliberately BEST-EVIDENCE, one rule: the
// query answers for the LATEST drop at/before T, and any later same-name
// pickup in that round (up to T) hides it. The RENDERER queries ONE row
// at a time — every dropped item on the map is its own marker (unlike
// the single C4), so it passes each weapon_drop as the bundle's only
// drops entry (see drawDrops): the selection then reads "this row at/before
// T", each live drop draws at its stored position, and a same-name pickup
// hides exactly the drops it postdates (two same-name drops both before
// one pickup may both hide — best-effort: the game's item_pickup carries
// no provenance for which ground gun was taken, and buy-restock rows look
// identical — CS2.md "item_pickup"). The whole-bundle form stays the
// single-answer contract for any caller holding many rows: no position
// guessing, no cross-round matching.
//
// The position on a drop row is the VICTIM's position at the kill tick
// (extract stores it exactly like bomb_drop stores the C4 carrier's
// position at release — the item's physics slide is unrecorded, same
// accepted semantics; CS2.md "bomb_dropped"). A pickup TERMINATES
// visibility rather than back-propagating its own position: once the
// item is carried, its world marker is gone (the carrier's dot is not
// a dropped item).
//
// The gun|util split (drawDrops' layer gate) is the STORED
// detail_json.cat the view joins onto rows by seq (getDropDetails —
// never re-derived here; models.IsUtilityWeapon owns that rule) and
// the dropped gun's mag/reserve ammo rides the same join
// (row.dropAmmo). Pure, seek-safe — unit-tested by src/lib/drops.test.js.

// hasDropPos reports whether a row carries a usable world position
// (normalizeEvent aliases posX/posY → x/y; missing evidence stays
// null — the zero-vector convention of extract's posPtrs). Same rule
// as bomb.js hasBombPos, scoped-named here so the C4 module stays the
// C4 lifecycle's only content.
export function hasDropPos(row) {
  return !!row && Number.isFinite(row.x) && Number.isFinite(row.y);
}

// dropEvidenceAt — THE drop reconstruction rule (see the module header).
// Returns { state: 'dropped', row, x, y, z } while the item sits on the
// ground, null once picked up / the round ended / no evidence — a pure
// function of (evidence, tick), so a scrub re-derives everything.
export function dropEvidenceAt(ev, tick) {
  const e = ev || {};
  let d = null;
  for (const row of e.drops || []) {
    if (row && Number.isFinite(row.tick) && row.tick <= tick && (!d || row.tick > d.tick)) {
      d = row;
    }
  }
  if (!d) return null; // nothing dropped at/before T

  // Round scoping: out of scope once that round's round_end reached T.
  let end = null;
  for (const r of e.roundEnds || []) {
    if (r && r.round === d.round && r.tick >= d.tick && (!end || r.tick < end.tick)) {
      end = r;
    }
  }
  if (end && tick >= end.tick) return null;

  // Pickup termination: a same-name pickup in the drop's round after
  // the drop and at/before T means the item is carried — not ground.
  for (const p of e.pickups || []) {
    if (!p || !Number.isFinite(p.tick)) continue;
    if (p.round !== d.round || p.weapon !== d.weapon) continue;
    if (p.tick <= d.tick || p.tick > tick) continue;
    return null;
  }

  if (!hasDropPos(d)) return null;
  return { state: 'dropped', row: d, x: d.x, y: d.y, z: d.z ?? null };
}
