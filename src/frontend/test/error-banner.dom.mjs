// error-banner.dom.mjs — the ErrorBanner contract the panels rely on: with `onretry` the
// banner carries a Retry button after its text, and clicking it runs `onretry` once; with
// no `onretry` there is no button. The text stays the banner's role="alert" line.
// Run (from frontend/):  node test/error-banner.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const h = await boot('error-banner');
const { mount, unmount, flushSync } = await import('svelte');
const Harness = (await import(pathToFileURL(h.bundle(resolve('test/error-banner.harness.svelte'))).href)).default;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const mountBanner = async (props) => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(Harness, { target, props });
  await h.settle(20);
  return { target, cleanup: () => (unmount(instance), target.remove()) };
};

// 1. With a retry: one alert line, the text, then one button labelled by retryLabel.
{
  let calls = 0;
  const { target, cleanup } = await mountBanner({ retry: () => calls++ });
  const line = target.querySelector('p.error[role="alert"]');
  check('the banner is an alert line', !!line);
  check('the banner shows its text', line && line.textContent.trim().startsWith('Load failed'), line && line.textContent);
  const button = line && line.querySelector('button');
  check('the retry button sits inside the banner', !!button);
  check('the retry button carries retryLabel', button && button.textContent.trim() === 'Try again', button && button.textContent);
  button && button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  flushSync();
  check('clicking retry runs onretry once', calls === 1, `calls=${calls}`);
  cleanup();
}

// 2. Without a retry: the text alone, no button.
{
  const { target, cleanup } = await mountBanner({ retry: null });
  const line = target.querySelector('p.error[role="alert"]');
  check('no onretry means no button', line && !line.querySelector('button'));
  check('no onretry keeps the text', line && line.textContent.trim() === 'Load failed', line && line.textContent);
  cleanup();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(0);
