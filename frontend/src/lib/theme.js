// M5 theming: dark ships default, light tokens live in
// style-m3b.css under [data-theme="light"]. Both palettes are derived
// from VS Code dark+/light+ with the brand pair #28397F / #FBAC18
// substituting VS Code's #007ACC/#0078d4 accents; the token blocks are
// at the top of public/style.css (dark) and public/style-m3b.css
// (light). Shared by main.js (boot), Settings and the command palette's
// Toggle theme action.
const KEY = 'spectra:theme'; // localStorage: 'light' | 'dark'

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* private mode / disabled storage — fall through to the OS hint */
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export function applyTheme(t) {
  const v = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* non-fatal — the attribute still applies for this session */
  }
  return v;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  return applyTheme(next);
}
