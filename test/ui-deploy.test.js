import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

test('Deploy screen: sits below Updates, saves the repository, deploys and lists the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-uidep-'));
  const app = path.join(root, 'app');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"p"}');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });

  const node = await startNode({ seed: true, appRoot: app });
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.click(b.button('Operations'));
    await wait(() => b.$$('.nav-sub-link').some((a) => a.textContent.trim() === 'Deploy'));
    const links = b.$$('.nav-sub-link').map((a) => a.textContent.trim());
    assert.equal(links.indexOf('Deploy'), links.indexOf('Updates') + 1, links.join('|'));
    b.click(b.$$('.nav-sub-link').find((a) => a.textContent.trim() === 'Deploy'));

    const section = 'section[x-data="deployPage"]';
    await wait(() => b.$(`${section} #dep-url`));
    assert.equal(b.button('Deploy').disabled, true, 'no repository yet');
    b.type(b.$(`${section} #dep-url`), origin);
    await wait(() => !b.button('Save').disabled);
    b.click(b.button('Save'));
    await until(() => node.ctx.settings.get('deploy.repo_url') === origin);
    await wait(() => !b.button('Deploy').disabled);

    b.click(b.button('Deploy'));
    await wait(() => b.$$(`${section} table .tag`).some((t) => t.textContent.trim() === 'done'));
    assert.match(
      execFileSync('git', ['ls-remote', '--heads', origin], { encoding: 'utf8' }),
      /refs\/heads\/main/,
    );
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
