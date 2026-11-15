// strings/errors.js — error phrasing templates rendered through errText (services.js) — {err} = underlying error text, {what} = operation noun
// Populated by Sweep-B extraction (design §5.2); values are plain strings
// with {arg} placeholders (design §3.2).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const errors = {
  // payload browser (PayloadTree.svelte — the unparsable-payload state)
  payloadInvalidJson: 'This payload isn\'t valid JSON — use the Raw view.',
};
