// sortstate.js — a table's sort state, one step. Choosing the sorted column again
// flips its direction; choosing another column sorts by it in that column's default
// direction (defaultDesc[key]).
//
//   const next = nextSort({ key: sortKey, desc }, key, SORT_DEFAULT_DESC);
//   sortKey = next.key; desc = next.desc;

export function nextSort(sort, key, defaultDesc) {
  if (sort.key === key) return { key, desc: !sort.desc };
  return { key, desc: !!defaultDesc[key] };
}

// compareAsc is the ascending order of two values: -1, 0 or 1 by `<` and `>`.
export function compareAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
