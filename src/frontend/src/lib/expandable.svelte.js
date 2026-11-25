// expandable.svelte.js: the big-screen toggle for a panel (a preview, or any
// box that fills the window while it is open). `on` is the state; `toggle` flips
// it; `key` collapses it on Escape, and only then, so the key stays the panel's
// own everywhere else. The panel gets the `preview-expanded` class while open.
import * as S from './strings/index.js';

export function expandable() {
  let on = $state(false);
  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
    },
    key(e) {
      if (on && e.key === S.common.keyEscape) {
        e.stopPropagation();
        on = false;
      }
    },
  };
}
