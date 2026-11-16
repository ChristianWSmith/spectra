// Equipment-icon loader: the frontend side of the /api/icons pipeline.
//
// Go extracts the game's SVG silhouettes from the user's local CS2
// install into the app data dir (internal/mappack/icons.go, IconService),
// serves them at /api/icons/<file>.svg, and describes what's available at
// /api/icons/manifest.json — {"extracted", "count",
// "icons": {"<canonical name>": "/api/icons/<file>.svg"},
// "maps": {"<map name>": "/api/icons/map_icon_<map>.svg"}}. icons keys
// are the canonical demoinfocs equipment names — the exact strings the
// replay state stream's weapon/inventory fields carry ("AK-47", "Smoke
// Grenade", "Kevlar + Helmet", …), so lookup is one exact-match hit
// against data the stream already produced; maps keys are MAP names
// ("de_mirage"), the Library's map column's lookup. The two halves stay
// split: count === icons size (the map logos are ~1.75 MB the Replay
// preload never draws — they ride their own key, mapCount).
//
// TEXT-LABEL FALLBACK: iconURL()/mapIconURL()/preloadIcons() return null
// for a name with no icon (no CS2 install, extraction not run yet, file
// missing after a game update). null is a normal outcome, not an error —
// the CALLER renders the canonical name as a text label instead of an
// image. Never throws for a missing icon or a dead manifest endpoint.
//
// Pure parts (normalizeManifest, iconURL, mapIconURL) are node-tested:
// frontend/src/lib/icons.test.js.

// The fail-soft empty manifest — frozen so callers can share it safely.
const EMPTY_MANIFEST = Object.freeze({
  extracted: false,
  count: 0,
  icons: Object.freeze({}),
  maps: Object.freeze({}),
  mapCount: 0,
  note: '',
});

// Session memo: one fetch per page load; resetIconManifest() drops it
// (the service wrappers do this after a successful extraction).
let manifestPromise = null;

// stringEntries is the fail-soft dict filter both halves share: only
// string→string (non-empty URL) entries survive, so a malformed payload
// can never put a non-string into a lookup table.
function stringEntries(raw) {
  const out = {};
  if (raw != null && typeof raw === 'object') {
    for (const [name, url] of Object.entries(raw)) {
      if (typeof name === 'string' && typeof url === 'string' && url !== '') {
        out[name] = url;
      }
    }
  }
  return out;
}

// normalizeManifest is the fail-soft boundary: any input (null, a 404
// body, a malformed payload) becomes a well-formed manifest with the
// same five keys, so callers never shape-check. iconURL/mapIconURL only
// keep string→string entries; count/mapCount are recomputed so they
// match their own half's size.
export function normalizeManifest(raw) {
  if (raw == null || typeof raw !== 'object') return EMPTY_MANIFEST;
  const icons = stringEntries(raw.icons);
  const maps = stringEntries(raw.maps);
  if (Object.keys(icons).length === 0 && Object.keys(maps).length === 0) {
    return EMPTY_MANIFEST;
  }
  return Object.freeze({
    extracted: raw.extracted !== false,
    count: Object.keys(icons).length,
    icons: Object.freeze(icons),
    maps: Object.freeze(maps),
    mapCount: Object.keys(maps).length,
    note: typeof raw.note === 'string' ? raw.note : '',
  });
}

// loadIconManifest fetches /api/icons/manifest.json once per session.
// Resolves to a normalized manifest on every path: 404/network failure
// → the empty manifest (extracted:false, icons:{}) — the caller then
// falls back to text labels. Failures are NOT memoized (the next call
// retries; services.js cachedRead drops failed reads the same way), a
// successful body stays memoized until resetIconManifest().
export function loadIconManifest() {
  if (!manifestPromise) {
    const p = fetch('/api/icons/manifest.json', { cache: 'no-store' })
      .then((res) =>
        res && res.ok ? res.json().then(normalizeManifest) : Promise.reject(new Error('icon manifest unavailable')),
      )
      .catch(() => {
        // Fail-soft for THIS caller (resolves to the empty manifest) but
        // re-arm the memo so the next call refetches. Re-arm only if the
        // memo still points at us — resetIconManifest may have won.
        if (manifestPromise === p) manifestPromise = null;
        return EMPTY_MANIFEST;
      });
    manifestPromise = p;
  }
  return manifestPromise;
}

// resetIconManifest drops the session memo so the next loadIconManifest
// refetches — call it after IconService.ExtractIcons (services.js's
// extractIcons() wrapper already does).
export function resetIconManifest() {
  manifestPromise = null;
}

// iconURL resolves a canonical equipment name to its SVG URL, or null
// (→ render the name as text). Takes the manifest so hot paths (per-frame
// render sites) can pass a manifest they already loaded.
export function iconURL(name, manifest) {
  if (!manifest || !manifest.icons) return null;
  return manifest.icons[name] || null;
}

// mapIconURL resolves a MAP name ("de_mirage") to its square logo URL,
// or null (→ the caller renders the bare map name). Same contract as
// iconURL: takes the manifest so a caller (the Library's map column) can
// pass the one it already loaded, and never throws for a missing
// manifest or an unlisted map. It reads ONLY the manifest's `maps` half —
// the map logos are deliberately not in `icons` (see the module header).
export function mapIconURL(mapName, manifest) {
  if (!manifest || !manifest.maps) return null;
  return manifest.maps[mapName] || null;
}

// preloadIcons fetches and decodes every requested icon, resolving to a
// Map<name, HTMLImageElement | null> — the image when it decoded, null
// when the name has no icon or the load failed (per-image, never a
// rejection; the caller text-labels the nulls). Names load in parallel;
// a name that appears twice is one image. Usable directly by the canvas
// renderer: draw image if present, else fillText(name).
export async function preloadIcons(names) {
  const manifest = await loadIconManifest();
  const out = new Map();
  await Promise.all(
    [...new Set(names)].map(
      (name) =>
        new Promise((resolve) => {
          const url = iconURL(name, manifest);
          if (!url) {
            out.set(name, null);
            resolve();
            return;
          }
          const img = new Image();
          img.onload = () => {
            out.set(name, img);
            resolve();
          };
          img.onerror = () => {
            out.set(name, null);
            resolve();
          };
          img.src = url;
        }),
    ),
  );
  return out;
}
