// M5 theming (plan §2.6): dark ships default, light tokens live in
// style-m3b.css under [data-theme="light"]. Shared by main.js (boot),
// Settings and the command palette's Toggle theme action.
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
