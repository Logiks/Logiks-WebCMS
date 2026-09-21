import { JSDOM, VirtualConsole } from 'jsdom';
import { until } from './helpers.js';

/**
 * Opens the real admin SPA in jsdom against a running test server. jsdom has no fetch, so we bridge to
 * Node's fetch with a small cookie jar (one jar per opened "browser").
 */
export async function openAdmin(base, { path = '/admin' } = {}) {
  const jar = new Map();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = await JSDOM.fromURL(`${base}${path}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const headers = { ...(opts.headers || {}) };
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let body = opts.body;
        if (
          body &&
          typeof body === 'object' &&
          typeof body.size === 'number' &&
          typeof body.slice === 'function'
        ) {
          // a File/Blob from the page: read it into bytes for Node's fetch
          body = await new Promise((resolve, reject) => {
            const fr = new w.FileReader();
            fr.onload = () => resolve(Buffer.from(fr.result));
            fr.onerror = reject;
            fr.readAsArrayBuffer(body);
          });
        }
        const res = await fetch(new URL(url, base), { ...opts, body, headers, redirect: 'manual' });
        for (const c of res.headers.getSetCookie()) {
          const [kv] = c.split(';');
          const i = kv.indexOf('=');
          if (/expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(kv.slice(0, i));
          else jar.set(kv.slice(0, i), kv.slice(i + 1));
        }
        return res;
      };
    },
  });
  const win = dom.window;
  const doc = win.document;
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const h = {
    win,
    doc,
    errors,
    $,
    $$,
    text: () => doc.body.textContent.replace(/\s+/g, ' '),
    type(el, value) {
      el.value = value;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    click: (el) =>
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })),
    submit: (form) =>
      form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })),
    button: (label) => $$('button').find((b) => b.textContent.trim() === label),
    visible: (el) => Boolean(el) && el.style.display !== 'none',
    /** Is there a VISIBLE alert matching this text? (textContent alone also sees x-show=false content.) */
    alertShown: (re) =>
      $$('.alert').some((a) => re.test(a.textContent) && a.style.display !== 'none'),
    go: (hash) => {
      win.location.hash = hash;
    },
    async signIn(email, password) {
      await until(() => $('#email'), { timeout: 8000 });
      h.type($('#email'), email);
      h.type($('#pw'), password);
      h.submit($('form.login-form'));
      await until(() => $('.shell'));
    },
    close: () => win.close(),
  };
  await until(() => $('#email') || $('.shell') || $('#rp-new') || $('.login'), { timeout: 8000 });
  return h;
}
