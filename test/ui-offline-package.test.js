import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

test('Deploy screen offers an offline package: build it, see it listed with a download link, and read how to install it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-uioff-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"f","version":"3.1.0"}\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  const node = await startNode({ seed: true, appRoot: root });
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/deploy');
    const section = 'section[x-data="deployPage"]';
    // No repository is set: a package does not need one.
    await wait(() => b.$(`${section} [data-build-package]`));
    const button = b.$(`${section} [data-build-package]`);
    assert.equal(button.disabled, false, 'building a package needs no git repository');
    assert.ok(b.$(`${section} [data-nm]`), 'node_modules can be included');
    assert.match(b.$(`${section} [data-packages]`).textContent, /None built yet/);

    // Built here, the same way the button does it, then the screen lists it.
    await node.ctx.deploy.start({ package: true, data: false, media: false, bump: 'minor' }, null);
    await node.ctx.deploy.idle();
    await wait(() => /cms-3\.2\.0\.zip/.test(b.$(`${section} [data-packages]`).textContent));
    const link = [...b.$(`${section} [data-packages]`).querySelectorAll('a')].find((a) =>
      /cms-3\.2\.0\.zip/.test(a.textContent),
    );
    assert.equal(link.getAttribute('href'), '/api/admin/deploy/packages/cms-3.2.0.zip');
    assert.match(b.$(`${section} [data-packages]`).textContent, /package:apply/);
    assert.match(b.$(`${section} [data-packages]`).textContent, /package:import/);
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
