// Report-only dead-code scan for the frontend. Stdlib-only; never edits.
// Usage: node scripts/deadscan.mjs   (run from src/frontend; `make deadscan` in src/)
//
// Reports:
//   1. modules under src/ not reachable from src/main.js (tests excluded)
//   2. named/default imports used nowhere else in their file
//   3. top-level declarations whose name occurs only once across src/ and test/
//   4. CSS class selectors in public/*.css that no source file mentions
//
// Every finding is a candidate. Known intentional cases (Wails runtime classes,
// oracle/test-seam exports, and the like) are listed in ALLOW below.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const srcDir = path.join(root, 'src')
const testDir = path.join(root, 'test')
const publicDir = path.join(root, 'public')

// Class names the runtime adds (not in repo source): keep their CSS rules.
const ALLOW_CLASSES = new Set([
  'file-drop-target-active', // added by @wailsio/runtime on native file drop
  'section-title', // documented shared heading class for non-<h2> markup (style.css)
])

function walk(dir, out = [], exts = /\.(m?js|svelte|ts)$/) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'bindings'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, exts)
    else if (exts.test(e.name)) out.push(p)
  }
  return out
}

const srcFiles = walk(srcDir)
// Generated builtin sources embed Svelte text as strings; skip them for import analysis.
const isGenerated = (f) => f.includes(`${path.sep}generated${path.sep}`)
const testFiles = walk(testDir)
const isTest = (f) => testFiles.includes(f) || /\.test\.js$/.test(f)
const text = new Map([...srcFiles, ...testFiles].map((f) => [f, fs.readFileSync(f, 'utf8')]))
const rel = (f) => path.relative(root, f)

function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.svelte`, path.join(base, 'index.js')])
    if (text.has(c)) return c
  return null
}

// ---- 1. reachability from the app entry ----
const edges = new Map()
const specRes = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/gm,
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /new URL\(\s*['"]([^'"]+)['"]/g,
]
for (const f of text.keys()) {
  const deps = []
  for (const re of specRes) {
    let m
    re.lastIndex = 0
    while ((m = re.exec(text.get(f)))) {
      const r = resolveSpec(f, m[1])
      if (r) deps.push(r)
    }
  }
  edges.set(f, deps)
}
const reach = new Set()
const stack = [path.join(srcDir, 'main.js')]
while (stack.length) {
  const f = stack.pop()
  if (reach.has(f)) continue
  reach.add(f)
  for (const d of edges.get(f) ?? []) stack.push(d)
}
console.log('== 1. src modules not reachable from src/main.js')
for (const f of srcFiles) if (!reach.has(f) && !isTest(f) && !isGenerated(f) && !f.endsWith('.d.ts')) console.log(`  ${rel(f)}`)

// ---- 2. imports used only at the import site ----
// A use is any occurrence of the name not preceded by an identifier char or a
// dot, except that a spread (`...name`) counts as a use.
const useCount = (src, id) => {
  const re = new RegExp(`(?<![\\w$])(?:\\.\\.\\.)?${id.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')
  let n = 0
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, m.index - 3), m.index)
    if (before.endsWith('.') && !before.endsWith('...')) continue // obj.name
    n++
  }
  return n
}
console.log('\n== 2. imported names used only at their import')
for (const f of [...srcFiles, ...testFiles]) {
  if (isGenerated(f)) continue
  const src = text.get(f)
  const named = /^import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*['"][^'"]+['"]/gm
  let m
  while ((m = named.exec(src)))
    for (const part of m[1].split(',')) {
      const id = part.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/).pop()
      if (id && useCount(src, id) <= 1) console.log(`  ${rel(f)}: ${id}`)
    }
  const def = /^import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"][^'"]+['"]/gm
  while ((m = def.exec(src))) if (useCount(src, m[1]) <= 1) console.log(`  ${rel(f)}: default ${m[1]}`)
}

// ---- 3. top-level declarations referenced nowhere else ----
const corpus = [...text.values()].join('\n')
const countWord = (id) => {
  let n = 0
  const re = new RegExp(`(?<![\\w$])${id.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')
  for (const _ of corpus.matchAll(re)) n++
  return n
}
console.log('\n== 3. top-level declarations with a single occurrence across src/ and test/')
const declRe = /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
for (const f of srcFiles) {
  if (isTest(f) || isGenerated(f)) continue
  let m
  declRe.lastIndex = 0
  while ((m = declRe.exec(text.get(f)))) {
    if (countWord(m[1]) <= 1) console.log(`  ${rel(f)}: ${m[1]}`)
  }
}

// ---- 4. CSS classes no source file mentions ----
const sources = [...srcFiles, ...testFiles, path.join(root, 'index.html')].filter((f) => fs.existsSync(f))
const sourceText = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const cssFiles = walk(publicDir, [], /\.css$/)
// Source files that are not app modules (type declarations) are not reachability roots.
console.log('\n== 4. CSS class selectors no source mentions')
for (const c of cssFiles) {
  // Blank comments and URLs first: `http://www.w3.org` is not a class selector.
  const css = fs.readFileSync(c, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/https?:\/\/\S+/g, '')
  const seen = new Set()
  for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    const cls = m[1]
    if (seen.has(cls) || ALLOW_CLASSES.has(cls)) continue
    seen.add(cls)
    const re = new RegExp(`(?<![\\w-])${cls.replace(/-/g, '\\-')}(?![\\w-])`)
    if (!re.test(sourceText)) console.log(`  ${rel(c)}: .${cls}`)
  }
}
