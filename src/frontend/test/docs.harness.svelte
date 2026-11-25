<script>
  // Test harness for DocsPopup: one popup whose open flag, requested section and token the driver
  // sets through globalThis. onClose counts into globalThis.__closed.
  import DocsPopup from './lib/components/DocsPopup.js';

  let state = $state({ open: false, section: null, token: 0 });

  globalThis.__closed = 0;
  globalThis.__set = (next) => {
    state = { ...state, ...next };
  };
</script>

<DocsPopup
  open={state.open}
  section={state.section}
  token={state.token}
  onClose={() => {
    globalThis.__closed++;
  }}
/>
