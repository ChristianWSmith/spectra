// helpers-alias.mjs — the drivers' copy of the one import rule a component source
// obeys: `from 'spectra/helpers'` (the helper surface, src/lib/builtinhelpers.js).
// The app's bundler resolves that specifier through a Vite alias; the node drivers
// bundle or copy source themselves, so they rewrite it to the file's relative path
// to the surface before they walk or compile the source.
import { dirname, relative, resolve, sep } from 'node:path';

const SURFACE = resolve('src/lib/builtinhelpers.js');

export function aliasHelpers(source, absPath) {
  if (!source.includes('spectra/helpers')) return source;
  let rel = relative(dirname(resolve(absPath)), SURFACE).split(sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  // Only an import or export specifier is rewritten; the string itself (compile.js names it as a
  // constant) is left alone.
  return source.replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])spectra\/helpers\2/g, (_, lead, q) => `${lead}${q}${rel}${q}`);
}
