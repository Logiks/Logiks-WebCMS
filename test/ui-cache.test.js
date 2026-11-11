import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

test('System → Cache: clear pages, switch caching off and on', async () => {
  const node = await startNode({ seed: true });
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.click(b.button('System'));
    await wait(() => b.$$('.nav-sub-link').some((a) => a.textContent.trim() === 'Cache'));
    b.click(b.$$('.nav-sub-link').find((a) => a.textContent.trim() === 'Cache'));
    const section = 'section[x-data="cachePage"]';
    await wait(() => b.$(`${section} [data-clear="pages"]`));
    assert.equal(b.visible(b.$(`${section} [data-off]`)), false, 'no warning while it is on');

    b.click(b.$(`${section} [data-clear="pages"]`));
    await wait(() => /Cleared: Rendered pages/.test(b.text()));

    const sw = b.$(`${section} #cache-on`);
    sw.checked = false;
    sw.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await until(() => node.ctx.settings.get('cache.enabled') === false);
    await wait(() => b.visible(b.$(`${section} [data-off]`)));

    sw.checked = true;
    sw.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await until(() => node.ctx.settings.get('cache.enabled') === true);
    await wait(() => !b.visible(b.$(`${section} [data-off]`)));
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
