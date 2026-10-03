import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const camel = (/** @type {string} */ id) => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const title = (/** @type {string} */ id) =>
  id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * `npm run cli -- module:new <id>`: the smallest module that boots, with a route, a service, permissions and a test, and a
 * line in src/modules/index.js (D-067). Refuses to overwrite anything.
 * @param {string} id @param {string} root the project root
 * @returns {string[]} the files written (relative to root)
 */
export function scaffoldModule(id, root) {
  if (!ID.test(id))
    throw new Error(
      `"${id}" isn't a valid module id. Use lowercase letters, numbers and hyphens, starting with a letter (for example: newsletter).`,
    );
  const dir = path.join(root, 'src/modules', id);
  const testFile = path.join(root, 'test', `${id}.test.js`);
  const indexFile = path.join(root, 'src/modules/index.js');
  if (fs.existsSync(dir)) throw new Error(`src/modules/${id}/ already exists. Pick another id.`);
  if (fs.existsSync(testFile))
    throw new Error(`test/${id}.test.js already exists. Pick another id.`);
  const index = fs.readFileSync(indexFile, 'utf8');
  const key = camel(id);
  if (new RegExp(`\\b${key}\\b`).test(index))
    throw new Error(`src/modules/index.js already uses the name "${key}". Pick another id.`);
  if (!index.includes('\n];'))
    throw new Error('src/modules/index.js has a shape the scaffolder does not recognise.');
  const label = title(id);
  const Factory = `create${key[0].toUpperCase()}${key.slice(1)}`;

  const files = {
    [path.join(dir, 'service.js')]: `/**
 * ${label}. A service is a plain factory: it takes what it needs and returns an object. context.js wires it (through
 * this module's module.js), so it can talk to the rest of the platform through \`ctx\` and the bus.
 * @param {any} ctx
 */
export function ${Factory}(ctx) {
  const { settings } = ctx;
  void settings;
  return {
    /** Replace with what ${label} actually does. */
    status() {
      return { ok: true };
    },
  };
}
`,
    [path.join(dir, 'routes.js')]: `import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

/** ${label}: admin routes, mounted under /api/admin. Every route names the permission it needs. */
export default function ${key}Routes(ctx) {
  const r = Router();

  r.get('/${id}', requirePermission('${id}.read'), (_req, res) => {
    res.json(ctx.${key}.status());
  });

  return r;
}
`,
    [path.join(dir, 'module.js')]: `import routes from './routes.js';
import { ${Factory} } from './service.js';

export default {
  id: '${id}',
  label: '${label}',
  description: 'What ${label} is for, in one sentence.',
  // Modules that must be built first. The registry orders everything by this.
  requires: [],
  provides: {
    services: ['${key}'],
    permissions: ['${id}.read', '${id}.write'],
    // settings: ['${key}'],      namespaces you define in the settings registry
    // jobs: ['${id}.cleanup'],   jobs you define with ctx.jobs.define()
    // events: ['${id}.created'], events you emit with ctx.events.emit()
    // api: [],                   public API operations (see docs/MODULES.md)
  },
  create(ctx) {
    ctx.permissions.define('${label}', {
      '${id}.read': 'View ${label}',
      '${id}.write': 'Change ${label}',
    });
    ctx.${key} = ${Factory}(ctx);
  },
  routes: { admin: [routes] },
};
`,
    [testFile]: `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

test('${id} is registered, builds its service and guards its route', async () => {
  assert.ok(node.ctx.modules.has('${id}'));
  assert.deepEqual(node.ctx.${key}.status(), { ok: true });
  assert.equal((await admin.get('/api/admin/${id}')).status, 200);
  assert.equal((await request(node.app).get('/api/admin/${id}')).status, 401);
});
`,
  };

  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files))
    fs.writeFileSync(file, content, { flag: 'wx' });
  const imp = `import ${key} from './${id}/module.js';\n`;
  const imports = [...index.matchAll(/^import .*;\n/gm)];
  const last = imports[imports.length - 1];
  const at = (last?.index ?? 0) + (last?.[0].length ?? 0);
  const next = index.slice(0, at) + imp + index.slice(at);
  fs.writeFileSync(indexFile, next.replace('\n];', `\n  ${key},\n];`));
  return [...Object.keys(files), indexFile].map((f) => path.relative(root, f));
}
