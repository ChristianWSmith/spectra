// The completion items for a report template body (Go text/template): the
// template functions and control keywords, and the fields of the data the
// template's scope is rendered against (the report builder reads them from
// the app's report types: PlatformService.ReportFields).

// The functions and actions text/template provides, with their call shape.
export const TEMPLATE_FUNCTIONS = [
  { name: 'printf', args: 'format, args…', doc: 'Formats the arguments with a printf-style format, e.g. printf "%.1f" .DurationS.' },
  { name: 'print', args: 'args…', doc: 'Formats the arguments as fmt.Sprint would.' },
  { name: 'println', args: 'args…', doc: 'Formats the arguments as fmt.Sprintln would.' },
  { name: 'index', args: 'map, key…', doc: 'The value of a map or slice at the key, e.g. index $.Metrics .SteamID.' },
  { name: 'len', args: 'value', doc: 'The length of a string, slice, map or array.' },
  { name: 'slice', args: 'value, from, to', doc: 'A slice of a string or slice.' },
  { name: 'eq', args: 'a, b…', doc: 'True when a equals one of the following values.' },
  { name: 'ne', args: 'a, b', doc: 'True when a and b differ.' },
  { name: 'lt', args: 'a, b', doc: 'True when a is less than b.' },
  { name: 'le', args: 'a, b', doc: 'True when a is less than or equal to b.' },
  { name: 'gt', args: 'a, b', doc: 'True when a is greater than b.' },
  { name: 'ge', args: 'a, b', doc: 'True when a is greater than or equal to b.' },
  { name: 'and', args: 'a, b…', doc: 'The first empty argument, or the last argument.' },
  { name: 'or', args: 'a, b…', doc: 'The first non-empty argument, or the last argument.' },
  { name: 'not', args: 'value', doc: 'The boolean negation of the value.' },
  { name: 'html', args: 'value', doc: 'The value escaped for HTML.' },
  { name: 'js', args: 'value', doc: 'The value escaped for JavaScript.' },
  { name: 'urlquery', args: 'value', doc: 'The value escaped for a URL query.' },
  { name: 'call', args: 'fn, args…', doc: 'Calls a function value.' },
];

export const TEMPLATE_KEYWORDS = [
  { name: 'if', doc: 'Renders the body when the value is non-empty: {{if .X}} … {{else}} … {{end}}.' },
  { name: 'else', doc: 'The other branch of an if, or a chained else if.' },
  { name: 'range', doc: 'Loops a slice or map; . becomes each element: {{range .Scoreboard}} … {{end}}.' },
  { name: 'with', doc: 'Sets . to the value when it is non-empty: {{with .Match}} … {{end}}.' },
  { name: 'end', doc: 'Closes an if, range, with or define.' },
  { name: 'define', doc: 'Names a sub-template.' },
  { name: 'template', doc: 'Renders a named sub-template.' },
  { name: 'block', doc: 'Defines and renders a sub-template in place.' },
  { name: 'nil', doc: 'The nil value.' },
  { name: 'true', doc: 'The boolean true.' },
  { name: 'false', doc: 'The boolean false.' },
];

// templateItems builds the completion items for a template body.
//   fields: the TemplateField list for the scope, from PlatformService.ReportFields:
//           [{ name, type, fields? }], where fields lists a struct's (or a slice's
//           row's) fields one level down
export function templateItems({ fields = [] } = {}) {
  const items = [];
  for (const f of TEMPLATE_FUNCTIONS) {
    items.push({ label: f.name, kind: 'function', detail: `${f.name} ${f.args}`, doc: f.doc, insert: f.name, snippet: false });
  }
  for (const k of TEMPLATE_KEYWORDS) {
    items.push({ label: k.name, kind: 'keyword', detail: 'template keyword', doc: k.doc, insert: k.name, snippet: false });
  }
  for (const f of fields) {
    items.push({ label: `.${f.name}`, kind: 'field', detail: f.type, doc: `The ${f.name} field of the report's data.`, insert: `.${f.name}`, snippet: false });
    if (f.type.startsWith('[]') && (f.fields || []).length) {
      items.push({ label: `range .${f.name}`, kind: 'snippet', detail: 'loop over the rows', doc: `Loops the ${f.name} rows: inside, . is the row.`, insert: `range .${f.name}}}\n\t$0\n{{end}}`, snippet: true });
      for (const r of f.fields) {
        items.push({ label: `.${f.name}[row].${r.name}`, kind: 'field', detail: `${r.type} · a ${f.name} row`, doc: `Inside range .${f.name}: the ${r.name} field of each row.`, insert: `.${r.name}`, snippet: false });
      }
    } else if ((f.fields || []).length) {
      for (const c of f.fields) {
        items.push({ label: `.${f.name}.${c.name}`, kind: 'field', detail: c.type, doc: `The ${c.name} field of .${f.name}.`, insert: `.${f.name}.${c.name}`, snippet: false });
      }
    }
  }
  return items;
}
