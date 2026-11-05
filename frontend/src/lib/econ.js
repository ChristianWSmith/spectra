// Canonical economy math for the Economy view: the two per-team series
// the chart plots (EconCurve) and the two columns its hover tooltip
// shows. One spelling of the formulas, unit-tested in econ.test.js —
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
