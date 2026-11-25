// CONTROL_SELECTOR names the controls inside a row (a button, link or field). A click on one
// of them belongs to that control, so a row's own handler ignores it.
export const CONTROL_SELECTOR = 'button, a, input';

// keys.js — keyboard activation of a clickable row. A row that opens something
// on click also opens it from the keyboard: Enter, and Space unless `enterOnly`.
// The default action of the key is stopped, so a focused row never scrolls.
//
//   <tr tabindex="0" onclick={open} onkeydown={activateOnKey(open)}>
//   <tr tabindex="0" onclick={open} onkeydown={activateOnKey(open, { enterOnly: true })}>
export function activateOnKey(fn, { enterOnly = false } = {}) {
  return (e) => {
    if (!(e.key === 'Enter' || (!enterOnly && e.key === ' '))) return;
    e.preventDefault();
    fn(e);
  };
}

// openRow is a clickable row's handlers: a click opens the row, unless it came from a
// control inside the row (matching `ignore`), and Enter (or Space, unless enterOnly)
// opens it from the keyboard. Spread it onto the row: <tr {...openRow(open)}>.
export function openRow(fn, { ignore = '', enterOnly = false } = {}) {
  return {
    onclick: (e) => {
      if (ignore && e.target instanceof Element && e.target.closest(ignore)) return;
      fn(e);
    },
    onkeydown: activateOnKey(fn, { enterOnly }),
  };
}
