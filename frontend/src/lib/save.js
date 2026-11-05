// Native save plumbing for every download/export/render-to-file path.
// The webview's silent anchor downloads are replaced by OS file dialogs
// through the DialogService bindings:
//
//   saveText / saveBlob → SaveFile (pick a path) + WriteFile (land bytes;
//                         data crosses the bindings as base64)
//   saveExportURL       → SaveExport (pick a path, then Go fetches the URL
//                         route itself) — for URL-served payloads too big
//                         to round-trip: full-match WAVs.
//
// Cancel contract: every helper resolves to "" and otherwise does nothing.
// Failures reject so callers can surface them (there is no global error
// toast — each view reports through its own status/error area).
import { saveFile, writeFile, saveExport } from './services.js';

// blobToBase64 converts export bytes for WriteFile: Go's json decoder
// accepts a standard base64 string for []byte. Chunked so multi-MB clips
// don't blow the String.fromCharCode argument limit.
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// saveBlob opens the native save dialog for defaultName (file-type filter
// from ext) and writes the blob there. Resolves to the written path, or ""
// when the user cancels.
export async function saveBlob(defaultName, ext, blob) {
  const path = await saveFile(defaultName, [ext]);
  if (!path) return ''; // cancel — nothing written
  await writeFile(path, await blobToBase64(blob));
  return path;
}

// saveText is saveBlob for strings (CSV/JSON exports).
export async function saveText(defaultName, ext, text, mime) {
  return saveBlob(
    defaultName,
    ext,
    new Blob([text], { type: mime || 'application/octet-stream' }),
  );
}

// saveExportURL routes a URL-served file (a "/api/…" path with optional
// query) through the Go-side exporter: native dialog first, then the
// backend serves the URL straight to disk — the response never crosses the
// bindings. Resolves to the written path, or "" on cancel.
export async function saveExportURL(urlPath, defaultName, ext) {
  return saveExport(urlPath, defaultName, [ext]);
}
