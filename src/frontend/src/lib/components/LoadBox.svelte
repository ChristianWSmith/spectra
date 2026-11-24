<script>
  // LoadBox: the one loading shell every surface uses (a frame's panel, a view's root). It is the
  // whole standard in one place:
  //   - a load in flight that replaces the content on screen (busy) holds the box's height: its
  //     remembered height for this content identity, else the height it has now, else a default;
  //   - the first load hides the content (the held space is empty, the spinner shows);
  //   - a later swap keeps the content and dims it under a spinner centred on the box, so a swap
  //     never shows an empty box and never flashes;
  //   - a box remembers its height per content identity, so the next load holds the right space.
  // A refresh of the same content identity is not busy: the old data stays put until the new arrives.
  import { recalledHeight, rememberHeight, onSizesLoaded } from '../componentruntime/sizememory.js';

  let {
    busy = false,
    name = '',
    key = '',
    tag = 'div',
    class: cls = '',
    children,
  } = $props();

  let el = $state(null);
  // The content on screen has been settled once (the first load is over).
  let hasShown = $state(false);
  // The identity of the content on screen (the key when it last settled).
  let shownKey = '';
  let sizesLoaded = $state(0);
  // A box holding other boxes is a container: the boxes inside hold the space and show the spinner, so this
  // one neither hides nor spins. Tracked as the DOM changes.
  let holdsBoxes = $state(false);
  $effect(() => {
    if (!el || typeof MutationObserver === 'undefined') return;
    const check = () => (holdsBoxes = !!el.querySelector('.load-box'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  });
  const leafBusy = $derived(busy && !holdsBoxes);
  $effect(() => onSizesLoaded(() => sizesLoaded++));

  const sizeKey = (k) => (name ? name + '|' + k : '');

  // The height a busy box holds (a CSS length), from the most specific memory available.
  let hold = $state(null);
  $effect(() => {
    void sizesLoaded;
    if (!busy) {
      hold = null;
      return;
    }
    // Identity first (this match, this player); else the component's last settled height for any identity:
    // a new match is close to the last one, and that beats a fixed default.
    const remembered = (sizeKey(key) && recalledHeight(sizeKey(key))) || (name && recalledHeight(name)) || null;
    const current = el && el.offsetHeight > 0 ? el.offsetHeight : 0;
    hold = remembered ? remembered + 'px' : current ? current + 'px' : '12em';
  });

  // The content is shown once a busy period has ended (a box that starts settled has shown nothing yet:
  // its first load has not begun). Its content identity is the key it settled with.
  let wasBusy = false;
  $effect(() => {
    if (busy) {
      wasBusy = true;
    } else {
      if (wasBusy) hasShown = true;
      shownKey = key;
    }
  });

  // Remember the settled height under the identity the content had.
  $effect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (busy || !shownKey) return;
      if (sizeKey(shownKey)) rememberHeight(sizeKey(shownKey), el.offsetHeight);
      if (name) rememberHeight(name, el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<svelte:element
  this={tag}
  bind:this={el}
  class="load-box {cls}"
  class:load-busy={leafBusy}
  class:load-first={leafBusy && !hasShown}
  class:load-shown={hasShown}
  aria-busy={leafBusy ? 'true' : undefined}
  style:min-height={leafBusy ? hold : null}
>
  {@render children?.()}
</svelte:element>
