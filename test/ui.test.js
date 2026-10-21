import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { makeNode, ADMIN, until } from './helpers.js';

/**
 * Drives the real admin SPA (real Alpine, real server, real DB) in jsdom.
 * jsdom has no fetch, so we bridge it to Node's fetch with a tiny cookie jar.
 */
let node, base, dom, win, doc;
const errors = [];

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const text = () => doc.body.textContent.replace(/\s+/g, ' ');
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const click = (el) =>
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const button = (label) => $$('button').find((b) => b.textContent.trim() === label);
const go = (hash) => {
  win.location.hash = hash;
};
const visible = (el) => el && el.style.display !== 'none';

before(async () => {
  node = await makeNode();
  await node.ctx.nodes.start();
  base = node.url;

  const jar = new Map();
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));

  dom = await JSDOM.fromURL(`${base}/admin`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.confirm = () => true;
      w.fetch = async (url, opts = {}) => {
        const headers = { ...(opts.headers || {}) };
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(new URL(url, base), { ...opts, headers, redirect: 'manual' });
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
  win = dom.window;
  doc = win.document;
  await until(() => $('#email'), { timeout: 8000 });
});

after(async () => {
  win?.close();
  await node.close();
});

test('page loads with Alpine and shows the sign-in form; no script errors', async () => {
  assert.ok($('#pw'));
  assert.match(text(), /Sign in/);
  assert.deepEqual(errors, []);
});

test('wrong password shows an error and stays on the sign-in screen', async () => {
  type($('#email'), ADMIN.email);
  type($('#pw'), 'definitely-wrong');
  $('form.login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Email or password is incorrect/.test(text()));
  assert.ok($('#email'));
});

test('signing in shows the shell with navigation for an administrator', async () => {
  type($('#pw'), ADMIN.password);
  $('form.login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('.shell'));
  // The shell can paint before Alpine's nav x-for has flushed the permission-filtered list; wait for it to actually be there.
  await until(() => $$('.nav-link-x').some((a) => a.textContent.trim() === 'Overview'));
  const label = (a) => a.textContent.trim();
  // A sub-link is on screen only when its group's wrapper is (x-show hides the wrapper, not each link).
  const subLinks = () =>
    $$('.nav-sub')
      .filter(visible)
      .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map(label));
  assert.deepEqual(
    $$('.nav-link-x:not(.nav-sub-link)').map(label),
    [
      'Overview',
      'Webmaster',
      'Content',
      'Media Manager',
      'Analytics',
      'Logs',
      'Appearance',
      'System',
      'Settings',
      'Security',
      'Operations',
      'Automation',
      'Help',
    ],
    'top level: one link and twelve groups (Applications only appears once a plugin has a screen)',
  );
  assert.deepEqual(subLinks(), [], 'groups start collapsed on Overview');

  click(button('Content'));
  await until(() => subLinks().length);
  assert.deepEqual(subLinks(), ['Content pages', 'Posts', 'Categories and tags', 'AI Research']);
  click(button('Content'));
  await until(() => subLinks().length === 0);

  click(button('Logs'));
  await until(() => subLinks().length);
  assert.deepEqual(subLinks(), ['Audit log', 'Activity', 'Events', 'Text usage', 'Media usage']);
  click(button('Logs'));
  await until(() => subLinks().length === 0);

  click(button('Security'));
  await until(() => subLinks().length);
  assert.deepEqual(subLinks(), ['Users', 'Roles and permissions']);
  assert.equal(button('Security').getAttribute('aria-expanded'), 'true');
  click(button('Operations'));
  await until(() => subLinks().length === 6);
  assert.deepEqual(subLinks().slice(2), ['Cluster', 'System', 'Updates', 'Log Manager']);
  click(button('Security'));
  await until(() => subLinks().length === 4);
  assert.equal(button('Security').getAttribute('aria-expanded'), 'false');
  await until(() => /Config version/.test(text()));
});

test('settings: edit a value, see the save bar, save, and the change is live in the server', async () => {
  go('#/settings/general');
  await until(() => $('#f_site_name'));
  assert.equal($('#f_site_name').value, 'My Site');
  assert.ok(!visible($('.savebar')) || $('.savebar').style.display === 'none');

  type($('#f_site_name'), 'UI Test Store');
  await until(() => visible($('.savebar')) && /1 unsaved change/.test($('.savebar').textContent));
  click(button('Save changes'));
  await until(() => /Settings saved/.test(text()));
  assert.equal(node.ctx.settings.get('general.site_name'), 'UI Test Store');
  await until(() => !visible($('.savebar')));
});

test('settings: an invalid value is rejected and the message shows next to the field', async () => {
  type($('#f_timezone'), 'Mars/Base');
  await until(() => visible($('.savebar')));
  click(button('Save changes'));
  await until(() => /Unknown timezone/.test(text()));
  assert.equal(node.ctx.settings.get('general.timezone'), 'Asia/Kolkata');
  click(button('Discard'));
  await until(() => $('#f_timezone').value === 'Asia/Kolkata');
});

test('settings: booleans and lists round-trip; discard reverts', async () => {
  const sw = $('#f_maintenance_mode');
  sw.checked = true;
  sw.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => /1 unsaved change/.test($('.savebar').textContent));
  click(button('Save changes'));
  await until(() => node.ctx.settings.get('general.maintenance_mode') === true);
  sw.checked = false;
  sw.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => visible($('.savebar')));
  click(button('Save changes'));
  await until(() => node.ctx.settings.get('general.maintenance_mode') === false);

  [...$$('.subnav a')].find((a) => /Security/.test(a.textContent)).click();
  await until(() => $('#f_cors_origins'));
  type($('#f_cors_origins'), 'https://a.example.com\n\nhttps://b.example.com  ');
  await until(() => visible($('.savebar')));
  click(button('Save changes'));
  await until(() => node.ctx.settings.get('security.cors_origins').length === 2);
  assert.deepEqual(
    [...node.ctx.settings.get('security.cors_origins')],
    ['https://a.example.com', 'https://b.example.com'],
  );
});

