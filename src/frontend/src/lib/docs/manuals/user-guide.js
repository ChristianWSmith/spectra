// The Spectra user guide — the document the help popup renders (design
// §2.5). Sections are the TOC unit: every one EXCEPT the
// metric-language chapter carries `placeholder: true` and renders only
// its title plus the fixed "coming soon" note (explicit placeholders,
// never fake copy). The real metric-language sections are composed in
// from ./metric-language.js — that chapter IS the manual, and its first
// section id (`metric-language`) is the Builder `?` deep target.
//
// Section order follows the queued outline: getting started / import /
// library / match / replay / reports / SQL console / metrics /
// settings. Adding a real section later = write its blocks and drop
// `placeholder` — nothing else changes.
import { registerDoc } from '../registry.js';
import { metricLanguageSections } from './metric-language.js';

registerDoc({
  id: 'user-guide',
  title: 'Spectra guide',
  sections: [
    { id: 'getting-started', title: 'Getting started', placeholder: true },
    { id: 'import', title: 'Importing demos', placeholder: true },
    { id: 'library', title: 'Library', placeholder: true },
    { id: 'match', title: 'Match', placeholder: true },
    { id: 'replay', title: 'Replay', placeholder: true },
    { id: 'reports', title: 'Reports', placeholder: true },
    { id: 'sql-console', title: 'SQL console', placeholder: true },
    ...metricLanguageSections,
    { id: 'settings', title: 'Settings', placeholder: true },
  ],
});
