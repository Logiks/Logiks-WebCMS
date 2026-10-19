import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b, browser;
before(async () => {
  node = await makeNode();
  browser = (await node.ctx.visual.status()).ok;
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  await node.ctx.siteFiles.put(
    'pages/aa-ui.html',
    '---\ntitle: UI test page\n---\n<h1>One</h1><h1>Two</h1><p>We recieve things.</p>',
    { id: null, email: null, can: () => true },
  );
  if (browser)
    await node.ctx.testing.start({ viewports: ['desktop'], maxPages: 3 }, null, {
      origin: node.url,
      wait: true,
    });
});
after(async () => {
  b.close();
  await node.close();
});

const wait = (fn) => until(fn, { timeout: 10000, every: 50 });
const sec = () => b.$('section[x-data="testingPage"]');

test('Testing is under Automation, and shows a stored report with its problems grouped by page', async (t) => {
  b.go('#/testing');
  await wait(() => sec() && sec().querySelector('#t-run-h'));
  if (!browser) return t.skip('no Chrome/Chromium on this machine');
  await wait(() => sec().querySelectorAll('.t-page').length >= 1);
  assert.match(sec().textContent, /Check #1/);
  const page = [...sec().querySelectorAll('.t-page')].find((d) => d.textContent.includes('/aa-ui'));
  assert.ok(page, 'the test page is in the report');
  assert.match(page.textContent, /recieve/);
  assert.match(page.textContent, /h1/);
  // Filtering to errors hides the warnings.
  const sev = sec().querySelector('#t-f-sev');
  sev.value = 'error';
  sev.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  await wait(
    () => ![...sec().querySelectorAll('.t-page li')].some((li) => /recieve/.test(li.textContent)),
  );
});

test('the run form is there for people who may run checks', async () => {
  b.go('#/testing');
  await wait(() => sec() && sec().querySelector('#t-run-h'));
  assert.ok(sec().querySelector('#t-vp-mobile'));
  assert.ok(
    [...sec().querySelectorAll('button')].some((x) =>
      /Run check now|A check is running/.test(x.textContent),
    ),
  );
});
