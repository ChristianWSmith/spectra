import { mount } from 'svelte'
// VS Code's icon font (bundled: Vite emits the .ttf into dist/assets and
// rewrites the @font-face url, so the embedded build stays self-contained).
import '@vscode/codicons/dist/codicon.css'
import App from './App.svelte'
import { applyTheme, getTheme } from './lib/theme.js'
import { applyFontSize, getFontSize, reconcileFontSize } from './lib/fontsize.js'

// Theme boot (M5 §2.6): resolve + apply before first paint so the dark
// default never flashes when light is persisted.
applyTheme(getTheme())

// Font-size boot (changes.txt #6): same pre-paint localStorage cache as the
// theme — the persisted small/medium/large size paints immediately. The
// kvstore pref is the durable source of truth and reconciles right after
// mount (never-set / corrupt → "medium").
applyFontSize(getFontSize())

mount(App, { target: document.getElementById("app") })

// Rejections are already handled inside reconcileFontSize; the catch keeps
// the boot path free of unhandled-rejection noise.
reconcileFontSize().catch(() => {})
