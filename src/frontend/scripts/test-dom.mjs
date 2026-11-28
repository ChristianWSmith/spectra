// test-dom.mjs — runs every jsdom DOM harness (test/*.dom.mjs) and fails unless each one
// exits 0 AND prints no FAIL or UNCAUGHT line. A harness's uncaught-error handler keeps the
// process alive, so the exit code alone is not the verdict. Run from src/frontend:
//   node scripts/test-dom.mjs            (npm run test:dom)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const files = readdirSync('test').filter((f) => f.endsWith('.dom.mjs')).sort();
const bad = [];
for (const f of files) {
  const p = join('test', f);
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const lines = out.split('\n').filter((l) => /^\s*FAIL\b|UNCAUGHT/.test(l));
  const ok = r.status === 0 && lines.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}`);
  if (!ok) {
    bad.push(f);
    if (r.status !== 0) console.log(`     exit ${r.status ?? r.signal}`);
    for (const l of lines.slice(0, 10)) console.log(`     ${l.trim().slice(0, 300)}`);
  }
}
console.log(`\n${files.length - bad.length}/${files.length} DOM harnesses clean`);
if (bad.length) {
  console.log(`failed: ${bad.join(', ')}`);
  process.exit(1);
}
