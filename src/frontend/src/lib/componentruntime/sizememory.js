// The last rendered height of each mounted component, by its name. It lives for
// the process (like the view state), so a component that unmounts and mounts
// again reserves the height it had: while it loads, its root is held at that
// height, not collapsed to its empty shell. Keyed by name, not by data: the
// space of the last data is the space the next data takes.
const heights = new Map();

export function rememberHeight(name, px) {
  if (name && px > 0) heights.set(name, px);
}

export function recalledHeight(name) {
  return (name && heights.get(name)) || null;
}
