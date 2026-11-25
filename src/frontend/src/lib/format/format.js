// format.js: the one formatter for builtin and user components (Svelte source) and metrics (SQL).
// The builders call these before a save, and the build runs them over the shipped builtins, so a
// builtin never ships unformatted. The same module runs in the browser and in node (scripts/).
import * as prettier from 'prettier/standalone';
import * as estree from 'prettier/plugins/estree';
import * as babel from 'prettier/plugins/babel';
import * as postcss from 'prettier/plugins/postcss';
import * as svelte from 'prettier-plugin-svelte/browser';
import { format as formatSql } from 'sql-formatter';

// One Svelte style for every component: the house quotes and line width.
const SVELTE_OPTIONS = {
  parser: 'svelte',
  plugins: [svelte, estree, babel, postcss],
  printWidth: 110,
  singleQuote: true,
  semi: true,
  tabWidth: 2,
};

// formatComponentSource returns the Svelte source in its canonical layout.
export function formatComponentSource(source) {
  return prettier.format(String(source), SVELTE_OPTIONS);
}

// A macro ({{NAME}} or {{NAME:args}}) is not SQL: it is masked as a plain identifier while the
// formatter runs, then put back where it was. A masked token the formatter disturbed is a refusal,
// and the statement is returned as typed.
const MACRO = /\{\{[^}]*\}\}/g;

// formatMetricSql returns a metric's SQL in its canonical layout: keywords upper-case, one clause per
// line, macros left exactly as written. The reserved binds (:match_id, :steam_id, :round) are named
// parameters, so the formatter keeps them. Formatting changes layout only, never the statement.
export function formatMetricSql(sql) {
  const text = String(sql).trim();
  if (text === '') return '';
  const macros = [];
  const masked = text.replace(MACRO, (m) => {
    macros.push(m);
    return `__macro${macros.length - 1}__`;
  });
  const out = formatSql(masked, {
    language: 'sqlite',
    keywordCase: 'upper',
    tabWidth: 2,
    paramTypes: { named: [':'] },
  });
  const restored = out.replace(/__macro(\d+)__/g, (_, i) => macros[Number(i)] ?? '');
  const found = out.match(/__macro\d+__/g) || [];
  if (found.length !== macros.length) return text;
  return restored;
}
