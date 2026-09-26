import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
  el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
};

test('Scheduler is in the menu, under Automation', async () => {
  b.go('#/overview');
  const navText = () =>
    `${b.$$('nav a, aside a, nav button, aside button').map((a) => a.textContent.trim())}`;
  await wait(() => /Scheduler/.test(navText()));
});

test('create a scheduled task for a Service and run it now', async () => {
  await node.ctx.content.create(
    'post',
    { title: 'For the scheduler', status: 'published', data: {} },
    null,
  );

  b.go('#/services/new');
  const svcEd = () => b.$('section[x-data^="servicesEditor"]');
  await wait(() => svcEd() && svcEd().querySelector('#s-name'));
  setValue(svcEd().querySelector('#s-name'), 'Scheduled service');
  setValue(svcEd().querySelector('#s-slug'), 'ui-scheduled-service');
  const typeSelect = () => svcEd().querySelector('#s-type');
  await wait(() => typeSelect() && [...typeSelect().options].some((o) => o.value === 'post'));
  setValue(typeSelect(), 'post');
  const svcEnabled = svcEd().querySelector('#s-enabled');
  svcEnabled.checked = true;
  svcEnabled.dispatchEvent(new b.win.Event('change', { bubbles: true }));
  const svcSaveBtn = () =>
    [...svcEd().querySelectorAll('button')].find((x) => x.textContent === 'Create service');
  await wait(() => svcSaveBtn() && !svcSaveBtn().disabled);
  b.click(svcSaveBtn());
  await wait(() => node.ctx.services.get('ui-scheduled-service').catch(() => null));

  b.go('#/scheduler/new');
  const ed = () => b.$('section[x-data^="schedulerEditor"]');
  await wait(() => ed() && ed().querySelector('#sc-name'));
  setValue(ed().querySelector('#sc-name'), 'UI scheduled task');
  const targetSelect = () => ed().querySelector('#sc-target');
  await wait(
    () =>
      targetSelect() && [...targetSelect().options].some((o) => o.value === 'ui-scheduled-service'),
  );
  setValue(targetSelect(), 'ui-scheduled-service');
  const saveBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Create task');
  await wait(() => saveBtn() && !saveBtn().disabled);
  b.click(saveBtn());
  await wait(() => /^#\/scheduler\/\d+$/.test(b.win.location.hash));

  const runBtn = () =>
    [...ed().querySelectorAll('button')].find((x) => x.textContent === 'Run now');
  await wait(() => runBtn());
  b.click(runBtn());
  await wait(() => /\bok\b/.test(ed().textContent));

  const taskId = Number(b.win.location.hash.split('/').pop());
  const task = await node.ctx.scheduler.get(taskId);
  assert.equal(task.lastStatus, 'ok');
});
