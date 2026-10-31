import { mount } from 'svelte'
import App from './App.svelte'
import { applyTheme, getTheme } from './lib/theme.js'

// Theme boot (M5 §2.6): resolve + apply before first paint so the dark
// default never flashes when light is persisted.
applyTheme(getTheme())

mount(App, { target: document.getElementById("app") })
