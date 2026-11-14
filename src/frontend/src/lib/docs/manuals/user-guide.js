// The Spectra user guide — the document the help popup renders (design
// §2.5). Sections are the TOC unit. Since the 2026-11-14 content
// onboarding EVERY section carries real, cited prose: the researched
// guide sections live in ./user-guide-content.js (two exports because
// the draft orders the metric-language chapter between `metric-builder`
// and `reports`), and the engine-verified metric-language sections are
// composed in from ./metric-language.js — that chapter IS the manual,
// and its first section id (`metric-language`) is the Builder `?` deep
// target (App's openDocs('metric-language') — untouched).
//
// The guide ships no placeholders today (the draft covered every
// section; its thin `metric-language` pointer could not ship — its id
// would collide with the manual's first section and its "second
// document / document switcher" claims are false in this one-document
// popup). The renderer's "coming soon" path stays pinned by the
// registry round-trip test and the driver's throwaway manual; a section
// that runs thin again = drop its blocks and set `placeholder: true` —
// nothing else changes.
import { registerDoc } from '../registry.js';
import { metricLanguageSections } from './metric-language.js';
import { guideSectionsBeforeManual, guideSectionsAfterManual } from './user-guide-content.js';

registerDoc({
  id: 'user-guide',
  title: 'Spectra guide',
  sections: [
    ...guideSectionsBeforeManual,
    ...metricLanguageSections,
    ...guideSectionsAfterManual,
  ],
});
