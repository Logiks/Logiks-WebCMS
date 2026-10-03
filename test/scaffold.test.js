import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldModule } from '../src/core/modules/scaffold.js';

const INDEX = `import a from './a/module.js';

export const builtinModules = [
  a,
];
`;
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-scaffold-'));
  fs.mkdirSync(path.join(root, 'src/modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src/modules/index.js'), INDEX);
  return root;
};

describe('module:new', () => {
  test('writes a manifest, service, route and test, and registers the module', () => {
    const root = project();
    const made = scaffoldModule('news-letter', root);
    assert.deepEqual(made.sort(), [
      'src/modules/index.js',
      'src/modules/news-letter/module.js',
      'src/modules/news-letter/routes.js',
      'src/modules/news-letter/service.js',
      'test/news-letter.test.js',
    ]);
    const mod = fs.readFileSync(path.join(root, 'src/modules/news-letter/module.js'), 'utf8');
    assert.match(mod, /id: 'news-letter'/);
    assert.match(mod, /services: \['newsLetter'\]/);
    assert.match(mod, /ctx\.newsLetter = createNewsLetter\(ctx\)/);
    const index = fs.readFileSync(path.join(root, 'src/modules/index.js'), 'utf8');
    assert.match(index, /import newsLetter from '\.\/news-letter\/module\.js';/);
    assert.match(index, /\n {2}a,\n {2}newsLetter,\n\];/);
    fs.rmSync(root, { recursive: true });
  });

  test('refuses a bad id and never overwrites', () => {
    const root = project();
    assert.throws(() => scaffoldModule('Bad Name', root), /isn't a valid module id/);
    scaffoldModule('thing', root);
    assert.throws(() => scaffoldModule('thing', root), /already exists/);
    fs.rmSync(path.join(root, 'src/modules/thing'), { recursive: true });
    assert.throws(() => scaffoldModule('thing', root), /test\/thing.test.js already exists/);
    fs.rmSync(root, { recursive: true });
  });
});
