// Equipment-icon loader: the frontend side of the /api/icons pipeline.
//
// Go extracts the game's SVG silhouettes from the user's local CS2
// install into the app data dir (internal/mappack/icons.go, IconService),
// serves them at /api/icons/<file>.svg, and describes what's available at
// /api/icons/manifest.json — {"extracted", "count",
// "icons": {"<canonical name>": "/api/icons/<file>.svg"}}. Keys are the
// canonical demoinfocs equipment names — the exact strings the replay
// state stream's weapon/inventory fields carry ("AK-47", "Smoke Grenade",
// "Kevlar + Helmet", …), so lookup is one exact-match hit against data
// the stream already produced.
//
// TEXT-LABEL FALLBACK: iconURL()/preloadIcons() return null for a name
// with no icon (no CS2 install, extraction not run yet, file missing
// after a game update). null is a normal outcome, not an error — the
// CALLER renders the canonical name as a text label instead of an image.
// Never throws for a missing icon or a dead manifest endpoint.
//
// Pure parts (normalizeManifest, iconURL) are node-tested:
// frontend/src/lib/icons.test.js.

// The fail-soft empty manifest — frozen so callers can share it safely.
const EMPTY_MANIFEST = Object.freeze({
  extracted: false,
  count: 0,
  icons: Object.freeze({}),
  note: '',
});

// Session memo: one fetch per page load; resetIconManifest() drops it
// (the service wrappers do this after a successful extraction).
let manifestPromise = null;

// normalizeManifest is the fail-soft boundary: any input (null, a 404
// body, a malformed payload) becomes a well-formed manifest with the
// same three keys, so callers never shape-check. iconURL only keeps
// string→string entries; count is recomputed so count === icons size.
export function normalizeManifest(raw) {
  if (raw == null || typeof raw !== 'object') return EMPTY_MANIFEST;
  const icons = {};
  if (raw.icons != null && typeof raw.icons === 'object') {
    for (const [name, url] of Object.entries(raw.icons)) {
      if (typeof name === 'string' && typeof url === 'string' && url !== '') {
        icons[name] = url;
      }
    }
  }
  if (Object.keys(icons).length === 0) return EMPTY_MANIFEST;
  return Object.freeze({
    extracted: raw.extracted !== false,
    count: Object.keys(icons).length,
    icons: Object.freeze(icons),
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
