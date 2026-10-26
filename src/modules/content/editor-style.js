/**
 * Design tokens of the active theme for the editor's writing area (D-126): the page's text and background colours, its
 * accent and its font, read from the theme's own stylesheet so the editor follows the site instead of a copy of it.
 * Values are restricted to plain CSS value characters: they end up in a style attribute.
 */
const SAFE = /^[\w\s,'"#().%/+-]{1,200}$/;
const safe = (v) => (v && SAFE.test(v.trim()) ? v.trim() : null);

/** @param {any} ctx */
export async function editorStyle(ctx) {
  const id = ctx.themes.activeId();
  const rt = await ctx.themes.runtime(id);
  let css = '';
  for (const [path, f] of rt.files)
    if (/^styles\/.+\.css$/.test(path) && f.encoding === 'utf8') css += f.content + '\n';
  const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  const vars = {};
  for (const m of root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = safe(m[2]);
  const body = css.match(/(?:^|\})\s*body\s*\{([^}]*)\}/)?.[1] ?? '';
  const fontLine = body.match(/font(?:-family)?\s*:\s*([^;]+);/)?.[1] ?? '';
  // `font: 17px/1.65 system-ui, sans-serif` → the families after the size/line-height.
  const family = fontLine.replace(
    /^\s*(?:[\d.]+(?:px|rem|em|pt|%)\s*(?:\/\s*[\d.]+(?:px|rem|em|%)?)?\s*)/,
    '',
  );
  const size = fontLine.match(/^\s*([\d.]+(?:px|rem|em))/)?.[1] ?? null;
  let accent = null;
  try {
    accent = safe(ctx.settings.get(`theme_${id}.accent_color`));
  } catch {
    /* a theme without that setting has no accent of its own */
  }
  return {
    theme: id,
    ink: vars.ink ?? null,
    muted: vars.muted ?? null,
    line: vars.line ?? null,
    bg: vars.bg ?? null,
    soft: vars.soft ?? null,
    accent: accent ?? vars.accent ?? null,
    fontFamily: safe(family),
    fontSize: safe(size),
  };
}
