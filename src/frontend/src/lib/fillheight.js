// fillHeight: a Svelte action that makes a list panel run to the bottom of the scrolling content area,
// wherever the panel sits on the page. It measures the panel's own offset inside the content scroller
// (the .content element; the window when there is none), so no chrome height is guessed, and it re-measures
// on every resize of the layout. Below the narrow-screen breakpoint the panel is left to its content.
export const NARROW_PX = 1000;

export function fillHeight(node, gap = 20) {
  const scroller = node.closest('.content');

  const measure = () => {
    if (window.innerWidth <= NARROW_PX) {
      node.style.height = '';
      return;
    }
    if (scroller) {
      // The panel's offset in the scroller's own coordinates (independent of how far it is scrolled).
      const offset = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      node.style.height = Math.max(240, scroller.clientHeight - offset - gap) + 'px';
    } else {
      node.style.height = Math.max(240, window.innerHeight - node.getBoundingClientRect().top - gap) + 'px';
    }
  };

  measure();
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  if (ro) {
    ro.observe(document.body);
    if (scroller) ro.observe(scroller);
  }
  window.addEventListener('resize', measure);
  return {
    destroy() {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    },
  };
}
