/* Admin SPA — Alpine.js components. No build step; served as-is. */

// ───────── API client (cookie session + CSRF header) ─────────
const auth = { user: null, csrf: null };

async function refreshCsrf() {
  const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  auth.csrf = (await res.json()).csrfToken;
}

// When the person last did something. Sent with every request so the server can tell their clicks from a screen
// refreshing itself (Settings → Security: sign out after inactivity).
let lastInput = Date.now();
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'hashchange'])
  window.addEventListener(ev, () => (lastInput = Date.now()), { passive: true, capture: true });

async function api(method, path, body) {
  const send = async () => {
    const headers = {
      accept: 'application/json',
      'x-user-idle': String(Math.round((Date.now() - lastInput) / 1000)),
    };
    const opts = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) {
      if (typeof window.Blob !== 'undefined' && body instanceof window.Blob) {
        headers['content-type'] = 'application/octet-stream'; // an uploaded file goes as it is
        opts.body = body;
      } else {
        headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    if (method !== 'GET') {
      if (!auth.csrf) await refreshCsrf();
      headers['x-csrf-token'] = auth.csrf;
    }
    return fetch('/api' + path, opts);
  };
  let res = await send();
  if (res.status === 403 && method !== 'GET') {
    const j = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (j.error?.code === 'bad_csrf') {
      await refreshCsrf();
      res = await send(); // one retry with a fresh token
    }
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new CustomEvent('signed-out'));
    const err = new Error(data.error?.message || `Request failed (${res.status})`);
    Object.assign(err, data.error || {}, { status: res.status });
    throw err;
  }
  return data;
}

const toast = (msg, type = 'ok') =>
  window.dispatchEvent(new CustomEvent('toast', { detail: { msg, type } }));
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Chat text with `[label](#/screen)` and `[label](https://…)` turned into links. Escaped first, so nothing else is markup. */
const linkify = (s) =>
  esc(s).replace(
    /\[([^\]\n]{1,120})\]\((#\/[A-Za-z0-9_\-/%.]{1,200}|https:\/\/[^\s)"'<>]{1,500})\)/g,
    (_, label, href) =>
      href.startsWith('#')
        ? `<a href="${href}">${label}</a>`
        : `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );

// ───────── "Duplicate a theme" dialog, shared by Themes and the Theme editor ─────────
// It asks for the copy's name AND id. (It used to ask only for the id and always named the copy "<name> (copy)".)
const newDup = () => ({
  open: false,
  source: null,
  name: '',
  id: '',
  idTouched: false,
  busy: false,
  error: '',
});
const dupTheme = {
  dup: newDup(),
  /** A theme id from a name: lowercase letters, numbers and underscores, starting with a letter, 2–32 characters. */
  slugId(name) {
    let id = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(id)) id = `t_${id}`;
    return id.slice(0, 32).replace(/_+$/, '') || 'theme_copy';
  },
  openDup(t) {
    this.dup = {
      ...newDup(),
      open: true,
      source: t,
      name: `${t.name} (copy)`,
      id: this.slugId(`${t.id}_copy`),
    };
    this.$nextTick(() => document.getElementById('dup-name')?.select());
  },
  async submitDup() {
    const d = this.dup;
    d.error = '';
    d.busy = true;
    try {
      const { theme } = await api('POST', `/admin/themes/${d.source.id}/duplicate`, {
        id: d.id.trim(),
        name: d.name.trim() || undefined,
      });
      d.open = false;
      await this.dupDone(theme);
    } catch (e) {
      d.error = e.message;
    } finally {
      d.busy = false;
    }
  },
};

// ───────── helpers shared by every component ─────────
const H = {
  /** True when the assistant is on for this person, so a screen can offer "Ask the assistant". */
  assistantAvailable() {
    return (
      this.can('admin.access') && !Alpine.$data(document.body).disabledModules.includes('assistant')
    );
  },
  /**
   * Pin the assistant chat to one thing (a document path such as pages/about.html, or plugins/<slug>) and open it, so
   * "this page" in the chat means what is on screen here (D-085).
   */
  askAssistant(path, prefill = '') {
    Alpine.$data(document.body).toggleChat(true);
    if (path) {
      window.__assistantFocus = path;
      window.dispatchEvent(new CustomEvent('assistant-focus', { detail: path }));
    }
    if (prefill) {
      window.__assistantPrefill = prefill;
      window.dispatchEvent(new CustomEvent('assistant-ask', { detail: prefill }));
    }
  },
  can(perm) {
    const p = auth.user?.permissions || [];
    if (p.includes('*') || p.includes(perm)) return true;
    for (let i = perm.lastIndexOf('.'); i > 0; i = perm.lastIndexOf('.', i - 1))
      if (p.includes(perm.slice(0, i) + '.*')) return true;
    return false;
  },
  ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d < 30 ? `${d} d ago` : new Date(ms).toLocaleDateString();
  },
  since(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  },
  show(v) {
    if (v === null || v === undefined) return '∅';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === '') return '(empty)';
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  },
  /** First line of a page's init(): fetches that screen's markup from its owning module and mounts
   * it into this component's own (still-empty) root. Returns false (and shows an error) on failure,
   * so callers can bail out of the rest of their init() rather than run data-loading against a DOM
   * that never got its markup. */
  async mountFragment(mod, file) {
    try {
      this.$el.innerHTML = await loadFragment(mod, file);
    } catch {
      this.$el.innerHTML = '<div class="alert alert-danger">Could not load this screen.</div>';
      return false;
    }
    // Walk each new child individually, never `this.$el` itself — this component's own x-data is
    // already bound (we're running inside its init()); re-walking the root risks double-binding it.
    for (const child of [...this.$el.children]) Alpine.initTree(child);
    return true;
  },
  /** Like mountFragment, but for a plugin's own admin/index.html (src/modules/plugins/routes.js's dynamic
   * fragment middleware): a plugin's server.js is full-trust Node.js (D-060), and its admin screen gets the
   * same latitude — a <script> in its markup is re-created so it actually runs (innerHTML alone never executes
   * an injected <script>), letting a plugin register its own Alpine.data() component before initTree() binds it.
   * Core modules never need this (they use pre-registered Alpine.data() components), so mountFragment above is
   * left untouched. */
  async mountPluginFragment(slug) {
    let html;
    try {
      html = await loadFragment('plugin-' + slug, 'index');
    } catch {
      this.$el.innerHTML =
        '<div class="alert alert-danger">Could not load this plugin’s admin screen.</div>';
      return false;
    }
    // The page's CSP only runs scripts served from this site, so a plugin ships its code as `<script src="…">`.
    // Those load BEFORE the markup goes in: Alpine binds `x-data="…"` the moment it appears, so its
    // `Alpine.data(...)` must already exist. (Once per page; a changed script needs a reload.)
    const probe = document.createElement('template');
    probe.innerHTML = html;
    await Promise.all(
      [...probe.content.querySelectorAll('script[src]')].map(
        (el) =>
          new Promise((done) => {
            const src = el.getAttribute('src');
            if ([...document.scripts].some((s) => s.getAttribute('src') === src)) return done();
            const s = document.createElement('script');
            s.src = src;
            s.onload = s.onerror = () => done();
            document.head.append(s);
          }),
      ),
    );
    this.$el.innerHTML = html;
    // Inline scripts (only where the CSP allows them) run before Alpine walks the markup that uses them.
    const children = [...this.$el.children];
    for (const child of children) {
      if (child.tagName !== 'SCRIPT') continue;
      if (child.getAttribute('src')) {
        child.remove(); // already loaded above
        continue;
      }
      const s = document.createElement('script');
      for (const a of child.attributes) s.setAttribute(a.name, a.value);
      s.textContent = child.textContent;
      child.replaceWith(s);
    }
    for (const child of children) if (child.tagName !== 'SCRIPT') Alpine.initTree(child);
    return true;
  },
};

const hashParts = () => location.hash.replace(/^#\/?/, '').split('/');
// facts from /api/public/info that other components need
const meta = { passwordMinLength: 10, passwordReset: false, contentTypes: [], pluginNav: [] };
const thumb = (m) => {
  if (!m) return '';
  if (m.kind === 'file') return '';
  const small = (m.variants || [])
    .filter((v) => v.format === 'webp' && v.role !== 'icon')
    .sort((a, b) => a.width - b.width)[0];
  if (m.kind === 'video') return small ? `/media/${m.id}/${small.file}` : ''; // no still without ffmpeg
  // TIFF, HEIC and the like have no browser-friendly preview unless sharp could make one
  if (!small && /\.(tiff|heic|jxl)$/.test(m.originalFile)) return '';
  return `/media/${m.id}/${small ? small.file : m.originalFile}`;
};
const bytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const escHtml = (t) =>
  String(t ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** The words of some inline HTML. DOMParser builds an inert document, so nothing in it runs. */
const htmlText = (h) =>
  new window.DOMParser()
    .parseFromString(String(h ?? ''), 'text/html')
    .body.textContent.replace(/\u00a0/g, ' ');
/**
 * Word and Google Docs put their formatting in inline styles and their own markup (classes, conditional comments,
 * fake lists). This reads such a clipboard and keeps only what the editor has blocks for: headings, paragraphs with
 * bold/italic/underline/strike/super/subscript and links, lists, tables, quotes, code and rules. Everything it
 * builds is escaped here and sanitised again by the server on save. Pictures are counted, not kept.
 * @returns {{blocks: {type: string, data: any}[], images: number}}
 */
function pasteToBlocks(html) {
  const doc = new window.DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const state = { images: 0 };
  const out = [];
  let list = null;
  let buf = '';
  const SKIP = /^(SCRIPT|STYLE|META|LINK|TITLE|XML|HEAD|NOSCRIPT)$/;
  const BLOCK = /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|SECTION|ARTICLE|FIGURE|LI)$/;
  const wordList = (el) =>
    /mso-list/i.test(el.getAttribute('style') || '') &&
    !/mso-list:\s*none/i.test(el.getAttribute('style') || '');
  const hasBlock = (el) => !!el.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre');
  const safeHref = (raw) => {
    let h = String(raw || '').trim();
    try {
      const u = new URL(h);
      // Google Docs wraps every link in a redirect through google.com/url.
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q'))
        h = u.searchParams.get('q');
    } catch {
      /* relative addresses stay as they are */
    }
    if (/^#_/.test(h)) return ''; // Word's own bookmarks (_Toc…, _Ref…) point at nothing once pasted
    return /^(https?:\/\/\S+|mailto:|tel:|\/(?!\/)|#.|\?)/i.test(h) ? h : '';
  };
  const inline = (node, inLink = false) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        s += escHtml(n.textContent.replace(/\u00a0/g, ' ').replace(/[\r\n\t ]+/g, ' '));
        continue;
      }
      if (n.nodeType !== 1 || SKIP.test(n.tagName)) continue;
      const tag = n.tagName;
      if (tag === 'BR') {
        s += '<br>';
        continue;
      }
      if (tag === 'IMG') {
        state.images++;
        continue;
      }
      if (tag === 'UL' || tag === 'OL') continue; // a list inside an item is read as items of its own
      let inner = inline(n, inLink || tag === 'A');
      if (!inner) continue;
      const st = n.style || {};
      const fw = st.fontWeight;
      // Docs wraps everything in <b style="font-weight:normal">: an explicit weight beats the tag.
      if (fw ? /^(bold|[6-9]00)$/.test(fw) : tag === 'B' || tag === 'STRONG')
        inner = `<b>${inner}</b>`;
      const fs = st.fontStyle;
      if (fs ? fs === 'italic' : tag === 'I' || tag === 'EM') inner = `<i>${inner}</i>`;
      const td = st.textDecoration || st.textDecorationLine || '';
      if (!inLink && tag !== 'A' && (tag === 'U' || /underline/.test(td)))
        inner = `<u>${inner}</u>`;
      if (tag === 'S' || tag === 'STRIKE' || /line-through/.test(td)) inner = `<s>${inner}</s>`;
      if (tag === 'SUP' || st.verticalAlign === 'super') inner = `<sup>${inner}</sup>`;
      if (tag === 'SUB' || st.verticalAlign === 'sub') inner = `<sub>${inner}</sub>`;
      if (tag === 'A') {
        const href = safeHref(n.getAttribute('href'));
        if (href) inner = `<a href="${escHtml(href)}">${inner}</a>`;
      }
      s += inner;
    }
    return s;
  };
  const trimmed = (s) => s.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
  const plainOf = (el) =>
    el.textContent
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const flush = () => {
    const t = trimmed(buf);
    buf = '';
    list = null;
    if (htmlText(t).trim()) out.push({ type: 'paragraph', data: { text: t } });
  };
  const put = (b) => {
    flush();
    out.push(b);
  };
  const items = (el, acc) => {
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const t = trimmed(inline(li));
      if (htmlText(t).trim()) acc.push(t);
      for (const sub of li.children) if (/^(UL|OL)$/.test(sub.tagName)) items(sub, acc);
    }
  };
  const walk = (parent) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) {
        buf += escHtml(n.textContent.replace(/\u00a0/g, ' ').replace(/[\r\n\t ]+/g, ' '));
        continue;
      }
      if (n.nodeType !== 1 || SKIP.test(n.tagName)) continue;
      const tag = n.tagName;
      const cls = n.getAttribute('class') || '';
      if (/^H[1-6]$/.test(tag) || /MsoTitle/.test(cls)) {
        const text = plainOf(n);
        if (text)
          put({ type: 'header', data: { text, level: /^H/.test(tag) ? Number(tag[1]) : 1 } });
      } else if (tag === 'UL' || tag === 'OL') {
        const acc = [];
        items(n, acc);
        if (acc.length)
          put({
            type: 'list',
            data: { style: tag === 'OL' ? 'ordered' : 'unordered', items: acc.slice(0, 200) },
          });
      } else if (tag === 'P' && wordList(n)) {
        // Word's lists are plain paragraphs with a typed-out marker in a span it marks "Ignore".
        const probe = n.cloneNode(true);
        const marker = probe.querySelector(
          '[style*="mso-list:Ignore" i], [style*="mso-list: Ignore" i]',
        );
        const mark = marker ? plainOf(marker) : '';
        marker?.remove();
        const text = trimmed(inline(probe));
        if (!htmlText(text).trim()) continue;
        const style =
          /^\(?[0-9a-z]+[.)]/i.test(mark) && !/^o$/i.test(mark) ? 'ordered' : 'unordered';
        if (!list || list.data.style !== style) {
          flush();
          list = { type: 'list', data: { style, items: [] } };
          out.push(list);
        }
        if (list.data.items.length < 200) list.data.items.push(text);
      } else if (tag === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')]
          .slice(0, 50)
          .map((tr) =>
            [...tr.children]
              .filter((c) => /^T[DH]$/.test(c.tagName))
              .slice(0, 12)
              .map((c) => trimmed(inline(c))),
          )
          .filter((r) => r.length);
        if (rows.length)
          put({ type: 'table', data: { header: !!n.querySelector('thead, th'), rows } });
      } else if (tag === 'BLOCKQUOTE') {
        const text = trimmed(inline(n));
        if (htmlText(text).trim()) put({ type: 'quote', data: { text, caption: '' } });
      } else if (tag === 'PRE') {
        put({ type: 'code', data: { code: n.textContent.replace(/\r/g, '') } });
      } else if (tag === 'HR') {
        put({ type: 'delimiter', data: {} });
      } else if ((tag === 'P' || tag === 'DIV' || tag === 'LI') && !hasBlock(n)) {
        flush();
        buf = inline(n);
        flush();
      } else if (BLOCK.test(tag) || hasBlock(n)) {
        flush();
        walk(n);
        flush();
      } else {
        buf += inline({ childNodes: [n] });
      }
    }
  };
  walk(doc.body);
  flush();
  return { blocks: out.slice(0, 500), images: state.images };
}
/** Wrap the first mention of `title` that is not already inside a link; null when it is not mentioned. */
function linkFirst(html, title, url) {
  let inLink = 0;
  let done = false;
  const needle = String(title).toLowerCase();
  const out = String(html ?? '')
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a[\s>]/i.test(part)) inLink++;
        else if (/^<\/a>/i.test(part)) inLink = Math.max(0, inLink - 1);
        return part;
      }
      if (done || inLink) return part;
      const i = part.toLowerCase().indexOf(needle);
      if (i < 0) return part;
      done = true;
      return `${part.slice(0, i)}<a href="${escHtml(url)}">${part.slice(i, i + needle.length)}</a>${part.slice(i + needle.length)}`;
    })
    .join('');
  return done ? out : null;
}
/**
 * The whole content as one HTML document for the "Page source" view. Blocks that plain HTML can't say (an image from
 * the library, an embed, a download) carry their facts in data- attributes so the round trip through
 * sourceToBlocks() loses nothing. This is the editor's view of the blocks, not the public page's markup.
 */
function blocksToHtml(blocks) {
  const al = (d) => (d.align ? ` style="text-align:${d.align}"` : '');
  const out = blocks.map((b) => {
    const d = b.data || {};
    switch (b.type) {
      case 'paragraph':
        return `<p${al(d)}>${d.text || ''}</p>`;
      case 'header': {
        const l = Math.min(6, Math.max(1, Number(d.level) || 2));
        return `<h${l}${al(d)}>${escHtml(d.text)}</h${l}>`;
      }
      case 'list': {
        const t = d.style === 'ordered' ? 'ol' : 'ul';
        return `<${t}>\n${(d.items || []).map((i) => `  <li>${i}</li>`).join('\n')}\n</${t}>`;
      }
      case 'quote':
        return `<blockquote${al(d)}><p>${d.text || ''}</p>${d.caption ? `<footer>${escHtml(d.caption)}</footer>` : ''}</blockquote>`;
      case 'code':
        return `<pre><code>${escHtml(d.code)}</code></pre>`;
      case 'delimiter':
        return '<hr>';
      case 'image':
        return `<figure data-media="${d.mediaId || ''}"><img alt="${escHtml(d.alt)}">${d.caption ? `<figcaption>${d.caption}</figcaption>` : ''}</figure>`;
      case 'table': {
        const row = (r, tag) => `<tr>${r.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
        const [first, ...rest] = d.rows || [];
        if (!first) return '<table></table>';
        return `<table>${d.header ? `<thead>${row(first, 'th')}</thead>` : ''}<tbody>${(d.header ? rest : [first, ...rest]).map((r) => row(r, 'td')).join('')}</tbody></table>`;
      }
      case 'callout':
        return `<aside class="callout callout-${d.style || 'info'}">${d.title ? `<strong class="callout-title">${escHtml(d.title)}</strong>` : ''}${d.text || ''}</aside>`;
      case 'embed':
        return `<figure class="embed" data-url="${escHtml(d.url)}" data-ratio="${escHtml(d.ratio || '16:9')}">${d.caption ? `<figcaption>${escHtml(d.caption)}</figcaption>` : ''}</figure>`;
      case 'download':
        return `<p class="download" data-media="${d.mediaId || ''}" data-look="${d.look || 'link'}"><a>${escHtml(d.label)}</a></p>`;
      case 'button':
        return `<p class="cms-button-row"${al(d)}><a class="cms-button cms-button-${d.look || 'primary'}" href="${escHtml(d.url)}"${d.newTab ? ' target="_blank"' : ''}>${escHtml(d.text)}</a></p>`;
      case 'html':
        return `<div class="html-block">${d.code || ''}</div>`;
      default:
        return '';
    }
  });
  return out.filter(Boolean).join('\n\n');
}

/**
 * The reverse of blocksToHtml(): a page of HTML (also anything pasted into the source view) back into blocks. Known
 * blocks are read by their markers; everything else goes through pasteToBlocks(), so text is rebuilt from escaped,
 * known tags only. `dropped` counts top-level elements that turned into nothing (scripts, forms, unknown media).
 * @returns {{blocks: {type: string, data: any}[], dropped: number}}
 */
function sourceToBlocks(html) {
  const doc = new window.DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const blocks = [];
  let dropped = 0;
  const alignOf = (el) =>
    /text-align:\s*(left|center|right|justify)/i
      .exec(el.getAttribute('style') || '')?.[1]
      ?.toLowerCase();
  /** Inline HTML made safe by the same reader the paste uses. */
  const inl = (h) => pasteToBlocks(`<p>${h}</p>`).blocks[0]?.data.text || '';
  const cls = (el, pre, all, dflt) => all.find((x) => el.classList.contains(pre + x)) || dflt;
  for (const el of doc.body.children) {
    const tag = el.tagName;
    const c = el.classList;
    if (tag === 'FIGURE' && el.dataset.media) {
      blocks.push({
        type: 'image',
        data: {
          mediaId: Number(el.dataset.media) || null,
          alt: el.querySelector('img')?.getAttribute('alt') || '',
          caption: inl(el.querySelector('figcaption')?.innerHTML || ''),
        },
      });
    } else if (tag === 'FIGURE' && c.contains('embed')) {
      blocks.push({
        type: 'embed',
        data: {
          url: el.dataset.url || '',
          caption: el.querySelector('figcaption')?.textContent.trim() || '',
          ratio: ['16:9', '4:3', '1:1'].includes(el.dataset.ratio) ? el.dataset.ratio : '16:9',
        },
      });
    } else if (tag === 'ASIDE' && c.contains('callout')) {
      const t = el.querySelector('.callout-title');
      const title = t?.textContent.trim() || '';
      t?.remove();
      blocks.push({
        type: 'callout',
        data: {
          style: cls(el, 'callout-', ['info', 'success', 'warning', 'danger'], 'info'),
          title,
          text: inl(el.innerHTML),
        },
      });
    } else if (tag === 'P' && c.contains('download')) {
      blocks.push({
        type: 'download',
        data: {
          mediaId: Number(el.dataset.media) || null,
          label: el.textContent.trim(),
          look: el.dataset.look === 'card' ? 'card' : 'link',
        },
      });
    } else if (tag === 'P' && c.contains('cms-button-row')) {
      const a = el.querySelector('a');
      const b = {
        text: a?.textContent.trim() || '',
        url: a?.getAttribute('href') || '',
        look: cls(a || el, 'cms-button-', ['primary', 'secondary', 'outline'], 'primary'),
        newTab: a?.getAttribute('target') === '_blank',
      };
      const al = alignOf(el);
      blocks.push({ type: 'button', data: al ? { ...b, align: al } : b });
    } else if (tag === 'DIV' && c.contains('html-block')) {
      blocks.push({ type: 'html', data: { code: el.innerHTML.trim() } });
    } else if (tag === 'BLOCKQUOTE') {
      const f = el.querySelector('footer');
      const caption = f?.textContent.trim() || '';
      f?.remove();
      const ps = [...el.querySelectorAll('p')];
      const b = {
        text: inl(ps.length ? ps.map((x) => x.innerHTML).join('<br>') : el.innerHTML),
        caption,
      };
      const al = alignOf(el);
      blocks.push({ type: 'quote', data: al ? { ...b, align: al } : b });
    } else {
      const made = pasteToBlocks(el.outerHTML).blocks;
      if (!made.length) dropped++;
      const al = alignOf(el);
      if (al && made.length === 1 && ['paragraph', 'header', 'quote'].includes(made[0].type))
        made[0].data.align = al;
      blocks.push(...made);
    }
  }
  return { blocks: blocks.slice(0, 1000), dropped };
}
/** A block's words as lines; with `labelled`, each line says what kind of block it came from (for the compare). */
function blockPlain(b, labelled = false) {
  const d = b.data || {};
  const t = (x) => htmlText(x).trim();
  const tag = (x) => (labelled ? x : '');
  switch (b.type) {
    case 'paragraph':
      return [t(d.text)];
    case 'header':
      return [`${tag('#'.repeat(d.level || 2) + ' ')}${t(d.text)}`];
    case 'list':
      return (d.items || []).map((i) => `${tag('• ')}${t(i)}`);
    case 'quote':
      return [`${tag('“')}${t(d.text)}${tag('”')}${d.caption ? ' — ' + d.caption : ''}`];
    case 'code':
      return String(d.code || '')
        .split('\n')
        .map((l) => tag('    ') + l);
    case 'table':
      return (d.rows || []).map((r) => r.map(t).join(' | '));
    case 'callout':
      return [`${tag('[' + d.style + '] ')}${t(d.text)}`];
    case 'image':
      return [
        `${tag('[image #' + d.mediaId + '] ')}${d.alt || ''}${d.caption ? ' — ' + t(d.caption) : ''}`,
      ];
    case 'embed':
      return [`${tag('[video] ')}${d.url || ''}`];
    case 'download':
      return [`${tag('[download #' + d.mediaId + '] ')}${d.label || ''}`];
    case 'delimiter':
      return tag('———') ? ['———'] : [];
    default:
      return [];
  }
}
/**
 * A line diff laid out for two columns: unchanged lines on both sides, a run of removed lines beside the run of added
 * lines that replaced it. Plain longest-common-subsequence; documents are capped so a huge page can't freeze the tab.
 */
function diffRows(a, b, cap = 1500) {
  a = a.slice(0, cap);
  b = b.slice(0, cap);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const rows = [];
  let del = [];
  let add = [];
  const flush = () => {
    for (let k = 0; k < Math.max(del.length, add.length); k++)
      rows.push({
        l: del[k] ?? null,
        r: add[k] ?? null,
        kind: del[k] != null && add[k] != null ? 'chg' : del[k] != null ? 'del' : 'add',
      });
    del = [];
    add = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      rows.push({ l: a[i], r: b[j], kind: 'same' });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) add.push(b[j++]);
    else del.push(a[i++]);
  }
  flush();
  return rows;
}
const uid = (() => {
  let n = 0;
  return () => `b${++n}`;
})();

/** Shared by pagesList/componentsList: a "Choose a .zip" import that reports what Export gave back. */
function fileImportExport(kind) {
  return {
    importBusy: false,
    importError: '',
    prune: false,
    async importZip(file) {
      if (!file) return;
      this.importBusy = true;
      this.importError = '';
      try {
        const r = await api(
          'POST',
          `/admin/site/${kind}/import${this.prune ? '?prune=true' : ''}`,
          file,
        );
        const parts = [`${r.written} saved`, `${r.unchanged} unchanged`];
        if (r.removed) parts.push(`${r.removed} removed`);
        toast(
          `Import finished: ${parts.join(', ')}.${r.errors.length ? ` ${r.errors.length} failed.` : ''}`,
        );
        this.importError = r.errors.length
          ? r.errors.map((e) => `${e.path}: ${e.message}`).join('\n')
          : '';
        await this.load();
      } catch (e) {
        this.importError = e.message;
      } finally {
        this.importBusy = false;
      }
    },
  };
}

// ───────── the site tree's tiny file formats, read and written client-side for the page/component builder ─────────
// The server (component.js) remains the authority: every Save and Preview is validated there. This is just enough
// parsing to populate and rebuild the editors' forms.

/** `---\nkey: value\n---\nbody` → { front, body }. Mirrors component.js's splitFrontMatter. */
function splitFront(src) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { front: {}, body: src };
  const front = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    front[kv[1].toLowerCase()] = v;
  }
  return { front, body: src.slice(m[0].length) };
}

/** One front-matter line, quoting a string only where the tiny reader above would otherwise misread it. */
function frontLine(k, v) {
  if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`;
  const s = String(v);
  return /^(true|false|-?\d+(\.\d+)?)$/.test(s) || s === '' ? `${k}: "${s}"` : `${k}: ${s}`;
}

/** A component file → its three parts, for editing. Mirrors component.js's parseComponent (first block of each kind). */
function splitComponentFile(src) {
  const metaRe =
    /<script\s+type=["']application\/json["']\s+data-cms=["']meta["']\s*>([\s\S]*?)<\/script>/i;
  const styleRe = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/i;
  let meta = {};
  const mm = metaRe.exec(src);
  if (mm) {
    try {
      meta = JSON.parse(mm[1]);
    } catch {
      meta = {};
    }
  }
  const sm = styleRe.exec(src);
  return {
    meta,
    css: sm ? sm[1].trim() : '',
    template: src.replace(metaRe, '').replace(styleRe, '').trim(),
  };
}

/** A Liquid string literal for a value the admin typed: pick whichever quote it doesn't contain. */
function liquidStr(v) {
  const s = String(v ?? '');
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/"/g, '')}"`; // has both kinds of quote: rare; drop the double quotes rather than break the tag
}
const renderArg = (v) =>
  typeof v === 'boolean' || typeof v === 'number' ? String(v) : liquidStr(v);

/** One component instance → the `{% render %}` line it becomes in the saved page. */
function renderTag(b) {
  const args = Object.entries(b.args || {})
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${renderArg(v)}`)
    .join(', ');
  return `{% render "${b.name}"${args ? `, ${args}` : ''} %}`;
}

/** One `{% render "name", k: "v", n: 5, b: true %}` line → { name, args }, or null if it isn't (quoted or numeric/boolean
 *  arguments only — nothing this parser can't safely round-trip). */
function parseRenderLine(line) {
  const m = /^\{%\s*render\s+"([a-z][a-z0-9_/]*)"\s*(?:,\s*([\s\S]*))?%\}$/.exec(line.trim());
  if (!m) return null;
  const argsStr = (m[2] || '').trim();
  const args = {};
  if (argsStr) {
    const re =
      /([a-z][a-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)\s*(?:,\s*|$)/g;
    let mm;
    let consumed = 0;
    while ((mm = re.exec(argsStr))) {
      if (mm.index !== consumed) return null; // a gap the regex skipped over: something it can't parse
      consumed = mm.index + mm[0].length;
      const [, k, raw] = mm;
      args[k] =
        raw === 'true'
          ? true
          : raw === 'false'
            ? false
            : /^-?\d/.test(raw)
              ? Number(raw)
              : raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (consumed !== argsStr.length) return null;
  }
  return { name: m[1], args };
}

/** A page body → an ordered list of component instances, or null when it has anything this simple grammar can't show
 *  (raw HTML, Liquid logic, …) — those pages stay in "edit as code" only, nothing is ever guessed or discarded. */
function parseCompose(body) {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const p = parseRenderLine(line);
    if (!p) return null;
    blocks.push({ uid: uid(), name: p.name, args: p.args });
  }
  return blocks;
}

/** A page body → its markup, its stylesheet and its script. Only attribute-less `<style>`/`<script>` blocks move to their own
 *  tabs (several are joined in order); `<script src>`, `<style media>` and the rest stay in the markup untouched. */
function splitPageBody(body) {
  const take = (re) => {
    const parts = [];
    const rest = body.replace(re, (_m, inner) => {
      parts.push(inner.trim());
      return '';
    });
    body = rest;
    return parts.filter(Boolean).join('\n\n');
  };
  const css = take(/<style>([\s\S]*?)<\/style>/gi);
  const js = take(/<script>([\s\S]*?)<\/script>/gi);
  return { markup: body.trim(), css, js };
}
/** The reverse: the one body the server stores. Style then script, at the end, as plain tags. */
function joinPageBody({ markup, css, js }) {
  return [
    markup.trim(),
    css.trim() ? `<style>\n${css.trim()}\n</style>` : '',
    js.trim() ? `<script>\n${js.trim()}\n</script>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ───────── page fragments (each module owns its own admin-screen markup) ─────────
// A page's `<section x-data="...">` ships empty in index.html; its actual markup is fetched once
// (memoized per URL, same idiom as `loadEditor` below) from the owning module's own admin/ folder
// and injected on that page's first visit.
const fragmentCache = new Map();
// Stamped into index.html by the server (src/app.js) so a new release fetches new fragments, not cached ones.
const ADMIN_V = document.querySelector('meta[name="admin-version"]')?.content || '';
function loadFragment(mod, file) {
  const key = `${mod}/${file}`;
  if (!fragmentCache.has(key))
    fragmentCache.set(
      key,
      fetch(`/admin/modules/${mod}/${file}.html${ADMIN_V ? `?v=${ADMIN_V}` : ''}`).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      }),
    );
  return fragmentCache.get(key);
}

// ───────── code editor (CodeJar + Prism.js, self-hosted — no CDN, loaded lazily) ─────────
// Nothing here loads until a screen actually shows a code field: most admin screens never touch one, and the
// combined weight (CodeJar + Prism core + a handful of language files) beats shipping it in every page's <head>.
const PRISM_BASE = '/admin/vendor/prismjs';
const PRISM_MODE = {
  htmlmixed: 'markup',
  css: 'css',
  javascript: 'javascript',
  'application/json': 'json',
  'text/x-sql': 'sql',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}
let editorLoading;
/** Resolves once window.CodeJar and window.Prism (core + markup/css/clike/javascript/sql/json) are ready. */
function loadEditor() {
  if (!editorLoading)
    editorLoading = (async () => {
      for (const f of [
        'components/prism-core.min.js',
        'components/prism-markup.min.js',
        'components/prism-css.min.js',
        'components/prism-clike.min.js',
        'components/prism-javascript.min.js',
        'components/prism-sql.min.js',
        'components/prism-json.min.js',
      ])
        await loadScript(`${PRISM_BASE}/${f}`); // order matters: each file extends the previous one's globals
      // Token colours come from admin.css (.token.*), matched to the app's own palette — Prism's own theme
      // stylesheet is never loaded, one less request and one less colour scheme to keep in sync.
      // {{ site.name }} / {% render "x" %} coloured as one token, over the HTML grammar a template is otherwise
      // written in — Prism has no Liquid grammar of its own, and this is the whole of what one needs here.
      window.Prism.languages.insertBefore('markup', 'comment', {
        liquid: { pattern: /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/, alias: 'important' },
      });
      await loadScript('/admin/vendor/codejar/dist/codejar.js');
    })();
  return editorLoading;
}

// ───────── Monaco (the page editor's code editor, D-105) ─────────
// The VS Code editor: line numbers, completion, error squiggles, folding, find/replace, format. Self-hosted (AMD build, no
// bundler) and loaded only when a screen that wants it is opened — it is a few MB. A plain textarea stays on the page until
// it is ready (and for good if it can't load), so editing never depends on it.
const MONACO_BASE = '/admin/vendor/monaco/vs';
let monacoLoading;
function loadMonaco() {
  if (!monacoLoading)
    monacoLoading = (async () => {
      // jsdom (the UI tests) and very old browsers lack what Monaco needs: keep the textarea rather than half-load it.
      if (!window.matchMedia || !window.Worker) throw new Error('Monaco needs a full browser');
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${MONACO_BASE}/editor/editor.main.css`;
      document.head.appendChild(css);
      await loadScript(`${MONACO_BASE}/loader.js`);
      window.MonacoEnvironment = {
        // Same-origin module workers; the server redirects to the hashed file.
        getWorker: (_id, label) =>
          new window.Worker(`/admin/vendor/monaco-worker/${label}`, {
            type: 'module',
            name: label,
          }),
      };
      window.require.config({ paths: { vs: MONACO_BASE } });
      await new Promise((resolve, reject) =>
        window.require(['vs/editor/editor.main'], resolve, reject),
      );
      const ts = window.monaco.languages.typescript ?? window.monaco.typescript;
      // A script on a page is browser code: know the DOM, report syntax errors, but don't flag every global a theme defines.
      ts?.javascriptDefaults.setCompilerOptions({
        allowNonTsExtensions: true,
        target: ts.ScriptTarget?.ES2020 ?? 7,
        checkJs: false,
      });
      ts?.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      });
      registerLiquid(window.monaco);
      return window.monaco;
    })();
  return monacoLoading;
}

const LIQUID_TAGS = [
  [
    'if',
    '{% if ${1:condition} %}\n\t$0\n{% endif %}',
    'Show something only when a condition holds',
  ],
  ['unless', '{% unless ${1:condition} %}\n\t$0\n{% endunless %}', 'The opposite of if'],
  [
    'for',
    '{% for ${1:item} in ${2:list} %}\n\t$0\n{% endfor %}',
    'Repeat for every item of a list',
  ],
  [
    'case',
    '{% case ${1:value} %}\n{% when ${2:x} %}\n\t$0\n{% endcase %}',
    'Pick one branch by value',
  ],
  ['assign', '{% assign ${1:name} = ${2:value} %}', 'Set a variable'],
  ['capture', '{% capture ${1:name} %}\n\t$0\n{% endcapture %}', 'Capture output into a variable'],
  ['comment', '{% comment %}\n\t$0\n{% endcomment %}', 'A note that is not rendered'],
  [
    'render',
    '{% render "${1:component}" %}',
    'Place a component (or "theme/name" for a theme one)',
  ],
  [
    'seo',
    '{% seo title: ${1:title}, description: ${2:description} %}',
    'Say what this page is, for search and sharing',
  ],
  [
    'redirect',
    '{% redirect to: "${1:/}", status: ${2:301} %}',
    'Send the visitor to another address',
  ],
  ['not_found', '{% not_found %}', 'Make this whole page a 404'],
  ['raw', '{% raw %}\n\t$0\n{% endraw %}', 'Output Liquid-looking text as it is'],
];
const LIQUID_FILTERS = [
  'append',
  'prepend',
  'capitalize',
  'downcase',
  'upcase',
  'strip',
  'truncate',
  'truncatewords',
  'replace',
  'remove',
  'split',
  'join',
  'first',
  'last',
  'size',
  'sort',
  'reverse',
  'map',
  'where',
  'uniq',
  'default',
  'date',
  'escape',
  'strip_html',
  'newline_to_br',
  'url_encode',
  'plus',
  'minus',
  'times',
  'divided_by',
  'round',
  'json',
  't',
  'asset_url',
  'library_url',
  'absolute_url',
  'handle',
];
const LIQUID_GLOBALS = [
  ['page.title', 'This page’s title'],
  ['page.description', 'This page’s description'],
  ['page.url', 'This page’s address'],
  ['params', 'The varying parts of the address ([slug] → params.slug)'],
  ['query', 'The ?query string'],
  ['site.name', 'The site’s name'],
  ['site.locale', 'The visitor’s language'],
  ['csp_nonce', 'The script nonce for this render'],
];
/** What the open page editor can offer beyond the fixed lists (component names, api names): set by the screen. */
const liquidHints = { components: [], apis: [] };
let liquidRegistered = false;
function registerLiquid(monaco) {
  if (liquidRegistered) return;
  liquidRegistered = true;
  const K = monaco.languages.CompletionItemKind;
  const Snip = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  monaco.languages.registerCompletionItemProvider('html', {
    triggerCharacters: ['%', '{', '|', '"', ' ', '.'],
    provideCompletionItems(model, pos) {
      if (!String(model.uri).startsWith('cms://page/')) return { suggestions: [] };
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const word = model.getWordUntilPosition(pos);
      const range = new monaco.Range(
        pos.lineNumber,
        word.startColumn,
        pos.lineNumber,
        word.endColumn,
      );
      const open =
        line.lastIndexOf('{%') > line.lastIndexOf('%}')
          ? '{%'
          : line.lastIndexOf('{{') > line.lastIndexOf('}}')
            ? '{{'
            : null;
      if (!open) return { suggestions: [] };
      const tail = line.slice(line.lastIndexOf(open) + 2);
      const sug = [];
      if (/render\s+["'][\w/]*$/.test(tail)) {
        for (const c of liquidHints.components)
          sug.push({ label: c.name, kind: K.Module, detail: c.title, insertText: c.name, range });
        return { suggestions: sug };
      }
      if (/\|\s*\w*$/.test(tail)) {
        for (const f of LIQUID_FILTERS)
          sug.push({ label: f, kind: K.Function, insertText: f, range });
        return { suggestions: sug };
      }
      if (open === '{%' && /^\s*\w*$/.test(tail)) {
        // The tag-name position. The snippet already contains the `{%`, so replace from it.
        const start = line.lastIndexOf('{%') + 1;
        const full = new monaco.Range(pos.lineNumber, start, pos.lineNumber, pos.column);
        for (const [name, snippet, doc] of LIQUID_TAGS)
          sug.push({
            label: name,
            kind: K.Keyword,
            detail: doc,
            insertText: snippet,
            insertTextRules: Snip,
            range: full,
            filterText: `{% ${name}`,
          });
        return { suggestions: sug };
      }
      for (const [name, doc] of LIQUID_GLOBALS)
        sug.push({ label: name, kind: K.Variable, detail: doc, insertText: name, range });
      for (const a of liquidHints.apis)
        sug.push({
          label: `api.${a}`,
          kind: K.Variable,
          detail: 'Data a component on this page loads',
          insertText: `api.${a}`,
          range,
        });
      return { suggestions: sug };
    },
  });
}

document.addEventListener('alpine:init', () => {
  // An effect that was already queued when its element left the page (navigating away from a screen) still runs once,
  // after the screen's data is gone, and fails with "x is not defined". That error is about something nobody can see,
  // so it is not reported; an expression error on an element that is on the page is reported exactly as before.
  Alpine.setErrorHandler((error, el, expression) => {
    if (el && !el.isConnected) return;
    Object.assign(error ?? {}, { el, expression });
    console.warn(
      `Alpine Expression Error: ${error?.message}`,
      expression ? `Expression: "${expression}"` : '',
      el,
    );
    setTimeout(() => {
      throw error;
    }, 0);
  });

  // x-codejar="{ mode: 'htmlmixed', get: template, set: (v) => (template = v), readOnly: false, placeholder: '' }"
  // get/set run through Alpine's own expression scope, so whatever reactive property they touch stays exactly what
  // it was when the field was a plain textarea (x-model, a computed prop, …) — this only changes how it's drawn.
  Alpine.directive('codejar', (el, { expression }, { effect, evaluateLater, cleanup }) => {
    if (!(el instanceof HTMLTextAreaElement)) return;
    const evalCfg = evaluateLater(expression);
    let jar = null;
    let editorEl = null;
    let cfg = null;
    let destroyed = false;
    let creating = false;
    const highlight = (e) => {
      const code = e.textContent;
      const lang = cfg.mode && PRISM_MODE[cfg.mode];
      const grammar = lang && window.Prism.languages[lang];
      e.innerHTML = grammar
        ? window.Prism.highlight(code, grammar, lang)
        : code.replace(/[&<]/g, (c) => (c === '&' ? '&amp;' : '&lt;'));
    };
    const applyCfg = () => {
      editorEl.contentEditable = cfg.readOnly ? 'false' : 'plaintext-only';
      editorEl.dataset.placeholder = cfg.placeholder || '';
      const val = cfg.get ?? '';
      if (val !== jar.toString()) {
        jar.updateCode(val, false); // false: this is US setting it, not the user typing — onUpdate must not re-fire
        el.value = val; // onUpdate (which mirrors el.value) is skipped above, so mirror it here for anything reading el.value directly
      }
    };
    const ready = (next) => {
      cfg = next;
      if (!jar) {
        if (!creating) {
          creating = true;
          const rows = el.rows || 10;
          editorEl = document.createElement('div');
          editorEl.className = 'codejar form-control mono';
          editorEl.style.minHeight = `${rows * 1.35}em`;
          el.insertAdjacentElement('afterend', editorEl);
          el.style.display = 'none';
          loadEditor().then(() => {
            if (destroyed) return;
            jar = window.CodeJar(editorEl, highlight);
            jar.onUpdate((code) => {
              el.value = code; // mirror for anything that reads el.value directly (tests, forms)
              cfg.set(code);
            });
            // Nothing types into editorEl directly in code (only a real keystroke does); something that still
            // sets el.value and fires 'input' on the original (hidden) textarea — a test's h.type(), a form
            // reset — is forwarded into the editor, same as it would have reached a plain x-model textarea.
            el.addEventListener('input', () => {
              if (jar.toString() !== el.value) jar.updateCode(el.value);
            });
            applyCfg(); // cfg may have moved on since creation started; use the latest
          });
        }
        return;
      }
      applyCfg();
    };
    effect(() => evalCfg((next) => ready(next)));
    cleanup(() => {
      destroyed = true;
      jar?.destroy();
      editorEl?.remove();
      el.style.display = '';
    });
  });

  // x-monaco="{ language: 'html', get: code, set: (v) => (code = v), liquid: true, markers: errs, name: 'code.html' }" on a <textarea>.
  // Same contract as x-codejar (get/set through Alpine's scope, the textarea stays the fallback), plus: `liquid` colours
  // {{ }} / {% %} and enables Liquid completion, `markers` ([{ line, col, message }]) draws error squiggles, and the
  // instance is kept on `el._monaco` ({ editor, monaco }) so the screen can format, insert at the cursor, or focus.
  Alpine.directive('monaco', (el, { expression }, { effect, evaluateLater, cleanup }) => {
    if (!(el instanceof HTMLTextAreaElement)) return;
    const evalCfg = evaluateLater(expression);
    let cfg = null;
    let host = null;
    let editor = null;
    let model = null;
    let decos = null;
    let destroyed = false;
    let starting = false;
    let applying = false;

    const paintLiquid = () => {
      if (!cfg.liquid) return;
      const out = [];
      for (const m of model.findMatches(
        '\\{\\{[\\s\\S]*?\\}\\}|\\{%[\\s\\S]*?%\\}',
        true,
        true,
        false,
        null,
        false,
      ))
        out.push({ range: m.range, options: { inlineClassName: 'liquid-token' } });
      decos.set(out);
    };
    const apply = () => {
      const val = cfg.get ?? '';
      if (val !== model.getValue()) {
        applying = true;
        model.setValue(val);
        applying = false;
        el.value = val;
      }
      editor.updateOptions({ readOnly: !!cfg.readOnly });
      const monaco = window.monaco;
      monaco.editor.setModelMarkers(
        model,
        'cms',
        (cfg.markers ?? []).map((m) => {
          const line = Math.min(Math.max(1, m.line || 1), model.getLineCount());
          const col = Math.max(1, m.col || 1);
          const w = model.getWordAtPosition({ lineNumber: line, column: col });
          return {
            severity: monaco.MarkerSeverity.Error,
            message: m.message,
            startLineNumber: line,
            startColumn: w ? w.startColumn : col,
            endLineNumber: line,
            endColumn: w ? w.endColumn : model.getLineMaxColumn(line),
          };
        }),
      );
      paintLiquid();
    };
    const start = () => {
      if (starting) return;
      starting = true;
      el.dataset.editorState = 'loading';
      loadMonaco().then(
        (monaco) => {
          if (destroyed) return;
          host = document.createElement('div');
          host.className = 'monaco-host';
          el.insertAdjacentElement('afterend', host);
          model = monaco.editor.createModel(
            cfg.get ?? '',
            cfg.language,
            monaco.Uri.parse(
              `cms://page/${cfg.name || 'file'}-${Math.random().toString(36).slice(2, 8)}`,
            ),
          );
          editor = monaco.editor.create(host, {
            model,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
            fontSize: 13,
            lineNumbers: 'on',
            glyphMargin: true,
            folding: true,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            tabSize: 2,
            bracketPairColorization: { enabled: true },
            quickSuggestions: { other: true, comments: false, strings: true },
            suggest: { showWords: false },
            renderWhitespace: 'selection',
            padding: { top: 8, bottom: 8 },
            fixedOverflowWidgets: true,
            ariaLabel: cfg.label || 'Code editor',
          });
          decos = editor.createDecorationsCollection();
          model.onDidChangeContent(() => {
            if (applying) return;
            const v = model.getValue();
            el.value = v;
            cfg.set(v);
            paintLiquid();
          });
          el._monaco = { editor, monaco };
          el.style.display = 'none';
          el.dataset.editorState = 'ready';
          apply();
        },
        () => {
          // Monaco could not load: the textarea keeps working, and says nothing more — the screen is fully usable.
          el.dataset.editorState = 'failed';
        },
      );
    };
    effect(() => {
      evalCfg((next) => {
        cfg = next;
        if (editor) apply();
        else {
          if (el.value !== (cfg.get ?? '')) el.value = cfg.get ?? ''; // the fallback textarea shows it meanwhile
          start();
        }
      });
    });
    // The textarea still forwards input (a test's setValue, a form reset) while it is the visible editor.
    el.addEventListener('input', () => {
      if (!editor) cfg?.set(el.value);
    });
    cleanup(() => {
      destroyed = true;
      editor?.dispose();
      model?.dispose();
      host?.remove();
      delete el._monaco;
      el.style.display = '';
    });
  });

  // ───────── root ─────────
  Alpine.data('app', () => ({
    ...H,
    ready: false,
    user: null,
    siteName: '',
    branding: null,
    route: 'overview',
    toasts: [],
    login: { email: '', password: '', error: '', busy: false },
    forgot: { email: '', busy: false, sent: false, error: '' },
    reset: {
      token: '',
      valid: null,
      password: '',
      confirm: '',
      busy: false,
      done: false,
      error: '',
    },
    passwordReset: false,
    hash: location.hash,
    openGroups: [],
    sidebarOpen: false,
    // The assistant panel (System → Assistant, D-071): docked at the right so the admin stays usable beside it.
    chatOpen: (() => {
      try {
        return localStorage.getItem('assistant.open') === '1';
      } catch {
        return false;
      }
    })(),
    get chatShown() {
      return this.chatOpen && !!this.user && !this.disabledModules.includes('assistant');
    },
    toggleChat(on = !this.chatOpen) {
      this.chatOpen = on;
      try {
        localStorage.setItem('assistant.open', on ? '1' : '0');
      } catch {
        /* private window: the panel just opens closed next time */
      }
    },
    contentTypes: [],
    pluginNav: [],
    // Optional modules an administrator switched off (Settings → Modules): their menu entries are hidden.
    disabledModules: [],
    path: 'overview',
    picker: { open: false, items: [], busy: false, error: '', q: '', resolve: null },
    _seq: 0,

    get minLength() {
      return meta.passwordMinLength;
    },

    /** Inline style for the sign-in screens' side panel, from Settings → Login page. */
    get loginSideStyle() {
      const b = this.branding;
      if (!b) return '';
      if (b.backgroundType === 'color' && b.backgroundColor)
        return `background:${b.backgroundColor}`;
      if (b.backgroundType === 'image' && b.backgroundImageUrl)
        return `background:center/cover no-repeat url("${b.backgroundImageUrl}")`;
      return '';
    },

    /** Which top-level screen to show. A reset link wins even if someone is signed in. */
    get view() {
      if (!this.ready) return '';
      if (this.hash.startsWith('#/reset')) return 'reset';
      if (!this.user) return this.hash === '#/forgot' && this.passwordReset ? 'forgot' : 'login';
      return 'app';
    },

    /** The sidebar: plain links and collapsible groups. Only what this user may open is listed; a group with nothing left disappears. */
    get nav() {
      const entries = [
        { id: 'overview', label: 'Overview', icon: 'bi-speedometer2', perm: 'admin.access' },
        {
          id: 'webmaster',
          label: 'Webmaster',
          icon: 'bi-hammer',
          items: [
            // "Site pages", not "Pages": Content already has a content type called Pages, and the two are different things.
            { id: 'pages', label: 'Site pages', perm: 'pages.read' },
            { id: 'components', label: 'Components', perm: 'components.read' },
            {
              id: 'pageDesigner',
              label: 'AI Page Designer',
              module: 'page-designer',
              perm: 'pages.write',
            },
            { id: 'services', label: 'Services', module: 'services', perm: 'services.read' },
            { id: 'seo', label: 'SEO Manager', module: 'seo', perm: 'seo.read' },
          ],
        },
        {
          id: 'content',
          label: 'Content',
          icon: 'bi-file-earmark-richtext',
          items: [
            ...this.contentTypes.map((t) => ({
              id: `content/${t.id}`,
              label: t.plural,
              perm: `content.${t.id}.read`,
            })),
            {
              id: 'terms',
              label: 'Categories and tags',
              perm: 'content.terms.manage',
              // Only when a content type that is on uses categories or tags (they go with the blog).
              show: this.contentTypes.some((t) => t.taxonomies.length > 0),
            },
            { id: 'research', label: 'AI Research', module: 'research', perm: 'research.read' },
          ],
        },
        {
          // Moved out of Content to its own top-level group: media is used across the whole site (components,
          // themes, Services), not just content entries, so it doesn't belong nested under one content type's menu.
          id: 'media-manager',
          label: 'Media Manager',
          icon: 'bi-images',
          items: [
            { id: 'media', label: 'Media Library', perm: 'media.read' },
            {
              id: 'media-generator',
              label: 'Media Generator',
              module: 'media-generator',
              perm: 'media.upload',
            },
            { id: 'media-analytics', label: 'Media Analytics', perm: 'media.read' },
          ],
        },
        {
          // Installed plugins (docs/DECISIONS.md D-060): one menu entry per enabled plugin the signed-in user may
          // open (this.pluginNav, loaded from GET /admin/plugins/menu). The Plugin Manager itself is under Settings
          // (D-102), so this group only exists while some plugin has a screen.
          id: 'applications',
          label: 'Applications',
          icon: 'bi-grid-3x3-gap',
          items: [
            ...this.pluginNav.map((p) => ({
              id: `plugin-${p.slug}`,
              label: p.label,
              perm: p.perm,
            })),
          ],
        },
        {
          // Page views, sessions and activity, page-wise and user-wise (D-056) — near Content/Media, before Logs.
          id: 'analytics',
          label: 'Analytics',
          icon: 'bi-graph-up',
          items: [
            {
              id: 'analytics-overview',
              label: 'Overview',
              perm: 'analytics.read',
              module: 'analytics',
            },
            {
              id: 'analytics-active',
              label: 'Active Now',
              perm: 'analytics.read',
              module: 'analytics',
            },
            {
              id: 'analytics-pages',
              label: 'Page Analytics',
              perm: 'analytics.read',
              module: 'analytics',
            },
            {
              id: 'analytics-sessions',
              label: 'Sessions',
              perm: 'analytics.read',
              module: 'analytics',
            },
            {
              id: 'analytics-users',
              label: 'User-wise Analytics',
              perm: 'analytics.read',
              module: 'analytics',
            },
          ],
        },
        {
          // Every read-only "who did what, when" screen in one place, pulled out of Security/Content/Automation
          // (D-059 reverses part of D-058's placement): each screen keeps its own permission unchanged
          // (audit.read/content.activity/events.read), so a role's access is exactly what it was before — only
          // the menu location moved.
          id: 'logs',
          label: 'Logs',
          icon: 'bi-journal-text',
          items: [
            { id: 'audit', label: 'Audit log', perm: 'audit.read' },
            { id: 'content-activity', label: 'Activity', perm: 'content.activity' },
            { id: 'events', label: 'Events', module: 'events', perm: 'events.read' },
            { id: 'ai-usage-text', label: 'Text usage', module: 'ai-usage', perm: 'aiusage.read' },
            {
              id: 'ai-users-text',
              label: 'Text usage by user',
              module: 'ai-usage',
              perm: 'aiusage.read',
            },
            {
              id: 'ai-usage-media',
              label: 'Media usage',
              module: 'ai-usage',
              perm: 'aiusage.read',
            },
            {
              id: 'ai-users-media',
              label: 'Media usage by user',
              module: 'ai-usage',
              perm: 'aiusage.read',
            },
          ],
        },
        {
          // How the site looks (D-052): themes, their options and custom CSS, their files, and the menus they show.
          id: 'appearance',
          label: 'Appearance',
          icon: 'bi-palette',
          items: [
            { id: 'themes', label: 'Themes', perm: 'themes.read' },
            { id: 'customize', label: 'Customize', perm: 'themes.read' },
            { id: 'theme-editor', label: 'Theme editor', perm: 'themes.read' },
            { id: 'menus', label: 'Menus', perm: 'menus.manage' },
          ],
        },
        {
          // The site's system configuration (D-048/D-052). Distinct from Operations → System, which is cluster health.
          id: 'sysconfig',
          label: 'System',
          icon: 'bi-gear',
          items: [
            {
              id: 'requirements',
              label: 'Requirement',
              module: 'assistant',
              perm: 'requirements.read',
            },
            { id: 'prompts', label: 'Prompts', perm: 'prompts.read' },
            { id: 'publish', label: 'Publish & Git', module: 'publish', perm: 'publish.read' },
            {
              id: 'history',
              label: 'Change history',
              module: 'assistant',
              perm: 'history.read',
            },
            { id: 'locales', label: 'Translations', perm: 'locales.read' },
            { id: 'redirects', label: 'Redirects', perm: 'redirects.manage' },
            { id: 'messages', label: 'Messages', perm: 'site.messages' },
            { id: 'sitemap', label: 'Sitemap', module: 'sitemap', perm: 'sitemap.read' },
            { id: 'libraries', label: 'Libraries', perm: 'libraries.read' },
            { id: 'dbms', label: 'Database', module: 'dbms', perm: 'dbms.read' },
            { id: 'api', label: 'API', perm: 'api.read' },
          ],
        },
        {
          // A group so Features (whole subsystems: Blog, eCommerce…, D-100) sits beside the settings it replaces the guesswork of.
          id: 'settings-group',
          label: 'Settings',
          icon: 'bi-sliders',
          items: [
            { id: 'settings', label: 'All settings', perm: 'settings.read' },
            { id: 'features', label: 'Features', perm: 'features.read' },
            // Plugin Editor is reached from a button inside Plugin Manager itself (not its own nav entry) — its
            // route stays reachable via syncRoute()'s special-case, the same way 'account' is.
            { id: 'plugins', label: 'Plugin Manager', perm: 'plugins.read' },
            { id: 'modules', label: 'Modules', perm: 'cluster.read' },
          ],
        },
        {
          id: 'security',
          label: 'Security',
          icon: 'bi-shield-lock',
          items: [
            { id: 'users', label: 'Users', perm: 'users.read' },
            { id: 'roles', label: 'Roles and permissions', perm: 'roles.read' },
          ],
        },
        {
          id: 'operations',
          label: 'Operations',
          icon: 'bi-hdd-stack',
          items: [
            { id: 'cluster', label: 'Cluster', perm: 'cluster.read' },
            { id: 'system', label: 'System', perm: 'cluster.read' },
            { id: 'updates', label: 'Updates', perm: 'system.update' },
            { id: 'backup', label: 'Backups', module: 'backup', perm: 'backup.read' },
            { id: 'log-manager', label: 'Log Manager', module: 'logs', perm: 'logs.manage' },
          ],
        },
        {
          id: 'automation',
          label: 'Automation',
          icon: 'bi-lightning-charge',
          items: [
            { id: 'webhooks', label: 'Webhooks', module: 'webhooks', perm: 'webhooks.read' },
            { id: 'scheduler', label: 'Scheduler', module: 'scheduler', perm: 'scheduler.read' },
            { id: 'testing', label: 'AI Testing', module: 'testing', perm: 'testing.read' },
          ],
        },
        {
          // Guides and the prompt library, read from the markdown in docs/ (D-115). Open to everyone who can sign in.
          id: 'help',
          label: 'Help',
          icon: 'bi-life-preserver',
          items: [
            { id: 'help/administration', label: 'Administration', perm: 'admin.access' },
            { id: 'help/support', label: 'Support', perm: 'admin.access' },
            { id: 'help/coding', label: 'Coding guide', perm: 'admin.access' },
            { id: 'help/ai', label: 'AI prompting', perm: 'admin.access' },
            { id: 'help/prompts', label: 'Prompt library', perm: 'admin.access' },
          ],
        },
      ];
      if (!this.user) return [];
      // `module` ties an entry to an optional module; while that is switched off the entry is not offered.
      const allowed = (n) =>
        this.can(n.perm) &&
        n.show !== false &&
        !(n.module && this.disabledModules.includes(n.module));
      return entries
        .map((n) => (n.items ? { ...n, items: n.items.filter(allowed) } : n))
        .filter((n) => (n.items ? n.items.length : allowed(n)));
    },

    /** Hash split into parts, reactive to navigation. */
    get parts() {
      return this.hash.replace(/^#\/?/, '').split('/');
    },
    /** What the content screens should show: a list of one type, or the editor for one entry. */
    get contentViews() {
      const [r, type, id] = this.parts;
      if (r !== 'content' || !type || !this.contentTypes.some((t) => t.id === type)) return [];
      return id
        ? [{ key: `edit:${type}:${id}`, kind: 'edit', type, id }]
        : [{ key: `list:${type}`, kind: 'list', type }];
    },

    /** The page manager: a list, or the builder for one page (its file path, url-encoded whole, since it has slashes). */
    get pagesViews() {
      const [r, sub] = this.parts;
      if (r !== 'pages') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [
        { key: `edit:${sub}`, kind: 'edit', name: sub === 'new' ? null : decodeURIComponent(sub) },
      ];
    },
    /** The component builder: a list, or the editor for one component (its bare name). */
    get componentsViews() {
      const [r, sub] = this.parts;
      if (r !== 'components') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [
        { key: `edit:${sub}`, kind: 'edit', name: sub === 'new' ? null : decodeURIComponent(sub) },
      ];
    },
    /** Webmaster → Services: a list, or the editor for one service (its slug). */
    get servicesViews() {
      const [r, sub] = this.parts;
      if (r !== 'services') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [
        { key: `edit:${sub}`, kind: 'edit', slug: sub === 'new' ? null : decodeURIComponent(sub) },
      ];
    },
    /** Webmaster → SEO Manager: a list, or the editor for one rule (its id). */
    get seoViews() {
      const [r, sub] = this.parts;
      if (r !== 'seo') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [{ key: `edit:${sub}`, kind: 'edit', id: sub === 'new' ? null : sub }];
    },
    /** Automation → Webhooks: a list, or the editor for one webhook (its id). */
    get webhooksViews() {
      const [r, sub] = this.parts;
      if (r !== 'webhooks') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [{ key: `edit:${sub}`, kind: 'edit', id: sub === 'new' ? null : sub }];
    },
    /** Applications → Plugin Editor: the sessions list, or the chat screen for one session (its id). */
    get pluginEditorViews() {
      const [r, sub] = this.parts;
      if (r !== 'pluginEditor') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [{ key: `chat:${sub}`, kind: 'chat', id: sub }];
    },
    /** Webmaster → AI Page Designer: the sessions list, or the chat screen for one session (its id). */
    get pageDesignerViews() {
      const [r, sub] = this.parts;
      if (r !== 'pageDesigner') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [{ key: `chat:${sub}`, kind: 'chat', id: sub }];
    },
    /** Automation → Scheduler: a list, or the editor for one task (its id). */
    get schedulerViews() {
      const [r, sub] = this.parts;
      if (r !== 'scheduler') return [];
      if (!sub) return [{ key: 'list', kind: 'list' }];
      return [{ key: `edit:${sub}`, kind: 'edit', id: sub === 'new' ? null : sub }];
    },

    /** Every screen the user can open, groups flattened. */
    get navRoutes() {
      return this.nav.flatMap((n) => (n.items ? n.items.map((c) => c.id) : [n.id]));
    },

    groupActive(g) {
      return g.items.some((c) => c.id === this.route);
    },
    groupOpen(g) {
      return this.openGroups.includes(g.id);
    },
    toggleGroup(g) {
      this.openGroups = this.groupOpen(g)
        ? this.openGroups.filter((x) => x !== g.id)
        : [...this.openGroups, g.id];
    },

    async loadTypes() {
      try {
        this.contentTypes = meta.contentTypes = (await api('GET', '/admin/content/types')).types;
      } catch {
        this.contentTypes = meta.contentTypes = []; // no content permissions
      }
    },

    /** Which enabled plugins this user may open, for the Applications nav group. */
    async loadPlugins() {
      try {
        this.pluginNav = meta.pluginNav = (await api('GET', '/admin/plugins/menu')).items;
      } catch {
        this.pluginNav = meta.pluginNav = [];
      }
    },

    async loadModuleState() {
      try {
        this.disabledModules = (await api('GET', '/admin/system/modules/state')).disabled;
      } catch {
        this.disabledModules = [];
      }
    },

    async init() {
      // A module or feature was switched: the menu's entries and the content types it lists may both have changed.
      window.addEventListener('modules-changed', () => {
        this.loadModuleState();
        this.loadTypes();
      });
      window.addEventListener('pick-media', (e) => this.openPicker(e.detail.resolve));
      window.addEventListener('hashchange', () => {
        this.hash = location.hash;
        this.syncRoute();
        this.openResetLink();
        this.sidebarOpen = false;
      });
      window.addEventListener('toast', (e) => this.pushToast(e.detail.msg, e.detail.type));
      window.addEventListener('signed-out', () => this.setUser(null));
      // A plugin's own screen (or the Plugin Manager) enabling/disabling one changes the Applications group (and Plugin Manager sits under Settings).
      window.addEventListener('plugins-changed', () => this.loadPlugins());
      try {
        const info = await api('GET', '/public/info');
        this.siteName = info.siteName;
        this.branding = info.login || null;
        this.passwordReset = meta.passwordReset = !!info.passwordReset;
        meta.passwordMinLength = info.passwordMinLength ?? meta.passwordMinLength;
        document.title = `${info.siteName} · Admin`;
      } catch {
        /* login page still works without the name */
      }
      try {
        const me = await api('GET', '/auth/me');
        auth.csrf = me.csrfToken;
        this.setUser(me.user);
        await this.loadTypes();
        await this.loadPlugins();
        await this.loadModuleState();
      } catch {
        /* not signed in */
      }
      this.syncRoute();
      this.ready = true;
      this.openResetLink();
      this.$watch('view', () => this.applyFavicon());
      this.applyFavicon();
    },

    /** Swaps the browser-tab icon to Settings → Login page's favicon while a sign-in screen is shown. */
    applyFavicon() {
      const link = document.querySelector('link[rel="icon"]');
      if (!link) return;
      if (!this._defaultFavicon) this._defaultFavicon = link.href;
      const wantsBranding = ['login', 'forgot', 'reset'].includes(this.view);
      link.href = (wantsBranding && this.branding?.faviconUrl) || this._defaultFavicon;
    },

    setUser(u) {
      auth.user = u;
      this.user = u;
      if (!u) auth.csrf = null;
    },

    syncRoute() {
      const [first, second] = this.parts;
      const key =
        (first || 'overview') === 'content'
          ? `content/${second || ''}`
          : first === 'help'
            ? `help/${second || 'administration'}`
            : first || 'overview';
      // Plugin Editor is reached from a button in Plugin Manager, not its own nav link (still permission-gated),
      // the same "reachable but not listed" shape 'account' already has.
      const ok =
        key === 'account' ||
        (key === 'pluginEditor' && this.can('plugins.manage')) ||
        this.navRoutes.includes(key);
      this.route = ok ? first || 'overview' : 'overview';
      this.path = ok ? key : 'overview';
      // Landing on a screen (link, reload, back button) opens its group so the menu shows where you are.
      const home = this.nav.find((n) => n.items?.some((c) => c.id === this.path));
      if (home && !this.openGroups.includes(home.id))
        this.openGroups = [...this.openGroups, home.id];
    },

    // ───────── media picker (used by the editor and the media library) ─────────
    openPicker(resolve) {
      this.picker = { open: true, items: [], busy: false, error: '', q: '', resolve };
      this.loadPicker();
    },
    async loadPicker() {
      try {
        const qs = new URLSearchParams({
          limit: '60',
          ...(this.picker.q ? { q: this.picker.q } : {}),
        });
        this.picker.items = (await api('GET', `/admin/media?${qs}`)).items;
      } catch (e) {
        this.picker.error = e.message;
      }
    },
    async pickerUpload(files) {
      this.picker.busy = true;
      this.picker.error = '';
      try {
        for (const f of files)
          await api('POST', `/admin/media?name=${encodeURIComponent(f.name)}`, f);
        await this.loadPicker();
      } catch (e) {
        this.picker.error = e.message;
      } finally {
        this.picker.busy = false;
      }
    },
    choose(item) {
      this.picker.resolve?.(item);
      this.picker.open = false;
    },
    closePicker() {
      this.picker.resolve?.(null);
      this.picker.open = false;
    },
    thumb,

    async signIn() {
      this.login.busy = true;
      this.login.error = '';
      try {
        const out = await api('POST', '/auth/login', {
          email: this.login.email,
          password: this.login.password,
        });
        auth.csrf = out.csrfToken;
        if (
          !out.user.permissions.some((p) => p === '*' || p === 'admin.access' || p === 'admin.*')
        ) {
          await api('POST', '/auth/logout');
          this.login.error = "This account doesn't have access to the admin.";
          return;
        }
        this.login.password = '';
        // loadTypes() before setUser(): `ready` is already true on the login screen, so setUser() alone flips
        // `view` straight to 'app' and mounts the shell — loading types after that point is too late for
        // anything that reads contentTypes/meta.contentTypes at mount (the nav's Content group, Overview's
        // content KPI). The session cookie from the login response above already authenticates this call.
        await this.loadTypes();
        await this.loadPlugins();
        await this.loadModuleState();
        this.setUser(out.user);
        this.syncRoute();
      } catch (e) {
        this.login.error = e.message;
      } finally {
        this.login.busy = false;
      }
    },

    async submitForgot() {
      this.forgot.busy = true;
      this.forgot.error = '';
      try {
        await api('POST', '/auth/forgot', { email: this.forgot.email });
        this.forgot.sent = true;
      } catch (e) {
        this.forgot.error = e.message;
      } finally {
        this.forgot.busy = false;
      }
    },

    /** Reset links look like #/reset/<token>. Read the token, then take it out of the address bar. */
    async openResetLink() {
      const [route, token] = hashParts();
      if (route !== 'reset' || !token) return;
      history.replaceState(null, '', '#/reset');
      this.hash = '#/reset';
      Object.assign(this.reset, {
        token,
        valid: null,
        password: '',
        confirm: '',
        done: false,
        error: '',
      });
      try {
        this.reset.valid = (await api('POST', '/auth/reset/check', { token })).valid;
      } catch {
        this.reset.valid = false;
      }
    },

    async submitReset() {
      this.reset.error = '';
      if (this.reset.password !== this.reset.confirm) {
        this.reset.error = "The two passwords don't match.";
        return;
      }
      this.reset.busy = true;
      try {
        await api('POST', '/auth/reset', {
          token: this.reset.token,
          password: this.reset.password,
        });
        this.reset.done = true;
        this.reset.token = '';
        this.reset.password = this.reset.confirm = '';
        this.setUser(null);
      } catch (e) {
        if (e.code === 'invalid_token') this.reset.valid = false;
        else this.reset.error = e.message;
      } finally {
        this.reset.busy = false;
      }
    },

    async signOut() {
      await api('POST', '/auth/logout').catch(() => {});
      this.setUser(null);
      location.hash = '';
    },

    pushToast(msg, type) {
      const t = { id: ++this._seq, msg, type };
      this.toasts.push(t);
      setTimeout(
        () => (this.toasts = this.toasts.filter((x) => x.id !== t.id)),
        type === 'error' ? 6000 : 3500,
      );
    },
  }));

  // ───────── updates: pull new code and restart, one server at a time ─────────
  Alpine.data('updatesPage', () => ({
    ...H,
    data: null,
    history: [],
    restartAfter: true,
    restarting: {}, // nodeId → { host, role, since } while a server is on its way down and back up
    timer: null,
    tick: 0,
    async init() {
      if (!(await this.mountFragment('updates', 'page'))) return;
      await this.refresh(true);
      this.timer = setInterval(() => this.refresh(), 3000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async refresh(withHistory = false) {
      try {
        this.data = await api('GET', '/admin/updates');
        this.loadSource();
        this.trackRestarts();
        // History changes rarely; read it on load, after an action, and every few ticks.
        if (withHistory || ++this.tick % 5 === 0)
          this.history = (await api('GET', '/admin/updates/history')).entries;
      } catch {
        /* the server that answered may be the one restarting; the next tick tries again */
      }
    },
    /** A server that reports "restarting" is expected to vanish and return under a new id; watch for that. */
    trackRestarts() {
      const nodes = this.data.nodes;
      for (const n of nodes)
        if (n.update?.op === 'restart' && n.update.status === 'running' && !this.restarting[n.id])
          this.restarting[n.id] = { host: n.host, role: n.role, since: Date.now() };
      for (const [id, r] of Object.entries(this.restarting)) {
        const back = nodes.find(
          (n) => n.id !== id && n.host === r.host && n.role === r.role && n.status === 'up',
        );
        const gone = !nodes.some((n) => n.id === id);
        if (gone && back) {
          delete this.restarting[id];
          toast(`${r.host} is back${back.commit ? ' on ' + back.commit.slice(0, 7) : ''}.`);
          this.refresh(true);
        } else if (Date.now() - r.since > 180000) {
          delete this.restarting[id];
          toast(
            `${r.host} hasn't come back after 3 minutes. Check its process supervisor and logs.`,
            'error',
          );
        }
      }
    },
    git(n) {
      return n.update?.git || null;
    },
    self() {
      return this.data?.nodes.find((n) => n.self) || {};
    },
    srcUrl: '',
    srcBranch: '',
    srcLoaded: false,
    /** Fill the source form once from the server's settings; later refreshes must not overwrite what is being typed. */
    loadSource() {
      if (this.srcLoaded || !this.data?.source) return;
      this.srcUrl = this.data.source.url;
      this.srcBranch = this.data.source.branch;
      this.srcLoaded = true;
    },
    sourceDirty() {
      return (
        !!this.data?.source &&
        (this.srcUrl.trim() !== this.data.source.url ||
          this.srcBranch.trim() !== this.data.source.branch)
      );
    },
    async saveSource() {
      try {
        const body = { url: this.srcUrl.trim(), branch: this.srcBranch.trim() };
        await api('PUT', '/admin/updates/source', body);
        toast(`Updates now come from ${body.url} (${body.branch}).`);
        await this.refresh(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    working(n) {
      return n.update?.status === 'running' || !!this.restarting[n.id];
    },
    /** Something the admin can act on: the server is up, idle, and is a git checkout. */
    actionable(n) {
      return n.status === 'up' && !this.working(n) && this.git(n)?.supported !== false;
    },
    state(n) {
      const u = n.update;
      const g = this.git(n);
      if (this.restarting[n.id]) return { label: 'Restarting…', tone: 'warn' };
      if (n.status === 'stale') return { label: 'Not reporting', tone: 'warn' };
      if (u?.status === 'running') return { label: u.step || 'Working…', tone: 'warn' };
      if (u?.status === 'failed') return { label: 'Failed', tone: 'warn' };
      if (!g) return { label: 'Reading…', tone: '' };
      if (!g.supported) return { label: 'Not a git checkout', tone: '' };
      if (g.blocker === 'dirty') return { label: 'Local changes', tone: 'warn' };
      if (n.commit && g.headFull !== n.commit) return { label: 'Restart needed', tone: 'warn' };
      if (g.behind > 0)
        return { label: `${g.behind} update${g.behind === 1 ? '' : 's'} available`, tone: 'warn' };
      return g.fetchedAt
        ? { label: 'Up to date', tone: 'ok' }
        : { label: 'Not checked yet', tone: '' };
    },
    running(n) {
      const g = this.git(n);
      const bits = [n.commit ? n.commit.slice(0, 7) : null, g?.branch, 'v' + n.version];
      return bits.filter(Boolean).join(' · ') + ' · ' + n.role;
    },
    message(n) {
      const u = n.update;
      const g = this.git(n);
      if (this.restarting[n.id]) return 'Waiting for the server to drain, stop and start again.';
      if (u?.message && u.status !== 'idle') return u.message;
      if (g && !g.supported) return g.message;
      if (g?.blocker === 'dirty')
        return 'This checkout has uncommitted changes to tracked files. Commit or stash them before updating.';
      return '';
    },
    incoming(n) {
      return this.git(n)?.incoming || [];
    },
    notes(n) {
      const g = this.git(n);
      if (!g?.behind) return '';
      const parts = [];
      if (g.needsInstall) parts.push('dependency changes');
      if (g.needsMigrate) parts.push('database migrations');
      return parts.length ? 'Includes ' + parts.join(' and ') + '.' : '';
    },
    checkedAt(n) {
      const t = this.git(n)?.fetchedAt;
      return t ? 'Last checked ' + this.ago(t) : '';
    },
    /** Only server in the pool → restarting it takes the site down for a moment. */
    lastServer(n) {
      return (
        this.data.nodes.filter((x) => x.status === 'up' && x.role !== 'worker').length <= 1 &&
        n.role !== 'worker'
      );
    },
    async act(n, action, body, started) {
      try {
        await api('POST', `/admin/updates/nodes/${encodeURIComponent(n.id)}/${action}`, body);
        toast(started);
        await this.refresh(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    check(n) {
      return this.act(n, 'check', undefined, `Checking ${n.host} for updates…`);
    },
    update(n) {
      const restart = this.restartAfter && this.can('system.restart');
      const g = this.git(n);
      const what =
        g?.behind > 0
          ? `Apply ${g.behind} update${g.behind === 1 ? '' : 's'} on ${n.host}`
          : `Update ${n.host}`;
      const tail = restart
        ? this.lastServer(n)
          ? ' and restart it? This is the only web server, so the site is unavailable while it restarts.'
          : ' and restart it? It leaves the load balancer while it restarts.'
        : '? The new code runs after the next restart.';
      if (!confirm(what + tail)) return;
      return this.act(n, 'apply', { restart }, `Updating ${n.host}…`);
    },
    restart(n) {
      const tail = this.lastServer(n)
        ? ' This is the only web server, so the site is unavailable while it restarts.'
        : ' It leaves the load balancer while it restarts.';
      if (!confirm(`Restart ${n.host}?` + tail)) return;
      return this.act(n, 'restart', undefined, `Restarting ${n.host}…`);
    },
    describe(e) {
      const m = e.meta || {};
      const host = m.host || 'a server';
      switch (e.action) {
        case 'updates.apply':
          return m.from === m.to
            ? `${host} was already at ${m.to}${m.restart ? ' and was restarted' : ''}`
            : `${host} updated ${m.from} → ${m.to}${m.restart ? ' and restarted' : ''}`;
        case 'updates.source':
          return `Switched the update source from ${m.from?.url} (${m.from?.branch}) to ${m.to?.url} (${m.to?.branch})`;
        case 'updates.check':
          return `Checked ${host} for updates` + (m.behind ? ` (${m.behind} available)` : '');
        case 'updates.restart':
          return `Restarted ${host}`;
        default:
          return `${host}: ${e.action.replace('updates.', '').replace('_', ' ')} — ${m.message || ''}`;
      }
    },
  }));

  // ───────── content: list of one type ─────────
  Alpine.data('contentList', (typeId) => ({
    ...H,
    typeId,
    entries: [],
    total: 0,
    loaded: false,
    status: '',
    q: '',
    termId: '',
    authorId: '',
    from: '',
    to: '',
    terms: [], // every term of the type's taxonomies, for the category filter
    authors: [],
    offset: 0,
    limit: 25,
    error: '',
    get type() {
      return (
        meta.contentTypes.find((t) => t.id === this.typeId) || {
          label: '',
          plural: '',
          can: {},
          fields: [],
        }
      );
    },
    get filtered() {
      return !!(this.q || this.status || this.termId || this.authorId || this.from || this.to);
    },
    async init() {
      if (!(await this.mountFragment('content', 'list'))) return;
      await this.load();
      // The filters' choices come after the list so a slow one never holds the entries back.
      try {
        for (const t of this.type.taxonomies || [])
          this.terms.push(
            ...(await api('GET', `/admin/content/taxonomies/${t.id}/terms`)).terms.map((x) => ({
              id: x.id,
              name: x.name,
              group: t.plural,
            })),
          );
        this.authors = (await api('GET', '/admin/content/authors')).authors;
      } catch {
        /* the list still works without its filters' choices */
      }
    },
    clearFilters() {
      this.q = this.status = this.termId = this.authorId = this.from = this.to = '';
      return this.load(true);
    },
    async load(reset = false) {
      if (reset) this.offset = 0;
      try {
        const qs = new URLSearchParams({ limit: String(this.limit), offset: String(this.offset) });
        if (this.status) qs.set('status', this.status);
        if (this.q) qs.set('q', this.q);
        if (this.termId) qs.set('termId', this.termId);
        if (this.authorId) qs.set('authorId', this.authorId);
        // A day, in the person's own timezone: from its first millisecond to its last.
        if (this.from) qs.set('from', String(new Date(`${this.from}T00:00:00`).getTime()));
        if (this.to) qs.set('to', String(new Date(`${this.to}T23:59:59.999`).getTime()));
        const r = await api('GET', `/admin/content/types/${this.typeId}/entries?${qs}`);
        this.entries = r.entries;
        this.total = r.total;
        this.error = '';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loaded = true;
      }
    },
    depth: (e) => e.path.split('/').length - 1,
    statusLabel(e) {
      if (e.status === 'scheduled' && e.publishAt)
        return 'Scheduled · ' + new Date(e.publishAt).toLocaleString();
      if (e.status === 'review') return 'Awaiting review';
      return e.status[0].toUpperCase() + e.status.slice(1);
    },
    next() {
      this.offset += this.limit;
      return this.load();
    },
    prev() {
      this.offset = Math.max(0, this.offset - this.limit);
      return this.load();
    },
  }));

  // ───────── content: the editor for one entry ─────────
  Alpine.data('contentEditor', (typeId, id) => ({
    ...H,
    typeId,
    id,
    isNew: id === 'new',
    loading: true,
    entry: null,
    form: {
      title: '',
      slug: '',
      status: 'draft',
      publishAt: '',
      parentId: null,
      termIds: [],
      authorId: null,
      unpublishAt: '',
      data: {},
    },
    slugTouched: false,
    authors: [],
    redirectOld: true, // redirect the old address when a live entry's address changes
    checks: null, // the pre-publish checklist: null = not run yet
    checksBusy: false,
    saveState: '', // '' | saving | saved | error — what autosave and Save last did
    saveNote: '',
    autosaveMs: 5000,
    autosaveTimer: null,
    changeSeq: 0,
    activeId: null, // the block the toolbar acts on
    range: null, // the last selection inside a text block, kept while a toolbar control has focus
    dragging: false,
    uploading: 0,
    cmp: { open: false, a: '', b: 'current', rows: [], busy: false, error: '' },
    design: null, // the active theme's fonts and colours, so the writing area looks like the page
    templates: [],
    tplOpen: false,
    analysis: null, // focus keyword, readability, quality, duplicates and link suggestions
    analysisBusy: false,
    analysisTimer: null,
    serpView: 'desktop',
    device: { open: false, width: 1280, url: '', busy: false, error: '' },
    share: { open: false, hours: 24, url: '', expiresAt: 0, busy: false, copied: false },
    src: { open: false, f: null, text: '', error: '' }, // the whole content as HTML
    md: { open: false, f: null, text: '', error: '', busy: false },
    menu: { open: false, x: 0, y: 0, mode: 'context', f: null, id: null },
    linkDlg: { open: false, url: '', newTab: false, q: '', results: [], note: '' },
    dragFrom: null,
    dragOver: null,
    reviewNote: '',
    parents: [],
    terms: {},
    revisions: [],
    showRevisions: false,
    media: {},
    newTerm: {},
    busy: false,
    error: '',
    errors: {},
    dirty: false,
    get type() {
      return (
        meta.contentTypes.find((t) => t.id === this.typeId) || {
          label: '',
          fields: [],
          taxonomies: [],
          can: {},
        }
      );
    },
    get canPublish() {
      return !!this.type.can?.publish;
    },
    get statuses() {
      return this.canPublish
        ? [
            ['draft', 'Draft'],
            ['review', 'Awaiting review'],
            ['published', 'Published'],
            ['scheduled', 'Scheduled'],
            ['archived', 'Archived'],
          ]
        : [
            ['draft', 'Draft'],
            ['review', 'Awaiting review'],
          ];
    },
    get addressPreview() {
      const slug = this.form.slug || (this.entry?.slug ?? '');
      const parent = this.parents.find((p) => p.id === this.form.parentId);
      const base =
        this.type.routing === 'blog'
          ? '/blog/'
          : this.type.routing === 'root'
            ? '/'
            : `/${this.typeId}/`;
      return base + (parent ? parent.path + '/' : '') + (slug || '…');
    },
    async init() {
      if (!(await this.mountFragment('content', 'edit'))) return;
      try {
        if (this.type.hierarchical) {
          const list = await api('GET', `/admin/content/types/${this.typeId}/entries?limit=200`);
          this.parents = list.entries.filter((e) => String(e.id) !== String(this.id));
        }
        for (const t of this.type.taxonomies || []) {
          this.terms[t.id] = (await api('GET', `/admin/content/taxonomies/${t.id}/terms`)).terms;
          this.newTerm[t.id] = '';
        }
        this.authors = (await api('GET', '/admin/content/authors')).authors;
        if (this.isNew) this.fill(null);
        else this.fill((await api('GET', `/admin/content/entries/${this.id}`)).entry);
        // After the form exists: these only decorate it, and must not race what the writer has typed.
        this.loadDesign();
        this.loadTemplates();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.$nextTick(() => {
          this.dirty = false;
          this.$watch(
            'form',
            () => {
              this.dirty = true;
              this.changeSeq++;
              this.scheduleAutosave();
              this.scheduleAnalysis();
            },
            { deep: true },
          );
          // Choosing to go live is the moment to see what is missing, before pressing Save.
          this.$watch('form.status', (st) => {
            if (st === 'published' || st === 'scheduled') this.runChecks();
          });
        });
        this.onSelection = () => this.rememberSelection();
        document.addEventListener('selectionchange', this.onSelection);
      }
    },
    destroy() {
      clearTimeout(this.autosaveTimer);
      clearTimeout(this.analysisTimer);
      if (this.onSelection) document.removeEventListener('selectionchange', this.onSelection);
    },
    fill(entry) {
      this.entry = entry;
      const data = {};
      for (const f of this.type.fields) {
        const v = entry?.data?.[f.key];
        if (f.type === 'blocks')
          data[f.key] = {
            blocks: (v?.blocks || []).map((b) => {
              if ((b.type === 'image' || b.type === 'download') && b.data.mediaId)
                this.loadMedia(b.data.mediaId);
              return { _id: uid(), _src: false, type: b.type, data: { ...b.data } };
            }),
          };
        else if (f.type === 'list') data[f.key] = v || [];
        else if (f.type === 'boolean') data[f.key] = !!v;
        else if (f.type === 'select') data[f.key] = v ?? f.options?.[0]?.value ?? '';
        else data[f.key] = v ?? (f.type === 'media' ? null : '');
        if (f.type === 'media' && data[f.key]) this.loadMedia(data[f.key]);
      }
      this.form = {
        title: entry?.title || '',
        slug: entry?.slug || '',
        status: entry?.status || 'draft',
        publishAt: entry?.publishAt ? this.toLocal(entry.publishAt) : '',
        parentId: entry?.parentId ?? null,
        termIds: (entry?.terms || []).map((t) => t.id),
        authorId: entry?.authorId ?? auth.user?.id ?? null,
        unpublishAt: entry?.unpublishAt ? this.toLocal(entry.unpublishAt) : '',
        data,
      };
      this.redirectOld = true;
      this.slugTouched = !!entry;
    },
    toLocal(ms) {
      const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 16);
    },
    async loadMedia(mid) {
      if (!mid || this.media[mid]) return;
      try {
        this.media[mid] = (await api('GET', `/admin/media/${mid}`)).item;
      } catch {
        this.media[mid] = { id: mid, filename: '(deleted)', kind: 'file', variants: [] };
      }
    },
    thumb,
    bytes,
    async pick(f) {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.media[item.id] = item;
      this.form.data[f.key] = item.id;
    },
    // — text fields with list values (one per line) —
    listText(f) {
      return (this.form.data[f.key] || []).join('\n');
    },
    setList(f, text) {
      this.form.data[f.key] = text
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    },
    // — the block editor —
    blocksOf(f) {
      return this.form.data[f.key]?.blocks || [];
    },
    addBlock(f, type) {
      const d = {
        paragraph: { text: '' },
        header: { text: '', level: 2 },
        list: { style: 'unordered', items: [] },
        quote: { text: '', caption: '' },
        code: { code: '' },
        delimiter: {},
        image: { mediaId: null, caption: '', alt: '' },
        table: {
          header: true,
          rows: [
            ['', ''],
            ['', ''],
          ],
        },
        callout: { style: 'info', title: '', text: '' },
        embed: { url: '', caption: '', ratio: '16:9' },
        download: { mediaId: null, label: '', look: 'link' },
        button: { text: '', url: '', look: 'primary', newTab: false },
        html: { code: '' },
      }[type];
      const b = { _id: uid(), _src: false, type, data: JSON.parse(JSON.stringify(d)) };
      this.blocksOf(f).push(b);
      this.activeId = b._id;
    },
    duplicateBlock(f, i) {
      const list = this.blocksOf(f);
      const b = list[i];
      const copy = {
        _id: uid(),
        _src: false,
        type: b.type,
        data: JSON.parse(JSON.stringify(b.data)),
      };
      list.splice(i + 1, 0, copy);
      this.activeId = copy._id;
    },
    moveBlock(f, i, d) {
      const list = this.blocksOf(f);
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    },
    removeBlock(f, i) {
      this.blocksOf(f).splice(i, 1);
    },
    blockLines(b) {
      return (b.data.items || []).join('\n');
    },
    setBlockLines(b, text) {
      b.data.items = text
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    },
    /** Keep a contenteditable block's text in sync without rebuilding it (which would move the caret). */
    initRich(el, b) {
      el.innerHTML = b.data.text || '';
    },
    syncRich(el, b) {
      b.data.text = el.innerHTML;
    },
    /** Pasting brings other pages' divs, spans and inline styles into the block and breaks its layout: keep the words only. */
    pastePlain(e, el, b) {
      const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') ?? '';
      if (typeof document.execCommand === 'function')
        document.execCommand('insertText', false, text);
      else el.append(document.createTextNode(text));
      this.syncRich(el, b);
    },
    /**
     * Paste from Word, Google Docs or a web page: headings, lists, links, tables and basic formatting come across as
     * the matching blocks. A short bit of formatted text goes into the paragraph at the caret; anything with structure
     * becomes blocks after it (replacing it when it is empty). With nothing but plain text, the words are kept as-is.
     */
    pasteRich(e, el, b, f) {
      const cd = e.clipboardData || window.clipboardData;
      const html = cd?.getData('text/html') || '';
      const { blocks, images } = html ? pasteToBlocks(html) : { blocks: [], images: 0 };
      if (!blocks.length) return this.pastePlain(e, el, b);
      if (images)
        toast('Pictures in pasted text are not kept. Drop them into the editor to upload them.');
      if (blocks.length === 1 && blocks[0].type === 'paragraph' && b.type === 'paragraph') {
        const t = blocks[0].data.text;
        if (typeof document.execCommand === 'function')
          document.execCommand('insertHTML', false, t);
        else el.innerHTML += t;
        return this.syncRich(el, b);
      }
      const list = this.blocksOf(f);
      const at = list.findIndex((x) => x._id === b._id);
      const made = blocks.map((x) => ({ _id: uid(), _src: false, type: x.type, data: x.data }));
      const empty = b.type === 'paragraph' && !htmlText(b.data.text).trim();
      list.splice(empty ? at : at + 1, empty ? 1 : 0, ...made);
      this.activeId = made[made.length - 1]._id;
      toast(`Pasted ${made.length} block${made.length === 1 ? '' : 's'}.`);
    },
    // — the toolbar: one, fixed at the top of the content, acting on the block you last touched —
    activeBlock(f) {
      return this.blocksOf(f).find((b) => b._id === this.activeId) || null;
    },
    /** Text blocks that hold inline formatting (bold, colour…). */
    richActive(f) {
      const b = this.activeBlock(f);
      return !!b && (b.type === 'paragraph' || b.type === 'callout') && !b._src;
    },
    styleOf(f) {
      const b = this.activeBlock(f);
      if (!b) return '';
      return b.type === 'paragraph' ? 'p' : b.type === 'header' ? 'h' + b.data.level : '';
    },
    /** Paragraph ⇄ heading, in place, keeping the words. */
    setStyle(f, v) {
      const b = this.activeBlock(f);
      if (!b || !v || (b.type !== 'paragraph' && b.type !== 'header')) return;
      const keep = b.data.align ? { align: b.data.align } : {};
      if (v === 'p') {
        if (b.type === 'header') {
          b.data = { text: escHtml(b.data.text), ...keep };
          b.type = 'paragraph';
        }
        return;
      }
      const level = Number(v.slice(1));
      if (b.type === 'paragraph') {
        b.data = { text: htmlText(b.data.text), level, ...keep };
        b.type = 'header';
      } else b.data.level = level;
    },
    setAlign(f, a) {
      const b = this.activeBlock(f);
      if (!b || !['paragraph', 'header', 'quote'].includes(b.type)) return;
      b.data.align = b.data.align === a ? undefined : a;
    },
    toggleSource(f) {
      const b = this.activeBlock(f);
      if (b && (b.type === 'paragraph' || b.type === 'callout')) b._src = !b._src;
    },
    /** A toolbar control takes focus away from the text, so the selection is kept as it moves. */
    rememberSelection() {
      const sel = window.getSelection?.();
      if (!sel || !sel.rangeCount) return;
      const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (node?.closest?.('.rich')) this.range = sel.getRangeAt(0).cloneRange();
    },
    exec(cmd, value) {
      if (typeof document.execCommand !== 'function' || !this.range) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.range);
      document.execCommand(cmd, false, value);
      this.rememberSelection();
    },
    format(cmd) {
      this.exec(cmd);
    },
    colour(v) {
      this.exec('foreColor', v);
    },
    size(v) {
      if (v) this.exec('fontSize', v);
    },
    // — images dropped straight into the content —
    isFileDrag(e) {
      return !!e.dataTransfer?.types && [...e.dataTransfer.types].includes('Files');
    },
    async dropFiles(e, f) {
      this.dragging = false;
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const images = files.filter((x) => /^image\//.test(x.type));
      if (images.length < files.length)
        toast('Only images can be dropped here. Add other files with a Download block.', 'error');
      const list = this.blocksOf(f);
      let at = list.findIndex((b) => b._id === this.activeId);
      at = at < 0 ? list.length : at + 1;
      for (const file of images) {
        this.uploading++;
        try {
          const { item } = await api(
            'POST',
            `/admin/media?name=${encodeURIComponent(file.name)}`,
            file,
          );
          this.media[item.id] = item;
          const b = {
            _id: uid(),
            _src: false,
            type: 'image',
            data: { mediaId: item.id, caption: '', alt: item.alt || '' },
          };
          list.splice(at++, 0, b);
          this.activeId = b._id;
        } catch (err) {
          toast(`${file.name}: ${err.message}`, 'error');
        } finally {
          this.uploading--;
        }
      }
    },
    sizeHint(m) {
      if (!m || !m.size) return '';
      return m.size > 512_000
        ? `${bytes(m.size)} — large. Smaller images load faster; compress it in the Media library.`
        : `${bytes(m.size)} — a good size.`;
    },
    needsAlt(b) {
      const m = this.media[b.data.mediaId];
      return !!b.data.mediaId && !b.data.alt && !(m && m.alt);
    },
    embedOk(url) {
      return /^https:\/\/((www\.|m\.)?youtube\.com\/(watch\?|embed\/)|youtu\.be\/|(player\.)?vimeo\.com\/)/i.test(
        String(url || '').trim(),
      );
    },
    // — a table block —
    addRow(b) {
      b.data.rows.push(new Array(b.data.rows[0]?.length || 2).fill(''));
    },
    addCol(b) {
      if ((b.data.rows[0]?.length || 0) < 12) b.data.rows.forEach((r) => r.push(''));
    },
    removeRow(b, i) {
      if (b.data.rows.length > 1) b.data.rows.splice(i, 1);
    },
    removeCol(b) {
      if ((b.data.rows[0]?.length || 0) > 1) b.data.rows.forEach((r) => r.pop());
    },
    async pickBlockFile(b) {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.media[item.id] = item;
      b.data.mediaId = item.id;
      if (!b.data.label) b.data.label = item.filename.replace(/\.[^.]+$/, '');
    },
    async pickBlockImage(b) {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.media[item.id] = item;
      b.data.mediaId = item.id;
      if (!b.data.alt) b.data.alt = item.alt || '';
    },
    // — the site's look in the writing area —
    async loadDesign() {
      try {
        this.design = await api('GET', '/admin/content/editor-style');
      } catch {
        this.design = null; // the editor works without the theme's look
      }
    },
    get designStyle() {
      const d = this.design;
      if (!d) return '';
      const v = {
        '--ed-ink': d.ink,
        '--ed-bg': d.bg,
        '--ed-accent': d.accent,
        '--ed-line': d.line,
        '--ed-soft': d.soft,
        '--ed-font': d.fontFamily,
        '--ed-size': d.fontSize,
      };
      return Object.entries(v)
        .filter(([, x]) => x)
        .map(([k, x]) => `${k}:${x}`)
        .join(';');
    },
    // — templates —
    get hasBody() {
      return this.type.fields.some((f) => f.type === 'blocks');
    },
    async loadTemplates() {
      if (!this.hasBody || !this.type.can?.write) return;
      try {
        this.templates = (
          await api('GET', `/admin/content/types/${this.typeId}/templates`)
        ).templates;
      } catch {
        this.templates = [];
      }
    },
    applyTemplate(t) {
      const filled = this.type.fields.some((f) => f.type === 'blocks' && this.blocksOf(f).length);
      if (filled && !confirm('Replace what is in the editor with this template?')) return;
      for (const f of this.type.fields) {
        const v = t.data?.[f.key];
        if (v === undefined) continue;
        if (f.type === 'blocks')
          this.form.data[f.key] = {
            blocks: (v.blocks || []).map((b) => ({
              _id: uid(),
              _src: false,
              type: b.type,
              data: JSON.parse(JSON.stringify(b.data)),
            })),
          };
        else if (f.key === 'excerpt' && !this.form.data[f.key]) this.form.data[f.key] = v;
      }
      this.tplOpen = false;
      toast(`Started from “${t.name}”.`);
    },
    async saveAsTemplate() {
      const name = (window.prompt('Name for this template') || '').trim();
      if (!name) return;
      const data = {};
      for (const f of this.type.fields) {
        const v = this.form.data[f.key];
        if (f.type === 'blocks')
          data[f.key] = { blocks: v.blocks.map(({ type, data: d }) => ({ type, data: d })) };
        else if (f.key === 'excerpt') data[f.key] = v;
      }
      try {
        const { template } = await api('POST', `/admin/content/types/${this.typeId}/templates`, {
          name,
          data,
        });
        this.templates.push(template);
        toast(`Saved the template “${name}”.`);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    async deleteTemplate(t) {
      if (!confirm(`Delete the template “${t.name}”? Entries made from it are not affected.`))
        return;
      try {
        await api('DELETE', `/admin/content/templates/${t.id}`);
        this.templates = this.templates.filter((x) => x.id !== t.id);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    // — search preview, focus keyword and writing checks —
    get hasSeoPanel() {
      return this.type.fields.some((f) => f.key === 'seo_title');
    },
    get serp() {
      const d = this.form.data;
      const mobile = this.serpView === 'mobile';
      const clip = (t, n) => (t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…');
      return {
        title: clip((d.seo_title || this.form.title || 'Untitled').trim(), mobile ? 55 : 60),
        desc: clip((d.seo_description || this.suggested || '').trim(), mobile ? 120 : 160),
        host: location.host,
        crumb: this.addressPreview.split('/').filter(Boolean).join(' › '),
      };
    },
    scheduleAnalysis() {
      if (!this.analysis) return; // keeps itself fresh only once someone has asked for it
      clearTimeout(this.analysisTimer);
      this.analysisTimer = setTimeout(() => this.runAnalysis(), 2500);
    },
    async runAnalysis() {
      if (this.analysisBusy) return;
      this.analysisBusy = true;
      this.analysisError = '';
      try {
        const p = this.payload();
        this.analysis = await api('POST', `/admin/content/types/${this.typeId}/analysis`, {
          title: p.title,
          slug: this.form.slug || undefined,
          data: p.data,
          entryId: this.entry?.id,
        });
      } catch (e) {
        this.analysisError = e.message;
        this.analysis ||= {
          keyword: [],
          structure: [],
          readability: { items: [] },
          quality: [],
          duplicates: [],
          links: [],
        };
      } finally {
        this.analysisBusy = false;
      }
    },
    analysisError: '',
    get analysisGroups() {
      const a = this.analysis;
      if (!a) return [];
      const r = a.readability;
      return [
        { key: 'keyword', title: 'Focus keyword', items: a.keyword },
        { key: 'structure', title: 'Headings', items: a.structure },
        {
          key: 'readability',
          title:
            'Readability' +
            (r.score == null ? '' : ` · ${r.score} of 100, ${r.label.toLowerCase()}`),
          items: r.items,
        },
        { key: 'quality', title: 'Content quality', items: a.quality },
      ].filter((g) => g.items?.length);
    },
    statusIcon(st) {
      return (
        {
          good: 'bi-check-circle-fill text-success',
          warn: 'bi-exclamation-triangle-fill text-warning',
          bad: 'bi-x-circle-fill text-danger',
        }[st] || 'bi-info-circle muted'
      );
    },
    /** Link the first mention of a suggested page's title in the text. */
    linkSuggestion(sug) {
      for (const f of this.type.fields.filter((x) => x.type === 'blocks'))
        for (const b of this.blocksOf(f)) {
          if (b.type !== 'paragraph') continue;
          const next = linkFirst(b.data.text, sug.title, sug.url);
          if (!next) continue;
          b.data.text = next;
          const el = document.querySelector(`[data-bid="${b._id}"] .rich`);
          if (el) el.innerHTML = next;
          this.analysis.links = this.analysis.links.filter((x) => x.id !== sug.id);
          return toast(`Linked “${sug.title}”.`);
        }
      toast(
        `“${sug.title}” is not in a paragraph, so there is nothing to link. Select words and use the link button.`,
        'error',
      );
    },
    // — previews: new tab, on devices, and a link for reviewers —
    async previewLink(hours = 1) {
      return api('POST', `/admin/content/entries/${this.id}/preview-link`, { hours });
    },
    async openDevices() {
      this.device.open = true;
      this.device.error = '';
      if (this.device.url) return;
      this.device.busy = true;
      try {
        this.device.url = (await this.previewLink(1)).path;
      } catch (e) {
        this.device.error = e.message;
      } finally {
        this.device.busy = false;
      }
    },
    closeDevices() {
      this.device.open = false;
      this.device.url = ''; // the link is short-lived: ask for a fresh one next time
    },
    async makeShare() {
      this.share.busy = true;
      this.share.copied = false;
      try {
        const r = await this.previewLink(Number(this.share.hours));
        this.share.url = r.url;
        this.share.expiresAt = r.expiresAt;
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        this.share.busy = false;
      }
    },
    async copyShare() {
      try {
        await window.navigator.clipboard.writeText(this.share.url);
        this.share.copied = true;
      } catch {
        document.getElementById('share-url')?.select();
        toast('Press Ctrl+C (or ⌘C) to copy the link.');
      }
    },
    // — approval: writers submit, publishers approve or send back —
    get canSubmitReview() {
      return !this.canPublish && this.form.status === 'draft' && !!this.type.can?.write;
    },
    get inReview() {
      return this.entry?.status === 'review';
    },
    async moveTo(status, note = '') {
      const was = this.form.status;
      this.form.status = status;
      this.reviewNote = note;
      await this.save();
      this.reviewNote = '';
      if (this.saveState === 'error') this.form.status = was;
    },
    submitForReview() {
      return this.moveTo('review');
    },
    approve() {
      return this.moveTo('published');
    },
    requestChanges() {
      const note = window.prompt('What should the writer change? They see this in the history.');
      if (note === null) return;
      return this.moveTo('draft', `Changes requested: ${note.trim() || 'see the content'}`);
    },
    // — the whole content as HTML —
    openSource(f) {
      this.src = { open: true, f: f.key, text: blocksToHtml(this.blocksOf(f)), error: '' };
    },
    applySource() {
      const { blocks, dropped } = sourceToBlocks(this.src.text);
      if (!blocks.length && this.src.text.trim())
        return (this.src.error =
          'Nothing in this HTML could be turned into content. Use paragraphs, headings, lists, tables or quotes.');
      this.form.data[this.src.f] = { blocks: this.made(blocks) };
      this.src.open = false;
      toast(
        dropped
          ? `Applied. ${dropped} part${dropped === 1 ? '' : 's'} could not be kept.`
          : 'Applied.',
      );
    },
    made(blocks) {
      return blocks.map((x) => {
        if ((x.type === 'image' || x.type === 'download') && x.data.mediaId)
          this.loadMedia(x.data.mediaId);
        return { _id: uid(), _src: false, type: x.type, data: x.data };
      });
    },
    // — Markdown —
    openMarkdown(f) {
      this.md = { open: true, f: f.key, text: '', error: '', busy: false };
    },
    async readMarkdownFile(e) {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 400_000)
        return (this.md.error = 'That file is too large. Import it in parts.');
      this.md.text = await file.text();
    },
    async importMarkdown(replace) {
      if (!this.md.text.trim())
        return (this.md.error = 'Paste some Markdown, or choose a .md file.');
      this.md.busy = true;
      this.md.error = '';
      try {
        const { blocks } = await api('POST', '/admin/content/markdown', { markdown: this.md.text });
        if (!blocks.length) return (this.md.error = 'No content was found in that text.');
        const f = this.type.fields.find((x) => x.key === this.md.f);
        if (replace) this.form.data[f.key] = { blocks: this.made(blocks) };
        else this.blocksOf(f).push(...this.made(blocks));
        this.md.open = false;
        toast(`Imported ${blocks.length} block${blocks.length === 1 ? '' : 's'}.`);
      } catch (e) {
        this.md.error = e.message;
      } finally {
        this.md.busy = false;
      }
    },
    // — links: addresses, same tab or new tab, and pages of this site —
    link() {
      this.rememberSelection();
      const picked = this.range ? this.range.toString().trim() : '';
      this.linkDlg = {
        open: true,
        url: '',
        newTab: false,
        q: picked.slice(0, 60),
        results: [],
        note: '',
        text: '',
        collapsed: !picked,
      };
      if (picked) this.searchLinks();
      this.$nextTick(() => document.getElementById('lk-url')?.focus());
    },
    async searchLinks() {
      const q = this.linkDlg.q.trim();
      if (q.length < 2) return (this.linkDlg.results = []);
      try {
        this.linkDlg.results = (
          await api('GET', `/admin/content/link-search?q=${encodeURIComponent(q)}`)
        ).results;
      } catch {
        this.linkDlg.results = [];
      }
    },
    useLink(r) {
      this.linkDlg.url = r.url;
      this.linkDlg.newTab = false;
      if (this.linkDlg.collapsed && !this.linkDlg.text) this.linkDlg.text = r.title;
    },
    applyLink() {
      const d = this.linkDlg;
      const url = d.url.trim();
      if (!/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#|\?)/i.test(url))
        return (d.note =
          'Use https://, mailto: or tel:, or a page on this site such as /about or #section.');
      const rg = this.range;
      const node =
        rg &&
        (rg.commonAncestorContainer.nodeType === 1
          ? rg.commonAncestorContainer
          : rg.commonAncestorContainer.parentElement);
      const host = node?.closest?.('.rich');
      if (!rg || !host) return (d.note = 'Click in the text where the link goes, then try again.');
      const a = document.createElement('a');
      a.setAttribute('href', url);
      if (d.newTab && /^https?:/i.test(url)) a.setAttribute('target', '_blank');
      if (rg.collapsed) a.textContent = d.text.trim() || url;
      else {
        a.appendChild(rg.extractContents());
        a.querySelectorAll('a').forEach((x) => x.replaceWith(...x.childNodes)); // no link inside a link
      }
      rg.insertNode(a);
      this.range = null;
      d.open = false;
      host.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    // — right-click and selected-text options —
    openMenu(e, f, b, mode = 'context') {
      this.activeId = b._id;
      this.rememberSelection();
      this.menu = { open: true, x: e.clientX, y: e.clientY, mode, f, id: b._id };
    },
    /** After a mouse-up or key-up inside text: a small bar appears above whatever is selected. */
    selectionBar(f, b) {
      setTimeout(() => {
        const sel = window.getSelection?.();
        if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim())
          return this.menu.mode === 'bubble' && this.closeMenu();
        const r = sel.getRangeAt(0).getBoundingClientRect?.() || { left: 0, top: 0, width: 0 };
        this.activeId = b._id;
        this.rememberSelection();
        this.menu = {
          open: true,
          x: r.left + r.width / 2,
          y: Math.max(8, r.top - 44),
          mode: 'bubble',
          f,
          id: b._id,
        };
      }, 0);
    },
    closeMenu() {
      this.menu.open = false;
    },
    get menuStyle() {
      const w = this.menu.mode === 'bubble' ? 230 : 220;
      const left = Math.max(
        8,
        Math.min(
          this.menu.x - (this.menu.mode === 'bubble' ? w / 2 : 0),
          window.innerWidth - w - 8,
        ),
      );
      return `left:${left}px;top:${this.menu.y}px`;
    },
    menuDo(action) {
      const f = this.menu.f;
      const list = this.blocksOf(f);
      const b = list.find((x) => x._id === this.menu.id);
      const i = list.indexOf(b);
      this.closeMenu();
      if (!b) return;
      this.activeId = b._id;
      switch (action) {
        case 'bold':
        case 'italic':
        case 'underline':
          return this.format(action);
        case 'link':
          return this.link();
        case 'unlink':
          return this.exec('unlink');
        case 'clear':
          return this.exec('removeFormat');
        case 'p':
        case 'h2':
        case 'h3':
          return this.setStyle(f, action);
        case 'quote':
          if (b.type === 'paragraph' || b.type === 'header') {
            b.data = { text: htmlText(b.data.text), caption: '' };
            b.type = 'quote';
          }
          return;
        case 'duplicate':
          return this.duplicateBlock(f, i);
        case 'up':
          return this.moveBlock(f, i, -1);
        case 'down':
          return this.moveBlock(f, i, 1);
        case 'remove':
          return this.removeBlock(f, i);
      }
    },
    /** One class string: Alpine can't mix objects into a class list. */
    blockClass(i, b) {
      const moving = this.dragFrom !== null && this.dragOver === i;
      return [
        this.activeId === b._id && 'block-active',
        moving && this.dragFrom > i && 'drop-before',
        moving && this.dragFrom < i && 'drop-after',
        b.type === 'header' && 'block-h' + b.data.level,
      ]
        .filter(Boolean)
        .join(' ');
    },
    // — drag a block to a new place —
    dragStart(e, i) {
      this.dragFrom = i;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-cms-block', String(i));
      }
    },
    dragOverBlock(i) {
      if (this.dragFrom !== null) this.dragOver = i;
    },
    dropBlock(f, i) {
      const from = this.dragFrom;
      this.dragFrom = this.dragOver = null;
      if (from === null || from === i) return;
      const list = this.blocksOf(f);
      const [b] = list.splice(from, 1);
      list.splice(i, 0, b);
      this.activeId = b._id;
    },
    dragEnd() {
      this.dragFrom = this.dragOver = null;
    },
    // — taxonomy —
    hasTerm(tid) {
      return this.form.termIds.includes(tid);
    },
    toggleTerm(tid, on) {
      this.form.termIds = on
        ? [...new Set([...this.form.termIds, tid])]
        : this.form.termIds.filter((x) => x !== tid);
    },
    async addTerm(tax) {
      const name = (this.newTerm[tax] || '').trim();
      if (!name) return;
      try {
        const { term } = await api('POST', `/admin/content/taxonomies/${tax}/terms`, { name });
        this.terms[tax] = [...this.terms[tax], term];
        this.toggleTerm(term.id, true);
        this.newTerm[tax] = '';
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    slugFromTitle(title) {
      if (this.slugTouched || !this.isNew) return;
      this.form.slug = title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100);
    },
    payload() {
      const data = {};
      for (const f of this.type.fields) {
        const v = this.form.data[f.key];
        data[f.key] =
          f.type === 'blocks'
            ? { blocks: v.blocks.map(({ type, data: d }) => ({ type, data: d })) }
            : v;
      }
      const body = {
        title: this.form.title,
        status: this.form.status,
        data,
        termIds: this.form.termIds,
        publishAt:
          this.form.status === 'scheduled' && this.form.publishAt
            ? new Date(this.form.publishAt).getTime()
            : null,
      };
      if (this.form.slug) body.slug = this.form.slug;
      if (this.type.hierarchical) body.parentId = this.form.parentId || null;
      if (this.entry) body.version = this.entry.version;
      if (this.type.can?.others && this.form.authorId) body.authorId = Number(this.form.authorId);
      if (this.form.status === 'published' || this.form.status === 'scheduled')
        body.unpublishAt = this.form.unpublishAt ? new Date(this.form.unpublishAt).getTime() : null;
      if (this.addressChanged) body.redirect = this.redirectOld;
      if (this.reviewNote) body.note = this.reviewNote;
      return body;
    },
    /** A live entry whose address is changing: its old address would stop working. */
    get addressChanged() {
      const e = this.entry;
      if (!e || e.status !== 'published') return false;
      const slug = this.form.slug && this.form.slug !== e.slug;
      const moved = this.type.hierarchical && (this.form.parentId || null) !== (e.parentId ?? null);
      return !!(slug || moved);
    },
    // — counters and the suggested description —
    textLen(f) {
      const v = this.form.data[f.key];
      return typeof v === 'string' ? v.length : 0;
    },
    counterText(f) {
      const n = this.textLen(f);
      const max = f.max || 500;
      const hint =
        f.key === 'seo_description' && n
          ? n < 120
            ? ' · a little short'
            : n > 160
              ? ' · search results cut it off'
              : ' · good length'
          : f.key === 'seo_title' && n > 60
            ? ' · search results cut it off'
            : '';
      return `${n} / ${max}${hint}`;
    },
    counterClass(f) {
      const n = this.textLen(f);
      if (f.key === 'seo_description' && n)
        return n < 120 || n > 160 ? 'text-warning' : 'text-success';
      if (f.key === 'seo_title' && n) return n > 60 ? 'text-warning' : 'text-success';
      return n >= (f.max || 500) * 0.95 ? 'text-warning' : 'muted';
    },
    wordCount(f) {
      const words = this.blocksOf(f)
        .map((b) => blockPlain(b).join(' '))
        .join(' ')
        .split(/\s+/)
        .filter(Boolean).length;
      return `${words} word${words === 1 ? '' : 's'}`;
    },
    /** What search engines show when the description is left empty: the summary, else the start of the text. */
    get suggested() {
      const d = this.form.data;
      let text = (d.excerpt || '').trim();
      if (!text)
        for (const f of this.type.fields)
          if (f.type === 'blocks')
            text +=
              ' ' +
              this.blocksOf(f)
                .filter((b) => b.type === 'paragraph')
                .map((b) => htmlText(b.data.text))
                .join(' ');
      text = text.replace(/\s+/g, ' ').trim();
      return text.length <= 155 ? text : text.slice(0, 154).replace(/\s+\S*$/, '') + '…';
    },
    // — the pre-publish checklist —
    async runChecks() {
      if (this.checksBusy) return;
      this.checksBusy = true;
      try {
        const p = this.payload();
        this.checks = (
          await api('POST', `/admin/content/types/${this.typeId}/checks`, {
            title: p.title,
            slug: this.form.slug || undefined,
            data: p.data,
            entryId: this.entry?.id,
          })
        ).checks;
      } catch (e) {
        this.checks = [{ id: 'failed', level: 'error', message: e.message, fix: 'Try again.' }];
      } finally {
        this.checksBusy = false;
      }
    },
    // — autosave: drafts only —
    scheduleAutosave() {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = setTimeout(() => this.autosave(), this.autosaveMs);
    },
    get canAutosave() {
      return (
        !!this.type.can?.write &&
        this.form.status === 'draft' &&
        (!this.entry || this.entry.status === 'draft')
      );
    },
    async autosave() {
      if (!this.dirty || this.busy || !this.canAutosave || !this.form.title.trim()) return;
      const seq = this.changeSeq;
      this.saveState = 'saving';
      try {
        if (!this.entry) {
          const { entry } = await api(
            'POST',
            `/admin/content/types/${this.typeId}/entries`,
            this.payload(),
          );
          this.entry = entry;
          this.isNew = false;
          this.id = String(entry.id);
          // The address now names the entry, without the screen reloading under the writer's cursor.
          history.replaceState(null, '', `#/content/${this.typeId}/${entry.id}`);
        } else {
          const { entry } = await api('PUT', `/admin/content/entries/${this.id}`, {
            ...this.payload(),
            autosave: true,
          });
          this.entry = { ...this.entry, version: entry.version, updatedAt: entry.updatedAt };
        }
        if (seq === this.changeSeq) this.dirty = false;
        this.saveState = 'saved';
        this.saveNote = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        this.saveState = 'error';
        this.saveNote = e.message;
      }
    },
    async save() {
      clearTimeout(this.autosaveTimer);
      this.busy = true;
      this.error = '';
      this.errors = {};
      this.saveState = 'saving';
      try {
        if (this.isNew) {
          const { entry } = await api(
            'POST',
            `/admin/content/types/${this.typeId}/entries`,
            this.payload(),
          );
          toast('Saved.');
          this.dirty = false;
          location.hash = `#/content/${this.typeId}/${entry.id}`;
          return;
        }
        const r = await api('PUT', `/admin/content/entries/${this.id}`, this.payload());
        this.fill(r.entry);
        this.$nextTick(() => (this.dirty = false));
        this.saveState = 'saved';
        this.saveNote = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (r.redirect && !r.redirect.error)
          toast(`Saved. ${r.redirect.from} now redirects to ${r.redirect.to}.`);
        else if (r.redirect)
          toast(`Saved. The old address was not redirected: ${r.redirect.error}`, 'error');
        else toast('Saved.');
      } catch (e) {
        this.saveState = 'error';
        this.saveNote = e.message;
        if (e.field) this.errors[e.field] = e.message;
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async remove() {
      if (!confirm(`Delete “${this.entry.title}”? This can't be undone.`)) return;
      try {
        await api('DELETE', `/admin/content/entries/${this.id}`);
        toast('Deleted.');
        location.hash = `#/content/${this.typeId}`;
      } catch (e) {
        this.error = e.message;
      }
    },
    async preview() {
      try {
        const r = await api('POST', `/admin/content/entries/${this.id}/preview-link`, {});
        if (typeof window.open === 'function') window.open(r.path, '_blank', 'noopener');
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    async loadRevisions() {
      this.showRevisions = !this.showRevisions;
      if (this.showRevisions)
        this.revisions = (
          await api('GET', `/admin/content/entries/${this.id}/revisions`)
        ).revisions;
    },
    async restore(r) {
      if (
        !confirm(
          `Replace the current text with version ${r.version}? The current text stays in the history.`,
        )
      )
        return;
      try {
        const { entry } = await api(
          'POST',
          `/admin/content/entries/${this.id}/revisions/${r.id}/restore`,
          {},
        );
        this.fill(entry);
        this.revisions = (
          await api('GET', `/admin/content/entries/${this.id}/revisions`)
        ).revisions;
        toast(`Restored version ${r.version}.`);
      } catch (e) {
        this.error = e.message;
      }
    },
    // — side-by-side compare of two versions —
    async compare(r) {
      this.cmp = { open: true, a: String(r.id), b: 'current', rows: [], busy: false, error: '' };
      await this.runCompare();
    },
    async runCompare() {
      this.cmp.busy = true;
      this.cmp.error = '';
      try {
        const load = async (id) =>
          id === 'current'
            ? { title: this.entry.title, data: this.entry.data }
            : (await api('GET', `/admin/content/entries/${this.id}/revisions/${id}`)).revision;
        const [a, b] = await Promise.all([load(this.cmp.a), load(this.cmp.b)]);
        this.cmp.rows = diffRows(this.docLines(a), this.docLines(b));
      } catch (e) {
        this.cmp.error = e.message;
      } finally {
        this.cmp.busy = false;
      }
    },
    /** A version as lines of plain text, one per block row, for the diff. */
    docLines(v) {
      const out = [`Title: ${v.title}`];
      for (const f of this.type.fields) {
        const val = v.data?.[f.key];
        if (f.type === 'blocks')
          for (const b of val?.blocks || []) out.push(...blockPlain(b, true));
        else if (f.type === 'list') {
          if (val?.length) out.push(`${f.label}: ${val.join(', ')}`);
        } else if (val !== undefined && val !== null && val !== '' && val !== false)
          out.push(`${f.label}: ${val}`);
      }
      return out;
    },
    closeCompare() {
      this.cmp.open = false;
    },
  }));

  // ───────── media library ─────────
  Alpine.data('mediaPage', () => ({
    ...H,
    items: [],
    total: 0,
    q: '',
    kind: '',
    folder: '', // the folder being browsed ('' = top level)
    viewer: false, // the large document popup
    picked: [], // ids ticked for a move, copy or delete
    bulkFolder: '', // where Move / Copy put them
    folders: [], // every folder: [{ path, files }]
    compress: true, // upload images compressed (the default) or exactly as they are
    current: null,
    usage: 0,
    thumbAt: 1,
    busy: false,
    error: '',
    available: true,
    videoThumbnails: true,
    dragging: false,
    progress: { total: 0, done: 0, failed: [], running: false },
    thumb,
    bytes,
    async init() {
      if (!(await this.mountFragment('media', 'page'))) return;
      await Promise.all([this.load(), this.loadFolders()]);
    },
    async load() {
      const qs = new URLSearchParams({
        limit: '60',
        folder: this.folder,
        ...(this.q ? { q: this.q } : {}),
        ...(this.kind ? { kind: this.kind } : {}),
      });
      const r = await api('GET', `/admin/media?${qs}`);
      this.items = r.items;
      this.total = r.total;
      this.available = r.available;
      this.videoThumbnails = r.videoThumbnails !== false;
    },
    async loadFolders() {
      this.folders = (await api('GET', '/admin/media/folders')).folders;
    },
    async goto(path) {
      this.folder = path;
      this.current = null;
      this.picked = [];
      await this.load();
    },
    crumbs() {
      const parts = this.folder ? this.folder.split('/') : [];
      return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
    },
    /** Folders directly inside the one being browsed, with how many files each holds (subfolders included). */
    subfolders() {
      const base = this.folder ? this.folder + '/' : '';
      return this.folders
        .filter((f) => f.path.startsWith(base) && !f.path.slice(base.length).includes('/'))
        .map((f) => ({
          path: f.path,
          name: f.path.slice(base.length),
          files: this.folders
            .filter((g) => g.path === f.path || g.path.startsWith(f.path + '/'))
            .reduce((n, g) => n + g.files, 0),
        }));
    },
    async newFolder() {
      const name = window.prompt('Folder name' + (this.folder ? ` (inside ${this.folder})` : ''));
      if (!name?.trim()) return;
      try {
        const path = (this.folder ? this.folder + '/' : '') + name.trim();
        await api('POST', '/admin/media/folders', { path });
        await this.loadFolders();
        await this.goto(path);
      } catch (e) {
        this.error = e.message;
      }
    },
    async renameFolder() {
      const name = window.prompt('New folder name', this.folder.split('/').pop());
      if (!name?.trim()) return;
      const to = [...this.folder.split('/').slice(0, -1), name.trim()].join('/');
      try {
        await api('PUT', '/admin/media/folders', { from: this.folder, to });
        await this.loadFolders();
        await this.goto(to);
      } catch (e) {
        this.error = e.message;
      }
    },
    /** A folder can only go when nothing is inside it (subfolders count), and the top level never can. */
    folderEmpty() {
      if (!this.folder) return false;
      return !this.folders
        .filter((f) => f.path === this.folder || f.path.startsWith(this.folder + '/'))
        .some((f) => f.files > 0);
    },
    canFullscreen(m) {
      return m.kind === 'image' || m.kind === 'video' || this.isPdf(m);
    },
    isPdf(m) {
      return m.mime === 'application/pdf';
    },
    isPicked(id) {
      return this.picked.includes(id);
    },
    pick(id) {
      this.picked = this.isPicked(id) ? this.picked.filter((x) => x !== id) : [...this.picked, id];
    },
    pickAll() {
      this.picked = this.picked.length === this.items.length ? [] : this.items.map((m) => m.id);
    },
    /** Move, copy or delete the ticked files. Per-file failures are listed; the rest still go through. */
    async bulk(action) {
      const ids = [...this.picked];
      const n = ids.length;
      const noun = n === 1 ? 'file' : 'files';
      const where = this.bulkFolder || 'the top level';
      if (action === 'delete' && !confirm(`Delete ${n} ${noun}? This can't be undone.`)) return;
      this.error = '';
      try {
        const body = { ids, ...(action === 'delete' ? {} : { folder: this.bulkFolder }) };
        let r = await api('POST', `/admin/media/bulk/${action}`, body);
        const inUse = r.failed.filter((f) => f.code === 'in_use');
        if (
          action === 'delete' &&
          inUse.length &&
          confirm(
            `${inUse.length} of them ${inUse.length === 1 ? 'is' : 'are'} used in entries. Delete anyway? Those spots will be empty.`,
          )
        ) {
          const again = await api('POST', '/admin/media/bulk/delete', {
            ids: inUse.map((f) => f.id),
            force: true,
          });
          r = {
            done: [...r.done, ...again.done],
            failed: [...r.failed.filter((f) => f.code !== 'in_use'), ...again.failed],
          };
        }
        const verb = { move: 'Moved', copy: 'Copied', delete: 'Deleted' }[action];
        if (r.done.length)
          toast(
            `${verb} ${r.done.length} ${r.done.length === 1 ? 'file' : 'files'}${action === 'delete' ? '' : ` to ${where}`}.`,
          );
        if (r.failed.length)
          this.error = `${r.failed.length} could not be ${verb.toLowerCase()}: ${r.failed[0].message}`;
        this.picked = r.failed.map((f) => f.id);
        if (this.current && r.done.includes(this.current.id) && action !== 'copy')
          this.current = null;
        await Promise.all([this.load(), this.loadFolders()]);
      } catch (e) {
        this.error = e.message;
      }
    },
    async removeFolder() {
      if (!confirm(`Delete the folder ${this.folder}? It is empty, so no files are lost.`)) return;
      try {
        await api('DELETE', `/admin/media/folders?path=${encodeURIComponent(this.folder)}`);
        const up = this.folder.split('/').slice(0, -1).join('/');
        await this.loadFolders();
        await this.goto(up);
      } catch (e) {
        this.error = e.message;
      }
    },
    /**
     * Bulk upload: any number of files, three at a time, each landing in the folder being browsed. A file picked through
     * "Upload a folder" keeps its own sub-folders. One bad file is reported and the rest carry on.
     */
    async upload(fileList) {
      const files = [...fileList];
      if (!files.length) return;
      this.error = '';
      this.busy = true;
      this.progress = { total: files.length, done: 0, failed: [], running: true };
      const queue = [...files];
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const rel = f.webkitRelativePath
            ? f.webkitRelativePath.split('/').slice(0, -1).join('/')
            : '';
          const dir = [this.folder, rel].filter(Boolean).join('/');
          const qs = new URLSearchParams({ name: f.name, folder: dir });
          if (!this.compress) qs.set('compress', 'false');
          try {
            await api('POST', `/admin/media?${qs}`, f);
            this.progress.done++;
          } catch (e) {
            this.progress.failed.push({ name: f.name, message: e.message });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      this.progress.running = false;
      this.busy = false;
      const failed = this.progress.failed;
      if (failed.length)
        this.error =
          failed.length === 1
            ? failed[0].message
            : `${failed.length} files could not be uploaded. The reasons are listed below.`;
      // A clean finish clears the bar after a moment; if something failed it stays, with a Dismiss button, to be read.
      if (!failed.length) {
        const mine = this.progress;
        setTimeout(() => {
          if (this.progress === mine)
            this.progress = { total: 0, done: 0, failed: [], running: false };
        }, 1500);
      }
      if (this.progress.done)
        toast(`Uploaded ${this.progress.done} file${this.progress.done === 1 ? '' : 's'}.`);
      await Promise.all([this.load(), this.loadFolders()]);
    },
    async open(item) {
      this.viewer = false;
      this.current = { ...item };
      this.usage = (await api('GET', `/admin/media/${item.id}`)).usage;
    },
    async saveDetails() {
      try {
        const { item } = await api('PUT', `/admin/media/${this.current.id}`, {
          alt: this.current.alt,
          folder: this.current.folder,
        });
        toast('Saved.');
        await Promise.all([this.load(), this.loadFolders()]);
        this.current = item.folder === this.folder || !this.folder ? { ...item } : null;
      } catch (e) {
        this.error = e.message;
      }
    },
    async compressCurrent(mode) {
      const msg =
        mode === 'replace'
          ? 'Compress this image in place? The uncompressed original is replaced and can’t be recovered.'
          : 'Save a compressed copy? The original stays as it is.';
      if (!confirm(msg)) return;
      try {
        const { item } = await api('POST', `/admin/media/${this.current.id}/compress`, { mode });
        toast(mode === 'replace' ? 'Compressed.' : 'Compressed copy saved.');
        await Promise.all([this.load(), this.loadFolders()]);
        this.current = { ...item };
      } catch (e) {
        this.error = e.message;
      }
    },
    async retake() {
      try {
        const { item } = await api('POST', `/admin/media/${this.current.id}/thumbnail`, {
          at: Number(this.thumbAt) || 0,
        });
        this.current = { ...item };
        toast('Thumbnail updated.');
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove() {
      const used = this.usage;
      const msg = used
        ? `This file is used in ${used} entr${used === 1 ? 'y' : 'ies'}. Delete it anyway? Those spots will be empty.`
        : `Delete ${this.current.filename}?`;
      if (!confirm(msg)) return;
      try {
        await api('DELETE', `/admin/media/${this.current.id}${used ? '?force=true' : ''}`);
        this.current = null;
        toast('Deleted.');
        await Promise.all([this.load(), this.loadFolders()]);
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── System → Publish & Git (docs/DECISIONS.md D-117) ─────────
  Alpine.data('publishPage', () => ({
    ...H,
    s: null,
    branches: [],
    branch: '',
    versions: [],
    log: [],
    conflicts: [],
    message: '',
    note: '',
    pushAfter: false,
    busy: false,
    error: '',
    notice: '',
    async init() {
      if (!(await this.mountFragment('publish', 'page'))) return;
      await this.load();
    },
    async load(refresh = false) {
      try {
        const [s, b, v, l] = await Promise.all([
          api('GET', '/admin/publish/status' + (refresh ? '?refresh=true' : '')),
          api('GET', '/admin/publish/branches'),
          api('GET', '/admin/publish/versions'),
          api('GET', '/admin/publish/log'),
        ]);
        this.s = s;
        this.branches = b.branches;
        this.branch = b.current;
        this.versions = v.versions;
        this.log = l.commits;
      } catch (e) {
        this.error = e.message;
      }
    },
    aheadBehind() {
      const s = this.s;
      if (!s || !s.remote) return 'No remote';
      if (s.ahead == null) return 'Not checked yet. Use Check remote.';
      if (!s.ahead && !s.behind) return 'In step with the remote';
      return [s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : '']
        .filter(Boolean)
        .join(' · ');
    },
    kindLabel: (k) =>
      ({
        auto: 'automatic',
        manual: 'committed by hand',
        pull: 'pulled',
        branch: 'branch switch',
        restore: 'restore',
        revert: 'revert',
      })[k] || 'change',
    /** Run one action: show the outcome, refresh the screen, and keep the server's reason when it fails. */
    async run(fn) {
      this.busy = true;
      this.error = '';
      this.notice = '';
      try {
        await fn();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
        await this.load();
      }
    },
    commit() {
      return this.run(async () => {
        const r = await api('POST', '/admin/publish/commit', { message: this.message });
        this.notice = r.clean
          ? 'Nothing to commit: the site matches the last commit.'
          : r.started
            ? 'Tracking started. Later commits record what changes from here.'
            : 'Committed.';
        this.message = '';
      });
    },
    publish() {
      return this.run(async () => {
        const r = await api('POST', '/admin/publish/publish', {
          note: this.note,
          push: this.pushAfter,
        });
        this.notice = `Published v${r.version}. Caches refreshed.` + (r.pushed ? ' Pushed.' : '');
        if (r.pushError) this.error = `Published, but the push did not go through: ${r.pushError}`;
        this.note = '';
      });
    },
    push() {
      return this.run(async () => {
        await api('POST', '/admin/publish/push');
        this.notice = 'Pushed.';
      });
    },
    report(r) {
      this.conflicts = r.conflicts || [];
      if (r.status === 'conflict') {
        this.error = 'Some pages were changed on both sides. Choose which version to keep below.';
        return;
      }
      const bits = {
        up_to_date: 'Already up to date.',
        fast_forwarded: `Pulled ${r.applied} ${r.applied === 1 ? 'file' : 'files'}.`,
        merged: `Merged ${r.applied} ${r.applied === 1 ? 'file' : 'files'} from the remote.`,
      };
      this.notice = bits[r.status] || 'Done.';
      if (r.failed?.length) this.error = r.failed.map((f) => `${f.path}: ${f.reason}`).join(' · ');
    },
    pull(prefer) {
      return this.run(async () =>
        this.report(await api('POST', '/admin/publish/pull', prefer ? { prefer } : {})),
      );
    },
    resolve(prefer) {
      return this.pull(prefer);
    },
    sync() {
      return this.run(async () => {
        const r = await api('POST', '/admin/publish/sync', {});
        this.report(r.pulled);
        if (r.pushed) this.notice += ' Pushed.';
      });
    },
    purge() {
      return this.run(async () => {
        await api('POST', '/admin/publish/purge-cache');
        this.notice = 'Caches refreshed. Visitors will fetch fresh pages and files.';
      });
    },
    switchTo(name) {
      return this.run(async () => {
        const r = await api('POST', '/admin/publish/branch', { name });
        this.notice =
          r.status === 'already_there'
            ? `Already on ${name}.`
            : `Switched to ${name}. ${r.applied} ${r.applied === 1 ? 'file' : 'files'} changed.`;
        if (r.failed?.length)
          this.error = r.failed.map((f) => `${f.path}: ${f.reason}`).join(' · ');
      });
    },
    newBranch() {
      const name = window.prompt('New branch name (it starts from where the site is now)');
      if (!name?.trim()) return;
      return this.run(async () => {
        await api('POST', '/admin/publish/branch', { name: name.trim(), create: true });
        this.notice = `Created and switched to ${name.trim()}.`;
      });
    },
    restore(v) {
      if (
        !confirm(
          `Put the site back as it was at v${v.version}? Anything not committed is committed first, and this is recorded as one change you can undo.`,
        )
      )
        return;
      return this.run(async () => {
        const r = await api('POST', '/admin/publish/restore', { version: v.version });
        this.notice = `Restored v${v.version} (${r.applied} ${r.applied === 1 ? 'file' : 'files'} changed).`;
        if (r.failed?.length)
          this.error = r.failed.map((f) => `${f.path}: ${f.reason}`).join(' · ');
      });
    },
  }));

  // ───────── Automation → Log Manager ─────────
  Alpine.data('logManagerPage', () => ({
    ...H,
    logs: [],
    edit: {}, // id → days to keep, as typed
    age: {}, // id → "older than N days" for a manual prune
    open: '',
    rows: [],
    more: false,
    error: '',
    get current() {
      return this.logs.find((l) => l.id === this.open);
    },
    async init() {
      if (!(await this.mountFragment('logs', 'page'))) return;
      await this.load();
    },
    n(v) {
      return Number(v || 0).toLocaleString();
    },
    async load() {
      try {
        this.apply((await api('GET', '/admin/logs')).logs);
      } catch (e) {
        this.error = e.message;
      }
    },
    apply(logs) {
      this.logs = logs;
      for (const l of logs) {
        this.edit[l.id] = l.retentionDays;
        this.age[l.id] ??= l.retentionDays || 30;
      }
    },
    async view(id) {
      this.open = id;
      this.rows = [];
      const r = await api('GET', `/admin/logs/${id}?limit=50`);
      this.rows = r.rows;
      this.more = r.rows.length === 50;
    },
    async loadMore() {
      const r = await api(
        'GET',
        `/admin/logs/${this.open}?limit=50&before=${this.rows[this.rows.length - 1].id}`,
      );
      this.rows = [...this.rows, ...r.rows];
      this.more = r.rows.length === 50;
    },
    async save(l) {
      this.error = '';
      try {
        this.apply(
          (await api('PUT', `/admin/logs/${l.id}/retention`, { days: Number(this.edit[l.id]) }))
            .logs,
        );
        toast(
          `${l.label} will be kept for ${this.edit[l.id] || 'ever'}${this.edit[l.id] ? ' days' : ''}.`,
        );
      } catch (e) {
        this.error = e.message;
      }
    },
    async prune(l) {
      const d = Number(this.age[l.id]);
      const what =
        d === 0
          ? `Delete every entry in the ${l.label}?`
          : `Delete ${l.label} entries older than ${d} days?`;
      if (!confirm(`${what} This can't be undone.`)) return;
      this.error = '';
      try {
        const r = await api('POST', `/admin/logs/${l.id}/prune`, { days: d });
        toast(`Removed ${this.n(r.deleted)} ${r.deleted === 1 ? 'entry' : 'entries'}.`);
        await this.load();
        if (this.open === l.id) await this.view(l.id);
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── System → AI Usage ─────────
  Alpine.data('aiUsagePage', (kind = 'text') => ({
    ...H,
    kind,
    s: null,
    calls: [],
    from: '',
    to: '',
    provider: '',
    more: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('ai-usage', 'page'))) return;
      await this.load();
    },
    params() {
      const q = { kind: this.kind };
      if (this.from) q.from = String(new Date(this.from).getTime());
      if (this.to) q.to = String(new Date(this.to).getTime() + 86_400_000 - 1);
      return q;
    },
    async load() {
      this.error = '';
      try {
        const q = this.params();
        const recent = { limit: '50', ...q, ...(this.provider ? { provider: this.provider } : {}) };
        const [s, r, m] = await Promise.all([
          api(
            'GET',
            '/admin/ai-usage/summary?' + new URLSearchParams({ ...q, period: this.period }),
          ),
          api('GET', '/admin/ai-usage/recent?' + new URLSearchParams(recent)),
          this.kind === 'text'
            ? api('GET', '/admin/ai-usage/messages?' + new URLSearchParams({ ...q, limit: '50' }))
            : { messages: [] },
        ]);
        this.s = s;
        this.messages = m.messages;
        this.moreMessages = m.messages.length === 50;
        this.calls = r.calls;
        this.more = r.calls.length === 50;
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadMore() {
      const q = {
        limit: '50',
        ...this.params(),
        before: String(this.calls[this.calls.length - 1].id),
        ...(this.provider ? { provider: this.provider } : {}),
      };
      const r = await api('GET', '/admin/ai-usage/recent?' + new URLSearchParams(q));
      this.calls = [...this.calls, ...r.calls];
      this.more = r.calls.length === 50;
    },
    n(v) {
      return Number(v || 0).toLocaleString();
    },
    /** Text models report tokens; image providers report how many images were made. */
    amount(c) {
      return c.units
        ? this.n(c.units) + (c.units === 1 ? ' image' : ' images')
        : this.n(c.input + c.output) + ' tokens';
    },
  }));

  // ───────── AI Usage → by user (text and media are separate reports) ─────────
  Alpine.data('aiUsageUsersPage', (kind = 'text') => ({
    ...H,
    kind,
    s: null,
    messages: [],
    moreMessages: false,
    period: 'day',
    from: '',
    to: '',
    error: '',
    async init() {
      if (!(await this.mountFragment('ai-usage', 'users'))) return;
      await this.load();
    },
    params() {
      const q = { kind: this.kind };
      if (this.from) q.from = String(new Date(this.from).getTime());
      if (this.to) q.to = String(new Date(this.to).getTime() + 86_400_000 - 1);
      return q;
    },
    async load() {
      this.error = '';
      try {
        const q = this.params();
        const [s, m] = await Promise.all([
          api(
            'GET',
            '/admin/ai-usage/summary?' + new URLSearchParams({ ...q, period: this.period }),
          ),
          api('GET', '/admin/ai-usage/messages?' + new URLSearchParams({ ...q, limit: '50' })),
        ]);
        this.s = s;
        this.messages = m.messages;
        this.moreMessages = m.messages.length === 50;
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadMoreMessages() {
      const q = {
        ...this.params(),
        limit: '50',
        before: String(this.messages[this.messages.length - 1].id),
      };
      const r = await api('GET', '/admin/ai-usage/messages?' + new URLSearchParams(q));
      this.messages = [...this.messages, ...r.messages];
      this.moreMessages = r.messages.length === 50;
    },
    n(v) {
      return Number(v || 0).toLocaleString();
    },
  }));

  // ───────── Media Analytics ("Media Usage") ─────────
  Alpine.data('mediaAnalyticsPage', () => ({
    ...H,
    data: null,
    error: '',
    bytes,
    async init() {
      if (!(await this.mountFragment('media', 'analytics'))) return;
      try {
        this.data = await api('GET', '/admin/media/analytics');
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── Media Generator (AI images) ─────────
  Alpine.data('mediaGeneratorPage', () => ({
    ...H,
    providers: [],
    provider: '',
    prompt: '',
    result: null,
    filename: '',
    alt: '',
    busy: false,
    saving: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('media-generator', 'page'))) return;
      try {
        const { providers } = await api('GET', '/admin/media-generator/providers');
        this.providers = providers;
        const first = providers.find((p) => p.configured);
        this.provider = first ? first.id : providers[0]?.id || '';
      } catch (e) {
        this.error = e.message;
      }
    },
    async generate() {
      this.busy = true;
      this.error = '';
      try {
        const { dataUrl } = await api('POST', '/admin/media-generator/generate', {
          provider: this.provider,
          prompt: this.prompt,
        });
        this.result = { dataUrl };
        this.filename = 'generated.png';
        this.alt = this.prompt.trim();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async save() {
      this.saving = true;
      this.error = '';
      try {
        await api('POST', '/admin/media-generator/save', {
          dataUrl: this.result.dataUrl,
          filename: this.filename,
          alt: this.alt,
        });
        toast('Saved to the media library.');
        this.discard();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.saving = false;
      }
    },
    discard() {
      this.result = null;
      this.prompt = '';
      this.filename = '';
      this.alt = '';
    },
  }));

  // ───────── Content → AI Research ─────────
  Alpine.data('researchPage', () => ({
    ...H,
    items: [],
    current: null,
    images: [],
    q: '',
    kind: 'web',
    results: [],
    engine: '',
    searching: false,
    searched: false,
    loaded: false,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('research', 'page'))) return;
      await this.load();
    },
    async load() {
      try {
        this.items = (await api('GET', '/admin/research')).items;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loaded = true;
      }
    },
    async search() {
      this.searching = true;
      this.error = '';
      this.results = [];
      try {
        const r = await api('POST', '/admin/research/search', { query: this.q, kind: this.kind });
        this.results = r.results;
        this.engine = r.engine || '';
        this.searched = true;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.searching = false;
      }
    },
    async saveNote(r) {
      try {
        await api('POST', '/admin/research', {
          title: r.title || r.url,
          topic: this.q,
          summary: r.snippet || r.title || r.url,
          sources: [{ url: r.url, title: r.title }],
        });
        r.saved = true;
        toast('Saved to AI Research.');
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
    },
    async importImage(r) {
      try {
        await api('POST', '/admin/research/import-image', {
          url: r.url,
          name: r.title,
          alt: r.title,
          credit: [r.creator, r.license, r.pageUrl].filter(Boolean).join(', '),
        });
        r.saved = true;
        toast('Saved to the media library.');
      } catch (e) {
        this.error = e.message;
      }
    },
    async open(id) {
      this.error = '';
      try {
        this.current = (await api('GET', `/admin/research/${id}`)).item;
        const got = await Promise.all(
          this.current.mediaIds.map((m) => api('GET', `/admin/media/${m}`).catch(() => null)),
        );
        this.images = got.filter(Boolean).map((r) => r.item);
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove() {
      if (!confirm('Delete this research? The pictures stay in the media library.')) return;
      this.busy = true;
      try {
        await api('DELETE', `/admin/research/${this.current.id}`);
        this.current = null;
        this.images = [];
        await this.load();
        toast('Research deleted.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── categories and tags ─────────
  Alpine.data('termsPage', () => ({
    ...H,
    taxonomies: [],
    terms: {},
    names: {},
    error: '',
    async init() {
      if (!(await this.mountFragment('content', 'terms'))) return;
      this.taxonomies = [
        ...new Map(meta.contentTypes.flatMap((t) => t.taxonomies).map((x) => [x.id, x])).values(),
      ];
      for (const t of this.taxonomies) {
        this.names[t.id] = '';
        this.terms[t.id] = (await api('GET', `/admin/content/taxonomies/${t.id}/terms`)).terms;
      }
    },
    async add(t) {
      try {
        const { term } = await api('POST', `/admin/content/taxonomies/${t.id}/terms`, {
          name: this.names[t.id],
        });
        this.terms[t.id] = [...this.terms[t.id], term].sort((a, b) => a.name.localeCompare(b.name));
        this.names[t.id] = '';
        this.error = '';
      } catch (e) {
        this.error = e.message;
      }
    },
    async rename(t, term) {
      const name = window.prompt(`New name for “${term.name}”`, term.name);
      if (!name || name === term.name) return;
      try {
        await api('PUT', `/admin/content/terms/${term.id}`, { name });
        term.name = name;
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove(t, term) {
      if (
        !confirm(
          `Delete “${term.name}”? It is removed from ${term.uses} ${term.uses === 1 ? 'entry' : 'entries'}; the entries themselves stay.`,
        )
      )
        return;
      try {
        await api('DELETE', `/admin/content/terms/${term.id}`);
        this.terms[t.id] = this.terms[t.id].filter((x) => x.id !== term.id);
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── themes ─────────
  Alpine.data('themesPage', () => ({
    ...H,
    themes: [],
    allowJs: false,
    maxZipMb: 5,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('themes', 'themes'))) return;
      await this.load();
    },
    async load() {
      const r = await api('GET', '/admin/themes');
      this.themes = r.themes;
      this.allowJs = r.allowJs;
      this.maxZipMb = r.maxZipMb;
    },
    async upload(file) {
      if (!file) return;
      this.busy = true;
      this.error = '';
      try {
        const { theme } = await api('POST', '/admin/themes', file);
        toast(`Installed ${theme.name} ${theme.version}.`);
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async activate(t) {
      if (!confirm(`Switch the whole site to “${t.name}”? Every server changes within seconds.`))
        return;
      try {
        this.themes = (await api('POST', `/admin/themes/${t.id}/activate`, {})).themes;
        toast(`${t.name} is now live.`);
      } catch (e) {
        this.error = e.message;
      }
    },
    ...dupTheme,
    duplicate(t) {
      this.openDup(t);
    },
    async dupDone(theme) {
      toast(`Created ${theme.name}. It isn’t live until you make it live.`);
      await this.load();
    },
    async remove(t) {
      if (!confirm(`Remove the theme “${t.name}”?`)) return;
      try {
        await api('DELETE', `/admin/themes/${t.id}`);
        await this.load();
        toast('Removed.');
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── Appearance → Customize: a theme's options + custom CSS, previewed live (D-052) ─────────
  Alpine.data('customizePage', () => ({
    ...H,
    themes: [],
    id: '',
    theme: null,
    fields: [],
    saved: {},
    values: {},
    versions: {},
    errors: {},
    loaded: false,
    saving: false,
    error: '',
    previewPath: '/',
    previewHtml: '',
    previewing: false,
    previewError: '',
    _timer: null,
    _seq: 0,
    get optionFields() {
      return this.fields.filter((f) => f.key !== 'custom_css' && !f.secret);
    },
    get dirty() {
      return this.fields.some(
        (f) => JSON.stringify(this.values[f.key]) !== JSON.stringify(this.saved[f.key]),
      );
    },
    async init() {
      if (!(await this.mountFragment('themes', 'customize'))) return;
      this.themes = (await api('GET', '/admin/themes')).themes;
      const want = hashParts()[1];
      const first =
        this.themes.find((t) => t.id === want) ??
        this.themes.find((t) => t.active) ??
        this.themes[0];
      if (first) await this.open(first.id);
    },
    async open(id) {
      if (this.dirty && !confirm('Discard your unsaved changes?')) return;
      this.error = '';
      try {
        const r = await api('GET', `/admin/themes/${id}/customize`);
        this.id = id;
        this.theme = r.theme;
        this.apply(r.settings);
        this.loaded = true;
        history.replaceState(null, '', `#/customize/${id}`);
        await this.refresh();
      } catch (e) {
        this.error = e.message;
      }
    },
    apply(desc) {
      this.fields = desc.fields;
      const vals = {};
      const versions = {};
      for (const f of desc.fields) {
        vals[f.key] = desc.state[f.key]?.value ?? f.default;
        versions[f.key] = desc.state[f.key]?.version ?? 0;
      }
      this.saved = JSON.parse(JSON.stringify(vals));
      this.values = vals;
      this.versions = versions;
      this.errors = {};
    },
    set(key, v) {
      this.values[key] = v;
      delete this.errors[key];
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.refresh(), 500);
    },
    async refresh() {
      if (!this.id) return;
      const seq = ++this._seq;
      this.previewing = true;
      this.previewError = '';
      try {
        const r = await api('POST', `/admin/themes/${this.id}/preview`, {
          path: this.previewPath || '/',
          values: this.values,
        });
        if (seq !== this._seq) return; // a newer preview is on its way
        this.previewHtml = r.redirect
          ? `<p style="font:14px system-ui;padding:1rem">This address redirects to ${esc(r.redirect.to)}.</p>`
          : r.html;
      } catch (e) {
        if (seq !== this._seq) return;
        this.previewError = e.message;
        if (e.field) this.errors[e.field] = e.message;
      } finally {
        if (seq === this._seq) this.previewing = false;
      }
    },
    async save() {
      this.saving = true;
      this.error = '';
      try {
        const changed = {};
        for (const f of this.fields)
          if (JSON.stringify(this.values[f.key]) !== JSON.stringify(this.saved[f.key]))
            changed[f.key] = this.values[f.key];
        const r = await api('PUT', `/admin/themes/${this.id}/customize`, {
          values: changed,
          versions: Object.fromEntries(Object.keys(changed).map((k) => [k, this.versions[k]])),
        });
        this.apply(r.settings);
        toast(this.theme?.active ? 'Saved. Visitors see it now.' : 'Saved.');
      } catch (e) {
        if (e.field) this.errors[e.field.split('.').pop()] = e.message;
        this.error = e.message;
      } finally {
        this.saving = false;
      }
    },
    discard() {
      this.values = JSON.parse(JSON.stringify(this.saved));
      this.errors = {};
      this.refresh();
    },
  }));

  // ───────── Appearance → Theme editor: one file at a time; built-in themes are read-only (D-052) ─────────
  Alpine.data('themeEditorPage', () => ({
    ...H,
    bytes,
    themes: [],
    id: '',
    editable: false,
    files: [],
    path: '',
    file: null,
    content: '',
    original: '',
    newPath: '',
    loaded: false,
    saving: false,
    error: '',
    get dirty() {
      return !!this.file?.text && this.content !== this.original;
    },
    get required() {
      return this.path === 'theme.json' || this.path === 'layouts/default.html';
    },
    async init() {
      if (!(await this.mountFragment('themes', 'theme-editor'))) return;
      this.themes = (await api('GET', '/admin/themes')).themes;
      const want = hashParts()[1];
      const first =
        this.themes.find((t) => t.id === want) ??
        this.themes.find((t) => t.active && t.source === 'db') ??
        this.themes.find((t) => t.active) ??
        this.themes[0];
      if (first) await this.open(first.id);
    },
    async open(id, keepPath = false) {
      if (!keepPath && this.dirty && !confirm('Discard your unsaved changes to this file?')) return;
      this.error = '';
      try {
        const r = await api('GET', `/admin/themes/${id}/files`);
        this.id = id;
        this.editable = r.editable;
        this.files = r.files;
        this.loaded = true;
        history.replaceState(null, '', `#/theme-editor/${id}`);
        if (!keepPath) {
          this.path = '';
          this.file = null;
          const start = this.files.find((f) => f.path === 'layouts/default.html');
          if (start) await this.select(start.path, true);
        }
      } catch (e) {
        this.error = e.message;
      }
    },
    async select(p, force = false) {
      if (!force && this.dirty && !confirm('Discard your unsaved changes to this file?')) return;
      this.error = '';
      try {
        const { file } = await api(
          'GET',
          `/admin/themes/${this.id}/file?path=${encodeURIComponent(p)}`,
        );
        this.path = p;
        this.file = file;
        this.content = this.original = file.text ? file.content : '';
      } catch (e) {
        this.error = e.message;
      }
    },
    async save() {
      this.saving = true;
      this.error = '';
      try {
        const r = await api(
          'PUT',
          `/admin/themes/${this.id}/file?path=${encodeURIComponent(this.path)}`,
          {
            content: this.content,
          },
        );
        this.files = r.files;
        this.original = this.content;
        toast('Saved. Every server uses it within seconds.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.saving = false;
      }
    },
    async create() {
      const p = this.newPath.trim().replace(/^\/+/, '');
      if (!p) return;
      if (this.files.some((f) => f.path === p)) return this.select(p);
      this.error = '';
      try {
        const r = await api('PUT', `/admin/themes/${this.id}/file?path=${encodeURIComponent(p)}`, {
          content: '',
        });
        this.files = r.files;
        this.newPath = '';
        await this.select(p, true);
      } catch (e) {
        this.error = e.message;
      }
    },
    async upload(f) {
      if (!f) return;
      this.error = '';
      const p = `assets/${f.name}`;
      try {
        const r = await api(
          'POST',
          `/admin/themes/${this.id}/file?path=${encodeURIComponent(p)}`,
          f,
        );
        this.files = r.files;
        toast(`Uploaded ${p}.`);
      } catch (e) {
        this.error = e.message;
      }
    },
    async del() {
      if (!confirm(`Delete ${this.path} from this theme?`)) return;
      this.error = '';
      try {
        const r = await api(
          'DELETE',
          `/admin/themes/${this.id}/file?path=${encodeURIComponent(this.path)}`,
        );
        this.files = r.files;
        this.path = '';
        this.file = null;
        toast('Deleted.');
      } catch (e) {
        this.error = e.message;
      }
    },
    ...dupTheme,
    duplicate() {
      this.openDup(this.themes.find((x) => x.id === this.id) ?? { id: this.id, name: this.id });
    },
    async dupDone(theme) {
      this.themes = (await api('GET', '/admin/themes')).themes;
      toast(`Created ${theme.name}. Make it live under Appearance → Themes when it’s ready.`);
      await this.open(theme.id);
    },
  }));

  // ───────── System → Sitemap (D-053) ─────────
  Alpine.data('sitemapPage', () => ({
    ...H,
    sum: { urls: [], bySource: {} },
    v: { rules: [], extra_urls: [], exclude_types: [] },
    versions: {},
    enabled: true,
    types: [],
    q: '',
    offset: 0,
    loaded: false,
    busy: false,
    error: '',
    freqs: ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'],
    prios: Array.from({ length: 11 }, (_, i) => (i / 10).toFixed(1)),
    toggles: [
      { key: 'include_pages', label: 'The site’s fixed pages' },
      { key: 'include_entries', label: 'Published content, at the address a page gives it' },
      { key: 'include_terms', label: 'Category and tag pages' },
      { key: 'include_images', label: 'Each entry’s featured image' },
    ],
    async init() {
      if (!(await this.mountFragment('sitemap', 'page'))) return;
      this.types = meta.contentTypes;
      await this.load(0, true);
    },
    label(src) {
      if (src === 'page') return 'Site page';
      if (src === 'extra') return 'Extra';
      const [kind, id] = src.split(':');
      if (kind === 'term') return id === 'category' ? 'Category' : id === 'tag' ? 'Tag' : id;
      return this.types.find((t) => t.id === id)?.label ?? id;
    },
    apply(r) {
      const vals = {};
      for (const f of r.settings.fields) {
        vals[f.key] = r.settings.state[f.key]?.value ?? f.default;
        this.versions[f.key] = r.settings.state[f.key]?.version ?? 0;
      }
      vals.rules = (vals.rules || []).map((x) => ({
        pattern: x.pattern,
        exclude: !!x.exclude,
        changefreq: x.changefreq || '',
        priority: typeof x.priority === 'number' ? x.priority.toFixed(1) : '',
      }));
      this.v = vals;
      this.enabled = r.enabled;
    },
    async load(offset = 0, withSettings = false) {
      this.error = '';
      try {
        const qs = new URLSearchParams({ q: this.q, offset: String(offset) });
        const r = await api('GET', `/admin/sitemap?${qs}`);
        this.sum = r.summary;
        this.offset = offset;
        if (withSettings) this.apply(r);
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },
    toggleType(id, on) {
      this.v.exclude_types = on
        ? this.v.exclude_types.filter((x) => x !== id)
        : [...this.v.exclude_types, id];
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        const values = {
          ...this.v,
          rules: this.v.rules
            .filter((x) => x.pattern.trim())
            .map((x) =>
              x.exclude
                ? { pattern: x.pattern.trim(), exclude: true }
                : {
                    pattern: x.pattern.trim(),
                    ...(x.changefreq ? { changefreq: x.changefreq } : {}),
                    ...(x.priority !== '' ? { priority: Number(x.priority) } : {}),
                  },
            ),
        };
        const r = await api('PUT', '/admin/sitemap', { enabled: this.enabled, values });
        this.apply(r);
        this.sum = r.summary;
        this.offset = 0;
        toast('Saved. The sitemap is rebuilt.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async rebuild() {
      this.busy = true;
      try {
        await api('POST', '/admin/sitemap/regenerate', {});
        await this.load(0);
        toast(`Rebuilt: ${this.sum.total} addresses.`);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── System → Libraries: npm packages for the site (D-054) ─────────
  Alpine.data('librariesPage', () => ({
    ...H,
    bytes,
    libraries: [],
    allowScripts: false,
    q: '',
    results: [],
    name: '',
    version: '',
    autoload: true,
    current: null,
    picked: [],
    fileFilter: '',
    report: '',
    mirrors: [],
    mirrorUrl: '',
    mirrorReport: '',
    mirrorBusy: false,
    loaded: false,
    busy: false,
    error: '',
    get shownFiles() {
      const f = this.fileFilter.trim().toLowerCase();
      const files = this.current?.files ?? [];
      return files
        .filter((x) => (f ? x.path.toLowerCase().includes(f) : /\.(css|m?js)$/i.test(x.path)))
        .slice(0, 300);
    },
    get snippet() {
      const p =
        this.picked[0] ??
        this.current?.files.find((x) => /\.css$/.test(x.path))?.path ??
        'file.css';
      return `{{ '${this.current?.name}/${p}' | library_url }}`;
    },
    loadable(p) {
      return /\.css$/i.test(p) || (this.allowScripts && /\.m?js$/i.test(p));
    },
    async init() {
      if (!(await this.mountFragment('libraries', 'page'))) return;
      await this.load();
    },
    async load() {
      const r = await api('GET', '/admin/libraries');
      this.libraries = r.libraries;
      this.allowScripts = r.allowScripts;
      this.mirrors = (await api('GET', '/admin/libraries/mirrors')).mirrors;
      this.loaded = true;
    },
    /** Download a CDN file into the site; its address on this site is then listed to copy. */
    async downloadMirror() {
      this.mirrorBusy = true;
      this.busy = true;
      this.error = '';
      this.mirrorReport = '';
      try {
        const r = await api('POST', '/admin/libraries/mirrors', { url: this.mirrorUrl.trim() });
        this.mirrorUrl = '';
        this.mirrorReport =
          `Use ${r.url}` +
          (r.via === 'npm' ? ' (installed from npm)' : '') +
          (r.note ? ` — ${r.note}` : '') +
          (r.failed?.length
            ? ` — ${r.failed.length} file(s) it refers to could not be downloaded.`
            : '');
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.mirrorBusy = false;
        this.busy = false;
      }
    },
    async removeMirror(m) {
      if (!confirm(`Remove ${m.localUrl}? Pages that use it will lose that file.`)) return;
      try {
        await api('DELETE', `/admin/libraries/mirrors/${m.id}`);
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
    },
    async search() {
      if (!this.q.trim()) return;
      this.busy = true;
      this.error = '';
      try {
        this.results = (
          await api('GET', `/admin/libraries/search?q=${encodeURIComponent(this.q)}`)
        ).results;
        if (!this.results.length) this.error = 'No packages match that search.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async install(name, version) {
      this.busy = true;
      this.error = '';
      this.report = '';
      try {
        const existing = this.libraries.find((l) => l.name === name);
        const { library } = await api('POST', '/admin/libraries', {
          name: name.trim(),
          version: version.trim(),
          ...(existing ? {} : { autoload: this.autoload }),
        });
        toast(`Installed ${library.name} ${library.version}.`);
        this.name = this.version = '';
        this.results = this.results.map((p) =>
          p.name === library.name ? { ...p, installed: library.version } : p,
        );
        await this.load();
        this.configure(
          this.libraries.find((l) => l.name === library.name),
          library,
        );
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async configure(l, full) {
      if (!l) return;
      this.error = '';
      try {
        this.current =
          full ??
          (await api('GET', `/admin/libraries/one?name=${encodeURIComponent(l.name)}`)).library;
        this.picked = [...this.current.include];
        this.fileFilter = '';
      } catch (e) {
        this.error = e.message;
      }
    },
    pick(p, on) {
      this.picked = on ? [...this.picked, p] : this.picked.filter((x) => x !== p);
    },
    async saveFiles() {
      this.busy = true;
      this.error = '';
      try {
        const { library } = await api(
          'PUT',
          `/admin/libraries/one?name=${encodeURIComponent(this.current.name)}`,
          {
            include: this.picked,
          },
        );
        this.current = library;
        await this.load();
        toast('Saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async setAutoload(l, on) {
      this.error = '';
      try {
        await api('PUT', `/admin/libraries/one?name=${encodeURIComponent(l.name)}`, {
          autoload: on,
        });
        await this.load();
        toast(on ? `${l.name} loads on every page.` : `${l.name} no longer loads on every page.`);
      } catch (e) {
        this.error = e.message;
        await this.load();
      }
    },
    async remove(l) {
      if (!confirm(`Remove ${l.name}? Pages that use its files will lose them.`)) return;
      try {
        await api('DELETE', `/admin/libraries/one?name=${encodeURIComponent(l.name)}`);
        if (this.current?.name === l.name) this.current = null;
        await this.load();
        toast('Removed.');
      } catch (e) {
        this.error = e.message;
      }
    },
    async importList(file) {
      if (!file) return;
      this.busy = true;
      this.error = '';
      this.report = '';
      try {
        let doc;
        try {
          doc = JSON.parse(await file.text());
        } catch {
          throw new Error('That file isn’t JSON. Choose a list exported from System → Libraries.');
        }
        const r = await api('POST', '/admin/libraries/import', doc);
        this.report = `Installed ${r.installed.length}${r.installed.length ? ': ' + r.installed.map((x) => `${x.name} ${x.version}`).join(', ') : ''}.`;
        if (r.failed.length)
          this.error = `Not installed: ${r.failed.map((x) => `${x.name} (${x.error})`).join('; ')}`;
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── menus ─────────
  Alpine.data('menusPage', () => ({
    ...H,
    menus: [],
    pages: [],
    name: '',
    title: '',
    items: [],
    newName: '',
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('site', 'menus'))) return;
      await this.load();
      try {
        this.pages = (
          await api('GET', '/admin/content/types/page/entries?limit=200&status=published')
        ).entries;
      } catch {
        this.pages = []; // no permission to list pages: menus can still link to addresses
      }
      if (this.menus.length) this.select(this.menus[0].name);
    },
    async load() {
      this.menus = (await api('GET', '/admin/menus')).menus;
    },
    prep(items) {
      return items.map((i) => ({
        _id: uid(),
        label: i.label,
        kind: i.entryId ? 'entry' : 'url',
        entryId: i.entryId || null,
        url: i.url || '',
        children: this.prep(i.children || []),
      }));
    },
    select(name) {
      const m = this.menus.find((x) => x.name === name);
      this.name = name;
      this.title = m?.title || name;
      this.items = this.prep(m?.items || []);
      this.error = '';
    },
    create() {
      const n = this.newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_');
      if (!n) return;
      if (!this.menus.some((m) => m.name === n)) this.menus.push({ name: n, title: n, items: [] });
      this.newName = '';
      this.select(n);
    },
    /** The tree as a flat list, so it can be drawn with one loop. */
    get flat() {
      const out = [];
      const walk = (list, depth) =>
        list.forEach(
          (item, i) => (out.push({ item, list, i, depth }), walk(item.children, depth + 1)),
        );
      walk(this.items, 0);
      return out;
    },
    add(list = this.items) {
      list.push({
        _id: uid(),
        label: '',
        kind: this.pages.length ? 'entry' : 'url',
        entryId: this.pages[0]?.id ?? null,
        url: '',
        children: [],
      });
    },
    move(row, d) {
      const j = row.i + d;
      if (j < 0 || j >= row.list.length) return;
      [row.list[row.i], row.list[j]] = [row.list[j], row.list[row.i]];
    },
    remove(row) {
      row.list.splice(row.i, 1);
    },
    label(item) {
      if (item.label || item.kind !== 'entry') return item.label;
      return this.pages.find((p) => p.id === item.entryId)?.title || '';
    },
    clean(list) {
      return list.map((i) => ({
        label: i.label || this.label(i),
        ...(i.kind === 'entry' ? { entryId: Number(i.entryId) } : { url: i.url }),
        children: this.clean(i.children),
      }));
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        const { menu } = await api('PUT', `/admin/menus/${this.name}`, {
          title: this.title,
          items: this.clean(this.items),
        });
        this.menus = this.menus.some((m) => m.name === menu.name)
          ? this.menus.map((m) => (m.name === menu.name ? menu : m))
          : [...this.menus, menu];
        toast('Menu saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async del() {
      if (!confirm(`Delete the menu “${this.name}”? Themes that show it will show nothing.`))
        return;
      try {
        await api('DELETE', `/admin/menus/${this.name}`);
        await this.load();
        this.items = [];
        this.name = '';
        toast('Deleted.');
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── page manager ─────────
  Alpine.data('pagesList', () => ({
    ...H,
    ...fileImportExport('pages'),
    pages: [],
    loaded: false,
    // "New …" with AI: describe it, the AI writes and saves it, then the editor opens on it.
    gen: { open: false, description: '', address: '', busy: false, error: '' },
    async init() {
      if (!(await this.mountFragment('site', 'pages-list'))) return;
      await this.load();
    },
    async generate() {
      const g = this.gen;
      g.busy = true;
      g.error = '';
      try {
        const r = await api('POST', '/admin/site/pages/generate', {
          description: g.description.trim(),
          address: g.address.trim() || undefined,
        });
        toast(`Page "${r.address}" created. Review it and save any changes.`);
        Object.assign(g, { open: false, description: '', address: '' });
        location.hash = `#/pages/${encodeURIComponent(r.address)}`;
      } catch (e) {
        g.error = e.message;
      } finally {
        g.busy = false;
      }
    },
    async load() {
      this.pages = (await api('GET', '/admin/site/pages')).pages;
      this.loaded = true;
    },
    addressOf(p) {
      const parts = p.name.split('/');
      if (parts[parts.length - 1] === 'index') parts.pop();
      return `/${parts.join('/')}`;
    },
    entryLabel(p) {
      const f = p.front;
      if (!f) return '–';
      if (f.terms) return `Terms: ${f.terms}`;
      if (f.entry === 'own') return 'Any type with its own address';
      if (f.entry) return f.entry.includes(':') ? `One entry: ${f.entry}` : `Every ${f.entry}`;
      return 'Custom';
    },
    async remove(p) {
      if (!confirm(`Delete the page at ${this.addressOf(p)}?`)) return;
      await api('DELETE', `/admin/site/file?path=${encodeURIComponent(p.path)}`);
      await this.load();
      toast('Page deleted.');
    },
  }));

  Alpine.data('pagesEditor', (name) => ({
    ...H,
    isNew: !name,
    // `path` (pages/<name>.html) is what the store and the API use; `pageName`/the address bar only ever see the name.
    path: name ? `pages/${name}.html` : '',
    pageName: name || '',
    hash: null,
    originalContent: '',
    loaded: false,
    busy: false,
    error: '',
    layouts: [],
    entryTypes: [],
    taxonomies: [],
    components: [],
    front: {
      title: '',
      description: '',
      layout: '',
      noindex: false,
      sitemap: true,
      cache: true,
      limit: '',
      seoImage: null,
      seoType: '',
      twitterCard: '',
      // Page ⇄ module binding (D-069): 'any' writes no "uses" line, 'listed' holds the page to the modules chosen.
      usesMode: 'any',
      usesModules: [],
      usesServices: '',
    },
    usesInfo: { inferred: { modules: [], services: [] }, issues: [], modules: [] },
    seoImageMeta: null,
    thumb,
    shows: 'none',
    showsType: '',
    showsPath: '',
    showsTaxonomy: '',
    mode: 'compose',
    blocks: [],
    newBlockName: '',
    code: '',
    css: '',
    js: '',
    tab: 'general',
    tabs: [
      { id: 'general', label: 'General', icon: 'sliders' },
      { id: 'seo', label: 'SEO', icon: 'search' },
      { id: 'code', label: 'Code', icon: 'code-slash' },
      { id: 'scripts', label: 'Scripts', icon: 'filetype-js' },
      { id: 'style', label: 'Style', icon: 'filetype-css' },
      { id: 'preview', label: 'Preview', icon: 'eye' },
    ],
    device: 'desktop',
    previewParams: {},
    preview: { html: '', busy: false, error: '' },
    /** Liquid errors the last preview found, as editor squiggles: [{ line, col, message }]. */
    codeErrors: [],

    async init() {
      if (!(await this.mountFragment('site', 'pages-edit'))) return;
      const meta = await api('GET', '/admin/site/builder-meta');
      this.layouts = meta.layouts;
      this.entryTypes = meta.entryTypes;
      this.taxonomies = meta.taxonomies;
      this.components = (await api('GET', '/admin/site/components')).components;
      liquidHints.components = this.components.map((c) => ({
        name: c.name,
        title: c.meta?.title || '',
      }));
      liquidHints.apis = [
        ...new Set(this.components.flatMap((c) => (c.meta?.api ?? []).map((a) => a.name))),
      ];
      if (this.isNew) {
        this.originalContent = this.content();
        // chosen in the Templates panel on the Pages list (one use only: a reload starts blank)
        const picked = window.__pageTemplate;
        window.__pageTemplate = null;
        if (picked) this.applyTemplate(picked);
      } else await this.load();
      this.loaded = true;
      this.$watch(
        () =>
          JSON.stringify([
            this.pageName,
            this.front,
            this.shows,
            this.showsType,
            this.showsPath,
            this.showsTaxonomy,
            this.mode,
            this.blocks,
            this.code,
            this.css,
            this.js,
            this.previewParams,
          ]),
        () => this.schedulePreview(),
      );
      this.schedulePreview();
    },

    async load() {
      const r = await api('GET', `/admin/site/file?path=${encodeURIComponent(this.path)}`);
      this.hash = r.hash;
      const { front, body } = splitFront(r.content);
      this.front = {
        title: front.title || '',
        description: front.description || '',
        layout: front.layout || '',
        noindex: !!front.noindex,
        sitemap: front.sitemap !== false,
        cache: front.cache !== false,
        limit: front.limit || '',
        seoImage: front.seo_image || null,
        seoType: front.seo_type || '',
        twitterCard: front.twitter_card || '',
        usesMode: front.uses === undefined ? 'any' : 'listed',
        usesModules:
          front.uses === undefined || front.uses === 'none'
            ? []
            : String(front.uses)
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
        usesServices: front.uses_services ? String(front.uses_services) : '',
      };
      this.seoImageMeta = null;
      if (this.front.seoImage) this.loadSeoImageMeta();
      this.shows = 'none';
      this.showsType = '';
      this.showsPath = '';
      this.showsTaxonomy = '';
      if (front.terms) {
        this.shows = 'terms';
        this.showsTaxonomy = front.terms;
      } else if (front.entry === 'own') {
        this.shows = 'own';
      } else if (front.entry && front.entry.includes(':')) {
        const i = front.entry.indexOf(':');
        this.shows = 'fixed';
        this.showsType = front.entry.slice(0, i);
        this.showsPath = front.entry.slice(i + 1);
      } else if (front.entry) {
        this.shows = 'type';
        this.showsType = front.entry;
      }
      const parts = splitPageBody(body);
      const parsed = parseCompose(parts.markup);
      this.code = parts.markup;
      this.css = parts.css;
      this.js = parts.js;
      this.blocks = parsed || [];
      this.mode = parsed ? 'compose' : 'code';
      // What Save would write for an untouched form — so "Unsaved changes" means the author changed something, not that
      // the file was formatted differently by hand.
      this.originalContent = this.content();
      this.error = '';
    },

    async loadSeoImageMeta() {
      try {
        this.seoImageMeta = (await api('GET', `/admin/media/${this.front.seoImage}`)).item;
      } catch {
        this.seoImageMeta = null;
      }
    },
    async pickSeoImage() {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.front.seoImage = item.id;
      this.seoImageMeta = item;
    },
    get dynamicParams() {
      return [...this.pageName.matchAll(/\[(?:\.\.\.)?(\w+)\]/g)].map((m) => m[1]);
    },
    propsOf(name) {
      const props = this.components.find((c) => c.name === name)?.meta?.props;
      return props ? Object.entries(props).map(([key, p]) => ({ key, ...p })) : [];
    },
    componentTitle(name) {
      return this.components.find((c) => c.name === name)?.meta?.title || name;
    },
    addBlock() {
      if (!this.newBlockName) return;
      const args = {};
      for (const p of this.propsOf(this.newBlockName))
        if (p.default !== undefined) args[p.key] = p.default;
      this.blocks.push({ uid: uid(), name: this.newBlockName, args });
      this.newBlockName = '';
    },
    removeBlock(i) {
      this.blocks.splice(i, 1);
    },
    moveBlock(i, d) {
      const j = i + d;
      if (j < 0 || j >= this.blocks.length) return;
      const [b] = this.blocks.splice(i, 1);
      this.blocks.splice(j, 0, b);
    },
    composeBody() {
      return this.blocks.map(renderTag).join('\n');
    },
    toggleCode() {
      if (this.mode === 'compose') {
        this.code = this.composeBody();
        this.mode = 'code';
        return;
      }
      const parsed = parseCompose(this.code.trim());
      if (!parsed) {
        this.error =
          'This page has content that can’t be shown as a list of components (raw markup, Liquid logic…). Keep editing it as code.';
        return;
      }
      this.error = '';
      this.blocks = parsed;
      this.mode = 'compose';
    },

    // The address field is just the address (no pages/ prefix, no .html) — but someone used to naming files may still
    // type ".html" out of habit, so a trailing one is dropped rather than doubled up into a real /about.html address.
    get cleanName() {
      return this.pageName.trim().replace(/\.html?$/i, '');
    },
    fullPath() {
      return `pages/${this.cleanName}.html`;
    },
    buildFront() {
      const f = {};
      if (this.front.title.trim()) f.title = this.front.title.trim();
      if (this.front.description.trim()) f.description = this.front.description.trim();
      if (this.front.layout) f.layout = this.front.layout;
      if (this.front.noindex) f.noindex = true;
      if (!this.front.sitemap) f.sitemap = false;
      if (!this.front.cache) f.cache = false;
      if (this.front.limit) f.limit = this.front.limit;
      if (this.front.seoImage) f.seo_image = this.front.seoImage;
      if (this.front.seoType) f.seo_type = this.front.seoType;
      if (this.front.twitterCard) f.twitter_card = this.front.twitterCard;
      if (this.front.usesMode === 'listed') {
        f.uses = this.front.usesModules.length ? this.front.usesModules.join(', ') : 'none';
        if (this.front.usesServices.trim() && this.front.usesModules.includes('services'))
          f.uses_services = this.front.usesServices.trim();
      }
      if (this.shows === 'type' && this.showsType) f.entry = this.showsType;
      else if (this.shows === 'own') f.entry = 'own';
      else if (this.shows === 'fixed' && this.showsType && this.showsPath.trim())
        f.entry = `${this.showsType}:${this.showsPath.trim()}`;
      else if (this.shows === 'terms' && this.showsTaxonomy) f.terms = this.showsTaxonomy;
      return f;
    },
    content() {
      const lines = Object.entries(this.buildFront()).map(([k, v]) => frontLine(k, v));
      const fm = lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
      return (
        fm +
        joinPageBody({
          markup: this.mode === 'compose' ? this.composeBody() : this.code,
          css: this.css,
          js: this.js,
        })
      );
    },
    get dirty() {
      return !this.isNew && this.content() !== this.originalContent;
    },

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => {
        this.runPreview();
        this.checkUses();
      }, 700);
    },
    /** What this page's components would read, against what the page lists in "uses" (D-069). */
    async checkUses() {
      try {
        this.usesInfo = await api('POST', '/admin/site/uses', { content: this.content() });
      } catch {
        /* an invalid draft is reported by the preview; keep the last good answer */
      }
    },
    /** One click: list exactly the modules the page's components read. */
    useWhatItNeeds() {
      this.front.usesMode = 'listed';
      this.front.usesModules = [...this.usesInfo.inferred.modules];
    },
    toggleUses(id) {
      const m = this.front.usesModules;
      this.front.usesModules = m.includes(id) ? m.filter((x) => x !== id) : [...m, id];
    },
    async runPreview() {
      if (!this.cleanName) return;
      this.preview.busy = true;
      this.preview.error = '';
      try {
        const r = await api('POST', '/admin/site/preview', {
          mode: 'page',
          path: this.fullPath(),
          content: this.content(),
          params: this.previewParams,
        });
        this.preview.html = r.redirect
          ? `<p style="font:14px system-ui;padding:1rem">Redirects to ${r.redirect.to}</p>`
          : r.html;
        this.codeErrors = [];
      } catch (e) {
        this.preview.error = e.message;
        // Liquid reports "…, line:3, col:5": show it where it is. Only the markup is numbered the same as the stored
        // body (it comes first), so a position past its last line is left to the message alone.
        const at = /line:(\d+),?\s*col:(\d+)/.exec(e.message);
        const lines = this.mode === 'code' ? this.code.split('\n').length : 0;
        this.codeErrors =
          at && Number(at[1]) <= lines
            ? [{ line: Number(at[1]), col: Number(at[2]), message: e.message }]
            : [];
      } finally {
        this.preview.busy = false;
      }
    },

    /** The address this page answers at, when it has no varying part. */
    get liveUrl() {
      if (this.isNew || this.dynamicParams.length) return '';
      const n = this.cleanName.replace(/(^|\/)index$/, '');
      return `/${n}`;
    },
    get previewWidth() {
      return { desktop: '100%', tablet: '768px', mobile: '375px' }[this.device];
    },
    /** The Monaco instance behind a code field ($refs name), when it has loaded. */
    monacoOf(ref) {
      return this.$refs[ref]?._monaco ?? null;
    },
    formatCode(ref) {
      this.monacoOf(ref)?.editor.getAction('editor.action.formatDocument')?.run();
    },
    /** Put a `{% render %}` for a component at the cursor (or the end, before the editor has loaded). */
    insertComponent(name) {
      if (!name) return;
      const text = renderTag({ name, args: {} });
      const m = this.monacoOf('codeEd');
      if (m) {
        const sel = m.editor.getSelection();
        m.editor.executeEdits('insert-component', [{ range: sel, text, forceMoveMarkers: true }]);
        m.editor.focus();
      } else this.code = `${this.code.trimEnd()}\n${text}\n`;
      this.newBlockName = '';
    },
    openTab(id) {
      this.tab = id;
      // A hidden Monaco measures 0×0; automaticLayout fixes it on the next frame, but focus needs it to exist.
      if (['code', 'scripts', 'style'].includes(id))
        this.$nextTick(() =>
          this.monacoOf({ code: 'codeEd', scripts: 'jsEd', style: 'cssEd' }[id])?.editor.focus(),
        );
      if (id === 'preview') this.runPreview();
    },

    /** Fill this new page from a template: its address, title, description and code (Code tab, with its style). */
    applyTemplate(t) {
      const parts = splitPageBody(t.body.trim());
      this.pageName = t.name;
      this.front.title = t.front.title || '';
      this.front.description = t.front.description || '';
      this.code = parts.markup;
      if (parts.css) this.css = parts.css;
      if (parts.js) this.js = parts.js;
      this.mode = 'code';
      this.tab = 'code';
      toast('Template applied. Change anything you like, then Save.');
    },

    importFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
        const desc = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(
          text,
        )?.[1];
        const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
        const parts = splitPageBody((bodyMatch ? bodyMatch[1] : text).trim());
        this.code = parts.markup;
        if (parts.css) this.css = parts.css;
        if (parts.js) this.js = parts.js;
        this.mode = 'code';
        this.tab = 'code';
        if (title && !this.front.title) this.front.title = title;
        if (desc && !this.front.description) this.front.description = desc;
      };
      reader.readAsText(file);
    },

    async save() {
      this.error = '';
      if (!this.cleanName) {
        this.error = 'Give the page an address.';
        return;
      }
      this.pageName = this.cleanName; // correct a typed ".html" in the field itself, not just in what gets saved
      this.busy = true;
      try {
        const content = this.content();
        const newPath = this.fullPath();
        if (this.isNew || newPath !== this.path) {
          const r = await api('PUT', '/admin/site/file', { path: newPath, content });
          if (!this.isNew)
            await api('DELETE', `/admin/site/file?path=${encodeURIComponent(this.path)}`);
          this.hash = r.hash;
          history.replaceState(null, '', `#/pages/${encodeURIComponent(this.cleanName)}`);
          this.isNew = false;
          this.path = newPath;
        } else {
          const r = await api('PUT', '/admin/site/file', {
            path: newPath,
            content,
            expectedHash: this.hash,
          });
          this.hash = r.hash;
        }
        this.originalContent = content;
        toast('Page saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async discard() {
      await this.load();
    },
  }));

  // ───────── component builder ─────────
  Alpine.data('componentsList', () => ({
    ...H,
    ...fileImportExport('components'),
    components: [],
    loaded: false,
    // "Import snippet": paste HTML (or a GitHub file link) from HyperUI, PrebuiltUI… and save it as a component (D-106).
    snip: { open: false, html: '', url: '', name: '', title: '', license: '', overwrite: false },
    snipBusy: false,
    snipError: '',
    snipNotes: [],
    // "New component": describe it, the AI writes and saves it, then it opens in the editor.
    gen: { open: false, description: '', name: '', busy: false, error: '' },
    // "Library": browse HyperUI / PrebuiltUI from their open-source repositories, preview, and add several at once.
    lib: {
      open: false,
      sources: [],
      source: '',
      data: null,
      category: '',
      picked: [],
      busy: false,
      error: '',
      overwrite: false,
      notes: [], // what to know about the components just added (pictures swapped, scripts copied…)
      preview: { title: '', html: '', notes: [], busy: false, error: '' },
    },
    async init() {
      if (!(await this.mountFragment('site', 'components-list'))) return;
      await this.load();
    },
    async openLibrary() {
      const l = this.lib;
      l.open = !l.open;
      if (!l.open || l.sources.length) return;
      try {
        l.sources = (await api('GET', '/admin/site/components/catalog')).sources;
        if (l.sources.length) await this.pickSource(l.sources[0].id);
      } catch (e) {
        l.error = e.message;
      }
    },
    async pickSource(id) {
      const l = this.lib;
      l.source = id;
      l.data = null;
      l.picked = [];
      l.error = '';
      l.preview.html = '';
      l.busy = true;
      try {
        l.data = await api(
          'GET',
          `/admin/site/components/catalog?source=${encodeURIComponent(id)}`,
        );
        l.category = l.data.categories[0]?.id || '';
      } catch (e) {
        l.error = e.message;
      } finally {
        l.busy = false;
      }
    },
    libGroups() {
      return this.lib.data?.categories.find((c) => c.id === this.lib.category)?.groups || [];
    },
    libToggle(path) {
      const p = this.lib.picked;
      this.lib.picked = p.includes(path) ? p.filter((x) => x !== path) : [...p, path];
    },
    async libPreview(item) {
      const pv = this.lib.preview;
      Object.assign(pv, { title: item.title, html: '', notes: [], busy: true, error: '' });
      try {
        const c = await api('POST', '/admin/site/components/catalog/convert', {
          source: this.lib.source,
          path: item.path,
        });
        pv.notes = c.notes;
        pv.html = (
          await api('POST', '/admin/site/preview', {
            mode: 'component',
            name: c.name,
            content: c.content,
          })
        ).html;
      } catch (e) {
        pv.error = e.message;
      } finally {
        pv.busy = false;
      }
    },
    async libAdd() {
      const l = this.lib;
      l.busy = true;
      l.error = '';
      l.notes = [];
      try {
        const r = await api('POST', '/admin/site/components/catalog/import', {
          source: l.source,
          paths: l.picked.slice(0, 30),
          overwrite: l.overwrite,
        });
        toast(
          `${r.saved.length} added${r.skipped.length ? `, ${r.skipped.length} already there` : ''}${r.errors.length ? `, ${r.errors.length} failed` : ''}.`,
        );
        if (r.errors.length) l.error = r.errors.map((e) => e.message).join('\n');
        l.notes = r.notes || [];
        l.picked = l.picked.filter((p) => r.errors.some((e) => e.path === p));
        await this.load();
      } catch (e) {
        l.error = e.message;
      } finally {
        l.busy = false;
      }
    },
    async importSnippet() {
      const s = this.snip;
      this.snipBusy = true;
      this.snipError = '';
      this.snipNotes = [];
      try {
        const r = await api('POST', '/admin/site/components/import-snippet', {
          ...(s.html.trim() ? { html: s.html } : { url: s.url.trim() }),
          name: s.name.trim() || undefined,
          title: s.title.trim() || undefined,
          license: s.license.trim() || undefined,
          overwrite: s.overwrite,
        });
        toast(r.created ? `Component "${r.name}" added.` : `Component "${r.name}" replaced.`);
        this.snipNotes = r.notes;
        Object.assign(s, { html: '', url: '', name: '', title: '', overwrite: false });
        await this.load();
      } catch (e) {
        this.snipError = e.message;
      } finally {
        this.snipBusy = false;
      }
    },
    async generate() {
      const g = this.gen;
      g.busy = true;
      g.error = '';
      try {
        const r = await api('POST', '/admin/site/components/generate', {
          description: g.description.trim(),
          name: g.name.trim() || undefined,
        });
        toast(`Component "${r.name}" created. Review it and save any changes.`);
        Object.assign(g, { open: false, description: '', name: '' });
        location.hash = `#/components/${encodeURIComponent(r.name)}`;
      } catch (e) {
        g.error = e.message;
      } finally {
        g.busy = false;
      }
    },
    async load() {
      this.components = (await api('GET', '/admin/site/components')).components;
      this.loaded = true;
    },
    async remove(c) {
      if (
        !confirm(
          `Delete the component “${c.name}”? Pages that use it will show nothing where it was.`,
        )
      )
        return;
      await api('DELETE', `/admin/site/file?path=${encodeURIComponent(c.path)}`);
      await this.load();
      toast('Component deleted.');
    },
  }));

  Alpine.data('componentsEditor', (name) => ({
    ...H,
    isNew: !name,
    name: name || '',
    newName: name || '',
    hash: null,
    originalContent: '',
    loaded: false,
    busy: false,
    error: '',
    metaTitle: '',
    metaDescription: '',
    props: [],
    apis: [],
    css: '',
    template: '',
    preview: { html: '', busy: false, error: '' },
    tab: 'general',
    tabs: [
      { id: 'general', label: 'General', icon: 'card-text' },
      { id: 'data', label: 'Properties & data', icon: 'sliders' },
      { id: 'template', label: 'Template', icon: 'code-slash' },
      { id: 'style', label: 'Style', icon: 'palette' },
      { id: 'preview', label: 'Preview', icon: 'eye' },
    ],
    openTab(id) {
      this.tab = id;
    },

    async init() {
      if (!(await this.mountFragment('site', 'components-edit'))) return;
      if (this.isNew) this.originalContent = this.content();
      else await this.load();
      this.loaded = true;
      this.$watch(
        () =>
          JSON.stringify([
            this.newName,
            this.metaTitle,
            this.metaDescription,
            this.props,
            this.apis,
            this.css,
            this.template,
          ]),
        () => this.schedulePreview(),
      );
      this.schedulePreview();
    },

    async load() {
      const r = await api(
        'GET',
        `/admin/site/file?path=${encodeURIComponent(`components/${this.name}.html`)}`,
      );
      this.hash = r.hash;
      const { meta, css, template } = splitComponentFile(r.content);
      this.metaTitle = meta.title || '';
      this.metaDescription = meta.description || '';
      this.props = Object.entries(meta.props || {}).map(([key, p]) => ({
        key,
        type: p.type || 'string',
        label: p.label || '',
        default: p.default ?? '',
      }));
      this.apis = (meta.api || []).map((a) => ({ ...a }));
      this.css = css;
      this.template = template;
      this.originalContent = r.content;
      this.error = '';
    },
    addProp() {
      this.props.push({ key: '', label: '', type: 'string', default: '' });
    },
    removeProp(i) {
      this.props.splice(i, 1);
    },
    addApi() {
      this.apis.push({ name: '', url: '/api/public/', required: false });
    },
    removeApi(i) {
      this.apis.splice(i, 1);
    },

    buildMeta() {
      const props = {};
      for (const p of this.props) {
        if (!p.key.trim()) continue;
        const entry = { type: p.type || 'string' };
        if (p.label.trim()) entry.label = p.label.trim();
        if (p.default !== '' && p.default !== undefined && p.default !== null)
          entry.default =
            p.type === 'number'
              ? Number(p.default)
              : p.type === 'boolean'
                ? !!p.default
                : p.default;
        props[p.key.trim()] = entry;
      }
      const api = this.apis
        .filter((a) => a.name?.trim() && a.url?.trim())
        .map((a) => ({ name: a.name.trim(), url: a.url.trim(), required: !!a.required }));
      const meta = {};
      if (this.metaTitle.trim()) meta.title = this.metaTitle.trim();
      if (this.metaDescription.trim()) meta.description = this.metaDescription.trim();
      if (Object.keys(props).length) meta.props = props;
      if (api.length) meta.api = api;
      return meta;
    },
    content() {
      const meta = this.buildMeta();
      const parts = [];
      if (Object.keys(meta).length)
        parts.push(
          `<script type="application/json" data-cms="meta">\n${JSON.stringify(meta, null, 2)}\n</script>`,
        );
      if (this.css.trim()) parts.push(`<style>\n${this.css.trim()}\n</style>`);
      parts.push(this.template);
      return parts.join('\n');
    },
    get dirty() {
      return !this.isNew && this.content() !== this.originalContent;
    },

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.runPreview(), 700);
    },
    async runPreview() {
      if (!this.newName.trim()) return;
      this.preview.busy = true;
      this.preview.error = '';
      try {
        // The preview shows each property at its declared default; there is nowhere else defaults would come from
        // until a real page sets them, so trying a different value means editing the default and looking again.
        const props = Object.fromEntries(
          this.props.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.default ?? '']),
        );
        const r = await api('POST', '/admin/site/preview', {
          mode: 'component',
          name: this.newName.trim(),
          content: this.content(),
          props,
        });
        this.preview.html = r.html;
      } catch (e) {
        this.preview.error = e.message;
      } finally {
        this.preview.busy = false;
      }
    },

    async save() {
      this.error = '';
      if (!this.newName.trim()) {
        this.error = 'Give the component a name.';
        return;
      }
      this.busy = true;
      try {
        const content = this.content();
        const path = `components/${this.newName.trim()}.html`;
        if (this.isNew || this.newName.trim() !== this.name) {
          const r = await api('PUT', '/admin/site/file', { path, content });
          if (!this.isNew)
            await api(
              'DELETE',
              `/admin/site/file?path=${encodeURIComponent(`components/${this.name}.html`)}`,
            );
          this.hash = r.hash;
          this.isNew = false;
          this.name = this.newName.trim();
          history.replaceState(null, '', `#/components/${encodeURIComponent(this.name)}`);
        } else {
          const r = await api('PUT', '/admin/site/file', {
            path,
            content,
            expectedHash: this.hash,
          });
          this.hash = r.hash;
        }
        this.originalContent = content;
        toast('Component saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async discard() {
      await this.load();
    },
  }));

  // ───────── services ─────────
  Alpine.data('servicesList', () => ({
    ...H,
    services: [],
    loaded: false,
    // "New …" with AI: describe it, the AI writes and saves it, then the editor opens on it.
    gen: { open: false, description: '', busy: false, error: '' },
    importBusy: false,
    importError: '',
    async init() {
      if (!(await this.mountFragment('services', 'list'))) return;
      await this.load();
    },
    async generate() {
      const g = this.gen;
      g.busy = true;
      g.error = '';
      try {
        const r = await api('POST', '/admin/services/generate', {
          description: g.description.trim(),
        });
        toast(`Service "${r.slug}" created. Review it and save any changes.`);
        Object.assign(g, { open: false, description: '' });
        location.hash = `#/services/${encodeURIComponent(r.slug)}`;
      } catch (e) {
        g.error = e.message;
      } finally {
        g.busy = false;
      }
    },
    async load() {
      this.services = (await api('GET', '/admin/services')).services;
      this.loaded = true;
    },
    async remove(s) {
      if (
        !confirm(
          `Delete the service "${s.name}"? Anything reading it will get 404 instead of data.`,
        )
      )
        return;
      await api('DELETE', `/admin/services/${encodeURIComponent(s.slug)}`);
      await this.load();
      toast('Service deleted.');
    },
    async importZip(file) {
      if (!file) return;
      this.importBusy = true;
      this.importError = '';
      try {
        const r = await api('POST', '/admin/services/import', file);
        toast(
          `Import finished: ${r.created} created, ${r.updated} updated.${r.errors.length ? ` ${r.errors.length} failed.` : ''}`,
        );
        this.importError = r.errors.length
          ? r.errors.map((e) => `${e.path}: ${e.message}`).join('\n')
          : '';
        await this.load();
      } catch (e) {
        this.importError = e.message;
      } finally {
        this.importBusy = false;
      }
    },
  }));

  Alpine.data('servicesEditor', (slug) => ({
    ...H,
    isNew: !slug,
    slug: slug || '',
    newSlug: slug || '',
    name: '',
    description: '',
    mode: 'query',
    access: 'public',
    enabled: false,
    // query mode, source: content type
    qSource: 'type',
    qType: '',
    qTermId: '',
    qSort: 'newest',
    qPerPageDefault: 10,
    qPerPageMax: 50,
    qFields: [],
    // query mode, source: database table/view (services.sql)
    tTable: '',
    tColumns: [],
    tAvailableColumns: [],
    tWhere: [],
    tParams: [],
    tSortColumn: '',
    tSortDir: 'asc',
    tPerPageDefault: 10,
    tPerPageMax: 50,
    // sql mode
    sSql: '',
    sParams: [],
    sRowLimit: '',
    // script mode
    scCode: '',
    entryTypes: [],
    tables: [],
    loaded: false,
    busy: false,
    error: '',
    originalContent: '',
    preview: { result: null, busy: false, error: '' },

    async init() {
      if (!(await this.mountFragment('services', 'edit'))) return;
      const meta = await api('GET', '/admin/services/meta');
      this.entryTypes = meta.entryTypes;
      this.tables = meta.tables;
      if (this.isNew) this.originalContent = JSON.stringify(this.content());
      else await this.load();
      this.loaded = true;
      this.$watch(
        () => JSON.stringify(this.content()),
        () => this.schedulePreview(),
      );
      this.schedulePreview();
    },

    async load() {
      const r = await api('GET', `/admin/services/${encodeURIComponent(this.slug)}`);
      this.name = r.name;
      this.description = r.description;
      this.mode = r.mode;
      this.access = r.access;
      this.enabled = r.enabled;
      if (r.mode === 'query' && r.config.source === 'table') {
        this.qSource = 'table';
        this.tTable = r.config.table;
        this.tColumns = [...r.config.columns];
        this.tWhere = (r.config.where || []).map((w) => ({ ...w }));
        this.tParams = (r.config.params || []).map((p) => ({ ...p }));
        this.tSortColumn = r.config.sort?.column ?? '';
        this.tSortDir = r.config.sort?.dir ?? 'asc';
        this.tPerPageDefault = r.config.perPage.default;
        this.tPerPageMax = r.config.perPage.max;
        await this.loadTableColumns(this.tTable);
      } else if (r.mode === 'query') {
        this.qSource = 'type';
        this.qType = r.config.type;
        this.qTermId = r.config.termId ?? '';
        this.qSort = r.config.sort;
        this.qPerPageDefault = r.config.perPage.default;
        this.qPerPageMax = r.config.perPage.max;
        this.qFields = r.config.fields || [];
      } else if (r.mode === 'sql') {
        this.sSql = r.config.sql;
        this.sParams = (r.config.params || []).map((p) => ({ ...p }));
        this.sRowLimit = r.config.rowLimit ?? '';
      } else {
        this.scCode = r.config.code;
      }
      this.originalContent = JSON.stringify(this.content());
      this.error = '';
    },

    fieldsOf(typeId) {
      return this.entryTypes.find((t) => t.id === typeId)?.fields || [];
    },
    toggleField(key) {
      this.qFields = this.qFields.includes(key)
        ? this.qFields.filter((k) => k !== key)
        : [...this.qFields, key];
    },
    async loadTableColumns(table) {
      this.tAvailableColumns = [];
      if (!table) return;
      try {
        this.tAvailableColumns = (
          await api('GET', `/admin/services/tables/${encodeURIComponent(table)}/columns`)
        ).columns;
      } catch {
        this.tAvailableColumns = [];
      }
    },
    async onTableChange() {
      this.tColumns = [];
      this.tWhere = [];
      this.tSortColumn = '';
      await this.loadTableColumns(this.tTable);
    },
    toggleColumn(key) {
      this.tColumns = this.tColumns.includes(key)
        ? this.tColumns.filter((k) => k !== key)
        : [...this.tColumns, key];
    },
    addWhere() {
      this.tWhere.push({ column: '', param: '' });
    },
    removeWhere(i) {
      this.tWhere.splice(i, 1);
    },
    addTableParam() {
      this.tParams.push({ name: '', type: 'string', required: false });
    },
    removeTableParam(i) {
      this.tParams.splice(i, 1);
    },
    addParam() {
      this.sParams.push({ name: '', type: 'string', required: false });
    },
    removeParam(i) {
      this.sParams.splice(i, 1);
    },

    buildConfig() {
      if (this.mode === 'query' && this.qSource === 'table') {
        const c = {
          source: 'table',
          table: this.tTable,
          columns: this.tColumns,
          where: this.tWhere.filter((w) => w.column && w.param),
          params: this.tParams
            .filter((p) => p.name.trim())
            .map((p) => ({ name: p.name.trim(), type: p.type, required: !!p.required })),
          perPage: {
            default: Number(this.tPerPageDefault) || 10,
            max: Number(this.tPerPageMax) || 50,
          },
        };
        if (this.tSortColumn) c.sort = { column: this.tSortColumn, dir: this.tSortDir };
        return c;
      }
      if (this.mode === 'query') {
        const c = {
          source: 'type',
          type: this.qType,
          sort: this.qSort,
          perPage: {
            default: Number(this.qPerPageDefault) || 10,
            max: Number(this.qPerPageMax) || 50,
          },
        };
        if (this.qTermId !== '') c.termId = Number(this.qTermId);
        if (this.qFields.length) c.fields = this.qFields;
        return c;
      }
      if (this.mode === 'sql') {
        const c = {
          sql: this.sSql,
          params: this.sParams
            .filter((p) => p.name.trim())
            .map((p) => ({ name: p.name.trim(), type: p.type, required: !!p.required })),
        };
        if (this.sRowLimit !== '') c.rowLimit = Number(this.sRowLimit);
        return c;
      }
      return { code: this.scCode };
    },
    content() {
      return {
        slug: this.newSlug.trim(),
        name: this.name.trim(),
        description: this.description.trim(),
        mode: this.mode,
        access: this.access,
        enabled: this.enabled,
        config: this.buildConfig(),
      };
    },
    get dirty() {
      return !this.isNew && JSON.stringify(this.content()) !== this.originalContent;
    },
    get canPreview() {
      if (!this.newSlug.trim()) return false;
      if (this.mode === 'query')
        return this.qSource === 'table' ? this.tTable && this.tColumns.length : this.qType;
      if (this.mode === 'sql') return this.sSql.trim();
      return this.scCode.trim();
    },

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.runPreview(), 700);
    },
    async runPreview() {
      if (!this.canPreview) return;
      this.preview.busy = true;
      this.preview.error = '';
      try {
        this.preview.result = await api('POST', '/admin/services/preview', this.content());
      } catch (e) {
        this.preview.error = e.message;
        this.preview.result = null;
      } finally {
        this.preview.busy = false;
      }
    },

    async save() {
      this.error = '';
      if (!this.newSlug.trim()) {
        this.error = 'Give the service a slug.';
        return;
      }
      this.busy = true;
      try {
        const body = this.content();
        if (this.isNew) {
          await api('POST', '/admin/services', body);
          history.replaceState(null, '', `#/services/${encodeURIComponent(body.slug)}`);
          this.isNew = false;
        } else {
          await api('PUT', `/admin/services/${encodeURIComponent(this.slug)}`, body);
          if (body.slug !== this.slug)
            history.replaceState(null, '', `#/services/${encodeURIComponent(body.slug)}`);
        }
        this.slug = body.slug;
        this.originalContent = JSON.stringify(this.content());
        toast('Service saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async discard() {
      await this.load();
    },
  }));

  // ───────── SEO Manager (docs/DECISIONS.md D-049): per-URL SEO override rules ─────────
  Alpine.data('seoList', () => ({
    ...H,
    rules: [],
    loaded: false,
    async init() {
      if (!(await this.mountFragment('seo', 'list'))) return;
      await this.load();
    },
    async load() {
      this.rules = (await api('GET', '/admin/seo/rules')).rules;
      this.loaded = true;
    },
    async remove(r) {
      if (!confirm(`Delete the SEO rule for "${r.pattern}"?`)) return;
      await api('DELETE', `/admin/seo/rules/${r.id}`);
      await this.load();
      toast('Rule deleted.');
    },
  }));

  Alpine.data('seoRuleEditor', (id) => ({
    ...H,
    isNew: !id,
    id: id || null,
    pattern: '',
    priority: 0,
    enabled: true,
    title: '',
    description: '',
    image: null,
    imageMeta: null,
    thumb,
    type: '',
    noindexMode: 'inherit', // 'inherit' | 'yes' | 'no' — inherit leaves whatever the page would otherwise say
    nofollowMode: 'inherit',
    canonical: '',
    twitterCard: '',
    metaTags: [], // [{kind: 'name'|'property', key, content}]
    ldJsonText: '[]',
    loaded: false,
    busy: false,
    error: '',
    aiHint: '',
    aiBusy: false,
    aiError: '',
    aiNote: '',

    async init() {
      if (!(await this.mountFragment('seo', 'edit'))) return;
      if (!this.isNew) await this.load();
      this.loaded = true;
    },
    async load() {
      const { rule } = await api('GET', `/admin/seo/rules/${this.id}`);
      this.pattern = rule.pattern;
      this.priority = rule.priority;
      this.enabled = rule.enabled;
      this.title = rule.title || '';
      this.description = rule.description || '';
      this.image = rule.image || null;
      this.type = rule.type || '';
      this.noindexMode = rule.noindex === undefined ? 'inherit' : rule.noindex ? 'yes' : 'no';
      this.nofollowMode = rule.nofollow === undefined ? 'inherit' : rule.nofollow ? 'yes' : 'no';
      this.canonical = rule.canonical || '';
      this.twitterCard = rule.twitterCard || '';
      this.metaTags = (rule.metaTags || []).map((m) => ({
        kind: m.name ? 'name' : 'property',
        key: m.name || m.property,
        content: m.content,
      }));
      this.ldJsonText = JSON.stringify(rule.ldJson || [], null, 2);
      if (this.image) this.loadImageMeta();
    },
    async loadImageMeta() {
      try {
        this.imageMeta = (await api('GET', `/admin/media/${this.image}`)).item;
      } catch {
        this.imageMeta = null;
      }
    },
    async pickImage() {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.image = item.id;
      this.imageMeta = item;
    },
    addMetaTag() {
      this.metaTags.push({ kind: 'name', key: '', content: '' });
    },
    removeMetaTag(i) {
      this.metaTags.splice(i, 1);
    },

    /** Fill the form with the AI's suggestion. Nothing is saved: the person reads it, changes it and saves. */
    async suggest() {
      this.aiBusy = true;
      this.aiError = '';
      this.aiNote = '';
      try {
        const r = await api('POST', '/admin/seo/suggest', {
          pattern: this.pattern.trim(),
          hint: this.aiHint.trim() || undefined,
        });
        this.title = r.title;
        this.description = r.description;
        this.type = r.type;
        this.twitterCard = r.twitterCard;
        if (r.ldJson.length) this.ldJsonText = JSON.stringify(r.ldJson, null, 2);
        this.aiNote = `Filled in${r.ldJson.length ? ', with structured data' : ''}${
          r.readPage ? ' from the page’s text' : ' from your description'
        }. Read it, change what you like, then save the rule.`;
      } catch (e) {
        this.aiError = e.message;
      } finally {
        this.aiBusy = false;
      }
    },

    buildBody() {
      const body = {
        pattern: this.pattern.trim(),
        priority: Number(this.priority) || 0,
        enabled: this.enabled,
        metaTags: this.metaTags
          .filter((m) => m.key.trim() && m.content.trim())
          .map((m) => ({ [m.kind]: m.key.trim(), content: m.content.trim() })),
        ldJson: JSON.parse(this.ldJsonText || '[]'),
      };
      if (this.title.trim()) body.title = this.title.trim();
      if (this.description.trim()) body.description = this.description.trim();
      if (this.image) body.image = this.image;
      if (this.type) body.type = this.type;
      if (this.noindexMode !== 'inherit') body.noindex = this.noindexMode === 'yes';
      if (this.nofollowMode !== 'inherit') body.nofollow = this.nofollowMode === 'yes';
      if (this.canonical.trim()) body.canonical = this.canonical.trim();
      if (this.twitterCard) body.twitterCard = this.twitterCard;
      return body;
    },
    async save() {
      this.error = '';
      if (!this.pattern.trim()) {
        this.error = 'Give the rule a pattern, starting with /.';
        return;
      }
      let body;
      try {
        body = this.buildBody();
      } catch {
        this.error = 'The extra structured data (JSON-LD) isn’t valid JSON.';
        return;
      }
      this.busy = true;
      try {
        if (this.isNew) {
          const { rule } = await api('POST', '/admin/seo/rules', body);
          this.id = rule.id;
          this.isNew = false;
          history.replaceState(null, '', `#/seo/${rule.id}`);
        } else {
          await api('PUT', `/admin/seo/rules/${this.id}`, body);
        }
        toast('Rule saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── System → API (docs/DECISIONS.md D-068): the reference, the OpenAPI links, and API keys ─────────
  Alpine.data('apiPage', () => ({
    ...H,
    tab: 'keys', // 'keys' | 'reference'
    keys: [],
    ref: null,
    loaded: false,
    form: null, // the key being created or edited
    secret: '', // shown once, right after create or rotate
    error: '',
    busy: false,

    async init() {
      if (!(await this.mountFragment('api', 'page'))) return;
      await this.load();
    },
    async load() {
      this.ref = await api('GET', '/admin/api-reference');
      this.keys = (await api('GET', '/admin/api-keys')).keys;
      this.loaded = true;
    },
    blank() {
      return {
        id: null,
        name: '',
        allModules: true,
        scopes: [],
        writes: [], // modules this key may also write to ("content" means content:write)
        rateLimit: 600,
        enabled: true,
        expires: '',
      };
    },
    startNew() {
      this.secret = '';
      this.error = '';
      this.form = this.blank();
    },
    edit(k) {
      this.secret = '';
      this.error = '';
      this.form = {
        id: k.id,
        name: k.name,
        allModules: k.scopes.includes('*'),
        scopes: k.scopes.filter((x) => x !== '*' && !x.endsWith(':write')),
        writes: k.scopes.filter((x) => x.endsWith(':write')).map((x) => x.slice(0, -6)),
        rateLimit: k.rateLimit,
        enabled: k.enabled,
        expires: k.expiresAt ? new Date(k.expiresAt).toISOString().slice(0, 10) : '',
      };
    },
    toggleScope(id) {
      const s = this.form.scopes;
      this.form.scopes = s.includes(id) ? s.filter((x) => x !== id) : [...s, id];
    },
    toggleWrite(id) {
      const s = this.form.writes;
      this.form.writes = s.includes(id) ? s.filter((x) => x !== id) : [...s, id];
    },
    body() {
      const f = this.form;
      return {
        name: f.name.trim(),
        scopes: [...(f.allModules ? ['*'] : f.scopes), ...f.writes.map((m) => `${m}:write`)],
        rateLimit: Number(f.rateLimit) || 600,
        enabled: f.enabled,
        expiresAt: f.expires ? new Date(`${f.expires}T23:59:59`).getTime() : null,
      };
    },
    async save() {
      this.error = '';
      this.busy = true;
      try {
        if (this.form.id) {
          await api('PUT', `/admin/api-keys/${this.form.id}`, this.body());
          toast('Key saved.');
        } else {
          const r = await api('POST', '/admin/api-keys', this.body());
          this.secret = r.secret;
        }
        this.form = null;
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async rotate(k) {
      if (!confirm(`Rotate “${k.name}”? The current key stops working immediately.`)) return;
      this.secret = (await api('POST', `/admin/api-keys/${k.id}/rotate`, {})).secret;
      await this.load();
    },
    async remove(k) {
      if (!confirm(`Delete “${k.name}”? Anything using it stops working immediately.`)) return;
      await api('DELETE', `/admin/api-keys/${k.id}`);
      await this.load();
    },
    async copy(text) {
      try {
        await window.navigator.clipboard.writeText(text);
        toast('Copied.');
      } catch {
        toast('Copy failed. Select the text and copy it by hand.', 'error');
      }
    },
    statusOf(k) {
      return !k.enabled ? 'Disabled' : k.expired ? 'Expired' : 'Active';
    },
  }));

  // ───────── Settings → Modules (docs/DECISIONS.md D-067): what the platform is made of ─────────
  Alpine.data('modulesPage', () => ({
    ...H,
    modules: [],
    loaded: false,
    open: '',
    async init() {
      if (!(await this.mountFragment('system', 'modules'))) return;
      this.modules = (await api('GET', '/admin/system/modules')).modules;
      this.loaded = true;
    },
    toggle(id) {
      this.open = this.open === id ? '' : id;
    },
    /** The list split by category (D-095), "Platform" first; modules with no category are the platform itself. */
    get groups() {
      const by = new Map();
      for (const m of this.modules) {
        const c = m.category || 'Platform';
        if (!by.has(c)) by.set(c, []);
        by.get(c).push(m);
      }
      return [...by.entries()]
        .sort(([a], [b]) => (a === 'Platform' ? -1 : b === 'Platform' ? 1 : a.localeCompare(b)))
        .map(([name, modules]) => ({ name, modules }));
    },
    error: '',
    busy: '',
    /** Flip a module from what the list says now. The server says what to do first if others need it. */
    async toggleModule(id) {
      const m = this.modules.find((x) => x.id === id);
      if (!m) return;
      const enabled = m.switchedOff;
      this.error = '';
      this.busy = id;
      try {
        await api('PUT', `/admin/system/modules/${id}`, { enabled });
        toast(`${m.label} is ${enabled ? 'on' : 'off'}.`);
        this.modules = (await api('GET', '/admin/system/modules')).modules;
        window.dispatchEvent(new window.Event('modules-changed'));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = '';
      }
    },
  }));

  // ───────── Settings → Features (docs/DECISIONS.md D-100): switch whole subsystems on and off ─────────
  Alpine.data('featuresPage', () => ({
    ...H,
    features: [],
    loaded: false,
    error: '',
    busy: '',
    /** The feature a confirmation is open for, with what the server says switching it would do. */
    asking: null,
    async init() {
      if (!(await this.mountFragment('features', 'page'))) return;
      await this.load();
    },
    async load() {
      this.features = (await api('GET', '/admin/features')).features;
      this.loaded = true;
    },
    label(id) {
      return this.features.find((f) => f.id === id)?.label ?? id;
    },
    /** The labels of a list of feature ids, as one phrase: "Customer accounts, eCommerce". */
    labels(ids) {
      return ids.map((id) => this.label(id)).join(', ');
    },
    /** Ask first: what will change, or what blocks it. */
    async ask(f) {
      this.error = '';
      const enable = !f.enabled;
      try {
        const plan = await api('GET', `/admin/features/${f.id}/plan?enabled=${enable}`);
        this.asking = {
          id: f.id,
          label: f.label,
          enable,
          text: enable ? f.whenOn : f.whenOff,
          pulls: plan.features.filter((x) => x !== f.id),
          blockedBy: plan.blockedBy,
        };
      } catch (e) {
        this.error = e.message;
      }
    },
    cancel() {
      this.asking = null;
    },
    /** A real boolean: Alpine treats '' and 0 as "present" for a disabled attribute. */
    get canConfirm() {
      return !!this.asking && this.asking.blockedBy.length === 0 && !this.busy;
    },
    async confirm() {
      const a = this.asking;
      if (!a || !this.canConfirm) return;
      this.busy = a.id;
      this.error = '';
      try {
        this.features = (
          await api('PUT', `/admin/features/${a.id}`, { enabled: a.enable })
        ).features;
        toast(`${a.label} is ${a.enable ? 'on' : 'off'}.`);
        this.asking = null;
        window.dispatchEvent(new window.Event('modules-changed'));
      } catch (e) {
        this.error = e.message;
        this.asking = null;
      } finally {
        this.busy = '';
      }
    },
  }));

  // ───────── Automation → Events (docs/DECISIONS.md D-050): the log, and firing a test event ─────────
  Alpine.data('eventsPage', () => ({
    ...H,
    tab: 'log', // 'log' | 'fire'
    events: [],
    loaded: false,
    filterName: '',
    fireName: '',
    firePayload: '{}',
    fireError: '',
    fireBusy: false,

    async init() {
      if (!(await this.mountFragment('events', 'page'))) return;
      await this.load();
    },
    async load() {
      const qs = new URLSearchParams(this.filterName ? { name: this.filterName } : {});
      this.events = (await api('GET', `/admin/events?${qs}`)).events;
      this.loaded = true;
    },
    async fire() {
      this.fireError = '';
      let payload;
      try {
        payload = JSON.parse(this.firePayload || '{}');
      } catch {
        this.fireError = 'That isn’t valid JSON.';
        return;
      }
      this.fireBusy = true;
      try {
        await api('POST', '/admin/events/fire', { name: this.fireName.trim(), payload });
        toast('Event fired.');
        await this.load();
        this.tab = 'log';
      } catch (e) {
        this.fireError = e.message;
      } finally {
        this.fireBusy = false;
      }
    },
  }));

  // ───────── Automation → Webhooks (docs/DECISIONS.md D-050) ─────────
  Alpine.data('webhooksList', () => ({
    ...H,
    webhooks: [],
    loaded: false,
    async init() {
      if (!(await this.mountFragment('webhooks', 'list'))) return;
      await this.load();
    },
    async load() {
      this.webhooks = (await api('GET', '/admin/webhooks')).webhooks;
      this.loaded = true;
    },
    async remove(w) {
      if (!confirm(`Delete the webhook "${w.name}"? It will stop receiving events immediately.`))
        return;
      await api('DELETE', `/admin/webhooks/${w.id}`);
      await this.load();
      toast('Webhook deleted.');
    },
  }));

  Alpine.data('webhooksEditor', (id) => ({
    ...H,
    isNew: !id,
    id: id || null,
    name: '',
    event: '',
    enabled: true,
    url: '',
    secret: '',
    hasSecret: false,
    headers: [], // [{name, value}]
    payloadText: '{}',
    deliveries: [],
    loaded: false,
    busy: false,
    error: '',
    testBusy: false,

    async init() {
      if (!(await this.mountFragment('webhooks', 'edit'))) return;
      if (!this.isNew) {
        await this.load();
        await this.loadDeliveries();
      }
      this.loaded = true;
    },
    async load() {
      const { webhook } = await api('GET', `/admin/webhooks/${this.id}`);
      this.name = webhook.name;
      this.event = webhook.event;
      this.enabled = webhook.enabled;
      this.url = webhook.url;
      this.hasSecret = webhook.hasSecret;
      this.headers = webhook.headers || [];
      this.payloadText = JSON.stringify(webhook.payload || {}, null, 2);
    },
    async loadDeliveries() {
      this.deliveries = (await api('GET', `/admin/webhooks/${this.id}/deliveries`)).deliveries;
    },
    addHeader() {
      this.headers.push({ name: '', value: '' });
    },
    removeHeader(i) {
      this.headers.splice(i, 1);
    },

    buildBody() {
      const body = {
        name: this.name.trim(),
        event: this.event.trim(),
        enabled: this.enabled,
        url: this.url.trim(),
        headers: this.headers.filter((h) => h.name.trim() && h.value.trim()),
        payload: JSON.parse(this.payloadText || '{}'),
      };
      if (this.secret.trim()) body.secret = this.secret.trim();
      return body;
    },
    async save() {
      this.error = '';
      if (!this.name.trim() || !this.event.trim() || !this.url.trim()) {
        this.error = 'Give the webhook a name, an event pattern and a URL.';
        return;
      }
      let body;
      try {
        body = this.buildBody();
      } catch {
        this.error = 'The payload isn’t valid JSON.';
        return;
      }
      this.busy = true;
      try {
        if (this.isNew) {
          const { webhook } = await api('POST', '/admin/webhooks', body);
          this.id = webhook.id;
          this.isNew = false;
          this.hasSecret = webhook.hasSecret;
          history.replaceState(null, '', `#/webhooks/${webhook.id}`);
          await this.loadDeliveries();
        } else {
          const { webhook } = await api('PUT', `/admin/webhooks/${this.id}`, body);
          this.hasSecret = webhook.hasSecret;
        }
        this.secret = '';
        toast('Webhook saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async sendTest() {
      this.testBusy = true;
      this.error = '';
      try {
        await api('POST', `/admin/webhooks/${this.id}/test`);
        toast('Test delivery queued.');
        setTimeout(() => this.loadDeliveries(), 500);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.testBusy = false;
      }
    },
  }));

  // ───────── Settings → Plugin Manager (docs/DECISIONS.md D-060, D-102) ─────────
  Alpine.data('pluginsPage', () => ({
    ...H,
    plugins: [],
    loaded: false,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('plugins', 'list'))) return;
      await this.load();
    },
    async load() {
      this.plugins = (await api('GET', '/admin/plugins')).plugins;
      this.loaded = true;
    },
    async upload(file) {
      if (!file) return;
      this.busy = true;
      this.error = '';
      try {
        const { plugin } = await api('POST', '/admin/plugins', file);
        toast(`Installed ${plugin.name} ${plugin.version}.`);
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async rescan() {
      this.busy = true;
      this.error = '';
      try {
        await api('POST', '/admin/plugins/rescan');
        await this.load();
        toast('Looked again at plugins/.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async toggle(p) {
      this.error = '';
      try {
        await api('POST', `/admin/plugins/${p.slug}/${p.enabled ? 'disable' : 'enable'}`);
        await this.load();
        window.dispatchEvent(new CustomEvent('plugins-changed')); // its nav entry may have appeared/disappeared
        toast(p.enabled ? `${p.name} disabled.` : `${p.name} enabled.`);
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove(p) {
      if (!confirm(`Remove the plugin "${p.name}"? This can't be undone.`)) return;
      try {
        await api('DELETE', `/admin/plugins/${p.slug}`);
        await this.load();
        toast('Plugin removed.');
      } catch (e) {
        this.error = e.message;
      }
    },
    exportUrl(p) {
      return `/api/admin/plugins/${p.slug}/export`;
    },
    // Plugin Editor is a button here, not its own nav entry — this starts a session already scoped to the
    // plugin that was clicked, so the chat opens straight into editing it (docs/DECISIONS.md D-063).
    async editWithAi(p) {
      try {
        const { session } = await api('POST', '/admin/plugin-editor/sessions', { slug: p.slug });
        location.hash = '#/pluginEditor/' + session.id;
      } catch (e) {
        this.error = e.message;
      }
    },

    // ───── config (D-061: plugin.json's `config` → a plugin_<slug> settings namespace) ─────
    configSlug: null, // which row's config panel is open, or null
    configFields: [],
    configValues: {},
    configBusy: false,
    configError: '',
    get configPlugin() {
      return this.plugins.find((p) => p.slug === this.configSlug) ?? null;
    },
    async toggleConfig(p) {
      if (this.configSlug === p.slug) {
        this.configSlug = null;
        return;
      }
      this.configError = '';
      try {
        const data = await api('GET', `/admin/plugins/${p.slug}/config`);
        this.configFields = data.fields;
        this.configValues = Object.fromEntries(
          data.fields.map((f) => [f.key, data.state[f.key].value]),
        );
        this.configSlug = p.slug;
      } catch (e) {
        this.error = e.message;
      }
    },
    async saveConfig(p) {
      this.configBusy = true;
      this.configError = '';
      try {
        await api('PUT', `/admin/plugins/${p.slug}/config`, { values: this.configValues });
        toast(`${p.name}'s settings saved.`);
        this.configSlug = null;
      } catch (e) {
        this.configError = e.message;
      } finally {
        this.configBusy = false;
      }
    },
  }));

  // A plugin's own screen: just mounts its admin/index.html (full-trust markup, D-060 — see H.mountPluginFragment).
  Alpine.data('pluginScreen', (slug) => ({
    ...H,
    slug,
    async init() {
      await this.mountPluginFragment(slug);
    },
  }));

  // ───────── Applications → Plugin Editor (docs/DECISIONS.md D-063) ─────────
  Alpine.data('pluginEditorList', () => ({
    ...H,
    sessions: [],
    plugins: [],
    targetSlug: '', // '' = start a brand-new plugin; else edit this existing one
    loaded: false,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('plugin-editor', 'list'))) return;
      await this.load();
      try {
        this.plugins = (await api('GET', '/admin/plugins')).plugins;
      } catch {
        /* the "edit an existing plugin" dropdown just stays empty */
      }
    },
    async load() {
      this.sessions = (await api('GET', '/admin/plugin-editor/sessions')).sessions;
      this.loaded = true;
    },
    async start() {
      this.busy = true;
      this.error = '';
      try {
        const body = this.targetSlug ? { slug: this.targetSlug } : {};
        const { session } = await api('POST', '/admin/plugin-editor/sessions', body);
        location.hash = '#/pluginEditor/' + session.id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  Alpine.data('pluginEditorChat', (id) => ({
    ...H,
    id,
    tab: 'chat',
    session: null,
    messages: [],
    files: [],
    draft: '',
    busy: false,
    error: '',
    loaded: false,
    // ───── manual editing (docs/DECISIONS.md D-063 shipped read-only; added directly on request) ─────
    filePath: '',
    fileContent: '',
    fileOriginal: '',
    newFilePath: '',
    fileSaving: false,
    fileError: '',
    get fileDirty() {
      return !!this.filePath && this.fileContent !== this.fileOriginal;
    },
    async init() {
      if (!(await this.mountFragment('plugin-editor', 'chat'))) return;
      await this.load();
    },
    async load() {
      const data = await api('GET', `/admin/plugin-editor/sessions/${this.id}`);
      this.session = data.session;
      this.messages = data.messages;
      this.loaded = true;
      await this.loadFiles();
    },
    async loadFiles() {
      try {
        this.files = (await api('GET', `/admin/plugin-editor/sessions/${this.id}/files`)).files;
      } catch {
        this.files = [];
      }
    },
    async selectFile(p) {
      if (this.fileDirty && !confirm('Discard your unsaved changes to this file?')) return;
      this.fileError = '';
      try {
        const content = await (
          await fetch(
            `/api/admin/plugin-editor/sessions/${this.id}/file?path=${encodeURIComponent(p)}`,
            { credentials: 'same-origin' },
          )
        ).text();
        this.filePath = p;
        this.fileContent = this.fileOriginal = content;
        this.tab = 'files';
      } catch (e) {
        this.fileError = e.message;
      }
    },
    async saveFile() {
      this.fileSaving = true;
      this.fileError = '';
      try {
        const r = await api('PUT', `/admin/plugin-editor/sessions/${this.id}/file`, {
          path: this.filePath,
          content: this.fileContent,
        });
        this.files = r.files;
        this.fileOriginal = this.fileContent;
        if (!this.session?.slug)
          this.session = (await api('GET', `/admin/plugin-editor/sessions/${this.id}`)).session;
        toast('Saved.');
      } catch (e) {
        this.fileError = e.message;
      } finally {
        this.fileSaving = false;
      }
    },
    async createFile() {
      const p = this.newFilePath.trim().replace(/^\/+/, '');
      if (!p) return;
      this.newFilePath = '';
      if (this.files.includes(p)) return this.selectFile(p);
      this.filePath = p;
      this.fileContent = this.fileOriginal = '';
      this.tab = 'files';
      await this.saveFile();
    },
    async deleteFile() {
      if (!confirm(`Delete ${this.filePath}?`)) return;
      this.fileError = '';
      try {
        const r = await api(
          'DELETE',
          `/admin/plugin-editor/sessions/${this.id}/file?path=${encodeURIComponent(this.filePath)}`,
        );
        this.files = r.files;
        this.filePath = this.fileContent = this.fileOriginal = '';
        this.tab = 'chat';
      } catch (e) {
        this.fileError = e.message;
      }
    },
    // ───── turning the raw Anthropic message history into chat-friendly entries ─────
    get turns() {
      const out = [];
      for (let i = 0; i < this.messages.length; i++) {
        const m = this.messages[i];
        if (m.role === 'user' && typeof m.content === 'string') {
          out.push({ kind: 'user', text: m.content });
          continue;
        }
        if (m.role === 'user') continue; // a tool-result message: already folded into the turn before it
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const nextContent = this.messages[i + 1]?.content;
        const results = Array.isArray(nextContent) ? nextContent : [];
        const calls = blocks
          .filter((b) => b.type === 'tool_use')
          .map((c) => {
            const r = results.find((x) => x.tool_use_id === c.id);
            return {
              name: c.name,
              input: c.input,
              ok: r ? !r.is_error : null,
              resultText: r
                ? typeof r.content === 'string'
                  ? r.content
                  : JSON.stringify(r.content)
                : '',
            };
          });
        if (text || calls.length) out.push({ kind: 'assistant', text, calls });
      }
      return out;
    },
    async send() {
      const text = this.draft.trim();
      if (!text || this.busy) return;
      this.draft = '';
      this.error = '';
      this.busy = true;
      try {
        const out = await api('POST', `/admin/plugin-editor/sessions/${this.id}/messages`, {
          text,
        });
        this.session = out.session;
        this.messages = [...this.messages, ...out.messages];
        await this.loadFiles();
      } catch (e) {
        this.error = e.message;
        this.draft = text; // give it back so nothing typed is lost
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── System → Assistant (docs/DECISIONS.md D-071, D-072) ─────────
  const TOOL_LABELS = {
    site_map: 'Looked at the site',
    read_file: 'Read a file',
    read_requirements: 'Read the requirements',
    update_requirements: 'Updated the requirements',
    list_theme_files: 'Listed theme files',
    plugin_guide: 'Read the plugin rules',
    list_plugin_files: 'Listed a plugin’s files',
    edit_file: 'Edited a file',
    write_file: 'Wrote a file',
    delete_file: 'Deleted a file',
    validate_site: 'Checked the pages',
    generate_image: 'Generated a picture',
    list_libraries: 'Looked at the libraries',
    install_library: 'Installed a library',
    screenshot_page: 'Looked at a page in a browser',
    capture_reference: 'Studied a reference site',
    propose_plan: 'Proposed a plan',
    db_tables: 'Looked at the database',
    db_rows: 'Read table rows',
    db_create_table: 'Created a table',
    db_alter_table: 'Changed a table',
    db_write_row: 'Saved a row',
    db_request_delete: 'Asked to delete something',
    db_delete: 'Deleted from the database',
  };

  /** What kind of thing a document path is, and the admin screen where it lives. */
  const DOC_KINDS = [
    [/^pages\//, 'Page', '#/pages'],
    [/^components\//, 'Component', '#/components'],
    [/^plugins\/([^/]+)\//, 'Plugin', '#/plugins'],
    [/^themes\//, 'Theme file', '#/theme-editor'],
    [/^locales\//, 'Translation', '#/locales'],
    [/^menus\//, 'Menu', '#/menus'],
    [/^seo\//, 'SEO rule', '#/seo'],
    [/^services\//, 'Service', '#/services'],
    [/^requirements\.md$/, 'Project Requirement', '#/requirements'],
  ];
  const docKind = (path) => {
    const hit = DOC_KINDS.find(([re]) => re.test(path || ''));
    return hit ? { label: hit[1], href: hit[2] } : null;
  };
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

  Alpine.data('assistantPanel', () => ({
    ...H,
    linkify,
    sessions: [],
    session: null,
    items: [],
    draft: '',
    busy: false,
    error: '',
    loaded: false,
    usage: { input: 0, output: 0, cacheRead: 0 },
    commits: [],
    warnings: [],
    plans: [],
    confirmations: [], // staged deletions the person must confirm twice (D-119)
    focus: null,
    attachments: [],
    showChanges: false, // collapsed until there is something new to look at
    // The strip lists only files this chat WROTE (never ones it merely read); it can be folded away to save room.
    workingOpen: (() => {
      try {
        return localStorage.getItem('cms.assistant.workingOpen') !== '0';
      } catch {
        return true;
      }
    })(),
    toggleWorking() {
      this.workingOpen = !this.workingOpen;
      try {
        localStorage.setItem('cms.assistant.workingOpen', this.workingOpen ? '1' : '0');
      } catch {
        /* private window: the choice just lasts until the page reloads */
      }
    },
    models: { default: '', options: [] },
    details: {},
    openDiff: null,
    budget: { chatLimit: 0, dayLimit: 0, usedToday: 0 },
    async init() {
      if (!(await this.mountFragment('assistant', 'panel'))) return;
      this.loadBudget();
      this.loadModels();
      // "Ask the assistant" from Search hands over what was typed.
      const takePrefill = (text) => {
        this.draft = text;
        window.__assistantPrefill = null;
        this.$nextTick(() => document.getElementById('chat-input')?.focus());
      };
      window.addEventListener('assistant-ask', (e) => takePrefill(e.detail));
      window.addEventListener('assistant-focus', (e) => this.pin(e.detail, true));
      if (window.__assistantPrefill) takePrefill(window.__assistantPrefill);
      try {
        await this.loadSessions();
        let id = null;
        try {
          id = Number(localStorage.getItem('assistant.session')) || null;
        } catch {
          /* no storage: start from the latest chat */
        }
        const pick = this.sessions.find((s) => s.id === id) || this.sessions[0];
        if (pick) await this.open(pick.id);
      } catch (e) {
        this.error = e.message;
      }
      this.loaded = true;
      // A screen asked for a pin before this panel was on the page.
      if (window.__assistantFocus) await this.pin(window.__assistantFocus, true);
    },
    async loadSessions() {
      this.sessions = (await api('GET', '/admin/assistant/sessions')).sessions;
    },
    /** Flatten stored messages into what the panel shows: what was said, one line per tool used, and any picture. */
    show(messages) {
      // A generated picture's address is in the tool's result, which is a separate (hidden) message.
      const results = new Map();
      for (const m of messages)
        if (m.role === 'user' && Array.isArray(m.content))
          for (const b of m.content)
            if (b.type === 'tool_result') results.set(b.tool_use_id, b.content);
      const out = [];
      for (const m of messages) {
        if (m.role === 'user') {
          if (typeof m.content === 'string') {
            // "[auto] …" is the system asking the assistant to carry on after a cut-off reply, not the person.
            if (!m.content.startsWith('[auto] ')) out.push({ kind: 'user', text: m.content });
          } else if (m.content.some((b) => b.type === 'text'))
            out.push({
              kind: 'user',
              text: m.content.find((b) => b.type === 'text').text,
              images: m.content.filter((b) => b.type === 'image_ref').map((b) => b.url),
            });
          continue; // an array of tool results is plumbing
        }
        for (const b of Array.isArray(m.content) ? m.content : [m.content]) {
          if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'assistant', text: b.text });
          else if (b.type === 'tool_use' && b.name === 'propose_plan') {
            let planId = null;
            try {
              planId = JSON.parse(results.get(b.id) || '{}').planId ?? null;
            } catch {
              /* the call failed (a malformed plan): the label alone is shown */
            }
            out.push(
              planId
                ? { kind: 'plan', planId, plan: b.input, text: '', askChanges: false, note: '' }
                : { kind: 'tool', text: TOOL_LABELS.propose_plan },
            );
          } else if (b.type === 'tool_use' && b.name === 'db_request_delete') {
            let confirmId = null;
            try {
              confirmId = JSON.parse(results.get(b.id) || '{}').confirmationId ?? null;
            } catch {
              /* refused (unknown table, partial key): the label alone is shown */
            }
            out.push(
              confirmId
                ? { kind: 'confirm', confirmId, text: '', typed: '' }
                : { kind: 'tool', text: TOOL_LABELS.db_request_delete },
            );
          } else if (b.type === 'tool_use') {
            const path = typeof b.input?.path === 'string' ? b.input.path : '';
            out.push({
              kind: 'tool',
              text: TOOL_LABELS[b.name] || b.name,
              tool: b.name,
              path,
              doc: docKind(path)?.label || '',
            });
            if (b.name === 'generate_image') {
              try {
                const src = JSON.parse(results.get(b.id) || '{}').src;
                if (src) out.push({ kind: 'assistant', text: '', images: [src] });
              } catch {
                /* the tool failed: the label alone is shown */
              }
            }
          }
        }
      }
      return out;
    },
    async open(id) {
      this.error = '';
      const data = await api('GET', `/admin/assistant/sessions/${id}`);
      this.session = data.session;
      this.items = this.show(data.messages);
      this.usage = data.session.usage;
      this.commits = data.commits || [];
      this.plans = data.plans || [];
      this.confirmations = data.confirmations || [];
      this.focus = data.session.focus || null;
      this.showChanges = false;
      this.details = {};
      this.openDiff = null;
      this.warnings = [];
      try {
        localStorage.setItem('assistant.session', String(id));
      } catch {
        /* ignore */
      }
      this.scroll();
    },
    async newChat() {
      this.error = '';
      try {
        const { session } = await api('POST', '/admin/assistant/sessions');
        await this.loadSessions();
        await this.open(session.id);
      } catch (e) {
        this.error = e.message;
      }
    },
    async rename() {
      const title = window.prompt('Name this chat', this.session.title || '');
      if (!title?.trim()) return;
      try {
        await api('PUT', `/admin/assistant/sessions/${this.session.id}`, { title: title.trim() });
        await this.loadSessions();
        this.session = this.sessions.find((s) => s.id === this.session.id) || this.session;
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove() {
      if (!window.confirm('Delete this chat? The requirements document keeps what it recorded.'))
        return;
      try {
        await api('DELETE', `/admin/assistant/sessions/${this.session.id}`);
        this.session = null;
        this.items = [];
        this.commits = [];
        await this.loadSessions();
        if (this.sessions[0]) await this.open(this.sessions[0].id);
      } catch (e) {
        this.error = e.message;
      }
    },
    async send() {
      const text = this.draft.trim();
      const sent = this.attachments;
      if ((!text && !sent.length) || this.busy) return;
      this.error = '';
      this.busy = true;
      try {
        if (!this.session) {
          const { session } = await api('POST', '/admin/assistant/sessions');
          this.session = session;
        }
        this.items.push({
          kind: 'user',
          text: text || 'See the attached picture.',
          images: sent.map((a) => a.dataUrl),
        });
        this.draft = '';
        this.attachments = [];
        this.scroll();
        const out = await api('POST', `/admin/assistant/sessions/${this.session.id}/messages`, {
          text,
          images: sent.map((a) => ({ dataUrl: a.dataUrl, name: a.name })),
        });
        this.items.push(...this.show(out.messages.slice(1)));
        this.session = out.session;
        this.usage = out.session.usage;
        this.warnings = out.warnings || [];
        const fresh = await api('GET', `/admin/assistant/sessions/${this.session.id}`);
        this.commits = fresh.commits;
        this.plans = fresh.plans || [];
        this.details = {};
        this.openDiff = null;
        // Straight after the assistant built or changed something, show what it changed.
        if (out.commit && this.can('history.read')) {
          this.showChanges = true;
          await this.toggleDiff(out.commit);
        }
        await this.loadSessions();
        this.loadBudget();
        // The assistant may have changed the requirements, a page or a component under this screen.
        window.dispatchEvent(new CustomEvent('assistant-changed'));
      } catch (e) {
        const message = e.message;
        this.draft = text; // keep what was typed (and attached) so it can be sent again once the cause is fixed
        this.attachments = sent;
        if (this.session) await this.open(this.session.id).catch(() => {});
        this.error = message; // open() clears it
      } finally {
        this.busy = false;
        this.scroll();
      }
    },
    /** The pages, components, plugins… this chat has changed, newest first: so it is always clear what is being edited. */
    get working() {
      const seen = new Map();
      for (const it of [...this.items].reverse()) {
        if (it.kind !== 'tool' || !WRITE_TOOLS.has(it.tool) || !it.path || seen.has(it.path))
          continue;
        const k = docKind(it.path);
        if (!k) continue;
        const plugin = /^plugins\/([^/]+)\//.exec(it.path)?.[1];
        seen.set(it.path, {
          path: it.path,
          label: plugin ? `Plugin · ${plugin}` : k.label,
          name: plugin ? it.path.replace(/^plugins\/[^/]+\//, '') : it.path.replace(/^[^/]+\//, ''),
          href: k.href,
          deleted: it.tool === 'delete_file',
        });
        if (seen.size >= 8) break;
      }
      return [...seen.values()];
    },
    /** What the pinned thing is, for the chip: its kind and a short name. */
    get focusInfo() {
      if (!this.focus) return null;
      const plugin = /^plugins\/([^/]+)$/.exec(this.focus);
      if (plugin) return { label: 'Plugin', name: plugin[1], href: '#/plugins' };
      const k = docKind(this.focus);
      return {
        label: k?.label || 'Document',
        name: this.focus.replace(/^[^/]+\//, ''),
        href: k?.href || '#/',
      };
    },
    /**
     * Pin this chat to a page, component or plugin (starting a chat if there is none yet).
     * `fresh` is an "Ask the assistant" button: an earlier conversation about something else would colour the answer,
     * so it opens a new chat unless this one is empty or already about the same thing.
     */
    async pin(path, fresh = false) {
      window.__assistantFocus = null;
      this.error = '';
      try {
        if (fresh && path && this.session && this.items.length && this.focus !== path) {
          const { session } = await api('POST', '/admin/assistant/sessions');
          await this.loadSessions();
          await this.open(session.id);
        }
        if (!this.session) {
          const { session } = await api('POST', '/admin/assistant/sessions');
          this.session = session;
          await this.loadSessions();
        }
        const { session } = await api('PUT', `/admin/assistant/sessions/${this.session.id}`, {
          focus: path || '',
        });
        this.session = session;
        this.focus = session.focus || null;
        if (path) this.$nextTick(() => document.getElementById('chat-input')?.focus());
      } catch (e) {
        this.error = e.message;
      }
    },
    /** Where a proposed plan stands: pending until the person answers; later ones replace earlier ones. */
    planStatus(planId) {
      return this.plans.find((p) => p.id === planId)?.status || 'pending';
    },
    planStatusText(planId) {
      return (
        {
          pending: 'Waiting for your decision',
          approved: 'Approved',
          changes: 'You asked for changes',
          rejected: 'Not approved',
          superseded: 'Replaced by a newer plan',
        }[this.planStatus(planId)] || ''
      );
    },
    /** Answer a plan with the chat's buttons, then tell the assistant what was decided so it carries on. */
    async decidePlan(it, decision) {
      if (this.busy || !this.session) return;
      const note = (it.note || '').trim();
      if (decision === 'changes' && !note) {
        it.askChanges = true;
        return;
      }
      this.error = '';
      try {
        const r = await api(
          'POST',
          `/admin/assistant/sessions/${this.session.id}/plans/${it.planId}`,
          { decision, note },
        );
        this.plans = (await api('GET', `/admin/assistant/sessions/${this.session.id}`)).plans || [];
        this.draft =
          decision === 'approve'
            ? `Plan approved${r.savedToRequirements ? ' and saved under "Brief and assumptions"' : ''}. ${r.savedToRequirements ? '' : 'Save it under "Brief and assumptions" in the requirements first. '}Build it now, completely, then check the pages with screenshots.`
            : decision === 'changes'
              ? `Changes to the plan: ${note}`
              : `I do not approve this plan.${note ? ` ${note}` : ' Ask me what I want instead.'}`;
        await this.send();
      } catch (e) {
        this.error = e.message;
      }
    },
    confirmation(id) {
      return (
        this.confirmations.find((c) => c.id === id) || { status: 'pending', summary: '', kind: '' }
      );
    },
    confirmStatusText(id) {
      return (
        {
          pending: 'Waiting for you',
          first: 'Confirm once more',
          confirmed: 'Confirmed',
          used: 'Deleted',
          cancelled: 'Cancelled',
        }[this.confirmation(id).status] || ''
      );
    },
    /** One click on a deletion card. Two separate clicks (first, second) are needed; the assistant is told the outcome. */
    async decideConfirm(it, step) {
      this.error = '';
      try {
        await api(
          'POST',
          `/admin/assistant/sessions/${this.session.id}/confirmations/${it.confirmId}`,
          { step, typed: it.typed },
        );
        this.confirmations =
          (await api('GET', `/admin/assistant/sessions/${this.session.id}`)).confirmations || [];
        if (step === 'second') {
          this.draft = 'I confirmed the deletion twice. Carry it out now.';
          await this.send();
        } else if (step === 'cancel') {
          this.draft = 'I cancelled that deletion. Do not delete it.';
          await this.send();
        }
      } catch (e) {
        this.error = e.message;
      }
    },
    /** Show or hide what one entry changed, right in the chat (git's own diff when the server has it). */
    async toggleDiff(c) {
      if (this.openDiff === c.id) {
        this.openDiff = null;
        return;
      }
      try {
        if (!this.details[c.id])
          this.details[c.id] = await api('GET', `/admin/assistant/history/${c.id}`);
        this.openDiff = c.id;
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadModels() {
      try {
        this.models = await api('GET', '/admin/assistant/models');
      } catch {
        /* the picker just offers the default */
      }
    },
    modelName(value) {
      return this.models.options.find((m) => m.value === value)?.label || value || 'default';
    },
    /** Choose the model for this chat from now on; it applies to the next message. */
    async changeModel(value) {
      if (!this.session) return;
      try {
        const { session } = await api('PUT', `/admin/assistant/sessions/${this.session.id}`, {
          model: value || null,
        });
        this.session = session;
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadBudget() {
      try {
        this.budget = await api('GET', '/admin/assistant/budget');
      } catch {
        /* the footer just omits the limits */
      }
    },
    /** Read chosen or pasted pictures; the server shrinks them, so only a sanity limit applies here. */
    attach(files) {
      for (const f of [...files]) {
        if (this.attachments.length >= 4) {
          this.error = 'Attach up to 4 pictures at a time.';
          break;
        }
        if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
          this.error = 'Attach PNG, JPEG, WebP or GIF pictures.';
          continue;
        }
        if (f.size > 6 * 1024 * 1024) {
          this.error = 'A picture is too large (6 MB at most).';
          continue;
        }
        const r = new window.FileReader();
        r.onload = () => this.attachments.push({ dataUrl: r.result, name: f.name || 'pasted' });
        r.readAsDataURL(f);
      }
    },
    paste(ev) {
      const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        ev.preventDefault();
        this.attach(files);
      }
    },
    async revert(c) {
      if (!window.confirm('Revert this change? Anything edited since stays as it is.')) return;
      this.busy = true;
      this.error = '';
      try {
        const r = await api('POST', `/admin/assistant/history/${c.id}/revert`);
        toast(
          r.conflicts.length
            ? `Reverted ${r.reverted.length}; left ${r.conflicts.length} that were edited since.`
            : 'Change reverted.',
        );
        this.commits = (await api('GET', `/admin/assistant/sessions/${this.session.id}`)).commits;
        window.dispatchEvent(new CustomEvent('assistant-changed'));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    get usageLine() {
      const u = this.usage;
      const b = this.budget;
      const left = b.chatLimit ? ` · limit ${b.chatLimit.toLocaleString()}` : '';
      const day = b.dayLimit
        ? ` · today ${b.usedToday.toLocaleString()}/${b.dayLimit.toLocaleString()}`
        : '';
      return `This chat: ${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cached${left}${day}`;
    },
    scroll() {
      this.$nextTick(() => {
        const el = this.$refs.log;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  }));

  Alpine.data('historyPage', () => ({
    ...H,
    commits: [],
    selected: null,
    git: null,
    commitMessage: '',
    more: false,
    loaded: false,
    busy: false,
    error: '',
    notice: '',
    async init() {
      if (!(await this.mountFragment('assistant', 'history'))) return;
      window.addEventListener('hashchange', () => this.sync());
      window.addEventListener('assistant-changed', () => this.load());
      await this.load();
      this.loadGit();
      await this.sync();
    },
    async load() {
      try {
        this.commits = (await api('GET', '/admin/assistant/history')).commits;
        this.more = this.commits.length >= 50;
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadMore() {
      const last = this.commits.at(-1)?.id;
      const more = (await api('GET', `/admin/assistant/history?before=${last}`)).commits;
      this.commits.push(...more);
      this.more = more.length >= 50;
    },
    async loadGit() {
      try {
        this.git = await api('GET', '/admin/assistant/history/git');
      } catch {
        this.git = null;
      }
    },
    /** #/history/<id> selects one change; #/history shows the list alone. */
    async sync() {
      const id = Number(location.hash.replace(/^#\/?/, '').split('/')[1]);
      if (location.hash.replace(/^#\/?/, '').split('/')[0] !== 'history') return;
      if (!id) {
        this.selected = null;
        return;
      }
      try {
        this.selected = await api('GET', `/admin/assistant/history/${id}`);
      } catch (e) {
        this.error = e.message;
      }
    },
    async revert() {
      if (!window.confirm('Revert this change? Anything edited since stays as it is.')) return;
      this.busy = true;
      this.error = '';
      try {
        const r = await api('POST', `/admin/assistant/history/${this.selected.commit.id}/revert`);
        this.notice = r.conflicts.length
          ? `Reverted ${r.reverted.length} file(s). Left alone because they were edited since: ${r.conflicts.map((c) => c.path).join(', ')}.`
          : 'Change reverted.';
        await this.load();
        await this.sync();
        this.loadGit();
        window.dispatchEvent(new CustomEvent('assistant-changed'));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async commitNow() {
      this.busy = true;
      this.error = '';
      this.notice = '';
      try {
        const r = await api('POST', '/admin/assistant/history/commit', {
          message: this.commitMessage.trim() || undefined,
        });
        this.commitMessage = '';
        this.notice = r.started
          ? 'Tracking started: the site as it is now is the starting point. Later changes will be committed against it.'
          : r.commit
            ? `Committed ${r.commit.files} file${r.commit.files === 1 ? '' : 's'}.`
            : 'Nothing has changed since the last entry.';
        await this.load();
        this.loadGit();
        if (r.commit) location.hash = '#/history/' + r.commit.id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async push() {
      this.busy = true;
      this.error = '';
      this.notice = '';
      try {
        const r = await api('POST', '/admin/assistant/history/push');
        this.git = r.status;
        this.notice = 'Pushed.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  /** A deliberately small markdown renderer: everything is escaped first, then a few patterns become tags. Links are
   * only http(s) or site-relative, so a document can't smuggle a javascript: URL into the admin. */
  function mdToHtml(md) {
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
        .replace(
          /\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]*)\)/g,
          '<a href="$2" rel="noopener">$1</a>',
        );
    const out = [];
    let list = null;
    let code = null;
    const close = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of String(md).split('\n')) {
      if (line.startsWith('```')) {
        if (code) {
          out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
          code = null;
        } else {
          close();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
      if (h) {
        close();
        out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      } else if (li) {
        const kind = li[1] ? 'ol' : 'ul';
        if (list !== kind) {
          close();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline(li[2])}</li>`);
      } else if (!line.trim()) close();
      else {
        close();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    close();
    return out.join('\n');
  }

  Alpine.data('requirementsPage', () => ({
    ...H,
    markdown: '',
    authored: '',
    html: '',
    updatedAt: null,
    draft: '',
    editing: false,
    busy: false,
    loaded: false,
    error: '',
    versions: [],
    viewing: '', // id of the older version on screen, '' = the current one
    async init() {
      if (!(await this.mountFragment('assistant', 'requirements'))) return;
      // The assistant edits this document from the side panel: reload when it finishes a turn.
      window.addEventListener('assistant-changed', () => this.load());
      await this.load();
    },
    async load() {
      try {
        const d = await api('GET', '/admin/assistant/requirements');
        this.markdown = d.markdown;
        this.authored = d.authored;
        this.html = mdToHtml(d.markdown);
        this.updatedAt = d.updatedAt;
        this.loaded = true;
        this.versions = (await api('GET', '/admin/assistant/requirements/versions')).versions;
      } catch (e) {
        this.error = e.message;
      }
    },
    async pickVersion() {
      this.error = '';
      if (!this.viewing) return this.load();
      try {
        const v = await api('GET', `/admin/assistant/requirements/versions/${this.viewing}`);
        this.html = mdToHtml(v.markdown);
      } catch (e) {
        this.error = e.message;
      }
    },
    async restore() {
      if (!window.confirm('Make this version the current one? The present text stays in the list.'))
        return;
      this.busy = true;
      try {
        await api('POST', `/admin/assistant/requirements/versions/${this.viewing}/restore`);
        this.viewing = '';
        await this.load();
        toast('Version restored.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    startEdit() {
      this.draft = this.authored;
      this.editing = true;
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        await api('PUT', '/admin/assistant/requirements', { markdown: this.draft });
        this.editing = false;
        await this.load();
        toast('Project Requirement saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async rebuild() {
      if (
        !window.confirm(
          'Write a new version from the site and your chats? Your current text is kept in Change history, where you can revert it.',
        )
      )
        return;
      this.busy = true;
      this.error = '';
      try {
        await api('POST', '/admin/assistant/requirements/rebuild');
        await this.load();
        toast('Rebuilt. Read it through and edit what is wrong.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    download() {
      const url = URL.createObjectURL(new window.Blob([this.markdown], { type: 'text/markdown' }));
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: 'project-requirement.md',
      });
      a.click();
      URL.revokeObjectURL(url);
    },
  }));

  // ───────── Automation → Testing (docs/DECISIONS.md D-086) ─────────
  Alpine.data('testingPage', () => ({
    ...H,
    runs: [],
    current: null, // { run, findings, total, shots }
    browser: { ok: true, reason: '' },
    running: null,
    form: { viewports: ['mobile', 'tablet', 'desktop'], maxPages: 40, spelling: true },
    checkList: [], // every kind of check: [{ id, label, browser, optIn, always }]
    chosen: [], // the ones ticked for the next run
    showChecks: false,
    tab: 'reports', // reports | journeys
    journeys: [],
    jform: null, // the journey being edited: { id, name, steps, enabled }
    jresult: null, // how a "Try it now" went
    jbusy: false,
    filter: { severity: '', category: '', viewport: '', q: '' },
    limit: 500,
    loaded: false,
    busy: false,
    error: '',
    timer: null,
    async init() {
      if (!(await this.mountFragment('testing', 'page'))) return;
      await this.refresh();
      this.loaded = true;
      if (this.runs[0]) await this.open(this.runs[0].id);
      // Progress and the list stay current while a check is running; the timer stops with the screen.
      this.timer = setInterval(() => {
        if (!this.$root?.isConnected) return clearInterval(this.timer);
        if (this.running) this.refresh(true);
      }, 2500);
    },
    async refresh(keepOpen = false) {
      try {
        const [st, rs] = await Promise.all([
          api('GET', '/admin/testing/status'),
          api('GET', '/admin/testing/runs'),
        ]);
        this.browser = st.browser;
        if (!this.checkList.length) {
          this.checkList = st.checks;
          this.chosen = [...st.defaults];
        }
        this.runs = rs.runs;
        const was = this.running;
        this.running = st.running;
        if (keepOpen && was && !st.running && this.current?.run.id === was.id)
          await this.open(was.id);
      } catch (e) {
        this.error = e.message;
      }
    },
    get progress() {
      return this.running && this.running.unitsTotal
        ? Math.round((100 * this.running.unitsDone) / this.running.unitsTotal)
        : 0;
    },
    statusText(r) {
      return (
        {
          queued: 'Waiting',
          running: 'Running',
          done: 'Finished',
          failed: 'Failed',
          cancelled: 'Cancelled',
        }[r.status] || r.status
      );
    },
    get categories() {
      return Object.keys(this.current?.run.summary?.byCategory || {}).sort();
    },
    get compare() {
      const c = this.current?.run.summary?.comparison;
      return c
        ? `Since check #${c.previousRunId}: ${c.newCount} new problem${c.newCount === 1 ? '' : 's'}, ${c.resolvedCount} fixed.`
        : '';
    },
    get notes() {
      const s = this.current?.run.summary;
      if (!s) return '';
      return [
        s.mode === 'basic'
          ? 'Run without a browser: page HTML only. Not checked: layout, sideways scrolling, colour contrast, cut-off text, phone tap targets, picture sizes, browser errors.'
          : '',
        s.spellingUnavailable
          ? 'Spelling was skipped: the dictionary is not installed on this server.'
          : '',
        s.skippedLanguages?.length
          ? `Spelling was skipped for pages in: ${s.skippedLanguages.join(', ')}.`
          : '',
        s.linksSkipped > 0 ? `${s.linksSkipped} links were not followed (limit reached).` : '',
        `${s.linksChecked} links followed. Took ${Math.round(s.durationMs / 1000)} seconds.`,
      ]
        .filter(Boolean)
        .join(' ');
    },
    /** The findings grouped by page, worst first. */
    get groups() {
      if (!this.current) return [];
      const by = new Map();
      for (const f of this.current.findings) {
        if (!by.has(f.path))
          by.set(f.path, {
            path: f.path,
            items: [],
            errors: 0,
            warns: 0,
            infos: 0,
            shots: [],
            open: false,
          });
        const g = by.get(f.path);
        g.items.push(f);
        if (f.severity === 'error') g.errors++;
        else if (f.severity === 'warn') g.warns++;
        else g.infos++;
      }
      for (const s of this.current.shots) {
        const [vp, ...rest] = s.split('|');
        by.get(rest.join('|'))?.shots.push(vp);
      }
      return [...by.values()]
        .sort((a, b) => b.errors - a.errors || b.warns - a.warns || a.path.localeCompare(b.path))
        .map((g, i) => ({ ...g, open: i < 2 }));
    },
    /** Tick or untick a check; checks that need a browser are marked when this server has none. */
    toggleCheck(id) {
      this.chosen = this.chosen.includes(id)
        ? this.chosen.filter((x) => x !== id)
        : [...this.chosen, id];
    },
    get phase() {
      return this.running?.summary?.phase || '';
    },
    /** Open the assistant on the page with what was found, so one click starts the fix. */
    async fixWithAssistant(g) {
      let file = null;
      try {
        file = (await api('GET', `/admin/testing/resolve?path=${encodeURIComponent(g.path)}`)).file;
      } catch {
        /* no pin: the message still names the page */
      }
      const lines = g.items
        .filter((f) => f.severity !== 'info')
        .slice(0, 12)
        .map((f) => `- ${f.message}`);
      this.askAssistant(
        file,
        `The site check found these problems on ${g.path}${file ? '' : ' (it is generated from content, so find where it comes from first)'}:\n${lines.join('\n')}\nPlease fix them, then look at the page to confirm.`,
      );
    },
    baselineUrl(g, f) {
      return `/api/admin/testing/baselines/shot?viewport=${f.viewport}&path=${encodeURIComponent(g.path)}`;
    },
    /** Take the page's current look as the one future runs compare with. */
    async acceptLook(g, f) {
      this.busy = true;
      this.error = '';
      try {
        await api('POST', '/admin/testing/baselines/accept', {
          path: g.path,
          viewport: f.viewport,
        });
        toast('New look accepted. Future checks compare with it.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    pdfUrl() {
      return this.current ? `/api/admin/testing/runs/${this.current.run.id}/export.pdf` : '#';
    },

    // ───── journeys ─────
    async openJourneys() {
      this.tab = 'journeys';
      this.jresult = null;
      try {
        this.journeys = (await api('GET', '/admin/testing/journeys')).journeys;
      } catch (e) {
        this.error = e.message;
      }
    },
    newJourney() {
      this.jresult = null;
      this.jform = {
        id: null,
        name: '',
        steps: 'goto /\nexpect text ',
        enabled: true,
      };
    },
    editJourney(j) {
      this.jresult = null;
      this.jform = { ...j };
    },
    async saveJourney() {
      this.jbusy = true;
      this.error = '';
      const f = this.jform;
      try {
        const body = { name: f.name, steps: f.steps, enabled: f.enabled };
        if (f.id) await api('PUT', `/admin/testing/journeys/${f.id}`, body);
        else await api('POST', '/admin/testing/journeys', body);
        this.jform = null;
        await this.openJourneys();
        toast('Journey saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.jbusy = false;
      }
    },
    async removeJourney(j) {
      if (!window.confirm(`Delete the journey “${j.name}”?`)) return;
      try {
        await api('DELETE', `/admin/testing/journeys/${j.id}`);
        this.jform = null;
        await this.openJourneys();
      } catch (e) {
        this.error = e.message;
      }
    },
    async tryJourney(j) {
      this.jbusy = true;
      this.jresult = null;
      this.error = '';
      try {
        this.jresult = {
          name: j.name,
          ...(await api('POST', `/admin/testing/journeys/${j.id}/try`)),
        };
      } catch (e) {
        this.error = e.message;
      } finally {
        this.jbusy = false;
      }
    },
    shotUrl(viewport, path) {
      return `/api/admin/testing/runs/${this.current.run.id}/shot?viewport=${viewport}&path=${encodeURIComponent(path)}`;
    },
    async open(id) {
      this.error = '';
      this.filter = { severity: '', category: '', viewport: '', q: '' };
      this.limit = 500;
      await this.loadRun(id);
    },
    async loadRun(id) {
      const p = new URLSearchParams({ limit: String(this.limit) });
      for (const [k, v] of Object.entries(this.filter)) if (v) p.set(k, v);
      try {
        this.current = await api('GET', `/admin/testing/runs/${id}?${p}`);
      } catch (e) {
        this.error = e.message;
      }
    },
    reload() {
      return this.current ? this.loadRun(this.current.run.id) : null;
    },
    more() {
      this.limit += 500;
      return this.reload();
    },
    async start() {
      this.busy = true;
      this.error = '';
      try {
        const { run } = await api('POST', '/admin/testing/runs', {
          viewports: this.form.viewports,
          maxPages: this.form.maxPages,
          spelling: this.form.spelling,
          checks: this.chosen,
        });
        this.running = run;
        await this.refresh();
        toast('Check started.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async cancel(id) {
      this.busy = true;
      try {
        await api('POST', `/admin/testing/runs/${id}/cancel`);
        await this.refresh();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async remove(id) {
      if (!window.confirm('Delete this report and its pictures?')) return;
      this.busy = true;
      try {
        await api('DELETE', `/admin/testing/runs/${id}`);
        this.current = null;
        await this.refresh();
        toast('Report deleted.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── Help (docs/DECISIONS.md D-115): guides and the prompt library, read from docs/*.md ─────────
  // Addresses: #/help/<section> (the section's guides), #/help/<section>/<guide>, #/help/prompts (the library).
  Alpine.data('helpPage', () => ({
    ...H,
    index: null, // { sections: [{id,title,summary,docs:[]}], promptCount }
    section: 'administration',
    slug: '',
    doc: null,
    prompts: null, // { categories, items }
    category: '',
    promptQuery: '',
    openPrompt: '',
    blanks: {}, // prompt id → { blank text → what was typed }
    copied: '',
    docFilter: '',
    docMatches: null,
    supportQ: '',
    supportResults: null,
    q: '',
    results: null,
    loaded: false,
    error: '',
    _onHash: null,
    async init() {
      if (!(await this.mountFragment('help', 'page'))) return;
      this._onHash = () => this.show();
      window.addEventListener('hashchange', this._onHash);
      try {
        this.index = await api('GET', '/admin/help');
      } catch (e) {
        this.error = e.message;
      }
      this.loaded = true;
      await this.show();
    },
    destroy() {
      if (this._onHash) window.removeEventListener('hashchange', this._onHash);
    },
    /** Reads the address and loads what it names. */
    async show() {
      const [r, section, slug] = location.hash.replace(/^#\/?/, '').split('/');
      if (r !== 'help') return;
      this.section = section || 'administration';
      this.slug = slug || '';
      this.results = null;
      this.docFilter = '';
      this.docMatches = null;
      this.supportQ = '';
      this.supportResults = null;
      this.error = '';
      try {
        if (this.section === 'prompts') {
          this.doc = null;
          this.prompts ||= await api('GET', '/admin/help/prompts');
        } else if (this.slug) {
          this.doc = (
            await api(
              'GET',
              `/admin/help/${encodeURIComponent(this.section)}/${encodeURIComponent(this.slug)}`,
            )
          ).doc;
          this.$nextTick(() => {
            this.addCopyButtons();
            this.$root.querySelector('.help-doc')?.scrollIntoView?.({ block: 'start' });
          });
        } else this.doc = null;
      } catch (e) {
        this.doc = null;
        this.error = e.message;
      }
    },
    get current() {
      return this.index?.sections.find((s) => s.id === this.section) || null;
    },
    get sectionTitle() {
      return this.section === 'prompts' ? 'Prompt library' : (this.current?.title ?? 'Help');
    },
    go(section, slug) {
      location.hash = `#/help/${section}${slug ? `/${slug}` : ''}`;
    },
    async search() {
      const q = this.q.trim();
      if (q.length < 2) {
        this.results = null;
        return;
      }
      try {
        this.results = (await api('GET', `/admin/help/search?q=${encodeURIComponent(q)}`)).items;
      } catch (e) {
        this.error = e.message;
      }
    },
    /** The big box on the Support landing: search only the Support guides. */
    async searchSupport() {
      const q = this.supportQ.trim();
      if (q.length < 2) {
        this.supportResults = null;
        return;
      }
      try {
        this.supportResults = (
          await api('GET', `/admin/help/search?section=support&q=${encodeURIComponent(q)}`)
        ).items;
      } catch (e) {
        this.error = e.message;
      }
    },
    /** In a lookup guide (symptom tables) or an FAQ: show only the rows or questions that contain the typed words. */
    applyDocFilter(value) {
      // Takes the typed text directly: an @input handler can run before x-model has copied it.
      this.docFilter = value;
      const root = this.$root.querySelector('.help-doc');
      if (!root || !this.doc) return;
      const words = this.docFilter.toLowerCase().split(/\s+/).filter(Boolean);
      const items = root.querySelectorAll(
        this.doc.layout === 'accordion' ? 'details.help-qa' : 'tbody tr',
      );
      let shown = 0;
      items.forEach((el) => {
        const text = el.textContent.toLowerCase();
        const hit = words.every((w) => text.includes(w));
        el.hidden = !hit;
        if (hit) shown++;
        if (el.tagName === 'DETAILS') el.open = words.length > 0 && hit;
      });
      this.docMatches = words.length ? shown : null;
    },
    setAllOpen(open) {
      this.$root.querySelectorAll('.help-doc details.help-qa').forEach((d) => (d.open = open));
    },
    clearSearch() {
      this.q = '';
      this.results = null;
    },
    scrollToHeading(id) {
      this.$root.querySelector(`.help-doc [id="${id}"]`)?.scrollIntoView?.({ behavior: 'smooth' });
    },
    /** A copy button on each code sample in a guide. */
    addCopyButtons() {
      for (const pre of this.$root.querySelectorAll('.help-doc pre')) {
        if (pre.querySelector('.help-copy')) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'help-copy btn btn-sm btn-outline-secondary';
        b.textContent = 'Copy';
        b.addEventListener('click', async () => {
          await this.copyText(pre.querySelector('code')?.textContent ?? '');
          b.textContent = 'Copied';
          setTimeout(() => (b.textContent = 'Copy'), 1500);
        });
        pre.appendChild(b);
      }
    },
    async copyText(text) {
      try {
        await window.navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Plain-HTTP staging has no clipboard API: fall back to selecting a hidden field.
        const t = document.createElement('textarea');
        t.value = text;
        t.setAttribute('readonly', '');
        t.style.position = 'fixed';
        t.style.opacity = '0';
        document.body.appendChild(t);
        t.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          /* nothing else to try */
        }
        t.remove();
        return ok;
      }
    },
    // ── prompt library ──
    get promptItems() {
      if (!this.prompts) return [];
      const words = this.promptQuery.toLowerCase().split(/\s+/).filter(Boolean);
      return this.prompts.items.filter((p) => {
        if (this.category && p.category !== this.category) return false;
        const hay =
          `${p.title} ${p.summary} ${p.category} ${p.tags.join(' ')} ${p.body}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    },
    toggle(p) {
      this.openPrompt = this.openPrompt === p.id ? '' : p.id;
    },
    typed(p, blank) {
      return this.blanks[p.id]?.[blank] ?? '';
    },
    setBlank(p, blank, v) {
      this.blanks = { ...this.blanks, [p.id]: { ...this.blanks[p.id], [blank]: v } };
    },
    /** The prompt with the blanks the person has filled in; the rest stay as [[Blank]] so they are easy to spot. */
    filled(p) {
      return p.body.replace(
        /\[\[([^\][\n]{1,60})\]\]/g,
        (m, b) => this.blanks[p.id]?.[b.trim()] || m,
      );
    },
    async copyPrompt(p) {
      if (await this.copyText(this.filled(p))) {
        this.copied = p.id;
        setTimeout(() => (this.copied = ''), 1800);
      } else this.error = 'Could not copy. Select the text and copy it by hand.';
    },
  }));

  // ───────── System → Prompts (docs/DECISIONS.md D-082) ─────────
  Alpine.data('promptsPage', () => ({
    ...H,
    items: [],
    projectType: '',
    ruleAreas: [], // [{ id, label, hint }] the areas a builder can ask rules for
    tab: 'master',
    tabs: [
      { id: 'master', label: 'Master prompt' },
      { id: 'workflow', label: 'Working method' },
      { id: 'types', label: 'Project types' },
      { id: 'rules', label: 'Rules' },
      { id: 'preview', label: 'Preview' },
    ],
    current: null, // the prompt being edited: { key, kind, label, description, body, enabled, builtin, edited, isNew, id, area }
    preview: null, // { text, projectType, planning, parts }
    previewType: '',
    previewTopics: [],
    loaded: false,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('prompts', 'page'))) return;
      await this.load();
      this.setTab('master');
    },
    async load() {
      try {
        const d = await api('GET', '/admin/prompts');
        this.items = d.items;
        this.projectType = d.projectType;
        this.planning = d.planning || this.planning;
        this.ruleAreas = d.ruleAreas || [];
        this.previewType ||= d.projectType;
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },
    get tabInfo() {
      return (
        {
          master:
            'The quality standard every AI builder follows for every site, whatever its type. Keep it about principles, not about one kind of site.',
          workflow:
            'How a request is handled: when to ask questions, when to show a plan, when to just build. Which one applies is chosen under Settings → AI behaviour.',
          types:
            'What “good” means for one kind of site (shop, school, restaurant…). The type for this site is chosen under Settings → General; add your own for kinds of site you build often.',
          rules:
            'Conventions for one area, such as database tables or pages. They are sent only when the AI works in that area, so each stays short and is followed more reliably.',
          preview:
            'The exact text the AI receives for a project type and the areas you tick, so you can check how your edits read together.',
        }[this.tab] || ''
      );
    },
    planning: 'ask_when_unclear',
    get planningLabel() {
      return (
        {
          ask_when_unclear: 'Ask when unclear',
          always_confirm: 'Always confirm first',
          never_ask: 'Never ask',
        }[this.planning] || this.planning
      );
    },
    setTab(id) {
      this.tab = id;
      this.error = '';
      this.current = null;
      if (id === 'master') {
        const m = this.items.find((i) => i.kind === 'master');
        if (m) this.edit(m);
      }
    },
    get tabItems() {
      const kind = { workflow: 'workflow', types: 'project_type', rules: 'rules' }[this.tab];
      return this.items.filter((i) => i.kind === kind);
    },
    get typeItems() {
      return this.items.filter((i) => i.kind === 'project_type');
    },
    get freeAreas() {
      const used = new Set(this.items.filter((i) => i.kind === 'rules').map((i) => i.key.slice(6)));
      return this.ruleAreas.filter((a) => !used.has(a.id));
    },
    isSelected(i) {
      return i.kind === 'project_type' && i.key === 'project.' + this.projectType;
    },
    edit(i) {
      this.error = '';
      this.current = { ...i, isNew: false, id: '', area: '' };
    },
    startNew() {
      this.error = '';
      const rules = this.tab === 'rules';
      this.current = {
        key: '',
        kind: rules ? 'rules' : 'project_type',
        label: '',
        description: '',
        body: '',
        enabled: true,
        builtin: false,
        edited: false,
        isNew: true,
        id: '',
        area: rules ? this.freeAreas[0]?.id || '' : '',
      };
    },
    async save() {
      this.busy = true;
      this.error = '';
      const c = this.current;
      const body = {
        label: c.label,
        description: c.description,
        body: c.body,
        enabled: c.enabled,
      };
      try {
        if (c.isNew)
          await api(
            'POST',
            '/admin/prompts',
            c.kind === 'rules' ? { ...body, area: c.area } : { ...body, id: c.id },
          );
        else await api('PUT', '/admin/prompts/' + encodeURIComponent(c.key), body);
        this.current = null;
        await this.load();
        this.setTab(this.tab);
        toast('Prompt saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async reset() {
      if (
        !window.confirm(
          'Replace your changes to this prompt with the text that ships with the platform?',
        )
      )
        return;
      this.busy = true;
      this.error = '';
      try {
        const d = await api(
          'POST',
          '/admin/prompts/' + encodeURIComponent(this.current.key) + '/reset',
        );
        this.current = { ...d.item, isNew: false, id: '', area: '' };
        await this.load();
        toast('Prompt reset.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async remove() {
      const what = this.current.kind === 'rules' ? 'rule set' : 'project type';
      if (!window.confirm(`Delete this ${what}?`)) return;
      this.busy = true;
      this.error = '';
      try {
        await api('DELETE', '/admin/prompts/' + encodeURIComponent(this.current.key));
        this.current = null;
        await this.load();
        toast('Deleted.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async showPreview() {
      this.error = '';
      try {
        this.preview = await api(
          'GET',
          '/admin/prompts/compose?projectType=' +
            encodeURIComponent(this.previewType) +
            '&topics=' +
            encodeURIComponent(this.previewTopics.join(',')),
        );
      } catch (e) {
        this.error = e.message;
      }
    },
  }));

  // ───────── Operations → Backups (docs/DECISIONS.md D-120) ─────────
  Alpine.data('backupPage', () => ({
    ...H,
    items: [],
    status: { state: 'idle' },
    loaded: false,
    busy: false,
    error: '',
    notice: '',
    form: {
      name: '',
      secrets: 'keep',
      data: 'all',
      includeMedia: true,
      folders: ['public', 'plugins', 'site'],
    },
    folderChoices: [
      { id: 'public', label: 'Site files (public/)' },
      { id: 'plugins', label: 'Plugins (plugins/)' },
      { id: 'site', label: 'Starter site, themes and wording (site/)' },
    ],
    plan: null, // what restoring the chosen backup would do
    safety: false,
    confirmText: '',
    timer: null,
    get running() {
      return this.status.state === 'running';
    },
    async init() {
      if (!(await this.mountFragment('backup', 'page'))) return;
      await this.load();
      this.timer = setInterval(() => this.poll(), 2000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async load() {
      try {
        const d = await api('GET', '/admin/backups');
        this.items = d.items;
        this.status = d.status;
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },
    /** While something runs the list is reread; when it stops, the result is reported once. */
    async poll() {
      if (!this.loaded) return;
      const was = this.running;
      try {
        this.status = await api('GET', '/admin/backups/status');
      } catch {
        return; // a restore signs everyone out; the next sign-in shows the result
      }
      if (was && !this.running) {
        await this.load();
        if (this.status.error) this.error = this.status.error;
        else this.notice = 'Finished.';
      } else if (this.running !== was) await this.load();
    },
    when(t) {
      return new Date(t).toLocaleString();
    },
    size(n) {
      return n >= 1048576
        ? (n / 1048576).toFixed(1) + ' MB'
        : Math.max(1, Math.round(n / 1024)) + ' KB';
    },
    contents(b) {
      const m = b.manifest;
      if (!m) return '';
      const folderFiles = Object.values(m.folders || {}).reduce((n, f) => n + f.files, 0);
      return `${m.rows} records in ${Object.keys(m.tables).length} tables, ${m.media.files} uploads, ${folderFiles} folder files, ${m.dialect}, passwords ${m.secrets === 'remove' ? 'left out' : 'kept'}`;
    },
    async create() {
      this.busy = true;
      this.error = this.notice = '';
      try {
        await api('POST', '/admin/backups', { ...this.form });
        this.form.name = '';
        await this.load();
        this.status = await api('GET', '/admin/backups/status');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async upload(ev) {
      const file = ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      this.busy = true;
      this.error = this.notice = '';
      try {
        await api('POST', '/admin/backups/upload?name=' + encodeURIComponent(file.name), file);
        await this.load();
        this.notice = 'Backup uploaded. Choose Restore to use it.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async startRestore(b) {
      this.error = this.notice = '';
      this.confirmText = '';
      try {
        this.plan = await api('GET', `/admin/backups/${b.id}/inspect`);
      } catch (e) {
        this.error = e.message;
      }
    },
    async restore() {
      this.busy = true;
      this.error = this.notice = '';
      try {
        await api('POST', `/admin/backups/${this.plan.backup.id}/restore`, {
          confirm: this.confirmText,
          safety: this.safety,
        });
        this.plan = null;
        this.status = await api('GET', '/admin/backups/status');
        this.notice = 'Restore started.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async remove(b) {
      if (!window.confirm(`Delete the backup “${b.name}”? The file cannot be brought back.`))
        return;
      this.busy = true;
      this.error = this.notice = '';
      try {
        await api('DELETE', '/admin/backups/' + b.id);
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── Webmaster → AI Page Designer (docs/DECISIONS.md D-065) ─────────
  // ───────── startup templates: one picker for Site pages and the AI Page Designer ─────────
  // The button and the panel are one fragment (site/template-picker.html), mounted into whichever screen asks for it.
  // `mode` decides what "Use this template" does: 'designer' starts a Page Designer session with the template staged as
  // its draft; 'pages' opens the page editor on a new page filled from it.
  const PAGE_ADDRESS = /^pages\/[a-z0-9][a-z0-9/_-]*\.html$/i;
  Alpine.data('templatePicker', (mode) => ({
    mode,
    templates: [],
    open: false,
    cat: 'All',
    tpl: null, // the template shown in the preview
    detail: null, // …and its page source (front matter + body)
    html: '',
    busy: false, // drawing the preview
    previewError: '',
    path: '',
    error: '',
    starting: false,
    drawn: new Map(), // template id → { detail, html }: switching back to one is instant
    async init() {
      try {
        this.$el.innerHTML = await loadFragment('site', 'template-picker');
      } catch {
        return; // no button: "a brand-new page" still works without templates
      }
      for (const child of [...this.$el.children]) Alpine.initTree(child);
      try {
        this.templates = (await api('GET', '/admin/site/page-templates')).templates;
      } catch {
        /* needs pages.write; without it the button stays hidden */
      }
    },
    get categories() {
      return ['All', ...new Set(this.templates.map((t) => t.category))];
    },
    get shown() {
      return this.cat === 'All'
        ? this.templates
        : this.templates.filter((t) => t.category === this.cat);
    },
    get url() {
      const p = this.path
        .trim()
        .replace(/^pages\//, '')
        .replace(/\.html$/, '');
      return '/' + (p === 'index' ? '' : p);
    },
    openPanel() {
      this.open = true;
      this.error = '';
      if (!this.tpl && this.templates.length) this.pick(this.templates[0]);
    },
    async pick(t) {
      this.tpl = t;
      this.path = `pages/${t.id}.html`;
      this.error = '';
      this.previewError = '';
      const have = this.drawn.get(t.id);
      if (have) {
        this.detail = have.detail;
        this.html = have.html;
        return;
      }
      this.html = '';
      this.detail = null;
      this.busy = true;
      try {
        const detail = (await api('GET', `/admin/site/page-templates/${t.id}`)).template;
        const front = Object.entries(detail.front)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: "${String(v).replace(/"/g, "'")}"`);
        const content = (front.length ? `---\n${front.join('\n')}\n---\n` : '') + detail.body;
        const out = await api('POST', '/admin/site/preview', {
          mode: 'page',
          path: `pages/${t.id}.html`,
          content,
          url: '/' + t.id,
        });
        if (this.tpl?.id !== t.id) return; // the person already picked another one
        this.detail = detail;
        this.html = out.html || '';
        this.drawn.set(t.id, { detail, html: this.html });
      } catch (e) {
        this.previewError =
          'The preview could not be drawn (' + e.message + '). You can still use the template.';
      } finally {
        this.busy = false;
      }
    },
    async use() {
      const path = this.path.trim();
      this.error = '';
      if (!PAGE_ADDRESS.test(path)) {
        this.error =
          'Use an address like pages/about.html — letters, numbers, dashes and slashes, inside pages/ and ending in .html.';
        return;
      }
      this.starting = true;
      try {
        if (this.mode === 'designer') {
          const { session } = await api('POST', '/admin/page-designer/sessions', {
            template: this.tpl.id,
            path,
          });
          this.open = false;
          location.hash = '#/pageDesigner/' + session.id;
          return;
        }
        // Site pages: the editor opens on a NEW page filled from the template. Saving a new page would silently
        // replace one already at that address, so a taken address is refused here, while it is easy to change.
        if ((await api('GET', '/admin/site/pages')).pages.some((p) => p.path === path)) {
          this.error = `A page already exists at ${path}. Choose a different address, or open that page and edit it.`;
          return;
        }
        let detail = this.detail;
        if (!detail)
          detail = (await api('GET', `/admin/site/page-templates/${this.tpl.id}`)).template;
        window.__pageTemplate = {
          name: path.replace(/^pages\//, '').replace(/\.html$/, ''),
          front: detail.front,
          body: detail.body,
        };
        this.open = false;
        location.hash = '#/pages/new';
      } catch (e) {
        this.error = e.message; // stays in the panel, beside the address that needs fixing
      } finally {
        this.starting = false;
      }
    },
  }));

  Alpine.data('pageDesignerList', () => ({
    ...H,
    sessions: [],
    pages: [],
    targetPath: '', // '' = a brand-new page; else edit this existing one
    loaded: false,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('page-designer', 'list'))) return;
      await this.load();
      try {
        this.pages = (await api('GET', '/admin/site/pages')).pages;
      } catch {
        /* the "edit an existing page" dropdown just stays empty */
      }
    },
    async load() {
      this.sessions = (await api('GET', '/admin/page-designer/sessions')).sessions;
      this.loaded = true;
    },
    async start() {
      this.busy = true;
      this.error = '';
      try {
        const body = this.targetPath ? { path: this.targetPath } : {};
        const { session } = await api('POST', '/admin/page-designer/sessions', body);
        location.hash = '#/pageDesigner/' + session.id;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  Alpine.data('pageDesignerChat', (id) => ({
    ...H,
    id,
    session: null,
    messages: [],
    proposals: [],
    draft: '',
    busy: false,
    deciding: false,
    saving: false,
    saveMessage: '',
    error: '',
    loaded: false,
    preview: { html: '', busy: false, error: '' },
    async init() {
      if (!(await this.mountFragment('page-designer', 'chat'))) return;
      await this.load();
      if (this.currentDraft) await this.refreshPreview();
    },
    async load() {
      const data = await api('GET', `/admin/page-designer/sessions/${this.id}`);
      this.session = data.session;
      this.messages = data.messages;
      this.proposals = data.proposals;
      this.loaded = true;
    },
    get pendingProposals() {
      return this.proposals.filter((p) => p.status === 'pending');
    },
    /** The most recent write_page_draft tool call across the whole conversation — mirrors service.js's own
     * findLatestDraft() so the UI shows exactly what the model last staged, with no separate state to drift. */
    get currentDraft() {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const blocks = Array.isArray(this.messages[i].content) ? this.messages[i].content : [];
        const call = blocks.find((b) => b.type === 'tool_use' && b.name === 'write_page_draft');
        if (call) return call.input;
      }
      return null;
    },
    async send() {
      const text = this.draft.trim();
      if (!text || this.busy) return;
      this.draft = '';
      this.error = '';
      this.saveMessage = '';
      this.busy = true;
      try {
        const out = await api('POST', `/admin/page-designer/sessions/${this.id}/messages`, {
          text,
        });
        this.session = out.session;
        this.messages = [...this.messages, ...out.messages];
        await this.load(); // picks up any new proposals too
        if (this.currentDraft) await this.refreshPreview();
      } catch (e) {
        this.error = e.message;
        this.draft = text; // give it back so nothing typed is lost
      } finally {
        this.busy = false;
      }
    },
    async decide(p, verb) {
      this.deciding = true;
      try {
        await api(
          'POST',
          `/admin/page-designer/sessions/${this.id}/proposals/${p.id}/${verb === 'approve' ? 'approve' : 'reject'}`,
        );
        await this.load();
        if (this.currentDraft) await this.refreshPreview(); // an approved component may now render differently
      } catch (e) {
        this.error = e.message;
      } finally {
        this.deciding = false;
      }
    },
    async refreshPreview() {
      this.preview.busy = true;
      this.preview.error = '';
      try {
        const r = await api('POST', `/admin/page-designer/sessions/${this.id}/preview`);
        this.preview.html = r.redirect
          ? `<p style="font:14px system-ui;padding:1rem">Redirects to ${r.redirect.to}</p>`
          : r.html;
      } catch (e) {
        this.preview.error = e.message;
      } finally {
        this.preview.busy = false;
      }
    },
    async savePage() {
      const d = this.currentDraft;
      if (!d) return;
      this.saving = true;
      this.error = '';
      this.saveMessage = '';
      try {
        await api('POST', `/admin/page-designer/sessions/${this.id}/save`, {
          path: d.path,
          frontMatter: d.front_matter || {},
          body: d.body,
        });
        this.saveMessage = 'Saved — the page is live.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.saving = false;
      }
    },
    // ───── turning the raw Anthropic message history into chat-friendly entries (same shape as Plugin Editor) ─────
    get turns() {
      const out = [];
      for (let i = 0; i < this.messages.length; i++) {
        const m = this.messages[i];
        if (m.role === 'user' && typeof m.content === 'string') {
          out.push({ kind: 'user', text: m.content });
          continue;
        }
        if (m.role === 'user') continue; // a tool-result message: already folded into the turn before it
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const nextContent = this.messages[i + 1]?.content;
        const results = Array.isArray(nextContent) ? nextContent : [];
        const calls = blocks
          .filter((b) => b.type === 'tool_use')
          .map((c) => {
            const r = results.find((x) => x.tool_use_id === c.id);
            return {
              name: c.name,
              input: c.input,
              ok: r ? !r.is_error : null,
              resultText: r
                ? typeof r.content === 'string'
                  ? r.content
                  : JSON.stringify(r.content)
                : '',
            };
          });
        if (text || calls.length) out.push({ kind: 'assistant', text, calls });
      }
      return out;
    },
  }));

  // ───────── Automation → Scheduler (docs/DECISIONS.md D-051) ─────────
  Alpine.data('schedulerList', () => ({
    ...H,
    tasks: [],
    loaded: false,
    async init() {
      if (!(await this.mountFragment('scheduler', 'list'))) return;
      await this.load();
    },
    async load() {
      this.tasks = (await api('GET', '/admin/scheduler/tasks')).tasks;
      this.loaded = true;
    },
    describe(t) {
      if (t.scheduleType === 'cron') return t.cronExpr;
      const ms = t.everyMs;
      if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000} day(s)`;
      if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} hour(s)`;
      return `every ${Math.round(ms / 60_000)} minute(s)`;
    },
    async remove(t) {
      if (!confirm(`Delete the scheduled task "${t.name}"?`)) return;
      await api('DELETE', `/admin/scheduler/tasks/${t.id}`);
      await this.load();
      toast('Task deleted.');
    },
    async runNow(t) {
      await api('POST', `/admin/scheduler/tasks/${t.id}/run`);
      toast('Run queued.');
      setTimeout(() => this.load(), 800);
    },
  }));

  Alpine.data('schedulerEditor', (id) => ({
    ...H,
    isNew: !id,
    id: id || null,
    name: '',
    kind: 'service',
    target: '',
    scheduleType: 'interval',
    everyValue: 1,
    everyUnit: 'hours', // 'minutes' | 'hours' | 'days'
    cronExpr: '',
    cronPreview: [],
    cronError: '',
    enabled: true,
    paramsText: '{}',
    services: [],
    webhooks: [],
    lastRunAt: null,
    lastStatus: '',
    lastError: '',
    loaded: false,
    busy: false,
    error: '',
    runBusy: false,

    async init() {
      if (!(await this.mountFragment('scheduler', 'edit'))) return;
      const [svcs, whs] = await Promise.all([
        api('GET', '/admin/services'),
        api('GET', '/admin/webhooks'),
      ]);
      this.services = svcs.services;
      this.webhooks = whs.webhooks;
      if (!this.isNew) await this.load();
      this.loaded = true;
    },
    async load() {
      const { task } = await api('GET', `/admin/scheduler/tasks/${this.id}`);
      this.name = task.name;
      this.kind = task.kind;
      this.target = task.target;
      this.scheduleType = task.scheduleType;
      if (task.everyMs) {
        if (task.everyMs % 86_400_000 === 0) {
          this.everyValue = task.everyMs / 86_400_000;
          this.everyUnit = 'days';
        } else if (task.everyMs % 3_600_000 === 0) {
          this.everyValue = task.everyMs / 3_600_000;
          this.everyUnit = 'hours';
        } else {
          this.everyValue = Math.round(task.everyMs / 60_000);
          this.everyUnit = 'minutes';
        }
      }
      this.cronExpr = task.cronExpr || '';
      this.enabled = task.enabled;
      this.paramsText = JSON.stringify(task.params || {}, null, 2);
      this.lastRunAt = task.lastRunAt || null;
      this.lastStatus = task.lastStatus || '';
      this.lastError = task.lastError || '';
      if (this.cronExpr) await this.updateCronPreview();
    },
    get everyMs() {
      const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[this.everyUnit];
      return Math.round(Number(this.everyValue) * unitMs);
    },
    async updateCronPreview() {
      this.cronError = '';
      this.cronPreview = [];
      if (!this.cronExpr.trim()) return;
      try {
        const r = await api(
          'GET',
          `/admin/scheduler/cron-preview?expr=${encodeURIComponent(this.cronExpr)}`,
        );
        if (r.error) this.cronError = r.error;
        else this.cronPreview = r.next;
      } catch (e) {
        this.cronError = e.message;
      }
    },
    buildBody() {
      const body = {
        name: this.name.trim(),
        kind: this.kind,
        target: this.target,
        scheduleType: this.scheduleType,
        enabled: this.enabled,
        params: JSON.parse(this.paramsText || '{}'),
      };
      if (this.scheduleType === 'interval') body.everyMs = this.everyMs;
      else body.cronExpr = this.cronExpr.trim();
      return body;
    },
    async save() {
      this.error = '';
      if (!this.name.trim() || !this.target) {
        this.error = 'Give the task a name and pick a target.';
        return;
      }
      let body;
      try {
        body = this.buildBody();
      } catch {
        this.error = 'The params aren’t valid JSON.';
        return;
      }
      this.busy = true;
      try {
        if (this.isNew) {
          const { task } = await api('POST', '/admin/scheduler/tasks', body);
          this.id = task.id;
          this.isNew = false;
          history.replaceState(null, '', `#/scheduler/${task.id}`);
        } else {
          await api('PUT', `/admin/scheduler/tasks/${this.id}`, body);
        }
        toast('Task saved.');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async runNow() {
      this.runBusy = true;
      this.error = '';
      try {
        await api('POST', `/admin/scheduler/tasks/${this.id}/run`);
        toast('Run queued.');
        setTimeout(() => this.load(), 800);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.runBusy = false;
      }
    },
  }));

  // ───────── translations (site locales, merged with the theme's) ─────────
  Alpine.data('localesPage', () => ({
    ...H,
    languages: [],
    defaultLocale: 'en',
    themeId: '',
    code: '',
    name: '',
    entries: [],
    hash: null,
    filter: '',
    onlyMissing: false,
    newCode: '',
    scope: 'missing',
    translating: false,
    aiNotes: '',
    error: '',
    busy: false,
    loaded: false,
    async init() {
      if (!(await this.mountFragment('site', 'locales'))) return;
      const r = await api('GET', '/admin/site/locales');
      this.languages = r.languages;
      this.defaultLocale = r.defaultLocale;
      this.themeId = r.themeId;
      this.loaded = true;
      await this.open(this.defaultLocale);
    },
    async open(code) {
      this.error = '';
      const r = await api('GET', `/admin/site/locales/${encodeURIComponent(code)}`);
      this.code = r.code;
      this.name = r.name;
      this.hash = r.hash;
      this.entries = r.entries.map((e) => ({ ...e, edit: e.site ?? '' }));
    },
    get shown() {
      const q = this.filter.trim().toLowerCase();
      return this.entries.filter(
        (e) =>
          (!this.onlyMissing || (e.value === null && !e.edit)) &&
          (!q ||
            [e.key, e.reference, e.theme, e.edit].some((t) =>
              String(t ?? '')
                .toLowerCase()
                .includes(q),
            )),
      );
    },
    get dirty() {
      return this.entries.filter((e) => (e.site ?? '') !== e.edit.trim()).length;
    },
    get missing() {
      return this.entries.filter((e) => e.value === null && !e.edit.trim()).length;
    },
    /** Written by the AI and still as it wrote it (typing over it makes it the person's own). */
    isAi(e) {
      return !!e.ai && e.edit.trim() === (e.site ?? '');
    },
    get reviewCount() {
      return this.entries.filter((e) => this.isAi(e)).length;
    },
    async translate() {
      this.error = '';
      this.aiNotes = '';
      if (this.dirty) {
        this.error = 'Save your changes first, then translate.';
        return;
      }
      this.translating = true;
      try {
        const r = await api(
          'POST',
          `/admin/site/locales/${encodeURIComponent(this.code)}/translate`,
          {
            scope: this.scope,
          },
        );
        await this.open(this.code);
        this.languages = (await api('GET', '/admin/site/locales')).languages;
        this.aiNotes = r.translated
          ? `Translated ${r.translated} text${r.translated === 1 ? '' : 's'}. They are marked AI until you check them.`
          : 'Nothing needed translating.';
        if (r.skipped.length)
          this.aiNotes += ` ${r.skipped.length} left out: ${r.skipped
            .slice(0, 3)
            .map((s) => `${s.key} (${s.reason})`)
            .join('; ')}${r.skipped.length > 3 ? '…' : ''}`;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.translating = false;
      }
    },
    /** Confirm AI translations read well: the given keys, or every unchecked one in this language. */
    async markChecked(keys) {
      this.busy = true;
      this.error = '';
      try {
        await api('POST', `/admin/site/locales/${encodeURIComponent(this.code)}/review`, {
          keys: keys ?? this.entries.filter((e) => e.ai).map((e) => e.key),
        });
        await this.open(this.code);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async addLanguage() {
      this.error = '';
      const c = this.newCode.trim();
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(c)) {
        this.error = 'A language code looks like fr, hi or en-IN.';
        return;
      }
      if (!this.languages.some((l) => l.code === c))
        this.languages = [...this.languages, { code: c, name: c, site: false, theme: false }];
      this.newCode = '';
      await this.open(c);
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        const strings = Object.fromEntries(
          this.entries.filter((e) => e.edit.trim()).map((e) => [e.key, e.edit.trim()]),
        );
        await api('PUT', `/admin/site/locales/${encodeURIComponent(this.code)}`, {
          strings,
          ...(this.hash ? { expectedHash: this.hash } : {}),
        });
        toast('Translations saved. Every server shows them now.');
        await this.open(this.code);
        this.languages = (await api('GET', '/admin/site/locales')).languages;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async importZip(file) {
      if (!file) return;
      this.busy = true;
      this.error = '';
      try {
        const r = await api('POST', '/admin/site/locales/import', file);
        toast(
          `Imported ${r.saved.length} language${r.saved.length === 1 ? '' : 's'}: ${r.saved.join(', ') || 'none'}.${r.errors.length ? ` ${r.errors.length} failed.` : ''}`,
        );
        if (r.errors.length) this.error = r.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
        this.languages = (await api('GET', '/admin/site/locales')).languages;
        await this.open(this.code);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));

  // ───────── Copy database (System → Database → Copy database; was "Move database") ─────────
  Alpine.data('dbMovePanel', () => ({
    ...H,
    url: '',
    showUrl: true, // the string is shown so it can be checked; Hide masks it (it holds the new database's password)
    tested: null,
    st: { state: 'idle' },
    busy: false,
    error: '',
    restart: true,
    switched: null,
    timer: null,
    get running() {
      return this.st.state === 'running';
    },
    get sourceKindLabel() {
      return (
        { sqlite: 'SQLite', mysql: 'MySQL', pg: 'PostgreSQL' }[this.st.sourceKind] ||
        'this database'
      );
    },
    get rowsTotal() {
      return (this.st.tables || []).reduce((n, x) => n + x.source, 0);
    },
    get rowsDone() {
      return (this.st.tables || []).reduce((n, x) => n + (x.done ? x.source : x.copied || 0), 0);
    },
    get skipped() {
      return (this.st.objects || []).filter((o) => o.status === 'skipped');
    },
    get percent() {
      return this.rowsTotal ? Math.round((this.rowsDone / this.rowsTotal) * 100) : 5;
    },
    get headline() {
      return (
        { running: 'Copying…', ready: 'Copied and checked', failed: 'The copy did not finish' }[
          this.st.state
        ] || ''
      );
    },
    async init() {
      await this.refresh();
      this.timer = setInterval(() => this.running && this.refresh(), 1500);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async refresh() {
      try {
        this.st = await api('GET', '/admin/dbms/move');
      } catch (e) {
        this.error = e.message;
      }
    },
    async run(fn) {
      this.busy = true;
      this.error = '';
      try {
        await fn();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    test() {
      return this.run(async () => {
        this.tested = await api('POST', '/admin/dbms/move/test', { url: this.url });
      });
    },
    start(resume = false) {
      return this.run(async () => {
        this.switched = null;
        this.st = await api('POST', '/admin/dbms/move/start', { url: this.url, resume });
      });
    },
    clear() {
      return this.run(async () => {
        this.st = await api('POST', '/admin/dbms/move/discard', { url: this.url });
        this.tested = null;
        this.switched = null;
      });
    },
    switchNow() {
      const what = this.restart ? ' and restart' : '';
      if (
        !confirm(
          `Switch this server to the new database${what}? The old database is left as it is.`,
        )
      )
        return;
      return this.run(async () => {
        this.switched = await api('POST', '/admin/dbms/move/switch', {
          url: this.url,
          restart: this.restart,
        });
        await this.refresh();
      });
    },
  }));

  // ───────── database (System → Database, D-047) ─────────
  Alpine.data('dbmsPage', () => ({
    ...H,
    loaded: false,
    busy: false,
    error: '',
    tables: [],
    typeLabels: {},
    tab: 'tables', // 'tables' | 'table' | 'console'
    selectedTable: '',
    tableInfo: null,
    rows: [],
    rowsPage: 1,
    rowsPerPage: 25,
    rowsTotal: 0,
    rowsPages: 1,
    sortCol: '',
    sortDir: 'asc',
    editingRow: null, // a row object, or the string 'new'
    editForm: {},
    showCreateForm: false,
    newTable: { name: '', columns: [] },
    sql: '',
    consoleBusy: false,
    consoleError: '',
    consoleResult: null,
    savedQueries: [],
    newQueryName: '',

    async init() {
      if (!(await this.mountFragment('dbms', 'page'))) return;
      await this.loadTables();
      this.loaded = true;
    },
    async loadTables() {
      const r = await api('GET', '/admin/dbms/tables');
      this.tables = r.tables;
      this.typeLabels = r.typeLabels;
    },

    async openTable(name) {
      this.tab = 'table';
      this.selectedTable = name;
      this.editingRow = null;
      this.error = '';
      this.rowsPage = 1;
      this.sortCol = '';
      await this.loadTableInfo();
      await this.loadRows();
    },
    async loadTableInfo() {
      this.tableInfo = await api(
        'GET',
        `/admin/dbms/tables/${encodeURIComponent(this.selectedTable)}`,
      );
    },
    async loadRows() {
      const qs = new URLSearchParams({
        page: this.rowsPage,
        per_page: this.rowsPerPage,
        ...(this.sortCol ? { sort: this.sortCol, dir: this.sortDir } : {}),
      });
      const r = await api(
        'GET',
        `/admin/dbms/tables/${encodeURIComponent(this.selectedTable)}/rows?${qs}`,
      );
      this.rows = r.rows;
      this.rowsTotal = r.total;
      this.rowsPages = r.pages;
    },
    sortBy(col) {
      this.sortDir = this.sortCol === col && this.sortDir === 'asc' ? 'desc' : 'asc';
      this.sortCol = col;
      this.rowsPage = 1;
      this.loadRows();
    },
    changePage(p) {
      this.rowsPage = Math.min(this.rowsPages, Math.max(1, p));
      this.loadRows();
    },

    pkOf(row) {
      return Object.fromEntries(
        this.tableInfo.columns.filter((c) => c.primaryKey).map((c) => [c.name, row[c.name]]),
      );
    },
    startNewRow() {
      this.editingRow = 'new';
      this.editForm = Object.fromEntries(
        this.tableInfo.columns
          .filter((c) => !(c.primaryKey && c.autoIncrement))
          .map((c) => [c.name, c.default ?? '']),
      );
    },
    startEditRow(row) {
      this.editingRow = row;
      this.editForm = { ...row };
    },
    cancelEdit() {
      this.editingRow = null;
      this.editForm = {};
    },
    async saveRow() {
      this.busy = true;
      this.error = '';
      try {
        if (this.editingRow === 'new') {
          await api(
            'POST',
            `/admin/dbms/tables/${encodeURIComponent(this.selectedTable)}/rows`,
            this.editForm,
          );
          toast('Record created.');
        } else {
          await api('PUT', `/admin/dbms/tables/${encodeURIComponent(this.selectedTable)}/rows`, {
            pk: this.pkOf(this.editingRow),
            data: this.editForm,
          });
          toast('Record saved.');
        }
        this.editingRow = null;
        await this.loadRows();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async deleteRow(row) {
      if (!confirm('Delete this record? This can’t be undone.')) return;
      await api('DELETE', `/admin/dbms/tables/${encodeURIComponent(this.selectedTable)}/rows`, {
        pk: this.pkOf(row),
      });
      toast('Record deleted.');
      await this.loadRows();
    },

    addColumn() {
      this.newTable.columns.push({
        name: '',
        type: 'string',
        nullable: true,
        default: '',
        primaryKey: false,
        autoIncrement: false,
      });
    },
    removeColumn(i) {
      this.newTable.columns.splice(i, 1);
    },
    async createTable() {
      this.busy = true;
      this.error = '';
      try {
        await api('POST', '/admin/dbms/tables', this.newTable);
        toast(`Table "${this.newTable.name}" created.`);
        this.newTable = { name: '', columns: [] };
        this.showCreateForm = false;
        await this.loadTables();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async dropTable(name) {
      if (prompt(`Type "${name}" to confirm dropping it. This can’t be undone.`) !== name) return;
      await api('DELETE', `/admin/dbms/tables/${encodeURIComponent(name)}`);
      toast(`Table "${name}" dropped.`);
      if (this.selectedTable === name) {
        this.tab = 'tables';
        this.selectedTable = '';
      }
      await this.loadTables();
    },

    async openConsole() {
      this.tab = 'console';
      this.consoleResult = null;
      this.consoleError = '';
      await this.loadSavedQueries();
    },
    async loadSavedQueries() {
      this.savedQueries = (await api('GET', '/admin/dbms/saved-queries')).queries;
    },
    async runQuery() {
      if (!this.sql.trim()) return;
      this.consoleBusy = true;
      this.consoleError = '';
      try {
        this.consoleResult = await api('POST', '/admin/dbms/query', { sql: this.sql });
      } catch (e) {
        this.consoleError = e.message;
        this.consoleResult = null;
      } finally {
        this.consoleBusy = false;
      }
    },
    loadSavedQuery(q) {
      this.sql = q.sql;
    },
    async saveCurrentQuery() {
      if (!this.newQueryName.trim() || !this.sql.trim()) return;
      await api('POST', '/admin/dbms/saved-queries', {
        name: this.newQueryName.trim(),
        sql: this.sql,
      });
      this.newQueryName = '';
      await this.loadSavedQueries();
      toast('Query saved.');
    },
    async deleteSavedQuery(q) {
      if (!confirm(`Delete the saved query "${q.name}"?`)) return;
      await api('DELETE', `/admin/dbms/saved-queries/${q.id}`);
      await this.loadSavedQueries();
    },
  }));

  // ───────── redirects ─────────
  Alpine.data('redirectsPage', () => ({
    ...H,
    redirects: [],
    form: { from: '', to: '', status: 301 },
    error: '',
    async init() {
      if (!(await this.mountFragment('site', 'redirects'))) return;
      await this.load();
    },
    async load() {
      this.redirects = (await api('GET', '/admin/redirects')).redirects;
    },
    async add() {
      this.error = '';
      try {
        await api('POST', '/admin/redirects', { ...this.form, status: Number(this.form.status) });
        this.form = { from: '', to: '', status: 301 };
        await this.load();
        toast('Redirect added. It works on every server now.');
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove(r) {
      if (!confirm(`Remove the redirect from ${r.from}?`)) return;
      await api('DELETE', `/admin/redirects/${r.id}`);
      await this.load();
    },
  }));

  // ───────── contact messages ─────────
  Alpine.data('messagesPage', () => ({
    ...H,
    messages: [],
    loaded: false,
    async init() {
      if (!(await this.mountFragment('site', 'messages'))) return;
      this.messages = (await api('GET', '/admin/messages')).messages;
      this.loaded = true;
    },
    async remove(m) {
      if (!confirm(`Delete the message from ${m.name}?`)) return;
      await api('DELETE', `/admin/messages/${m.id}`);
      this.messages = this.messages.filter((x) => x.id !== m.id);
    },
  }));

  // ───────── my account ─────────
  Alpine.data('accountPage', () => ({
    ...H,
    me: auth.user,
    profile: { name: auth.user.name },
    savingName: false,
    nameError: '',
    form: { current: '', next: '', confirm: '' },
    errors: {},
    busy: false,
    sessions: [],
    loaded: false,
    minLength: meta.passwordMinLength,
    async init() {
      if (!(await this.mountFragment('auth', 'account'))) return;
      await this.loadSessions();
    },
    async loadSessions() {
      this.sessions = (await api('GET', '/auth/sessions')).sessions;
      this.loaded = true;
    },
    get others() {
      return this.sessions.filter((s) => !s.current).length;
    },
    get nameDirty() {
      return this.profile.name.trim() !== this.me.name;
    },
    async saveName() {
      this.nameError = '';
      this.savingName = true;
      try {
        const { user } = await api('PATCH', '/auth/profile', { name: this.profile.name });
        this.me = user;
        this.profile.name = user.name;
        this.$dispatch('profile-updated', user); // refresh the name in the header
        toast('Name saved.');
      } catch (e) {
        this.nameError = e.message;
      } finally {
        this.savingName = false;
      }
    },
    async changePassword() {
      this.errors = {};
      if (this.form.next !== this.form.confirm) {
        this.errors.confirm = "The two new passwords don't match.";
        return;
      }
      this.busy = true;
      try {
        const r = await api('POST', '/auth/password', {
          current: this.form.current,
          next: this.form.next,
        });
        this.form = { current: '', next: '', confirm: '' };
        const n = r.otherSessionsSignedOut;
        toast(
          n
            ? `Password changed. ${n} other device${n === 1 ? ' was' : 's were'} signed out.`
            : 'Password changed.',
        );
        await this.loadSessions();
      } catch (e) {
        const field = e.field === 'password' ? 'next' : e.field;
        if (field) this.errors[field] = e.message;
        else toast(e.message, 'error');
      } finally {
        this.busy = false;
      }
    },
    async revoke(s) {
      if (!confirm(`Sign out ${s.device}?`)) return;
      try {
        await api('DELETE', `/auth/sessions/${s.id}`);
        toast('Signed out.');
      } catch (e) {
        toast(e.message, 'error');
      }
      await this.loadSessions();
    },
    async revokeOthers() {
      if (!confirm(`Sign out ${this.others} other device${this.others === 1 ? '' : 's'}?`)) return;
      try {
        const r = await api('POST', '/auth/sessions/revoke-others');
        toast(`Signed out ${r.revoked} device${r.revoked === 1 ? '' : 's'}.`);
      } catch (e) {
        toast(e.message, 'error');
      }
      await this.loadSessions();
    },
  }));

  // ───────── system: health, cache, queue ─────────
  Alpine.data('systemPage', () => ({
    ...H,
    data: null,
    failed: [],
    timer: null,
    dbTimer: null,
    db: null, // Database panel (D-122): null while the Database module is off or the person may not read it
    fl: {
      open: false,
      step: 1,
      mode: 'all',
      candidates: [],
      picked: [],
      ch: null, // { token, phrase, expiresAt, plan }
      phrase: '',
      password: '',
      ack: false,
      busy: false,
      error: '',
      last: null,
    },
    async init() {
      if (!(await this.mountFragment('system', 'page'))) return;
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), 10000);
      await this.loadDb();
      this.dbTimer = setInterval(() => this.loadDb(), 30000);
    },
    destroy() {
      clearInterval(this.timer);
      clearInterval(this.dbTimer);
    },
    size(n) {
      if (n == null) return '–';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let v = Number(n);
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
    },
    dur(sec) {
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
    },
    when(t) {
      return new Date(t).toLocaleString();
    },
    async loadDb() {
      try {
        this.db = await api('GET', '/admin/dbms/ops/stats');
      } catch {
        this.db = null; // module off, or no dbms.read: the panel stays hidden
        return;
      }
      if (this.can('dbms.flush')) {
        try {
          this.fl.last = (await api('GET', '/admin/dbms/ops/flush/last')).last;
        } catch {
          /* no snapshot info */
        }
      }
    },
    openFlush() {
      Object.assign(this.fl, {
        open: true,
        step: 1,
        mode: 'all',
        picked: [],
        ch: null,
        phrase: '',
        password: '',
        ack: false,
        error: '',
      });
      this.planAll();
    },
    closeFlush() {
      this.fl.open = false;
      this.fl.ch = null;
      this.fl.phrase = this.fl.password = '';
    },
    /** The choices (every table that may be erased, with its record count). */
    async planAll() {
      try {
        const p = await api('POST', '/admin/dbms/ops/flush/plan', { mode: 'all' });
        this.fl.candidates = p.candidates;
      } catch (e) {
        this.fl.error = e.message;
      }
    },
    /** Step 1 → 2: the server checks the choice and answers with the words to type. Nothing is erased. */
    async review() {
      this.fl.busy = true;
      this.fl.error = '';
      try {
        const body =
          this.fl.mode === 'all' ? { mode: 'all' } : { mode: 'tables', tables: this.fl.picked };
        this.fl.ch = await api('POST', '/admin/dbms/ops/flush/challenge', body);
        this.fl.phrase = this.fl.password = '';
        this.fl.ack = false;
        this.fl.step = 2;
      } catch (e) {
        this.fl.error = e.message;
      } finally {
        this.fl.busy = false;
      }
    },
    async erase() {
      this.fl.busy = true;
      this.fl.error = '';
      try {
        const r = await api('POST', '/admin/dbms/ops/flush', {
          token: this.fl.ch.token,
          phrase: this.fl.phrase,
          password: this.fl.password,
        });
        this.closeFlush();
        toast(`Erased ${r.total.toLocaleString()} records. You can put them back below.`);
        await this.loadDb();
        await this.refresh();
      } catch (e) {
        this.fl.error = e.message;
        if (/expired|already used/.test(e.message)) this.fl.step = 1;
      } finally {
        this.fl.busy = false;
      }
    },
    async undoFlush() {
      if (
        !window.confirm(
          'Put back the records that the last erase removed? Records made since stay.',
        )
      )
        return;
      this.fl.busy = true;
      try {
        await api('POST', '/admin/dbms/ops/flush/undo');
        toast('Putting the erased records back…');
        setTimeout(() => this.loadDb(), 3000);
      } catch (e) {
        this.fl.error = e.message;
      } finally {
        this.fl.busy = false;
      }
    },
    async refresh() {
      try {
        const [d, f] = await Promise.all([
          api('GET', '/admin/system'),
          api('GET', '/admin/system/jobs/failed'),
        ]);
        this.data = d;
        this.failed = f.jobs;
      } catch {
        /* keep the last view */
      }
    },
    get hitRate() {
      const c = this.data?.cache;
      const total = c ? c.l1Hits + c.l2Hits + c.misses : 0;
      return total ? `${Math.round(((c.l1Hits + c.l2Hits) / total) * 100)}%` : '–';
    },
    every(ms) {
      const m = Math.round(ms / 60000);
      return m < 60 ? `every ${m} min` : m < 1440 ? `every ${Math.round(m / 60)} h` : 'daily';
    },
    async flush() {
      if (!confirm('Flush the whole cache on every server? Pages are rebuilt on their next visit.'))
        return;
      try {
        await api('POST', '/admin/system/cache/flush');
        toast('Cache flushed on every server.');
        await this.refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    async retry(j) {
      try {
        await api('POST', `/admin/system/jobs/${j.id}/retry`);
        toast('Job queued to run again.');
      } catch (e) {
        toast(e.message, 'error');
      }
      await this.refresh();
    },
    async discard(j) {
      if (!confirm(`Discard the failed "${j.name}" job?`)) return;
      try {
        await api('DELETE', `/admin/system/jobs/${j.id}`);
      } catch (e) {
        toast(e.message, 'error');
      }
      await this.refresh();
    },
  }));

  // ───────── overview ─────────
  Alpine.data('overviewPage', () => ({
    ...H,
    cluster: null,
    recent: [],
    maintenance: false,
    failedJobs: null,
    content: null,
    traffic: null,
    active: null,
    mediaTotal: null,
    usersTotal: null,
    usersActiveWeek: null,
    get up() {
      return this.cluster ? this.cluster.nodes.filter((n) => n.status === 'up').length : 0;
    },
    get drifted() {
      return this.cluster ? this.cluster.nodes.filter((n) => n.drift).length : 0;
    },
    // Each KPI tile is gated by the same permission that already protects its data elsewhere in the admin —
    // a role sees only the tiles it could already open the full screen for, never a preview of something it can't.
    async init() {
      const [info, cluster, audit, failed, content, traffic, active, media, users] =
        await Promise.all([
          api('GET', '/public/info').catch(() => null),
          this.can('cluster.read') ? api('GET', '/admin/cluster').catch(() => null) : null,
          this.can('audit.read') ? api('GET', '/admin/audit?limit=8').catch(() => null) : null,
          this.can('cluster.read')
            ? api('GET', '/admin/system/jobs/failed').catch(() => null)
            : null,
          // Not pre-checked with meta.contentTypes here: right after an in-SPA sign-in (as opposed to a fresh
          // page load), this component can mount before loadTypes() resolves — meta.contentTypes would still be
          // stale/empty at that instant. The route itself already 403s with no readable type, which .catch()
          // turns into the same "hide the tile" outcome, so the server's own gate is the only check needed.
          api('GET', '/admin/content/summary').catch(() => null),
          this.can('analytics.read')
            ? api(
                'GET',
                `/admin/analytics/overview?surface=public&from=${Date.now() - 86_400_000}`,
              ).catch(() => null)
            : null,
          this.can('analytics.read')
            ? api('GET', '/admin/analytics/active?surface=public&windowMs=300000').catch(() => null)
            : null,
          this.can('media.read') ? api('GET', '/admin/media?limit=1').catch(() => null) : null,
          this.can('users.read') ? api('GET', '/admin/users').catch(() => null) : null,
        ]);
      this.maintenance = !!info?.maintenance;
      this.cluster = cluster;
      this.recent = audit?.entries || [];
      this.failedJobs = failed ? failed.jobs.length : null;
      this.content = content?.visible ? content : null;
      this.traffic = traffic;
      this.active = active;
      this.mediaTotal = media ? media.total : null;
      if (users?.users) {
        this.usersTotal = users.users.length;
        const weekAgo = Date.now() - 7 * 86_400_000;
        this.usersActiveWeek = users.users.filter(
          (u) => u.lastLoginAt && u.lastLoginAt >= weekAgo,
        ).length;
      }
    },
  }));

  // ───────── settings ─────────
  // ───────── Search (D-078): find a screen, a setting or a task by what you want to do ─────────
  // Words people use for a screen, beyond its menu label. Keyed by the menu id.
  const SCREEN_WORDS = {
    overview: 'dashboard home status health summary',
    pages: 'site pages edit html layout page manager',
    components: 'component blocks sections reusable widgets template',
    pageDesigner: 'ai build page design generate landing',
    services: 'api endpoint data query sql script service',
    seo: 'search engine title description meta og twitter schema json-ld',
    terms: 'categories tags taxonomy',
    research: 'research findings sources references links web notes saved ai',
    media: 'images files upload library pictures photos',
    'media-generator': 'ai image generate picture dall-e imagen stability',
    'media-analytics': 'media usage unused files',
    'log-manager': 'logs prune retention delete old audit events keep days',
    'ai-usage-text': 'ai cost tokens anthropic models calls log',
    'ai-usage-media': 'ai images generated openai google stability log',
    'ai-users-text': 'ai tokens per user messages prompts cost day week month report',
    'ai-users-media': 'ai images per user prompts generated day week month report',
    _x: 'ai cost tokens anthropic openai google stability models calls log',
    plugins: 'plugin extensions add-ons install',
    'analytics-overview': 'traffic visitors page views statistics stats',
    'analytics-active': 'live now online users right now',
    'analytics-pages': 'popular pages views',
    'analytics-sessions': 'visits sessions',
    'analytics-users': 'visitors users behaviour',
    audit: 'log who changed what history security events',
    'content-activity': 'content log editors who edited published',
    events: 'event log webhooks fired',
    themes: 'theme switch activate change look design skin install duplicate clone export',
    customize: 'theme options colors colours fonts custom css style branding',
    'theme-editor': 'theme files layout template css edit code header footer',
    menus: 'navigation menu header footer links nav',
    requirements: 'requirements documentation readme spec brief project',
    'help/administration': 'help guide manual documentation admin how to',
    'help/support': 'help support troubleshooting problem fix faq error report',
    'help/coding': 'help coding guide liquid component page developer query database data template',
    'help/ai': 'help ai prompting guide assistant prompt tips',
    'help/prompts': 'help prompt library prompts copy ai templates',
    testing:
      'testing tests check qa layout responsive mobile spelling accessibility links broken report audit seo',
    prompts: 'prompts project type system prompt instructions ai assistant master quality',
    history: 'change history git commit diff revert undo push versions',
    locales: 'translations languages wording text locale i18n',
    redirects: 'redirect 301 302 moved urls',
    messages: 'contact form messages inbox enquiries',
    sitemap: 'sitemap xml robots search engines urls',
    libraries: 'npm packages cdn bootstrap fonts icons javascript css jquery download',
    dbms: 'database tables sql query browse rows',
    api: 'api keys tokens public api openapi swagger documentation external',
    modules: 'modules switch on off enable disable features',
    settings: 'configuration options preferences',
    users: 'people accounts invite password reset lock unlock staff',
    roles: 'permissions access rights roles administrator editor',
    cluster: 'servers nodes health version drift',
    system: 'queue jobs failed cache redis runtime health',
    updates: 'update upgrade git pull restart deploy release servers',
    webhooks: 'webhook notify http callback integrations post',
    scheduler: 'schedule cron recurring tasks jobs timer automation',
  };
  // Words for a whole Settings section.
  const SETTINGS_WORDS = {
    general: 'site name maintenance mode language locale timezone',
    security:
      'csp content security policy cors headers hsts password lockout session cookies rate limit https',
    site: 'website url domain canonical head scripts analytics code',
    login: 'sign in page logo background welcome branding',
    mail: 'email smtp sender outgoing messages server',
    ai: 'anthropic claude api key model assistant',
    research: 'brave search web research key',
    media_generator: 'image generation openai google stability keys',
    assistant: 'assistant git push remote token limits budget summaries',
    seo: 'search engines twitter facebook verification tags',
    themes: 'theme scripts javascript allow',
    libraries: 'npm registry packages scripts cdn',
    cache: 'cache ttl pages speed performance redis',
    updates: 'update git remote branch restart migrations',
    features: 'features services public api switches',
    analytics: 'analytics tracking retention privacy',
  };
  // Words for one particular setting, where its label does not say what people would call it.
  const FIELD_WORDS = {
    'security.csp_img_sources':
      'content security policy csp images pictures external allow cdn blocked',
    'security.csp_connect_sources':
      'content security policy csp connect fetch xhr api external allow',
    'security.cors_origins': 'cors cross origin allowed public api browsers',
    'security.session_ttl_hours': 'sign out logged out stay signed in timeout expire',
    'security.max_login_attempts': 'brute force lock locked out wrong password',
  };
  // Tasks in plain words, pointing at the place that does them. `go` is a menu id or `settings/<section>/<field>`.
  const TASKS = [
    [
      'Change the Content Security Policy',
      'settings/security/csp_img_sources',
      'csp content security policy script style font image connect sources blocked cdn headers',
      'Allow extra image or connect sources. Scripts, styles and fonts load from the site itself: add them under System → Libraries.',
    ],
    [
      'Load Bootstrap, icons or fonts without a CDN',
      'libraries',
      'bootstrap icons fonts cdn google fonts npm download offline',
      'Install the npm package, or download a CDN file into the site.',
    ],
    [
      'Switch the site to another theme',
      'themes',
      'theme switch activate change design look skin',
      '',
    ],
    [
      'Change colours, fonts or add custom CSS',
      'customize',
      'colours colors fonts custom css style branding look theme options',
      '',
    ],
    [
      'Edit a theme’s layout, header or footer',
      'theme-editor',
      'theme layout header footer template css edit code files',
      '',
    ],
    [
      'Copy a theme to edit it',
      'themes',
      'duplicate clone copy theme built-in read-only',
      'Built-in themes are read-only. Duplicate one to get a copy you can edit.',
    ],
    ['Edit a page', 'pages', 'edit page html content layout', ''],
    ['Build a whole page with AI', 'pageDesigner', 'ai build new page landing design generate', ''],
    [
      'Add or change a reusable block',
      'components',
      'component block section widget reusable template',
      '',
    ],
    ['Change the navigation menu', 'menus', 'menu navigation header footer links nav', ''],
    [
      'Add a redirect from an old address',
      'redirects',
      'redirect 301 302 moved old url address',
      '',
    ],
    [
      'Translate the site or change its wording',
      'locales',
      'translate translation language wording text locale',
      '',
    ],
    [
      'Edit SEO titles and descriptions',
      'seo',
      'seo title description meta search engine open graph',
      '',
    ],
    ['Change the sitemap or robots.txt', 'sitemap', 'sitemap robots search engines crawl', ''],
    ['Upload images and files', 'media', 'upload images pictures photos files library', ''],
    [
      'Read what the assistant researched (with source links)',
      'research',
      'research findings sources references links notes web',
      '',
    ],
    [
      'Generate an image with AI',
      'media-generator',
      'ai generate image picture dall-e imagen stability',
      '',
    ],
    [
      'Change the site name or turn on maintenance mode',
      'settings/general/maintenance',
      'site name maintenance mode offline under construction',
      '',
    ],
    [
      'Set up outgoing email (SMTP)',
      'settings/mail',
      'email smtp mail server sender password reset invite',
      '',
    ],
    [
      'Add the Anthropic key or choose the AI model',
      'settings/ai',
      'anthropic claude key api model ai assistant',
      '',
    ],
    [
      'Add keys for image generation',
      'settings/media_generator',
      'openai google stability image generation key',
      '',
    ],
    [
      'Set assistant token limits or git push',
      'settings/assistant',
      'assistant tokens limit budget git push remote token summaries',
      '',
    ],
    [
      'Review or undo what the assistant changed',
      'history',
      'assistant changes diff revert undo git commit history push',
      '',
    ],
    [
      'Check the whole site for problems (layout, spelling, links)',
      'testing',
      'testing tests check qa layout responsive mobile spelling accessibility links broken report audit',
      '',
    ],
    [
      'Change what kind of site the AI builds (project type, prompts)',
      'prompts',
      'prompts project type system prompt instructions ai assistant master quality',
      '',
    ],
    [
      'Read or edit the site requirements',
      'requirements',
      'requirements spec documentation project brief readme',
      '',
    ],
    [
      'Add a person or reset a password',
      'users',
      'invite add new user admin account person staff password reset unlock',
      '',
    ],
    ['Decide who can do what', 'roles', 'roles permissions access rights administrator editor', ''],
    [
      'Change password rules, lockout or session length',
      'settings/security/password_min_length',
      'password rules lockout session length sign in attempts rate limit',
      '',
    ],
    [
      'Brand the sign-in page',
      'settings/login',
      'login sign in page logo background welcome branding',
      '',
    ],
    [
      'Create an API key for another app',
      'api',
      'api key token external integration public api openapi',
      '',
    ],
    [
      'Send events to another system (webhooks)',
      'webhooks',
      'webhook notify callback http integration event',
      '',
    ],
    [
      'Run something on a schedule',
      'scheduler',
      'schedule cron recurring timer automation job',
      '',
    ],
    [
      'Update or restart a server',
      'updates',
      'update upgrade restart deploy git pull release server',
      '',
    ],
    [
      'Check that all servers are healthy',
      'cluster',
      'cluster servers nodes health version drift',
      '',
    ],
    ['See who changed what', 'audit', 'audit log who changed history events security', ''],
    ['Browse the database or run SQL', 'dbms', 'database sql query tables rows browse', ''],
    [
      'See visitors and traffic',
      'analytics-overview',
      'traffic visitors statistics analytics page views',
      '',
    ],
    [
      'Read messages from the contact form',
      'messages',
      'contact form messages inbox enquiries',
      '',
    ],
    [
      'Switch features on or off',
      'features',
      'features blog ecommerce support payment switch enable disable on off',
      '',
    ],
    ['Switch modules on or off', 'modules', 'modules switch enable disable on off', ''],
    ['Clear or tune the cache', 'settings/cache', 'cache clear ttl speed performance', ''],
    [
      'Make the site faster',
      'settings/cache',
      'faster speed performance slow load fast cache',
      'Page and data caching.',
    ],
  ];
  const STOP = new Set([
    'how',
    'to',
    'do',
    'i',
    'my',
    'the',
    'a',
    'an',
    'of',
    'in',
    'on',
    'for',
    'can',
    'where',
    'is',
    'what',
    'and',
    'or',
    'with',
    'it',
    'me',
    'we',
  ]);
  const SOFT = new Set([
    'change',
    'set',
    'edit',
    'manage',
    'update',
    'add',
    'make',
    'find',
    'open',
    'show',
    'configure',
    'setup',
    'new',
    'create',
    'turn',
    'use',
    'get',
  ]);
  const words = (s) =>
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  /** 2 = matches at the start of a word, 1 = somewhere inside, 0 = no. */
  const hit = (hay, t) =>
    hay.startsWith(t) || hay.includes(` ${t}`) ? 2 : hay.includes(t) ? 1 : 0;
  /** One slip (a missing, extra or changed letter) against any word: forgives typos like "securty". */
  const near = (t, toks) =>
    t.length >= 5 &&
    toks.some((w) => {
      if (Math.abs(w.length - t.length) > 1) return false;
      let i = 0;
      let j = 0;
      let edits = 0;
      while (i < t.length && j < w.length) {
        if (t[i] === w[j]) (i++, j++);
        else if (++edits > 1) return false;
        else if (t.length > w.length) i++;
        else if (t.length < w.length) j++;
        else (i++, j++);
      }
      return edits + (t.length - i) + (w.length - j) <= 1;
    });
  /** How well one entry answers the query tokens (0 = not at all). Every non-soft token must match somewhere. */
  function rank(e, tokens) {
    let total = 0;
    let matched = 0;
    let required = 0;
    let requiredMatched = 0;
    for (const t of tokens) {
      const s = hit(e.title_, t)
        ? 6 + hit(e.title_, t) * 2
        : hit(e.words_, t)
          ? 3 + hit(e.words_, t)
          : hit(e.path_, t)
            ? 3
            : hit(e.sub_, t)
              ? 2
              : near(t, words(e.title_))
                ? 2.5
                : near(t, e.toks_)
                  ? 1.5
                  : 0;
      if (!SOFT.has(t)) required++;
      if (s) {
        matched++;
        if (!SOFT.has(t)) requiredMatched++;
      }
      total += s;
    }
    if (!matched) return 0;
    // Every word that matters must match; in a longer question, two thirds is enough ("undo what the AI changed").
    if (requiredMatched < required && !(required >= 3 && requiredMatched / required >= 0.66))
      return 0;
    if (e.title_.startsWith(tokens[0])) total += 3;
    return total + (e.type === 'task' ? 2 : e.type === 'screen' ? 1 : 0) - e.title_.length / 200;
  }

  Alpine.data('commandSearch', () => {
    /** @type {any[]} */
    let index = [];
    let settingsLoaded = false;
    return {
      open: false,
      q: '',
      active: 0,
      results: [],
      settings: null,
      /** The words to highlight in what is shown. */
      marks: [],
      async show() {
        this.open = true;
        this.q = '';
        this.active = 0;
        this.build();
        this.refresh();
        this.$nextTick(() => document.getElementById('cmdk-q')?.focus());
        if (!settingsLoaded && this.root().can('settings.read')) {
          settingsLoaded = true;
          try {
            const { namespaces } = await api('GET', '/admin/settings');
            this.addSettings(namespaces);
            this.build();
            this.refresh();
          } catch {
            settingsLoaded = false; // try again next time it is opened
          }
        }
      },
      hide() {
        this.open = false;
      },
      root: () => Alpine.$data(document.body),
      /** Screens this person can open, from the menu itself, so nothing is offered that they could not reach. */
      build() {
        const root = this.root();
        const out = [];
        for (const n of root.nav) {
          for (const c of n.items ?? [n])
            out.push(
              this.entry({
                type: 'screen',
                title: c.label,
                path: n.items ? n.label : '',
                go: `#/${c.id}`,
                icon: n.icon || 'bi-compass',
                words: SCREEN_WORDS[c.id] ?? '',
              }),
            );
        }
        const reachable = (go) => {
          if (go.startsWith('settings')) {
            // A settings task only when the person may read settings, and (once known) when that section exists.
            return (
              root.can('settings.read') &&
              (!this.settings || this.settings.some((n) => n.namespace === go.split('/')[1]))
            );
          }
          return root.nav.some((n) => (n.items ?? [n]).some((c) => c.id === go));
        };
        for (const [title, go, w, sub] of TASKS)
          if (reachable(go))
            out.push(
              this.entry({
                type: 'task',
                title,
                sub,
                path: this.where(go, root),
                go: `#/${go}`,
                icon: 'bi-lightbulb',
                words: w,
              }),
            );
        index = [...out, ...index.filter((e) => e.type === 'setting')];
      },
      where(go, root) {
        if (go.startsWith('settings')) {
          const ns = this.settings?.find((n) => n.namespace === go.split('/')[1]);
          return ns ? `Settings → ${ns.title}` : 'Settings';
        }
        for (const n of root.nav)
          for (const c of n.items ?? [n])
            if (c.id === go) return n.items ? `${n.label} → ${c.label}` : n.label;
        return '';
      },
      addSettings(namespaces) {
        this.settings = namespaces;
        const out = [];
        for (const ns of namespaces) {
          const sectionWords = `${SETTINGS_WORDS[ns.namespace] ?? ''} ${ns.namespace.replace(/_/g, ' ')}`;
          out.push(
            this.entry({
              type: 'setting',
              title: `${ns.title} settings`,
              sub: ns.description || '',
              path: 'Settings',
              go: `#/settings/${ns.namespace}`,
              icon: 'bi-sliders',
              words: sectionWords,
            }),
          );
          for (const f of ns.fields) {
            if (f.hidden) continue;
            out.push(
              this.entry({
                type: 'setting',
                title: f.label,
                sub: f.help || '',
                path: `Settings → ${ns.title}`,
                go: `#/settings/${ns.namespace}/${f.key}`,
                icon: 'bi-sliders',
                // The section's own words belong to the section (and the path), not to every field in it.
                words: `${f.key.replace(/_/g, ' ')} ${FIELD_WORDS[`${ns.namespace}.${f.key}`] ?? ''}`,
              }),
            );
          }
        }
        index = [...index.filter((e) => e.type !== 'setting'), ...out];
      },
      entry(e) {
        return {
          ...e,
          title_: words(e.title).join(' '),
          words_: words(e.words || '').join(' '),
          path_: words(e.path || '').join(' '),
          sub_: words(e.sub || '').join(' '),
          toks_: words(`${e.title} ${e.words || ''}`),
        };
      },
      refresh() {
        const tokens = words(this.q).filter((t) => !STOP.has(t));
        this.marks = tokens;
        this.active = 0;
        if (!tokens.length) {
          this.results = index
            .filter((e) => e.type === 'task')
            .slice(0, 8)
            .map((e) => ({ ...e, group: 'Common tasks' }));
          return;
        }
        const ranked = index
          .map((e) => ({ e, s: rank(e, tokens) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 12)
          .map((x) => ({
            ...x.e,
            group: x.e.type === 'task' ? 'Tasks' : x.e.type === 'screen' ? 'Screens' : 'Settings',
          }));
        // Keep the groups together but in the order the best match of each appears.
        const order = [...new Set(ranked.map((r) => r.group))];
        this.results = order.flatMap((g) => ranked.filter((r) => r.group === g));
        if (
          this.root().can('admin.access') &&
          this.q.trim().length >= 3 &&
          !this.root().disabledModules.includes('assistant')
        )
          this.results.push({
            type: 'ask',
            group: 'Ask',
            title: `Ask the assistant: “${this.q.trim()}”`,
            sub: 'Describe what you want and the assistant can do it for you.',
            path: '',
            icon: 'bi-stars',
            go: '',
          });
      },
      /** Escaped text with the searched words marked: only escaped text is ever put into the page. */
      hl(text) {
        const s = String(text ?? '');
        if (!this.marks.length) return esc(s);
        const re = new RegExp(
          `(${this.marks
            .map((m) => m.replace(/[^a-z0-9]/g, ''))
            .filter(Boolean)
            .join('|')})`,
          'gi',
        );
        return s
          .split(re)
          .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
          .join('');
      },
      showGroup(i) {
        return i === 0 || this.results[i - 1].group !== this.results[i].group;
      },
      move(d) {
        if (!this.results.length) return;
        this.active = (this.active + d + this.results.length) % this.results.length;
        this.$nextTick(() =>
          document.getElementById(`cmdk-r${this.active}`)?.scrollIntoView?.({ block: 'nearest' }),
        );
      },
      choose(r = this.results[this.active]) {
        if (!r) return;
        this.hide();
        if (r.type === 'ask') {
          window.__assistantPrefill = this.q.trim();
          this.root().toggleChat(true);
          window.dispatchEvent(
            new CustomEvent('assistant-ask', { detail: window.__assistantPrefill }),
          );
          return;
        }
        const m = /^#\/settings\/([^/]+)\/([^/]+)$/.exec(r.go);
        if (m) {
          window.__settingsFocus = { ns: m[1], key: m[2] };
          location.hash = `#/settings/${m[1]}`;
          window.dispatchEvent(new CustomEvent('settings-focus'));
        } else location.hash = r.go;
      },
      onKey(e) {
        const typing =
          /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '') || e.target?.isContentEditable;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this.open ? this.hide() : this.show();
        } else if (
          !this.open &&
          e.key === '/' &&
          !typing &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault();
          this.show();
        } else if (this.open && e.key === 'Escape') this.hide();
      },
    };
  });

  Alpine.data('settingsPage', () => ({
    ...H,
    loaded: false,
    namespaces: [],
    ns: null,
    edits: {}, // ns -> { key: newValue }
    resets: {}, // ns -> { key: true }
    raws: {}, // 'ns.key' -> raw textarea text for list fields
    media: {}, // media id -> item, for 'media' fields (a plain number setting with a picker)
    errors: {},
    saving: false,
    testing: false,
    testResult: null,
    history: [],

    get current() {
      return this.namespaces.find((n) => n.namespace === this.ns) || null;
    },

    /** The sections in the left menu: grouped by what they are for, sorted by name inside each group. */
    get groups() {
      const GROUPS = [
        ['Site', ['general', 'site', 'seo', 'sitemap', 'content', 'themes', 'login', 'libraries']],
        ['Media', ['media', 'media_generator']],
        ['AI', ['ai', 'assistant', 'prompts', 'research', 'visual', 'testing']],
        ['Security', ['security']],
        ['Messaging and automation', ['mail', 'automation', 'analytics', 'publish']],
        ['System', ['system', 'updates', 'cache', 'modules', 'featureset', 'features']],
      ];
      const placed = new Set(GROUPS.flatMap(([, ids]) => ids));
      const byName = (a, b) => a.title.localeCompare(b.title);
      const out = GROUPS.map(([label, ids]) => ({
        label,
        items: this.namespaces.filter((n) => ids.includes(n.namespace)).sort(byName),
      }));
      // Anything a plugin or a later module adds still shows up, rather than vanishing from the menu.
      out.push({
        label: 'Other',
        items: this.namespaces.filter((n) => !placed.has(n.namespace)).sort(byName),
      });
      return out.filter((g) => g.items.length);
    },

    async init() {
      if (!(await this.mountFragment('settings', 'page'))) return;
      await this.reload();
      const want = hashParts()[1];
      if (want === 'history') await this.showHistory();
      else
        this.ns = this.namespaces.some((n) => n.namespace === want)
          ? want
          : this.namespaces[0]?.namespace;
      this.loaded = true;
      window.addEventListener('settings-focus', () => this.focusField());
      this.focusField();
    },

    /** Arriving from Search: open that section, scroll to the one setting and flash it. */
    async focusField() {
      const want = window.__settingsFocus;
      if (!want || !this.namespaces.length) return;
      window.__settingsFocus = null;
      if (this.namespaces.some((n) => n.namespace === want.ns)) this.select(want.ns);
      await this.$nextTick();
      await new Promise((r) => setTimeout(r, 60));
      const el = document.getElementById(`f-${want.ns}-${want.key}`);
      if (!el) return;
      el.scrollIntoView?.({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2400);
      el.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    },

    async reload() {
      const out = await api('GET', '/admin/settings');
      this.namespaces = out.namespaces;
      for (const n of out.namespaces) {
        if (!this.edits[n.namespace]) this.edits[n.namespace] = {};
        if (!this.resets[n.namespace]) this.resets[n.namespace] = {};
        for (const f of n.fields)
          if (f.media && n.state[f.key]?.value) this.loadMedia(n.state[f.key].value);
      }
    },

    async loadMedia(mid) {
      if (!mid || this.media[mid]) return;
      try {
        this.media[mid] = (await api('GET', `/admin/media/${mid}`)).item;
      } catch {
        this.media[mid] = { id: mid, filename: '(deleted)', kind: 'file', variants: [] };
      }
    },
    thumb,
    async pickMedia(f) {
      const item = await new Promise((resolve) =>
        window.dispatchEvent(new CustomEvent('pick-media', { detail: { resolve } })),
      );
      if (!item) return;
      this.media[item.id] = item;
      this.set(f, item.id);
    },

    select(ns) {
      this.ns = ns;
      this.errors = {};
      this.testResult = null;
      history.replaceState(null, '', `#/settings/${ns}`);
      this.toTop();
    },

    /** A new section starts at its top: the settings scroll in their own area now, which keeps its position between sections. */
    toTop() {
      const el = this.$root.querySelector('.settings-main');
      if (el) el.scrollTop = 0;
    },

    async showHistory() {
      this.ns = '__history';
      history.replaceState(null, '', '#/settings/history');
      this.toTop();
      this.history = (await api('GET', '/admin/settings/history?limit=100')).revisions;
    },

    st(f) {
      return this.current.state[f.key];
    },
    isRemoved(f) {
      return !!this.resets[this.ns]?.[f.key];
    },
    isDirty(f) {
      return this.edits[this.ns]?.[f.key] !== undefined || this.isRemoved(f);
    },
    dirtyCount(ns) {
      return (
        Object.keys(this.edits[ns] || {}).length +
        Object.values(this.resets[ns] || {}).filter(Boolean).length
      );
    },

    val(f) {
      const e = this.edits[this.ns]?.[f.key];
      if (e !== undefined) return e;
      if (f.secret) return '';
      return this.isRemoved(f) ? f.default : this.st(f).value;
    },

    set(f, v) {
      const e = this.edits[this.ns];
      const same = f.secret ? v === '' : JSON.stringify(v) === JSON.stringify(this.st(f).value);
      if (same) delete e[f.key];
      else e[f.key] = v;
      delete this.resets[this.ns][f.key];
      delete this.errors[f.key];
    },

    listText(f) {
      return this.raws[`${this.ns}.${f.key}`] ?? (this.val(f) || []).join('\n');
    },
    setList(f, text) {
      this.raws[`${this.ns}.${f.key}`] = text;
      this.set(
        f,
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    },

    remove(f) {
      delete this.edits[this.ns][f.key];
      this.resets[this.ns][f.key] = true;
    },
    undoRemove(f) {
      delete this.resets[this.ns][f.key];
    },
    resetToDefault(f) {
      this.remove(f);
    },

    discard() {
      this.edits[this.ns] = {};
      this.resets[this.ns] = {};
      for (const k of Object.keys(this.raws)) if (k.startsWith(this.ns + '.')) delete this.raws[k];
      this.errors = {};
    },

    async save() {
      const ns = this.ns;
      const values = { ...this.edits[ns] };
      const reset = Object.keys(this.resets[ns]).filter((k) => this.resets[ns][k]);
      const versions = {};
      for (const k of [...Object.keys(values), ...reset])
        versions[k] = this.current.state[k].version;
      this.saving = true;
      this.errors = {};
      try {
        const out = await api('PUT', `/admin/settings/${ns}`, { values, versions, reset });
        const i = this.namespaces.findIndex((n) => n.namespace === ns);
        this.namespaces[i] = out.settings;
        this.discard();
        toast(out.changed.length ? 'Settings saved' : 'Nothing changed');
        if (out.restartRequired.length)
          toast(`Restart needed for: ${out.restartRequired.join(', ')}`);
      } catch (e) {
        if (e.field) this.errors[e.field.split('.').pop()] = e.message;
        toast(e.message, 'error');
        if (e.code === 'version_conflict') await this.reload();
      } finally {
        this.saving = false;
      }
    },

    async runTest(t) {
      this.testing = true;
      this.testResult = null;
      try {
        this.testResult = await api('POST', `/admin/settings/${this.ns}/tests/${t.id}`, {
          values: this.edits[this.ns],
        });
      } catch (e) {
        this.testResult = { ok: false, message: e.message };
      } finally {
        this.testing = false;
      }
    },

    async restore(r) {
      if (
        !confirm(
          `Restore ${r.namespace}.${r.key} to ${r.wasReset ? 'its earlier value' : this.show(r.from)}?`,
        )
      )
        return;
      try {
        await api('POST', `/admin/settings/history/${r.id}/restore`);
        toast('Restored');
        await this.reload();
        await this.showHistory();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  }));

  // ───────── users ─────────
  Alpine.data('usersPage', () => ({
    ...H,
    users: [],
    roles: [],
    form: null,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('users', 'users'))) return;
      await this.load();
    },
    async load() {
      // Fetch together and assign roles first: the "Add user" form needs them to pick a default role.
      const [u, r] = await Promise.all([
        api('GET', '/admin/users'),
        api('GET', '/admin/roles').catch(() => ({ roles: [] })),
      ]);
      this.roles = r.roles;
      this.users = u.users;
    },
    edit(u) {
      this.error = '';
      const viewer = this.roles.find((r) => r.name === 'Viewer') || this.roles[0];
      this.form = u
        ? {
            id: u.id,
            name: u.name,
            email: u.email,
            roleId: u.roleId,
            status: u.status,
            password: '',
            locked: !!u.lockedUntil,
          }
        : {
            name: '',
            email: '',
            password: '',
            roleId: viewer?.id,
            status: 'active',
            invite: false,
          };
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        const f = this.form;
        if (f.id) {
          const patch = { name: f.name, email: f.email, roleId: f.roleId, status: f.status };
          if (f.password) patch.password = f.password;
          await api('PATCH', `/admin/users/${f.id}`, patch);
        } else if (f.invite) {
          await api('POST', '/admin/users/invite', {
            name: f.name,
            email: f.email,
            roleId: f.roleId,
          });
          toast(`Invitation sent to ${f.email}.`);
          this.form = null;
          await this.load();
          return;
        } else {
          await api('POST', '/admin/users', {
            name: f.name,
            email: f.email,
            password: f.password,
            roleId: f.roleId,
            status: f.status,
          });
        }
        toast('User saved');
        this.form = null;
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async sendLink() {
      try {
        await api('POST', `/admin/users/${this.form.id}/resend-invite`);
        toast(`A password link is on its way to ${this.form.email}.`);
      } catch (e) {
        this.error = e.message;
      }
    },
    async signOutEverywhere() {
      try {
        const r = await api('POST', `/admin/users/${this.form.id}/revoke-sessions`);
        toast(
          r.revoked
            ? `Signed out ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`
            : 'They had no active sessions.',
        );
      } catch (e) {
        this.error = e.message;
      }
    },
    async unlock() {
      try {
        await api('PATCH', `/admin/users/${this.form.id}`, { unlock: true });
        toast('Account unlocked');
        this.form = null;
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
    },
    async remove(u) {
      if (!confirm(`Delete ${u.name} (${u.email})? This can't be undone.`)) return;
      try {
        await api('DELETE', `/admin/users/${u.id}`);
        toast('User deleted');
        await this.load();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  }));

  // ───────── roles ─────────
  Alpine.data('rolesPage', () => ({
    ...H,
    roles: [],
    groups: [],
    form: null,
    busy: false,
    error: '',
    async init() {
      if (!(await this.mountFragment('users', 'roles'))) return;
      await this.load();
      this.groups = (await api('GET', '/admin/permissions')).groups;
    },
    async load() {
      this.roles = (await api('GET', '/admin/roles')).roles;
    },
    edit(r) {
      this.error = '';
      this.form = r
        ? {
            id: r.id,
            name: r.name,
            description: r.description,
            isSystem: r.isSystem,
            permissions: [...r.permissions],
          }
        : { name: '', description: '', isSystem: false, permissions: ['admin.access'] };
    },
    toggle(key, on) {
      const set = new Set(this.form.permissions);
      if (on) set.add(key);
      else set.delete(key);
      this.form.permissions = [...set];
    },
    async save() {
      this.busy = true;
      this.error = '';
      try {
        const { id, name, description, permissions } = this.form;
        if (id) await api('PATCH', `/admin/roles/${id}`, { name, description, permissions });
        else await api('POST', '/admin/roles', { name, description, permissions });
        toast('Role saved');
        this.form = null;
        await this.load();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async remove(r) {
      if (!confirm(`Delete the role "${r.name}"?`)) return;
      try {
        await api('DELETE', `/admin/roles/${r.id}`);
        toast('Role deleted');
        await this.load();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  }));

  // ───────── audit ─────────
  Alpine.data('auditPage', () => ({
    ...H,
    entries: [],
    filter: '',
    actorEmail: '',
    from: '',
    to: '',
    more: false,
    async init() {
      if (!(await this.mountFragment('audit', 'audit'))) return;
      await this.load(true);
    },
    /** Shared by `load` and the export link — `from`/`to` are <input type=date> strings (a whole day, local). */
    filterParams() {
      const q = {};
      if (this.filter) q.action = this.filter;
      if (this.actorEmail) q.actorEmail = this.actorEmail;
      if (this.from) q.from = String(new Date(this.from).getTime());
      if (this.to) q.to = String(new Date(this.to).getTime() + 86_400_000 - 1);
      return q;
    },
    get exportUrl() {
      return '/api/admin/audit/export?' + new URLSearchParams(this.filterParams());
    },
    clearFilters() {
      this.filter = '';
      this.actorEmail = '';
      this.from = '';
      this.to = '';
      this.load(true);
    },
    async load(reset) {
      const q = new URLSearchParams({ limit: '50', ...this.filterParams() });
      if (!reset && this.entries.length) q.set('before', this.entries[this.entries.length - 1].id);
      const { entries } = await api('GET', '/admin/audit?' + q);
      this.entries = reset ? entries : [...this.entries, ...entries];
      this.more = entries.length === 50;
    },
    detail(e) {
      const m = e.meta || {};
      if (e.action === 'settings.update') {
        return (m.changes || [])
          .map(
            (c) =>
              `<span class="mono">${esc(e.entityId)}.${esc(c.key)}</span> ` +
              (c.secret
                ? '<span class="muted">(secret changed)</span>'
                : `<span class="diff"><del>${esc(this.show(c.from))}</del> → <ins>${esc(c.reset ? 'default' : this.show(c.to))}</ins></span>`),
          )
          .join('<br>');
      }
      if (e.action.startsWith('user.'))
        return (
          esc(m.email || `user #${e.entityId}`) +
          (m.status ? ` · ${esc(m.status)}` : '') +
          (m.passwordReset ? ' · password reset' : '')
        );
      if (e.action.startsWith('role.')) return esc(m.name || `role #${e.entityId}`);
      if (e.action.startsWith('auth.'))
        return (
          esc(m.email || m.reason || '') +
          (m.attempts ? ` · attempt ${esc(m.attempts)}` : '') +
          (e.ip ? ` <span class="muted">from ${esc(e.ip)}</span>` : '')
        );
      return contentActivityDetail(e) ?? '';
    },
  }));

  // ───────── content activity ─────────
  // "pages/about-us.html" → "About us" — no front-matter parsing, derived purely from the path, so it works
  // uniformly for pages, components and any future site-file kind without reaching into their content.
  function humanizePath(p) {
    const base = (p || '')
      .split('/')
      .pop()
      .replace(/\.(html|json)$/, '');
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || p;
  }
  function siteFileKind(p) {
    if (p?.startsWith('pages/')) return 'page';
    if (p?.startsWith('components/')) return 'component';
    if (p?.startsWith('locales/')) return 'translation';
    return 'file';
  }
  const VERB = {
    create: 'Created',
    update: 'Updated',
    delete: 'Deleted',
    upload: 'Uploaded',
    created: 'Created',
    updated: 'Updated',
    deleted: 'Deleted',
    publish: 'Published',
    unpublish: 'Unpublished',
    schedule: 'Scheduled',
    archive: 'Archived',
  };
  /**
   * Shared by the Audit log's own `detail()` and Content Activity's: content-authoring actions read the same
   * way wherever they're shown. Returns `null` (not `''`) for anything it doesn't recognise, so a caller with
   * its own fallback (the general Audit log) can tell "no renderer for this" apart from "renders as nothing".
   */
  function contentActivityDetail(e) {
    const m = e.meta || {};
    if (e.action.startsWith('content.')) {
      const verb = VERB[e.action.slice(8)] || e.action;
      return (
        `${verb} <strong>${esc(m.title || `#${e.entityId}`)}</strong>` +
        (m.note ? ` <span class="muted">— ${esc(m.note)}</span>` : '')
      );
    }
    if (e.action.startsWith('term.'))
      return `${VERB[e.action.slice(5)] || e.action} <strong>${esc(m.name || `#${e.entityId}`)}</strong>`;
    if (e.action.startsWith('site.file_')) {
      const verb = VERB[e.action.slice(10)] || e.action;
      const kind = siteFileKind(e.entityId);
      return `${verb} ${kind} <strong>${esc(humanizePath(e.entityId))}</strong> <span class="muted mono">${esc(e.entityId || '')}</span>`;
    }
    if (e.action.startsWith('media.'))
      return (
        `${VERB[e.action.slice(6)] || e.action} <strong>${esc(m.filename || `#${e.entityId}`)}</strong>` +
        (m.alt ? ' <span class="muted">(alt text changed)</span>' : '')
      );
    if (e.action.startsWith('menu.'))
      return (
        `${VERB[e.action.slice(5)] || e.action} menu <strong>${esc(e.entityId)}</strong>` +
        (m.items !== undefined ? ` <span class="muted">(${esc(m.items)} items)</span>` : '')
      );
    if (e.action.startsWith('redirect.'))
      return (
        `${VERB[e.action.slice(9)] || e.action} redirect <strong>${esc(m.from || '')}</strong>` +
        (m.to ? ` → ${esc(m.to)}` : '')
      );
    if (e.action.startsWith('seo.rule_'))
      return `${VERB[e.action.slice(9)] || e.action} SEO rule <strong>${esc(m.pattern || `#${e.entityId}`)}</strong>`;
    return null;
  }

  Alpine.data('contentActivityPage', () => ({
    ...H,
    entries: [],
    actorEmail: '',
    from: '',
    to: '',
    more: false,
    detail: contentActivityDetail,
    async init() {
      if (!(await this.mountFragment('audit', 'content-activity'))) return;
      await this.load(true);
    },
    filterParams() {
      const q = {};
      if (this.actorEmail) q.actorEmail = this.actorEmail;
      if (this.from) q.from = String(new Date(this.from).getTime());
      if (this.to) q.to = String(new Date(this.to).getTime() + 86_400_000 - 1);
      return q;
    },
    get exportUrl() {
      return '/api/admin/audit/content/export?' + new URLSearchParams(this.filterParams());
    },
    clearFilters() {
      this.actorEmail = '';
      this.from = '';
      this.to = '';
      this.load(true);
    },
    async load(reset) {
      const q = new URLSearchParams({ limit: '50', ...this.filterParams() });
      if (!reset && this.entries.length) q.set('before', this.entries[this.entries.length - 1].id);
      const { entries } = await api('GET', '/admin/audit/content?' + q);
      this.entries = reset ? entries : [...this.entries, ...entries];
      this.more = entries.length === 50;
    },
  }));

  // ───────── analytics ─────────
  // Fixed categorical order (dataviz skill: "assign hues in fixed order, never cycled") — a device that never
  // appears just never draws a segment, rather than the remaining ones being repainted.
  const DEVICE_ORDER = ['desktop', 'mobile', 'tablet', 'bot', 'unknown'];
  const DEVICE_COLOR = {
    desktop: 'var(--chart-1)',
    mobile: 'var(--chart-2)',
    tablet: 'var(--chart-3)',
    bot: 'var(--chart-4)',
    unknown: 'var(--chart-other)',
  };
  const TREND_W = 600,
    TREND_H = 170,
    TREND_TOP = 10;

  Alpine.data('analyticsPage', (tab) => ({
    ...H,
    tab,
    // Public visitors are anonymous until customer accounts exist, so the "who" screen defaults to the admin panel.
    surface: tab === 'users' ? 'admin' : 'public',
    from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
    to: '',
    overview: null,
    trend: [],
    devices: [],
    referrers: [],
    direct: 0,
    hoverIdx: null,
    pages: [],
    sessions: [],
    moreSessions: false,
    users: [],
    async init() {
      if (!(await this.mountFragment('analytics', tab))) return;
      await this.load();
    },
    rangeParams() {
      const q = { surface: this.surface };
      if (this.from) q.from = String(new Date(this.from).getTime());
      if (this.to) q.to = String(new Date(this.to).getTime() + 86_400_000 - 1);
      return q;
    },
    pct(n) {
      return Math.round(n * 100) + '%';
    },
    duration(ms) {
      if (ms == null) return '–';
      return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
    },
    shortDate(iso) {
      return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    },
    async load() {
      const q = new URLSearchParams(this.rangeParams());
      if (this.tab === 'overview') {
        const [ov, tr, dv, rf] = await Promise.all([
          api('GET', '/admin/analytics/overview?' + q),
          api('GET', '/admin/analytics/trend?' + q),
          api('GET', '/admin/analytics/devices?' + q),
          api('GET', '/admin/analytics/referrers?' + q),
        ]);
        this.overview = ov;
        this.trend = tr.trend;
        this.devices = dv.devices;
        this.referrers = rf.top;
        this.direct = rf.direct;
      } else if (this.tab === 'pages') {
        this.pages = (await api('GET', '/admin/analytics/pages?' + q)).pages;
      } else if (this.tab === 'sessions') {
        await this.loadSessions(true);
      } else if (this.tab === 'users') {
        this.users = (await api('GET', '/admin/analytics/users?' + q)).users;
      }
    },
    async loadSessions(reset) {
      const q = new URLSearchParams({ limit: '50', ...this.rangeParams() });
      if (!reset && this.sessions.length)
        q.set('before', this.sessions[this.sessions.length - 1].lastSeen);
      const { sessions } = await api('GET', '/admin/analytics/sessions?' + q);
      this.sessions = reset ? sessions : [...this.sessions, ...sessions];
      this.moreSessions = sessions.length === 50;
    },

    // ───────── trend chart (two-line, pageviews + visitors) ─────────
    get trendMax() {
      return Math.max(1, ...this.trend.flatMap((t) => [t.pageviews, t.visitors]));
    },
    trendX(i) {
      return this.trend.length > 1 ? (i / (this.trend.length - 1)) * TREND_W : TREND_W / 2;
    },
    trendY(v) {
      return TREND_H - (v / this.trendMax) * (TREND_H - TREND_TOP);
    },
    trendLine(key) {
      return this.trend.map((t, i) => `${this.trendX(i)},${this.trendY(t[key])}`).join(' ');
    },
    /** A handful of evenly-spaced x-axis labels — never one per day, that's unreadable past a couple of weeks. */
    get trendTicks() {
      const n = this.trend.length;
      if (n <= 1) return this.trend.map((t, i) => ({ i, date: t.date }));
      const want = Math.min(6, n);
      const idxs = new Set([0, n - 1]);
      for (let k = 1; k < want - 1; k++) idxs.add(Math.round((k * (n - 1)) / (want - 1)));
      return [...idxs].sort((a, b) => a - b).map((i) => ({ i, date: this.trend[i].date }));
    },
    onTrendMove(evt) {
      const rect = this.$refs.trendSvg.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
      this.hoverIdx = Math.round(frac * (this.trend.length - 1));
    },
    onTrendLeave() {
      this.hoverIdx = null;
    },
    /**
     * Built as a markup string, not `<template x-for>`/`x-if` inside the `<svg>`: real browsers parse a
     * `<template>` nested in inline SVG as foreign content and never populate Alpine's loop scope from it (it
     * throws "x is not defined" for every binding inside) — invisible in jsdom, which doesn't reproduce that
     * parsing quirk, so this was only caught testing in an actual browser. Every value here is server-computed
     * (a date, a count) or one of this file's own fixed color tokens, never visitor input.
     */
    get trendSvgInner() {
      const p = [];
      p.push(
        `<line x1="0" y1="${this.trendY(0)}" x2="${TREND_W}" y2="${this.trendY(0)}" class="chart-crosshair"></line>`,
      );
      p.push(
        `<polyline class="chart-line" points="${esc(this.trendLine('pageviews'))}" stroke="var(--chart-1)"></polyline>`,
      );
      p.push(
        `<polyline class="chart-line" points="${esc(this.trendLine('visitors'))}" stroke="var(--chart-2)"></polyline>`,
      );
      for (const t of this.trendTicks)
        p.push(
          `<text class="chart-axis-label" x="${this.trendX(t.i)}" y="190" text-anchor="middle">${esc(this.shortDate(t.date))}</text>`,
        );
      const row = this.hoverIdx !== null ? this.trend[this.hoverIdx] : null;
      if (row) {
        const x = this.trendX(this.hoverIdx);
        const tx = Math.min(Math.max(x, 70), TREND_W - 70);
        p.push(`<line x1="${x}" y1="0" x2="${x}" y2="${TREND_H}" class="chart-crosshair"></line>`);
        p.push(
          `<circle cx="${x}" cy="${this.trendY(row.pageviews)}" r="4" fill="var(--chart-1)" class="chart-dot"></circle>`,
        );
        p.push(
          `<circle cx="${x}" cy="${this.trendY(row.visitors)}" r="4" fill="var(--chart-2)" class="chart-dot"></circle>`,
        );
        p.push(`<g transform="translate(${tx},12)">
          <rect class="chart-tooltip-bg" x="-62" y="-10" width="124" height="52" rx="4"></rect>
          <text class="chart-tooltip-text" x="0" y="4" text-anchor="middle">${esc(this.shortDate(row.date))}</text>
          <text class="chart-tooltip-text" x="0" y="18" text-anchor="middle">Views: ${row.pageviews}</text>
          <text class="chart-tooltip-text" x="0" y="32" text-anchor="middle">Visitors: ${row.visitors}</text>
        </g>`);
      }
      return p.join('');
    },

    // ───────── device donut ─────────
    get donutTotal() {
      return this.devices.reduce((s, d) => s + d.count, 0);
    },
    get donutSegments() {
      const R = 70,
        C = 2 * Math.PI * R,
        GAP = 4;
      const total = this.donutTotal || 1;
      const present = DEVICE_ORDER.map((device) => ({
        device,
        count: this.devices.find((d) => d.device === device)?.count || 0,
      })).filter((d) => d.count > 0);
      const usable = Math.max(0, C - present.length * GAP);
      let acc = 0;
      return present.map((d) => {
        const dash = (d.count / total) * usable;
        const seg = {
          device: d.device,
          count: d.count,
          pct: d.count / total,
          color: DEVICE_COLOR[d.device],
          dash,
          gap: C - dash,
          offset: -acc,
        };
        acc += dash + GAP;
        return seg;
      });
    },
    /** Same reason as `trendSvgInner`: a `<template x-for>` inside `<svg>` doesn't bind in a real browser. */
    get donutSvgInner() {
      return this.donutSegments
        .map(
          (seg) =>
            `<circle cx="100" cy="100" r="70" fill="none" stroke-width="32" stroke="${seg.color}" stroke-dasharray="${seg.dash} ${seg.gap}" stroke-dashoffset="${seg.offset}" transform="rotate(-90 100 100)"></circle>`,
        )
        .join('');
    },

    // ───────── top referrers (a ranked magnitude list, one hue — not a multi-series chart) ─────────
    get referrerRows() {
      const rows = [
        { host: 'Direct', sessions: this.direct },
        ...this.referrers.map((r) => ({ host: r.host, sessions: r.sessions })),
      ].filter((r) => r.sessions > 0);
      const max = Math.max(1, ...rows.map((r) => r.sessions));
      return rows
        .sort((a, b) => b.sessions - a.sessions)
        .map((r) => ({ ...r, pct: Math.round((r.sessions / max) * 100) }));
    },
  }));

  // ───────── cluster ─────────
  Alpine.data('clusterPage', () => ({
    ...H,
    data: null,
    timer: null,
    async init() {
      if (!(await this.mountFragment('cluster', 'page'))) return;
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), 5000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async refresh() {
      try {
        this.data = await api('GET', '/admin/cluster');
      } catch {
        /* transient; next tick retries */
      }
    },
    railPct(n) {
      const v = this.data?.dbConfigVersion || 0;
      return v === 0 ? 100 : Math.max(4, Math.min(100, (n.configVersion / v) * 100));
    },
  }));

  // A live snapshot (D-056's analytics_sessions), not a date-ranged report — polls like clusterPage rather than
  // taking a from/to filter.
  Alpine.data('analyticsActivePage', () => ({
    ...H,
    surface: 'public',
    windowMin: 5,
    data: null,
    timer: null,
    async init() {
      if (!(await this.mountFragment('analytics', 'active'))) return;
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), 15000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async refresh() {
      try {
        const q = new URLSearchParams({
          surface: this.surface,
          windowMs: String(this.windowMin * 60_000),
        });
        this.data = await api('GET', '/admin/analytics/active?' + q);
      } catch {
        /* transient; next tick retries */
      }
    },
    get maxCount() {
      return Math.max(1, ...(this.data?.byPage || []).map((r) => r.count));
    },
    pctOf(n) {
      return Math.round((n / this.maxCount) * 100);
    },
  }));
});
