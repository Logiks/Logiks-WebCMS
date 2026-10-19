import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b, receiver, receiverUrl;
const received = [];

before(async () => {
  node = await makeNode();
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
});
after(async () => {
  b.close();
  await node.close();
  await new Promise((resolve) => receiver.close(resolve));
});

const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

test('Webhooks is in the menu, under Automation; Events moved to Logs (D-059)', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /Webhooks/.test(navText()));
  assert.match(navText(), /Events/);
  // A collapsed group's own wrapper is hidden (x-show); its links aren't individually, so filter on the
  // wrapper (matches ui.test.js's subLinks()), not on '.nav-sub-link' directly.
  const groupLinks = () =>
    b
      .$$('.nav-sub')
      .filter(b.visible)
      .flatMap((g) => [...g.querySelectorAll('.nav-sub-link')].map((a) => a.textContent.trim()));
  b.click(b.button('Automation'));
  await wait(() => groupLinks().length);
  assert.deepEqual(groupLinks(), ['Webhooks', 'Scheduler', 'Testing']);
});

test('fire a test event from the Events screen and see it in the log', async () => {
  b.go('#/events');
  const page = () => b.$('section[x-data="eventsPage"]');
  await wait(() => page());
  const fireTab = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Fire test event');
  await wait(() => fireTab());
  b.click(fireTab());
  await wait(() => page().querySelector('#ev-name'));
  setValue(page().querySelector('#ev-name'), 'ui.manual_test');
  setValue(page().querySelector('#ev-payload'), '{"from":"ui-test"}');
  const fireBtn = () =>
    [...page().querySelectorAll('button')].find((x) => x.textContent === 'Fire');
  await wait(() => fireBtn() && !fireBtn().disabled);
  b.click(fireBtn());
  await wait(() => /ui\.manual_test/.test(page().textContent));
  assert.match(page().textContent, /"from":"ui-test"/);
});

test('create a webhook, fire a matching event, and see a recorded delivery', async () => {
  b.go('#/webhooks/new');
  const ed = () => b.$('section[x-data^="webhooksEditor"]');
  await wait(() => ed() && ed().querySelector('#wh-name'));
  setValue(ed().querySelector('#wh-name'), 'UI test hook');
  setValue(ed().querySelector('#wh-event'), 'ui.webhook_test');
  setValue(ed().querySelector('#wh-url'), receiverUrl);
  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create webhook');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => /^#\/webhooks\/\d+$/.test(b.win.location.hash));

  await node.ctx.events.emit('ui.webhook_test', { hello: 'world' });
  await wait(() => received.length > 0);
  assert.match(received[received.length - 1], /"hello":"world"/);

  await wait(() => /Recent deliveries/.test(ed().textContent));
  const sendTestBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Send test');
  await wait(() => sendTestBtn());
  const beforeTest = received.length;
  b.click(sendTestBtn());
  await wait(() => received.length > beforeTest);
  assert.match(received[received.length - 1], /"event":"test"/);
});
