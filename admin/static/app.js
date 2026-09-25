/* Admin SPA — Alpine.js components. No build step; served as-is. */

// ───────── API client (cookie session + CSRF header) ─────────
const auth = { user: null, csrf: null };

async function refreshCsrf() {
  const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  auth.csrf = (await res.json()).csrfToken;
}

async function api(method, path, body) {
  const send = async () => {
    const headers = { accept: 'application/json' };
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

// ───────── helpers shared by every component ─────────
const H = {
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
};

const hashParts = () => location.hash.replace(/^#\/?/, '').split('/');
// facts from /api/public/info that other components need
const meta = { passwordMinLength: 10, passwordReset: false, contentTypes: [] };
const thumb = (m) => {
  if (!m) return '';
  if (m.kind !== 'image') return '';
  const small = (m.variants || [])
    .filter((v) => v.format === 'webp')
    .sort((a, b) => a.width - b.width)[0];
  return `/media/${m.id}/${small ? small.file : m.originalFile}`;
};
const bytes = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
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

document.addEventListener('alpine:init', () => {
  // ───────── root ─────────
  Alpine.data('app', () => ({
    ...H,
    ready: false,
    user: null,
    siteName: '',
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
    contentTypes: [],
    path: 'overview',
    picker: { open: false, items: [], busy: false, error: '', q: '', resolve: null },
    _seq: 0,

    get minLength() {
      return meta.passwordMinLength;
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
            { id: 'services', label: 'Services', perm: 'services.read' },
            { id: 'seo', label: 'SEO Manager', perm: 'seo.read' },
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
            { id: 'terms', label: 'Categories and tags', perm: 'content.terms.manage' },
            { id: 'media', label: 'Media', perm: 'media.read' },
          ],
        },
        {
          // Was "Appearance" — now also holds the database manager, so it's named for the site's whole system
          // configuration rather than just its look. (Distinct from Operations → System, which is cluster health.)
          id: 'appearance',
          label: 'System',
          icon: 'bi-palette',
          items: [
            { id: 'themes', label: 'Themes', perm: 'themes.read' },
            { id: 'locales', label: 'Translations', perm: 'locales.read' },
            { id: 'menus', label: 'Menus', perm: 'menus.manage' },
            { id: 'redirects', label: 'Redirects', perm: 'redirects.manage' },
            { id: 'messages', label: 'Messages', perm: 'site.messages' },
            { id: 'dbms', label: 'Database', perm: 'dbms.read' },
          ],
        },
        { id: 'settings', label: 'Settings', icon: 'bi-sliders', perm: 'settings.read' },
        {
          id: 'security',
          label: 'Security',
          icon: 'bi-shield-lock',
          items: [
            { id: 'users', label: 'Users', perm: 'users.read' },
            { id: 'roles', label: 'Roles and permissions', perm: 'roles.read' },
            { id: 'audit', label: 'Audit log', perm: 'audit.read' },
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
          ],
        },
        {
          id: 'automation',
          label: 'Automation',
          icon: 'bi-lightning-charge',
          items: [
            { id: 'events', label: 'Events', perm: 'events.read' },
            { id: 'webhooks', label: 'Webhooks', perm: 'webhooks.read' },
          ],
        },
      ];
      if (!this.user) return [];
      const allowed = (n) => this.can(n.perm);
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

    async init() {
      window.addEventListener('pick-media', (e) => this.openPicker(e.detail.resolve));
      window.addEventListener('hashchange', () => {
        this.hash = location.hash;
        this.syncRoute();
        this.openResetLink();
      });
      window.addEventListener('toast', (e) => this.pushToast(e.detail.msg, e.detail.type));
      window.addEventListener('signed-out', () => this.setUser(null));
      try {
        const info = await api('GET', '/public/info');
        this.siteName = info.siteName;
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
      } catch {
        /* not signed in */
      }
      this.syncRoute();
      this.ready = true;
      this.openResetLink();
    },

    setUser(u) {
      auth.user = u;
      this.user = u;
      if (!u) auth.csrf = null;
    },

    syncRoute() {
      const [first, second] = this.parts;
      const key =
        (first || 'overview') === 'content' ? `content/${second || ''}` : first || 'overview';
      const ok = key === 'account' || this.navRoutes.includes(key);
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
        this.setUser(out.user);
        await this.loadTypes();
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
      await this.refresh(true);
      this.timer = setInterval(() => this.refresh(), 3000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async refresh(withHistory = false) {
      try {
        this.data = await api('GET', '/admin/updates');
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
    async init() {
      await this.load();
    },
    async load(reset = false) {
      if (reset) this.offset = 0;
      try {
        const qs = new URLSearchParams({ limit: String(this.limit), offset: String(this.offset) });
        if (this.status) qs.set('status', this.status);
        if (this.q) qs.set('q', this.q);
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
      data: {},
    },
    slugTouched: false,
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
            ['published', 'Published'],
            ['scheduled', 'Scheduled'],
            ['archived', 'Archived'],
          ]
        : [['draft', 'Draft']];
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
      try {
        if (this.type.hierarchical) {
          const list = await api('GET', `/admin/content/types/${this.typeId}/entries?limit=200`);
          this.parents = list.entries.filter((e) => String(e.id) !== String(this.id));
        }
        for (const t of this.type.taxonomies || []) {
          this.terms[t.id] = (await api('GET', `/admin/content/taxonomies/${t.id}/terms`)).terms;
          this.newTerm[t.id] = '';
        }
        if (this.isNew) this.fill(null);
        else this.fill((await api('GET', `/admin/content/entries/${this.id}`)).entry);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.$nextTick(() => {
          this.dirty = false;
          this.$watch('form', () => (this.dirty = true), { deep: true });
        });
      }
    },
    fill(entry) {
      this.entry = entry;
      const data = {};
      for (const f of this.type.fields) {
        const v = entry?.data?.[f.key];
        if (f.type === 'blocks')
          data[f.key] = {
            blocks: (v?.blocks || []).map((b) => ({
              _id: uid(),
              type: b.type,
              data: { ...b.data },
            })),
          };
        else if (f.type === 'list') data[f.key] = v || [];
        else if (f.type === 'boolean') data[f.key] = !!v;
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
        data,
      };
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
      }[type];
      this.blocksOf(f).push({ _id: uid(), type, data: { ...d } });
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
    format(cmd) {
      if (typeof document.execCommand === 'function') document.execCommand(cmd);
    },
    link() {
      const url = window.prompt('Link address (https://…, mailto:, tel:)');
      if (!url) return;
      if (!/^(https?:\/\/|mailto:|tel:)/i.test(url))
        return toast('Use an address that starts with https://, mailto: or tel:.', 'error');
      if (typeof document.execCommand === 'function')
        document.execCommand('createLink', false, url);
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
      return body;
    },
    async save() {
      this.busy = true;
      this.error = '';
      this.errors = {};
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
        const { entry } = await api('PUT', `/admin/content/entries/${this.id}`, this.payload());
        this.fill(entry);
        this.$nextTick(() => (this.dirty = false));
        toast('Saved.');
      } catch (e) {
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
  }));

  // ───────── media library ─────────
  Alpine.data('mediaPage', () => ({
    ...H,
    items: [],
    total: 0,
    q: '',
    kind: '',
    current: null,
    usage: 0,
    busy: false,
    error: '',
    available: true,
    dragging: false,
    thumb,
    bytes,
    async init() {
      await this.load();
    },
    async load() {
      const qs = new URLSearchParams({
        limit: '60',
        ...(this.q ? { q: this.q } : {}),
        ...(this.kind ? { kind: this.kind } : {}),
      });
      const r = await api('GET', `/admin/media?${qs}`);
      this.items = r.items;
      this.total = r.total;
      this.available = r.available;
    },
    async upload(files) {
      this.busy = true;
      this.error = '';
      let done = 0;
      try {
        for (const f of files) {
          await api('POST', `/admin/media?name=${encodeURIComponent(f.name)}`, f);
          done++;
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
        if (done) toast(`Uploaded ${done} file${done === 1 ? '' : 's'}.`);
        await this.load();
      }
    },
    async open(item) {
      this.current = { ...item };
      this.usage = (await api('GET', `/admin/media/${item.id}`)).usage;
    },
    async saveAlt() {
      try {
        const { item } = await api('PUT', `/admin/media/${this.current.id}`, {
          alt: this.current.alt,
        });
        this.items = this.items.map((i) => (i.id === item.id ? item : i));
        toast('Saved.');
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
        await this.load();
      } catch (e) {
        this.error = e.message;
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
    async init() {
      await this.load();
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
    },
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
    previewParams: {},
    preview: { html: '', busy: false, error: '' },

    async init() {
      const meta = await api('GET', '/admin/site/builder-meta');
      this.layouts = meta.layouts;
      this.entryTypes = meta.entryTypes;
      this.taxonomies = meta.taxonomies;
      this.components = (await api('GET', '/admin/site/components')).components;
      if (this.isNew) this.originalContent = this.content();
      else await this.load();
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
      const parsed = parseCompose(body.trim());
      this.code = body.trim();
      this.blocks = parsed || [];
      this.mode = parsed ? 'compose' : 'code';
      this.originalContent = r.content;
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
      return fm + (this.mode === 'compose' ? this.composeBody() : this.code);
    },
    get dirty() {
      return !this.isNew && this.content() !== this.originalContent;
    },

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.runPreview(), 700);
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
      } catch (e) {
        this.preview.error = e.message;
      } finally {
        this.preview.busy = false;
      }
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
        this.code = (bodyMatch ? bodyMatch[1] : text).trim();
        this.mode = 'code';
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
    async init() {
      await this.load();
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

    async init() {
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
    importBusy: false,
    importError: '',
    async init() {
      await this.load();
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

    async init() {
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
    error: '',
    busy: false,
    loaded: false,
    async init() {
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
    async init() {
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), 10000);
    },
    destroy() {
      clearInterval(this.timer);
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
    get up() {
      return this.cluster ? this.cluster.nodes.filter((n) => n.status === 'up').length : 0;
    },
    get drifted() {
      return this.cluster ? this.cluster.nodes.filter((n) => n.drift).length : 0;
    },
    async init() {
      const [info, cluster, audit] = await Promise.all([
        api('GET', '/public/info').catch(() => null),
        this.can('cluster.read') ? api('GET', '/admin/cluster').catch(() => null) : null,
        this.can('audit.read') ? api('GET', '/admin/audit?limit=8').catch(() => null) : null,
      ]);
      this.maintenance = !!info?.maintenance;
      this.cluster = cluster;
      this.recent = audit?.entries || [];
    },
  }));

  // ───────── settings ─────────
  Alpine.data('settingsPage', () => ({
    ...H,
    loaded: false,
    namespaces: [],
    ns: null,
    edits: {}, // ns -> { key: newValue }
    resets: {}, // ns -> { key: true }
    raws: {}, // 'ns.key' -> raw textarea text for list fields
    errors: {},
    saving: false,
    testing: false,
    testResult: null,
    history: [],

    get current() {
      return this.namespaces.find((n) => n.namespace === this.ns) || null;
    },

    async init() {
      await this.reload();
      const want = hashParts()[1];
      if (want === 'history') await this.showHistory();
      else
        this.ns = this.namespaces.some((n) => n.namespace === want)
          ? want
          : this.namespaces[0]?.namespace;
      this.loaded = true;
    },

    async reload() {
      const out = await api('GET', '/admin/settings');
      this.namespaces = out.namespaces;
      for (const n of out.namespaces) {
        if (!this.edits[n.namespace]) this.edits[n.namespace] = {};
        if (!this.resets[n.namespace]) this.resets[n.namespace] = {};
      }
    },

    select(ns) {
      this.ns = ns;
      this.errors = {};
      this.testResult = null;
      history.replaceState(null, '', `#/settings/${ns}`);
    },

    async showHistory() {
      this.ns = '__history';
      history.replaceState(null, '', '#/settings/history');
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
    more: false,
    async init() {
      await this.load(true);
    },
    async load(reset) {
      const q = new URLSearchParams({ limit: '50' });
      if (this.filter) q.set('action', this.filter);
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
      return '';
    },
  }));

  // ───────── cluster ─────────
  Alpine.data('clusterPage', () => ({
    ...H,
    data: null,
    timer: null,
    async init() {
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
});
