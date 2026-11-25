<script>
  // Test harness for ToggleSwitch: one switch whose owned value and lock the driver
  // sets through globalThis, and whose onchange requests land in globalThis.__calls.
  import ToggleSwitch from './toggleswitch-bundle.js';

  let on = $state(true);
  let locked = $state(false);

  globalThis.__calls = [];
  globalThis.__set = (v) => {
    on = v;
  };
  globalThis.__lock = (v) => {
    locked = v;
  };
</script>

<ToggleSwitch checked={on} disabled={locked} label="Enabled: demo" onchange={(v) => globalThis.__calls.push(v)} />