test('settings: secrets are write-only in the UI and encrypted in the database', async () => {
  [...$$('.subnav a')].find((a) => /Email/.test(a.textContent)).click();
  await until(() => $('#f_password'));
  assert.equal($('#f_password').value, '');
  type($('#f_password'), 'ui-secret-pw');
  await until(() => visible($('.savebar')));
  click(button('Save changes'));
  await until(() => node.ctx.settings.get('mail.password') === 'ui-secret-pw');
  await until(() =>
    /Saved/.test(
      $$('.frow')
        .map((r) => r.textContent)
        .join(' '),
    ),
  );
  assert.equal($('#f_password').value, '');
  assert.ok(
    !doc.documentElement.outerHTML.includes('ui-secret-pw'),
    'the secret must not appear anywhere in the DOM',
  );
  const row = await node.ctx.db('settings').where({ namespace: 'mail', name: 'password' }).first();
  assert.match(row.value, /^enc:v1:/);
});

test('settings: history lists changes and restores a previous value', async () => {
  [...$$('.subnav a')].find((a) => /History/.test(a.textContent)).click();
  await until(() => /general\.site_name/.test(text()));
  const secretRow = $$('tbody tr').find((r) => /mail\.password/.test(r.textContent));
  assert.match(secretRow.textContent, /Secret value changed/);
  assert.ok(!/ui-secret-pw/.test(secretRow.textContent));
  const siteRow = $$('tbody tr').find((r) => /general\.site_name/.test(r.textContent));
  click(
    [...siteRow.querySelectorAll('button')].find((b) => /Restore previous/.test(b.textContent)),
  );
  await until(() => node.ctx.settings.get('general.site_name') === 'My Site');
});

