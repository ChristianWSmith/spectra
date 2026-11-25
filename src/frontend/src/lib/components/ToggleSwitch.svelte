<script>
  // An on/off switch: a native checkbox with role="switch", so keyboard and
  // screen-reader behavior is the checkbox's own. The parent owns the value;
  // onchange receives the requested state.
  let { checked = false, label = '', disabled = false, title = '', onchange = () => {} } = $props();

  // The parent owns the value. The click's requested state goes to onchange,
  // and the box goes straight back to the owned value: a refused change leaves
  // it where it was, and a granted one shows once the refreshed row arrives.
  function change(e) {
    const input = e.currentTarget;
    if (!disabled) onchange(input.checked);
    input.checked = checked;
  }
</script>

<label class="toggle-switch" class:is-disabled={disabled} {title}>
  <input
    type="checkbox"
    role="switch"
    aria-label={label}
    {checked}
    {disabled}
    onchange={change}
  />
  <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
</label>

<style>
  .toggle-switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    flex: none;
  }
  .toggle-switch.is-disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .toggle-switch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .toggle-track {
    display: inline-block;
    width: 30px;
    height: 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--widget-bg);
    position: relative;
    transition: background 120ms ease;
  }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
    transition: transform 120ms ease;
  }
  .toggle-switch input:checked + .toggle-track {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle-switch input:checked + .toggle-track .toggle-thumb {
    transform: translateX(14px);
    background: var(--bg);
  }
  .toggle-switch input:focus-visible + .toggle-track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
