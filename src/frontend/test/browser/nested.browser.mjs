// Real-browser check: a frame that holds frames is a container (no card of its own); a leaf frame keeps its card.
// Run from src/frontend: node test/browser/nested.browser.mjs. Starts and stops its own Vite and Chromium.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = 9314;
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/test/browser/nested.html`)).ok;
  } catch {
    await sleep(500);
  }
}

let dom = '';
if (up) {
  dom = await new Promise((resolve) => {
    const chrome = spawn(
      CHROME,
      ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=4000', '--dump-dom', `${BASE}/test/browser/nested.html`],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    let buf = '';
    const done = (text) => {
      clearTimeout(limit);
      process.kill(-chrome.pid, 'SIGKILL');
      resolve(text);
    };
    const limit = setTimeout(() => done(buf), 120000);
    chrome.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('</pre>')) done(buf);
    });
    chrome.on('exit', () => done(buf));
  });
}
vite.kill('SIGKILL');

const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log(up ? 'FAIL: the page did not report' : 'FAIL: the Vite server did not start');
  process.exit(1);
}
const o = JSON.parse(m[1].replace(/&quot;/g, '"'));
const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
console.log('Nested frames in headless Chromium');
check('a frame that holds a frame has no card background', transparent(o.parentBg), o.parentBg);
check('a frame that holds a frame has no card border', transparent(o.parentBorder), o.parentBorder);
check('a leaf frame keeps its card', !transparent(o.leafBg), o.leafBg);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