test('users: list, create, and the last administrator is protected', async () => {
  go('#/users');
  await until(
    () =>
      button('Add user') && $$('tbody tr').some((r) => /admin@example\.com/.test(r.textContent)),
  );
  click(button('Add user'));
  const form = await until(() =>
    $$('form.panel').find((f) => visible(f) && /New user/.test(f.textContent)),
  );
  const [name, email] = form.querySelectorAll('input');
  type(name, 'Priya Sharma');
  type(email, 'priya@example.com');
  type(form.querySelector('input[type=password]'), 'Priya-pass-12345');
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /priya@example\.com/.test(text()));
  assert.equal(
    (await node.ctx.db('users').where({ email: 'priya@example.com' }).first()).status,
    'active',
  );

  const adminRow = $$('tbody tr').find((r) => /admin@example\.com/.test(r.textContent));
  click([...adminRow.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete'));
  await until(() => /can't delete your own account/i.test(text()));
  assert.ok(await node.ctx.db('users').where({ email: ADMIN.email }).first());
});

test('roles: permission groups render and a custom role can be created', async () => {
  go('#/roles');
  await until(() => /Administrator/.test(text()) && /Everything/.test(text()));
  click(button('Add role'));
  await until(() => $('#p_settings\\.read'));
  const form = $$('form.panel').find((f) => visible(f) && /New role/.test(f.textContent));
  type(form.querySelector('input'), 'Support');
  const box = $('#p_audit\\.read');
  box.checked = true;
  box.dispatchEvent(new win.Event('change', { bubbles: true }));
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(async () => await node.ctx.db('roles').where({ name: 'Support' }).first());
  const role = await node.ctx.db('roles').where({ name: 'Support' }).first();
  assert.deepEqual(JSON.parse(role.permissions).sort(), ['admin.access', 'audit.read']);
});

test('audit log shows what happened, with secrets redacted', async () => {
  go('#/audit');
  await until(() => /settings\.update/.test(text()));
  assert.match(text(), /general\.site_name\s+My Site → UI Test Store/);
  assert.match(text(), /mail\.password\s+\(secret changed\)/);
  assert.match(text(), /user\.create/);
  assert.ok(!/ui-secret-pw/.test(text()));
});

test('audit log: actor filter narrows the list, and the export link carries the filters', async () => {
  go('#/audit');
  const scope = 'section[x-data="auditPage"] ';
  await until(() => /settings\.update/.test(text()));
  const exportLink = $(scope + 'a[download]');
  assert.match(exportLink.getAttribute('href'), /\/api\/admin\/audit\/export/);

  type($(scope + '#au-actor'), ADMIN.email);
  await until(() => exportLink.getAttribute('href').includes('actorEmail='), { timeout: 2000 });
  assert.match(
    exportLink.getAttribute('href'),
    new RegExp(`actorEmail=${encodeURIComponent(ADMIN.email)}`),
  );

  type($(scope + '#au-actor'), 'nobody-at-all@example.com');
  await new Promise((r) => setTimeout(r, 500)); // clear the 400ms debounce before polling
  await until(() => $$(scope + 'tbody tr').length === 0, { timeout: 2000 });
  assert.ok(visible($(scope + '.empty')));

  type($(scope + '#au-actor'), '');
  await until(() => /settings\.update/.test(text()));
});

test('cluster: shows this server with an up-to-date version rail; drift shows in amber', async () => {
  go('#/cluster');
  await until(() => $('.node'));
  assert.match($('.node').textContent, /this server/);
  assert.match($('.node').textContent, /up to date/);
  assert.ok(!$('.rail').classList.contains('drift'));

  // Insert a fake peer that has not applied the latest config → drift
  await node.ctx.db('cluster_nodes').insert({
    node_id: 'ghost-1',
    role: 'web',
    host: 'ghost',
    pid: 1,
    app_version: '0.1.0',
    started_at: Date.now(),
    last_seen: Date.now(),
    config_version: 1,
    draining: false,
  });
  await until(() => $$('.node').length === 2, { timeout: 8000 });
  const ghost = $$('.node').find((n) => /ghost/.test(n.textContent));
  assert.match(ghost.textContent, /behind/);
  assert.ok(ghost.querySelector('.rail').classList.contains('drift'));
});

test('overview shows counts; sign out returns to the sign-in form', async () => {
  go('#/overview');
  await until(() => /Servers up/.test(text()) && /behind on config/.test(text()));
  click(button('Sign out'));
  await until(() => $('#email'));
  assert.ok(!$('.shell'));
  assert.deepEqual(errors, [], `script errors: ${errors.join(' | ')}`);
});
