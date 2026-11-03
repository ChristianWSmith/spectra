// Font-size setting: small / medium / large (changes.txt #6). Mirrors the
// theme.js split of duties:
//
//   * localStorage ('spectra:font-size') is the synchronous pre-paint cache
//     main.js applies before mount, so the persisted size paints on frame
//     one with no flash of the default.
//   * the kvstore pref `font_size` (prefs.go, AutoSave = durable) is the
//     source of truth: reconcileFontSize() re-reads it on boot and fixes
//     any drift. Never-set and corrupt values normalize to "medium" —
//     "small" is what the app shipped with before the setting existed.
//
// The sizes live on :root (the font-size rule at the top of
// public/style.css); the rest of the stylesheet is em/rem-based, so that
// single declaration scales the whole UI. Values are integer px: 13 keeps
// today's exact density, 15 is a comfortable step up, 17 is the large
// step — ±2px around the default so each step is clearly perceptible.
import { getPref } from './services.js';

const KEY = 'spectra:font-size'; // localStorage cache: 'small' | 'medium' | 'large'
const PREF = 'font_size'; // kvstore key (prefs.go prefsFontSizeKey)

const SIZES = { small: '13px', medium: '15px', large: '17px' };

export const FONT_SIZES = ['small', 'medium', 'large'];

// normalizeFontSize maps anything (missing, corrupt, wrong-typed) to a
// valid size — "medium" is the default per prefs.go.
export function normalizeFontSize(v) {
  return Object.prototype.hasOwnProperty.call(SIZES, v) ? v : 'medium';
}

// getFontSize reads the pre-paint cache; invalid/absent → "medium".
export function getFontSize() {
  try {
    const v = localStorage.getItem(KEY);
    if (Object.prototype.hasOwnProperty.call(SIZES, v)) return v;
  } catch {
    /* private mode / disabled storage — fall through to the default */
  }
  return 'medium';
}

// applyFontSize sets :root's font-size inline (overriding the stylesheet
// default) and mirrors the value into the cache. Returns the normalized
// size actually applied.
export function applyFontSize(size) {
  const v = normalizeFontSize(size);
  document.documentElement.style.fontSize = SIZES[v];
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* non-fatal — the attribute still applies for this session */
  }
  return v;
}

// reconcileFontSize re-reads the durable kvstore pref after boot and
// applies it when it differs from the cached value (the kvstore wins —
// localStorage is only the cache). Failures keep the already-applied size
// rather than clobbering the UI with the default.
export async function reconcileFontSize() {
  let stored;
  try {
    stored = await getPref(PREF);
  } catch {
    return getFontSize(); // bindings unavailable — keep what painted
  }
  const want = normalizeFontSize(stored); // null / corrupt → "medium"
  if (want !== getFontSize()) return applyFontSize(want);
  return want;
}
