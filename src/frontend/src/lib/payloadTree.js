// Pure key/value-tree helpers for Explorer's generic payload browser.
// No services, no DOM, no runes — every function here is synchronous and
// deterministic so it can be unit-tested with `node --test`
// (see payloadTree.test.js). The Svelte side (components/PayloadTree.svelte)
// only wires these to markup.

// parsePayload parses an event's payload JSON blob. Unparseable input
// yields null (the view renders the "use the raw toggle" fallback).
export function parsePayload(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return null;
  }
}

// isObj is the tree's "is this a branch node?" test (arrays included —
// they are objects with index keys for our purposes).
export function isObj(v) {
  return v !== null && typeof v === 'object';
}

// entries lists a payload object's [key, value] pairs in order.
export function entries(v) {
  return Object.entries(v);
}

// countKeys is the "(N)" size shown on a branch summary.
export function countKeys(v) {
  return isObj(v) ? Object.keys(v).length : 0;
}

// kvText is the value's inline rendering ("{…}" / "[…]" for containers).
export function kvText(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') return Array.isArray(v) ? `[…]` : `{…}`;
  return String(v);
}

// kvClass maps a value to its value-class (kv-num / kv-str / …).
export function kvClass(v) {
  if (v === null || v === undefined) return 'kv-null';
  if (typeof v === 'number') return 'kv-num';
  if (typeof v === 'boolean') return 'kv-bool';
  if (typeof v === 'object') return 'kv-obj';
  return 'kv-str';
}

// matchPaths resolves a key query to the set of payload-relative paths
// ("userid", "round:score", …) that stay visible:
//
//   * a path is included when its own key matches the query, OR
//   * any key nested below it matches — so every ancestor of a hit is
//     present too and the template can render the chain down to it.
//
// Returns null when the query is empty ("show everything, walk nothing").
// One traversal per payload per keystroke: the template then does O(1)
// Set lookups per node instead of re-walking subtrees at every level (a
// per-node keyMatches would be O(subtree) *per node*).
export function matchPaths(payload, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  const out = new Set();
  if (!isObj(payload)) return out;
  const walk = (value, prefix) => {
    let nested = false;
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}:${k}` : k;
      let hit = String(k).toLowerCase().includes(q);
      if (!hit && isObj(v)) hit = walk(v, path);
      if (hit) {
        out.add(path);
        nested = true;
      }
    }
    return nested;
  };
  walk(payload, '');
  return out;
}
