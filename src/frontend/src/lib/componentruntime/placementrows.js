// The pure half of a surface's placements (owner ruling 43, "use as my
// view"): how stored rows become the entries a surface mounts. No I/O, so
// the node tests can pin it. A surface with no rows renders its default
// composition; a surface with rows renders exactly those rows, in order; a
// hidden row is kept in storage and not rendered.

// parseProps reads a placement's props (a JSON object) and gives an object,
// so a malformed value renders with no props rather than failing the slot.
export function parseProps(text) {
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// placedEntries turns stored rows into the entries a surface mounts.
export function placedEntries(rows) {
  return (rows || [])
    .filter((r) => r && r.component && !r.hidden)
    .map((r, i) => ({ key: i + ':' + r.component, component: r.component, props: parseProps(r.props) }));
}
