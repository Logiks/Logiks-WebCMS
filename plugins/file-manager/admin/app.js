  // Loaded by H.mountPluginFragment before this screen's markup goes in, so `fileManager` exists when Alpine binds it.
  // Writes need the CSRF token, which the admin's own api() helper keeps private, so this fetches its own.
  Alpine.data('fileManager', () => {
    const BASE = '/api/admin/apps/file-manager';
    let csrf = null;
    const call = async (method, url, body, retried = false) => {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET') {
        if (!csrf) csrf = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
        headers['x-csrf-token'] = csrf;
      }
      const res = await fetch(BASE + url, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error?.code === 'bad_csrf' && !retried) {
          csrf = null;
          return call(method, url, body, true);
        }
        throw new Error(data.error?.message || 'That didn’t work (' + res.status + ').');
      }
      return data;
    };
    const qs = (o) => '?' + new URLSearchParams(o).toString();

    return {
      tab: 'files',
      roots: [],
      can: { edit: false, delete: false },
      root: 'public',
      path: '',
      entries: [],
      loaded: false,
      busy: false,
      error: '',
      notice: '',
      // editor
      file: null,
      content: '',
      original: '',
      // create / rename / delete
      creating: '',
      newName: '',
      renaming: null,
      renameTo: '',
      del: null,
      delConfirm: '',
      delRecursive: false,
      delError: '',
      // search
      q: '',
      scope: 'all',
      glob: '',
      mode: 'content',
      optCase: false,
      optWord: false,
      optRegex: false,
      results: [],
      truncated: '',
      searched: false,
      summary: null,

      get crumbs() {
        return this.path ? this.path.split('/') : [];
      },
      get rootKind() {
        return this.roots.find((r) => r.id === this.root)?.kind;
      },
      get rootNote() {
        return this.roots.find((r) => r.id === this.root)?.note || '';
      },
      get dirty() {
        return !!this.file && this.content !== this.original;
      },
      get resultSummary() {
        const s = this.summary;
        if (!s) return '';
        return this.results.length + ' match' + (this.results.length === 1 ? '' : 'es') + ' in ' + s.scanned + ' files searched (' + s.tookMs + ' ms)';
      },

      join: (dir, name) => (dir ? dir + '/' + name : name),
      size(n) {
        if (n == null) return '';
        return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
      },
      dirOf: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''),
      baseOf: (p) => p.slice(p.lastIndexOf('/') + 1),
      /** Monaco language id from the file name. */
      langOf(p) {
        const ext = (/\.([a-z0-9]+)$/i.exec(p)?.[1] || '').toLowerCase();
        return (
          { html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'shell' }[ext] || 'plaintext'
        );
      },
      iconOf(name) {
        const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
        const icon = { html: 'bi-filetype-html', htm: 'bi-filetype-html', css: 'bi-filetype-css', js: 'bi-filetype-js', mjs: 'bi-filetype-js', cjs: 'bi-filetype-js', json: 'bi-filetype-json', md: 'bi-markdown', svg: 'bi-filetype-svg', png: 'bi-file-earmark-image', jpg: 'bi-file-earmark-image', jpeg: 'bi-file-earmark-image', gif: 'bi-file-earmark-image', webp: 'bi-file-earmark-image' }[ext];
        return icon || 'bi-file-earmark-text';
      },

      // ───── AI help: the admin's own assistant panel, pinned to this file ─────
      // `askAssistant` / `assistantAvailable` live on the admin page's scope (this screen is nested in it).
      get parentScope() {
        return Alpine.$data(this.$el.parentElement);
      },
      // A stored value, not a getter: the admin's module list may not be loaded yet when this first renders, and a
      // getter that reads state Alpine doesn't track would never be asked again. Re-checked as each file opens.
      canAsk: false,
      checkAsk() {
        try {
          this.canAsk = !!this.parentScope.assistantAvailable();
        } catch {
          this.canAsk = false;
        }
      },
      /** The text selected in the editor (Monaco, or the plain textarea if Monaco isn't there), capped. */
      selection() {
        const ta = this.$el.querySelector('.fm-editor textarea');
        const ed = ta?._monaco?.editor;
        let text = '';
        if (ed) text = ed.getModel().getValueInRange(ed.getSelection());
        else if (ta) text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        return text.trim().slice(0, 4000);
      },
      /** What the assistant can be pinned to: a site-tree file, or a whole plugin. The shipped `site` files have no
       * assistant document kind, so there it just opens with the file named in the message. */
      focusPath() {
        if (!this.file) return null;
        if (this.root === 'public') return this.file.path;
        if (this.root === 'plugins') return 'plugins/' + this.file.path.split('/')[0];
        return null;
      },
      askAI() {
        if (!this.file) return;
        const where = this.root + '/' + this.file.path;
        const sel = this.selection();
        const prefill = sel
          ? 'About this part of ' + where + ':\n```\n' + sel + '\n```\n'
          : 'About ' + where + ': ';
        this.parentScope.askAssistant(this.focusPath(), prefill);
      },

      say(msg) {
        this.notice = msg;
        this.error = '';
      },
      fail(e) {
        this.error = e.message;
        this.notice = '';
      },

      async init() {
        try {
          const r = await call('GET', '/roots');
          this.roots = r.roots;
          this.can = r.can;
          this.checkAsk();
          await this.loadDir();
        } catch (e) {
          this.fail(e);
        }
      },

      confirmDiscard() {
        return !this.dirty || window.confirm('You have unsaved changes in this file. Discard them?');
      },

      async switchRoot(id) {
        if (id === this.root || !this.confirmDiscard()) return;
        this.root = id;
        this.path = '';
        this.closeFile(true);
        await this.loadDir();
      },
      async goDir(p) {
        this.path = p;
        await this.loadDir();
      },
      async loadDir() {
        try {
          const r = await call('GET', '/list' + qs({ root: this.root, path: this.path }));
          this.entries = r.entries;
          this.error = '';
        } catch (e) {
          this.entries = [];
          this.fail(e);
        } finally {
          this.loaded = true;
        }
      },

      async openFile(p, root = this.root) {
        if (!this.confirmDiscard()) return;
        try {
          const f = await call('GET', '/file' + qs({ root, path: p }));
          this.root = root;
          this.file = f;
          this.checkAsk();
          this.content = f.content;
          this.original = f.content;
          this.error = '';
          this.notice = '';
        } catch (e) {
          this.fail(e);
        }
      },
      closeFile(force = false) {
        if (!force && !this.confirmDiscard()) return;
        this.file = null;
        this.content = '';
        this.original = '';
      },
      async save() {
        if (!this.file || !this.dirty || this.busy) return;
        this.busy = true;
        try {
          const r = await call('PUT', '/file', { root: this.root, path: this.file.path, content: this.content, expectedHash: this.file.hash });
          this.file = { ...this.file, hash: r.hash, size: new Blob([this.content]).size };
          this.original = this.content;
          this.say(r.message);
          this.loadDir();
        } catch (e) {
          this.fail(e);
        } finally {
          this.busy = false;
        }
      },

      startCreate(type) {
        this.creating = type;
        this.newName = '';
        this.$nextTick(() => document.getElementById('fm-new')?.focus());
      },
      async create() {
        this.busy = true;
        try {
          const type = this.creating;
          const target = this.join(this.path, this.newName.trim());
          if (type === 'dir' && this.rootKind === 'tree') {
            // The site tree stores files only; a folder exists while it holds one. So "new folder" opens the (still
            // empty) folder and asks for its first file; it is saved with that file.
            const top = target.split('/')[0];
            if (!this.path && !['pages', 'components', 'locales'].includes(top))
              throw new Error('At the top, the site tree has three folders: pages, components and locales. Make your folder inside one of them.');
            this.creating = 'file';
            this.newName = '';
            await this.goDir(target);
            this.say('Folder ready. It is saved when you create its first file.');
            this.$nextTick(() => document.getElementById('fm-new')?.focus());
            return;
          }
          await call('POST', '/create', { root: this.root, path: target, type });
          this.creating = '';
          await this.loadDir();
          this.say((type === 'dir' ? 'Folder' : 'File') + ' created.');
          if (type === 'file') await this.openFile(target);
        } catch (e) {
          this.fail(e);
        } finally {
          this.busy = false;
        }
      },

      startRename(e) {
        this.renaming = this.join(this.path, e.name);
        this.renameTo = this.renaming;
        this.$nextTick(() => document.getElementById('fm-rename')?.focus());
      },
      async rename() {
        this.busy = true;
        try {
          const to = this.renameTo.trim();
          await call('POST', '/rename', { root: this.root, from: this.renaming, to });
          if (this.file && (this.file.path === this.renaming || this.file.path.startsWith(this.renaming + '/'))) this.closeFile(true);
          this.renaming = null;
          await this.loadDir();
          this.say('Renamed.');
        } catch (e) {
          this.renaming = null;
          this.fail(e);
        } finally {
          this.busy = false;
        }
      },

      async askDelete(p) {
        this.delConfirm = '';
        this.delRecursive = false;
        this.delError = '';
        try {
          this.del = await call('POST', '/delete-preview', { root: this.root, path: p });
          this.$nextTick(() => document.getElementById('fm-del-confirm')?.focus());
        } catch (e) {
          this.fail(e);
        }
      },
      async confirmDelete() {
        if (!this.del || this.busy) return;
        this.busy = true;
        this.delError = '';
        try {
          const gone = this.del.path;
          const r = await call('POST', '/delete', { root: this.del.root, path: gone, confirm: this.delConfirm, recursive: this.delRecursive });
          if (this.file && (this.file.path === gone || this.file.path.startsWith(gone + '/'))) this.closeFile(true);
          this.del = null;
          await this.loadDir();
          this.say('Deleted ' + r.removed + ' file' + (r.removed === 1 ? '' : 's') + '.');
        } catch (e) {
          this.delError = e.message; // stays in the dialog so the fix is right beside the message
        } finally {
          this.busy = false;
        }
      },

      async runSearch() {
        this.busy = true;
        this.error = '';
        try {
          const params = { q: this.q, root: this.scope, mode: this.mode, glob: this.glob };
          if (this.optCase) params.case = '1';
          if (this.optWord) params.word = '1';
          if (this.optRegex) params.regex = '1';
          const r = await call('GET', '/search' + qs(params));
          this.results = r.results;
          this.truncated = r.truncated || '';
          this.summary = r;
          this.searched = true;
        } catch (e) {
          this.fail(e);
        } finally {
          this.busy = false;
        }
      },
      async openHit(hit) {
        const dir = hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : '';
        if (!this.confirmDiscard()) return;
        this.root = hit.root;
        this.path = dir;
        this.tab = 'files';
        await this.loadDir();
        await this.openFile(hit.path, hit.root);
      },
    };
  });
