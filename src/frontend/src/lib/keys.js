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
