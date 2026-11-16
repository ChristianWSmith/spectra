<!-- HelpButton — THE header `?` (help-buttons wave, 2026-11-15).
     The one help affordance a view header may carry: the Builder `?`
     idiom (`.btn` + title/aria-label + `codicon-question`, the header's
     LAST element right of its `.spacer`) factored into a component so
     the six view headers and the Builder share ONE spelling instead of
     seven copies of the markup (AGENTS "One canonical way"). It opens
     the user guide AT `section` (a registry.js section id) through
     App's openDocs — transient popup state: no navigation, no hash
     change, no URL/viewstate entry; the view stays mounted behind the
     sheet. An unknown id would silently land at the guide's top
     (DocsPopup's goTo), so callers pass a REGISTERED section id —
     docslockstep.test.js pins the surface→section mapping.
     Placement (anti-spam criterion, Part 8): ONE per view header,
     primary chrome only — never per row, cell, column, card or dialog
     action. `label` names the target for callers that do (Builder
     names its section); every view header shares the common copy. -->
<script>
  import * as S from '../strings/index.js';

  let { section, openDocs, label = S.common.viewHelp } = $props();
</script>

<button
  class="btn"
  type="button"
  title={label}
  aria-label={label}
  onclick={() => openDocs(section)}
>
  <span class="codicon codicon-question" aria-hidden="true"></span>
</button>
