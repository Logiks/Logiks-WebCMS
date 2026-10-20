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

test('AI Testing: the checks can be chosen, a report offers PDF and CSV, and journeys can be written and tried', async (t) => {
  b.go('#/testing');
  await wait(() => sec() && sec().querySelector('#t-run-h'));
  assert.match(b.$('h1').textContent, /AI Testing/);
  // every kind of check is listed, with the optional ones marked
  await wait(() => sec().querySelectorAll('#t-checks input[type="checkbox"]').length >= 14);
  assert.match(sec().querySelector('#t-checks').textContent, /Keyboard/);
  assert.match(sec().querySelector('#t-checks').textContent, /opt-in/);
  if (browser) {
    await wait(() => sec().querySelector('a[href$="/export.pdf"]'));
    assert.match(
      sec().querySelector('a[href$="/export.pdf"]').getAttribute('href'),
      /\/api\/admin\/testing\/runs\/\d+\/export\.pdf/,
    );
  }
  // Journeys: write one and try it
  const tab = [...sec().querySelectorAll('.nav-link')].find((x) => x.textContent === 'Journeys');
  b.click(tab);
  await wait(() =>
    [...sec().querySelectorAll('button')].some((x) => x.textContent === 'New journey'),
  );
  b.click([...sec().querySelectorAll('button')].find((x) => x.textContent === 'New journey'));
  await wait(() => sec().querySelector('#t-j-name'));
  const set = (el, v) => {
    el.value = v;
    el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  };
  set(sec().querySelector('#t-j-name'), 'Home loads');
  set(sec().querySelector('#t-j-steps'), 'goto /aa-ui\nexpect text Two');
  sec()
    .querySelector('form[aria-labelledby="t-j-h"]')
    .dispatchEvent(new b.win.Event('submit', { bubbles: true, cancelable: true }));
  await wait(() =>
    [...sec().querySelectorAll('.list-group-item button')].some(
      (x) => x.textContent === 'Home loads',
    ),
  );
  b.click([...sec().querySelectorAll('button')].find((x) => x.textContent === 'Try it now'));
  await wait(() => /passed|stopped/.test(sec().textContent));
  assert.match(sec().textContent, /Try it now: Home loads/);
  // a mistake in the steps is explained, not saved
  b.click(
    [...sec().querySelectorAll('.list-group-item button')].find(
      (x) => x.textContent === 'Home loads',
    ),
  );
  await wait(() => sec().querySelector('#t-j-steps'));
  set(sec().querySelector('#t-j-steps'), 'fly away');
  sec()
    .querySelector('form[aria-labelledby="t-j-h"]')
    .dispatchEvent(new b.win.Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => /not a step|Start the journey/.test(sec().textContent));
  t.diagnostic('journeys ok');
});
