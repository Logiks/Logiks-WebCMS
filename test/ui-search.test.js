import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b;
before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const key = (win, init, target = win) =>
  target.dispatchEvent(
    new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
const palette = () => b.$('.cmdk');
const isOpen = () => palette() && palette().style.display !== 'none';
const input = () => b.$('#cmdk-q');
const type = (q) => {
  input().value = q;
  input().dispatchEvent(new b.win.Event('input', { bubbles: true }));
};
const titles = () => [...b.$$('.cmdk-item .cmdk-title')].map((x) => x.textContent.trim());
const close = async () => {
  if (isOpen()) key(b.win, { key: 'Escape' });
  await wait(() => !isOpen());
};

test('the Search button in the menu opens the palette with suggested tasks', async () => {
  await wait(() => b.$('.nav-search'));
  b.click(b.$('.nav-search'));
  await wait(() => isOpen());
  await wait(() => titles().length > 0);
  assert.ok(
    titles().includes('Change the Content Security Policy'),
    'common tasks are suggested before typing',
  );
  assert.equal(b.doc.activeElement, input(), 'the search box has focus');
  await close();
});

test('Ctrl+K and Cmd+K open it, Escape closes it, and "/" opens it only when not typing', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  key(b.win, { key: 'Escape' });
  await wait(() => !isOpen());
  key(b.win, { key: 'k', metaKey: true });
  await wait(() => isOpen());
  await close();
  key(b.win, { key: '/' });
  await wait(() => isOpen());
  await close();
  // Typing a slash into a field must not steal the keystroke.
  const field = b.doc.createElement('input');
  b.doc.body.appendChild(field);
  field.focus();
  key(b.win, { key: '/' }, field);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!isOpen());
  field.remove();
});

test('a task in plain words finds the setting; Enter opens that section and flashes the one field', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  type('how do I change the content security policy');
  // Settings are read once, after the palette is opened; wait for the individual setting to be listed too.
  await wait(() => titles().includes('Extra image sources (CSP)'));
  assert.equal(titles()[0], 'Change the Content Security Policy', 'the task answers it first');
  assert.ok(
    !titles().includes('Session cookie name'),
    'fields that are not about it are not listed',
  );
  // Choose the specific setting (the third entry or wherever it is) with the keyboard.
  const at = titles().indexOf('Extra image sources (CSP)');
  for (let i = 0; i < at; i++) key(b.win, { key: 'ArrowDown' }, input());
  key(b.win, { key: 'Enter' }, input());
  await wait(() => !isOpen());
  await wait(() => /#\/settings\/security/.test(b.win.location.hash));
  await wait(() => b.doc.getElementById('f-security-csp_img_sources'));
  await wait(() => b.doc.getElementById('f-security-csp_img_sources').classList.contains('flash'));
});

test('screens are found by what they do, not only by their name', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  type('theme');
  await wait(() => titles().includes('Themes') && titles().includes('Theme editor'));
  type('clone');
  await wait(() => titles().includes('Copy a theme to edit it'));
  type('maintenance mode');
  await wait(() => titles().includes('Maintenance mode'));
  type('smtp');
  await wait(() => titles().some((t) => /SMTP/.test(t)));
  await close();
});

test('a small typo still finds the right thing', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  type('securty');
  await wait(() => titles().includes('Security settings'));
  await close();
});

test('nothing is ever put into the page unescaped, and a query with no match offers the assistant', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  type('<img src=x onerror=alert(1)> xyzzy');
  await wait(() => titles().some((t) => t.startsWith('Ask the assistant')));
  assert.equal(b.$$('.cmdk-list img').length, 0);
  assert.match(titles().at(-1), /<img src=x onerror=alert\(1\)>/, 'shown as text');
  await close();
});

test('"Ask the assistant" opens the panel with what was typed already in the message box', async () => {
  key(b.win, { key: 'k', ctrlKey: true });
  await wait(() => isOpen());
  type('add a pricing page');
  await wait(() => titles().some((t) => t.startsWith('Ask the assistant')));
  const at = titles().findIndex((t) => t.startsWith('Ask the assistant'));
  for (let i = 0; i < at; i++) key(b.win, { key: 'ArrowDown' }, input());
  key(b.win, { key: 'Enter' }, input());
  await wait(() => !isOpen());
  await wait(() => b.$('aside.chat-dock #chat-input'));
  await wait(() => b.$('#chat-input').value === 'add a pricing page');
  b.click(b.$('aside.chat-dock [aria-label="Close the assistant"]'));
  await wait(() => !b.$('aside.chat-dock'));
});

test('a person who cannot read settings is never offered settings or screens they cannot open', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'Limited', permissions: ['admin.access', 'pages.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'limited@example.com', name: 'Limited', password: 'Correct-Horse-9', roleId: role.id },
    null,
  );
  const l = await openAdmin(node.url);
  try {
    await l.signIn('limited@example.com', 'Correct-Horse-9');
    await wait(() => l.$('.nav-search'));
    key(l.win, { key: 'k', ctrlKey: true });
    await wait(() => l.$('.cmdk') && l.$('.cmdk').style.display !== 'none');
    const q = l.$('#cmdk-q');
    const ask = async (text) => {
      q.value = text;
      q.dispatchEvent(new l.win.Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return [...l.$$('.cmdk-item .cmdk-title')].map((x) => x.textContent.trim());
    };
    const sec = await ask('security');
    assert.ok(
      !sec.includes('Security settings') && !sec.includes('Change the Content Security Policy'),
    );
    assert.ok(!(await ask('users')).includes('Users'), 'no Users screen without users.read');
    assert.ok((await ask('pages')).includes('Site pages'), 'what they can open is found');
  } finally {
    l.close();
  }
});

test('the chat bubbles keep their own padding: the old shared rules cannot leak into them again', () => {
  const css = fs.readFileSync(new URL('../admin/static/admin-ui.css', import.meta.url), 'utf8');
  const bubble = /\.ac-bubble\s*\{[^}]*\}/.exec(css)[0];
  assert.ok(
    !/pre-wrap/.test(bubble),
    'pre-wrap on the bubble would keep the template’s whitespace as blank lines',
  );
  assert.match(/\.ac-text\s*\{[^}]*\}/.exec(css)[0], /pre-wrap/);
  const panel = fs.readFileSync(
    new URL('../src/modules/assistant/admin/panel.html', import.meta.url),
    'utf8',
  );
  assert.ok(!/chat-(user|assistant|bubble|msg)/.test(panel), 'the panel uses its own ac-* names');
});
