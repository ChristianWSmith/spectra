// Canonical economy math for the Economy view: the two per-team series
// the chart plots (EconCurve), the two columns its hover tooltip shows,
// and the loss-bonus pip count the buy-types table's Loss cells render
// (lossPips). One spelling of the formulas, unit-tested in econ.test.js —
// views must not re-derive them.
//
//   equipment value — the game's freeze-time-end value of the gear the
//     side actually holds (EconomyRow.EquipCT/EquipT, sampled with the
//     money below in the same freeze-end handler, so both always refer to
//     the same instant of the same round).
//   net worth        — equipment value + that side's unspent money at
//     that same freeze end (EconomyRow.MoneyCT/MoneyT, the sampled
//     money_sampled_sum): the total value the team holds, gear plus the
//     cash it can still spend.
//
// Because unspent money is never negative, net worth can never fall
// below equipment value. (An earlier version also subtracted the free
// spawn-issued default pistols held — round_economy.free_pistol_value —
// which made net worth dip BELOW equipment value whenever a side's cash
// was smaller than the value of those granted pistols; pinned here so it
// cannot come back. See CS2.md "Free spawn-issued default pistol".)

// columns returns both series values for one economy row and one side.
// A missing or non-numeric sample reads 0 (the COALESCE/`|| 0` path the
// Go side exposes for a round with no round_economy row).
// bySide picks a side's value from a pair: ct for the CT side, t for the T side.
export function bySide(side, ct, t) {
  return side === 'ct' ? ct : t;
}

export function econColumns(r, key) {
  const equip = Number(key === 'ct' ? r.equipCT : r.equipT) || 0;
  const cash = Number(key === 'ct' ? r.moneyCT : r.moneyT) || 0;
  return { equip, net: equip + cash };
}

// econValue is the chart's plotted value for a row/side under the active
// metric ('equip' | 'networth'); anything other than 'equip' reads net
// worth, the chart's only other metric.
export function econValue(r, key, metric) {
  const c = econColumns(r, key);
  return metric === 'equip' ? c.equip : c.net;
}

// lossPips — THE loss-bonus pip count for one side's stored bonus value
// (the Economy table's Loss CT/T cells render it as a five-slot stack —
// never re-derived at a call site). The store reconstructs the value
// from round results (store.GetEconomy → applyLossBonuses: base $1400,
// +$500 per consecutive loss, max 4), so every stored number is one of
// $1400 / $1900 / $2400 / $2900 / $3400 and the ladder maps straight
// onto its five rungs: pips = clamp(round((v − 1400) / 500) + 1, 0…5).
// A non-positive or unparseable value reads ZERO filled pips — never a
// guessed step (the lead ruling: non-positive ⇒ no filled pip).
export function lossPips(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = Math.round((n - 1400) / 500) + 1;
  return Math.min(5, Math.max(0, p));
}
