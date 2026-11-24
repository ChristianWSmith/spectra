// Real-browser check of the builders' list column, each builder alone as the app shows it: the list runs to
// the bottom of the content area, its rows scroll inside it, and the two lists share one width. Loads the real
// stylesheets and the real fillHeight action. Run from src/frontend: node test/browser/builders.browser.mjs.
// Starts and stops its own Vite and Chromium.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = 9315;
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
    up = (await fetch(`${BASE}/test/browser/builders.html`)).ok;
  } catch {
    await sleep(500);
  }
}

function runPage(only) {
  return new Promise((resolve) => {
    const url = `${BASE}/test/browser/builders.html?only=${only}`;
    const chrome = spawn(
      CHROME,
      ['--headless', '--no-sandbox', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=4000', '--dump-dom', url],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    let buf = '';
    const done = (text) => {
      clearTimeout(limit);
      try {
        process.kill(-chrome.pid, 'SIGKILL'); // the whole group: Chromium's helpers stop with it
      } catch {
        // already exited
      }
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

const reports = {};
if (up) {
  for (const only of ['bld', 'rb']) {
    const dom = await runPage(only);
    const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    reports[only] = m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
  }
}
vite.kill('SIGKILL');

if (!up || !reports.bld || !reports.rb) {
  console.log(up ? 'FAIL: a page did not report' : 'FAIL: the Vite server did not start');
  process.exit(1);
}
const b = reports.bld;
const r = reports.rb;
console.log('Builder list layout in headless Chromium');
check('the Builder and Reports lists share one column width', b.width === r.width, `${b.width} vs ${r.width}`);
check('the column width is the shared 250–330px range', b.width >= 250 && b.width <= 330, String(b.width));
for (const [name, o] of [['Builder', b], ['Reports', r]]) {
  check(`the ${name} list runs to the bottom of the content area`, Math.abs(o.bottom - (o.scrollerBottom - 20)) <= 2, `${o.bottom} vs ${o.scrollerBottom - 20}`);
  check(`the ${name} rows scroll inside the list`, o.rowsOverflow === 'auto' && o.rowsScroll > 0, `${o.rowsOverflow} ${o.rowsScroll}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
