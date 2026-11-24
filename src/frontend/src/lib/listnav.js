// listnav.js — keyboard navigation of a list of options (the pickers and the
// suggestion lists). A list moves its highlighted row with the arrows, wrapping at
// the ends; Enter picks the highlighted row; the highlighted row is kept in view.
//
//   function move(d) { active = stepActive(items.length, activeIdx, d); }
//   function onKey(e) { onListKey(e, { move, pick: () => pick(activeIdx) }); }
//   $effect(() => { open; active; scrollActive(listEl, '.mp-opt.active'); });

// stepActive is the index d rows away from activeIdx in a list of count rows, wrapping.
// An index below zero (no row highlighted) counts from the first row.
export function stepActive(count, activeIdx, d) {
  if (!count) return activeIdx;
  const from = activeIdx < 0 ? 0 : activeIdx;
  return (from + d + count) % count;
}

// onListKey handles ArrowDown, ArrowUp and Enter for a list: the arrows call move(±1),
// Enter calls pick() when canPick() allows it (always, by default). The default action
// of a handled key is stopped.
export function onListKey(e, { move, pick, canPick = () => true }) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter' && canPick()) {
    e.preventDefault();
    pick();
  }
}

// scrollActive keeps the row matching selector inside listEl in view, after the frame
// that renders the new highlight.
export function scrollActive(listEl, selector) {
  requestAnimationFrame(() => {
    const el = listEl && listEl.querySelector(selector);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  });
}
