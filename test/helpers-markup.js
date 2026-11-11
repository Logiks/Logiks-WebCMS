/**
 * A small HTML tag-balance check for the admin's hand-written fragments (no build step, so nothing else catches a stray or
 * missing closing tag; the browser quietly "repairs" it and the layout moves). Reports where a closing tag does not match what
 * is open, a closing tag with nothing open, and tags still open at the end. Attribute values (which may hold `<` and `>`
 * inside Alpine expressions), comments, and raw-text elements are skipped.
 */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
// Elements whose end tag may be left out in valid HTML; these are not tracked.
const OPTIONAL_END = new Set([
  'p',
  'li',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'option',
  'optgroup',
  'dt',
  'dd',
]);
const RAW = new Set(['script', 'style', 'textarea']);

/** @returns {string[]} problems, each with the line it was found on; empty when the fragment is balanced */
export function checkMarkup(html) {
  const problems = [];
  const stack = [];
  const lineAt = (i) => html.slice(0, i).split('\n').length;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(m[3]);
    if (VOID.has(name) || OPTIONAL_END.has(name)) continue;
    if (!closing) {
      if (RAW.has(name)) {
        // Skip to its end tag: what is inside is text.
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        if (end === -1) problems.push(`line ${lineAt(m.index)}: <${name}> is never closed`);
        else re.lastIndex = html.indexOf('>', end) + 1;
        continue;
      }
      if (!selfClosed) stack.push({ name, line: lineAt(m.index) });
      continue;
    }
    const top = stack.at(-1);
    if (!top) {
      problems.push(`line ${lineAt(m.index)}: </${name}> closes nothing`);
    } else if (top.name !== name) {
      problems.push(
        `line ${lineAt(m.index)}: </${name}> found, but <${top.name}> from line ${top.line} is still open`,
      );
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at !== -1) stack.length = at; // resynchronise so one slip is reported once
    } else stack.pop();
  }
  for (const s of stack) problems.push(`line ${s.line}: <${s.name}> is never closed`);
  return problems;
}
