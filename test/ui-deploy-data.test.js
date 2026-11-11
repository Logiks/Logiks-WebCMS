import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

test('Deploy screen: choose what to copy per table, a child lifts its parents, the choice is saved; conflicts can be ticked and applied', async () => {
  const node = await startNode({ seed: true });
  const t0 = Date.now();
  // A change a deployment brought that differs here, waiting for a person.
  await node.ctx
    .db('redirects')
    .insert({ from_path: '/old', to_url: '/mine', status_code: 301, created_at: t0 });
  await node.ctx.db('deploy_conflicts').insert({
    tbl: 'redirects',
    row_key: 'k1',
    label: 'redirects: /old',
    target_id: '1',
    incoming: JSON.stringify({ from_path: '/old', to_url: '/dev', status_code: 301 }),
    changes: JSON.stringify([{ column: 'to_url', current: '/mine', incoming: '/dev' }]),
    status: 'open',
    created_at: t0,
  });
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/deploy');
    const section = 'section[x-data="deployPage"]';
    await wait(() => b.$(`${section} #dep-url`));
    await wait(() => b.$$(`${section} select`).length > 5);

    const sel = (table) => b.$(`${section} select[aria-label="What to copy from ${table}"]`);
    assert.equal(sel('menus').value, 'sync', 'what you built syncs by default');
    assert.equal(sel('entries').value, 'skip', 'content is off by default');
    assert.deepEqual(
      [...sel('media').options].map((o) => o.value),
      ['skip', 'add'],
    );

    // Choosing entry_terms lifts entries and terms (a child needs its parents).
    sel('entry_terms').value = 'add';
    sel('entry_terms').dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() => sel('entries').value !== 'skip' && sel('terms').value !== 'skip');

    const save = () => b.button('Save as default');
    await wait(() => !save().disabled);
    b.click(save());
    await until(() => node.ctx.settings.get('deploy.data_selection')?.tables.entry_terms === 'add');
    const saved = node.ctx.settings.get('deploy.data_selection');
    assert.notEqual(saved.tables.entries, 'skip');
    assert.ok(saved.settings.includes('site.theme'));
    await wait(() => save().disabled);

    // The waiting change: tick it and take dev's version.
    const boxSel = `${section} input[aria-label="Select redirects: /old"]`;
    await wait(() => b.$$(boxSel).length === 1);
    assert.match(b.text(), /here \/mine · dev \/dev/);
    assert.equal(b.button("Use dev's version").disabled, true, 'nothing ticked yet');
    const box = b.$(boxSel);
    box.checked = true;
    box.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() => !b.button("Use dev's version").disabled);
    b.click(b.button("Use dev's version"));
    await until(async () => (await node.ctx.db('redirects').first()).to_url === '/dev', {
      timeout: 10000,
    });
    await wait(() => b.$$(boxSel).length === 0);
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
