/**
 * Markdown → blocks (D-126). A small, deliberate subset: headings, paragraphs, bullet and numbered lists, quotes,
 * fenced code, tables, rules, and inline bold / italic / strikethrough / code / links. Raw HTML in the source is shown
 * as text, never passed through; pictures and anything else unknown become plain words. The result goes through
 * sanitizeBlocks() like every other save, so this only decides the shape.
 */

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

/** Inline Markdown to the inline HTML the blocks use. */
export function inlineMd(src) {
  // Pull code spans out first so nothing inside them is interpreted.
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // pictures are not imported
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, text, href) => {
      const url = href.replace(/&amp;/g, '&');
      return SAFE_HREF.test(url) ? `<a href="${esc(url)}">${text}</a>` : text;
    })
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<b>$2</b>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/**
 * @param {string} md
 * @returns {{type: string, data: any}[]}
 */
export function markdownToBlocks(md) {
  const lines = String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front matter is not content
    .split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', data: { text: inlineMd(para.join(' ')) } });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      flush();
    } else if ((m = line.match(/^(`{3,}|~{3,})/))) {
      flush();
      const fence = m[1];
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence); i++) code.push(lines[i]);
      blocks.push({ type: 'code', data: { code: code.join('\n') } });
    } else if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flush();
      const text = m[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`|\*)/g, '');
      blocks.push({ type: 'header', data: { text, level: m[1].length } });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'delimiter', data: {} });
    } else if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++)
        q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ type: 'quote', data: { text: inlineMd(q.join(' ')), caption: '' } });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length; i++) {
        const li = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (li) items.push(inlineMd(li[1].replace(/^\[[ xX]\]\s+/, '')));
        else if (/^\s{2,}\S/.test(lines[i]) && items.length)
          items[items.length - 1] += ' ' + inlineMd(lines[i].trim());
        else break;
      }
      i--;
      blocks.push({ type: 'list', data: { style: ordered ? 'ordered' : 'unordered', items } });
    } else if (
      line.includes('|') &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')
    ) {
      flush();
      const rows = [cells(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++)
        rows.push(cells(lines[i]));
      i--;
      const width = Math.min(12, Math.max(...rows.map((r) => r.length)));
      blocks.push({
        type: 'table',
        data: {
          header: true,
          rows: rows
            .slice(0, 50)
            .map((r) => Array.from({ length: width }, (_, c) => inlineMd(r[c] ?? ''))),
        },
      });
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}
