#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `
CMS command line

  setup [--email a@b.com] [--password ...]   create .env, run migrations, seed roles, create the first admin
  migrate | migrate:rollback | migrate:status

  config:list [namespace]                    show effective settings (secrets masked)
  config:get <ns.key>
  config:set <ns.key> <value>                value is parsed as JSON when possible (true, 42, ["a"]) else string
  config:reset <ns.key>                      revert to the default

  module:new <id>                            scaffold a module (manifest, service, route, test) and register it
  module:list                                list the built-in modules and what they need

  search:reindex                             rebuild the site search index from published content

  site:seed [--force]                        load the starter pages and components (only into an empty site unless --force)
  site:list                                  list the pages and components in the site tree
  site:pull [dir]                            write the site tree to a folder (default ./public)
  site:push [dir] [--prune]                  read pages/ and components/ from a folder into the site (default ./public);
                                             --prune also deletes site files that are not in the folder

  user:create --email a@b.com --name "A B" --role Administrator [--password ...]
  user:reset-password <email> [--password ...]
  user:unlock <email>

Config changes made here are published to running servers (via Redis when configured;
otherwise they are picked up by the periodic poll).
`;

function args(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--'))
      flags[argv[i].slice(2)] =
        argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

const randomPassword = () => randomBytes(12).toString('base64url');

function writeEnvIfMissing() {
  const target = path.join(ROOT, '.env');
  if (fs.existsSync(target)) return false;
  const tpl = fs
    .readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    .replace(/^APP_MASTER_KEY=.*$/m, `APP_MASTER_KEY=${randomBytes(32).toString('base64')}`);
  fs.writeFileSync(target, tpl, { mode: 0o600 });
  return true;
}

async function main() {
  process.env.LOG_LEVEL = process.env.CLI_LOG_LEVEL || 'warn';
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  // In containers the key comes from the environment; only create a .env when it doesn't.
  if (cmd === 'setup' && !process.env.APP_MASTER_KEY && writeEnvIfMissing()) {
    console.log(
      'Created .env with a new APP_MASTER_KEY. Back this key up: encrypted settings cannot be read without it.',
    );
    (await import('dotenv')).config({ path: path.join(ROOT, '.env'), override: false });
  }

  // Modules (D-067): scaffolding writes files and needs no database; listing only reads the manifests.
  if (cmd === 'module:new') {
    if (!pos[0]) throw new Error('Say which module to create: npm run cli -- module:new <id>');
    const { scaffoldModule } = await import('../core/modules/scaffold.js');
    const made = scaffoldModule(pos[0], ROOT);
    console.log(
      `Created module "${pos[0]}":\n  ${made.join('\n  ')}\nRun: node --test test/${pos[0]}.test.js`,
    );
    return;
  }
  if (cmd === 'module:list') {
    const { builtinModules } = await import('../modules/index.js');
    const { createModuleRegistry } = await import('../core/modules/registry.js');
    const reg = createModuleRegistry();
    reg.registerAll(builtinModules);
    for (const id of reg.ids()) {
      const m = /** @type {any} */ (reg.get(id));
      console.log(
        `${id.padEnd(16)} ${m.label}${m.requires.length ? `  (needs ${m.requires.join(', ')})` : ''}`,
      );
    }
    return;
  }

  const { loadEnv } = await import('../core/env.js');
  const env = loadEnv();

  // Lightweight path for migrations: no settings/bus needed.
  if (cmd.startsWith('migrate')) {
    const { createDb } = await import('../core/db/index.js');
    const db = createDb(env);
    try {
      if (cmd === 'migrate') {
        const [batch, done] = await db.migrate.latest();
        console.log(
          done.length
            ? `Batch ${batch}: applied ${done.length} migration(s)\n  ${done.join('\n  ')}`
            : 'Database is up to date.',
        );
      } else if (cmd === 'migrate:rollback') {
        const [batch, done] = await db.migrate.rollback();
        console.log(`Rolled back batch ${batch}: ${done.join(', ') || 'nothing to roll back'}`);
      } else if (cmd === 'migrate:status') {
        const [done, pending] = await db.migrate.list();
        console.log(`applied: ${done.length}, pending: ${pending.length}`);
        for (const p of pending) console.log(`  pending  ${p.file ?? p.name}`);
      }
    } finally {
      await db.destroy();
    }
    return;
  }

  const { createContext } = await import('../context.js');
  const ctx = await createContext({ env });
  try {
    switch (cmd) {
      case 'setup': {
        await ctx.users.ensureDefaultRoles();
        const [{ n }] = await ctx.db('users').count({ n: '*' });
        if (Number(n) === 0) {
          // A brand-new installation only: site pages win over content pages, so never seed a site that is already in use.
          await ctx.siteFiles.seedDefaults(path.join(ROOT, 'site', 'defaults'), null);
          // Subsystems are opt-in on a new install (Settings → Features, D-100). Existing installs keep the blog they have.
          await ctx.settings.update('featureset', { values: { enabled: [] } }, null, {
            internal: true,
          });
          const email = flags.email || process.env.ADMIN_EMAIL || 'admin@example.com';
          const password = flags.password || process.env.ADMIN_PASSWORD || randomPassword();
          await ctx.users.createInitialAdmin({ email, password });
          console.log(
            `\nAdmin created\n  email:    ${email}\n  password: ${password}\n${flags.password || process.env.ADMIN_PASSWORD ? '' : '  (generated — shown once; change it after signing in)\n'}`,
          );
        } else console.log('Users already exist; skipping admin creation.');
        console.log(
          'Setup complete. Start the server with: npm start   then open http://localhost:' +
            env.PORT +
            '/admin',
        );
        break;
      }
      case 'site:seed': {
        const r = await ctx.siteFiles.seedDefaults(path.join(ROOT, 'site', 'defaults'), null, {
          force: Boolean(flags.force),
        });
        console.log(
          r.skipped
            ? 'The site already has pages or components; nothing seeded (use --force to import anyway).'
            : `Seeded ${r.written} file(s)${r.errors.length ? `, ${r.errors.length} failed` : ''}.`,
        );
        for (const e of r.errors) console.log(`  ✖ ${e.message}`);
        break;
      }
      case 'site:list': {
        for (const f of ctx.siteFiles.list())
          console.log(`${f.kind.padEnd(9)} ${f.path}  (${f.size} bytes)`);
        break;
      }
      case 'site:pull': {
        const dir = path.resolve(pos[0] || ctx.env.SITE_DIR);
        const r = await ctx.siteFiles.exportTo(dir);
        console.log(`Wrote ${r.files} file(s) to ${dir}`);
        break;
      }
      case 'site:push': {
        const dir = path.resolve(pos[0] || ctx.env.SITE_DIR);
        const r = await ctx.siteFiles.importFrom(dir, null, { prune: Boolean(flags.prune) });
        console.log(
          `Saved ${r.written} changed file(s), ${r.unchanged} unchanged${r.removed ? `, deleted ${r.removed}` : ''}.`,
        );
        for (const e of r.errors) console.log(`  ✖ ${e.message}`);
        if (r.errors.length) process.exitCode = 1;
        break;
      }
      case 'search:reindex': {
        const n = await ctx.search.reindex();
        console.log(`Indexed ${n} published entr${n === 1 ? 'y' : 'ies'}.`);
        break;
      }
      case 'config:list': {
        for (const v of ctx.settings
          .describeAll()
          .filter((d) => !pos[0] || d.namespace === pos[0])) {
          console.log(`\n[${v.namespace}] ${v.title}`);
          for (const f of v.fields) {
            const s = v.state[f.key];
            const shown = f.secret ? (s.isSet ? '••••••' : '(not set)') : JSON.stringify(s.value);
            console.log(
              `  ${v.namespace}.${f.key} = ${shown}  ${s.source !== 'default' ? `[${s.source}]` : ''}`,
            );
          }
        }
        break;
      }
      case 'config:get': {
        const [ns, key] = String(pos[0]).split('.');
        const f = ctx.registry.field(ns, key);
        console.log(f.secret ? '(secret — not printed)' : JSON.stringify(ctx.settings.get(pos[0])));
        break;
      }
      case 'config:set': {
        const [ns, key] = String(pos[0]).split('.');
        let value = pos.slice(1).join(' ');
        try {
          value = JSON.parse(value);
        } catch {
          /* keep string */
        }
        const out = await ctx.settings.update(ns, { values: { [key]: value } }, null);
        console.log(
          out.changed.length ? `Updated ${pos[0]} (config version ${out.version}).` : 'No change.',
        );
        break;
      }
      case 'config:reset': {
        const [ns, key] = String(pos[0]).split('.');
        const out = await ctx.settings.update(ns, { reset: [key] }, null);
        console.log(
          out.changed.length
            ? `Reset ${pos[0]} to default (config version ${out.version}).`
            : 'Already at default.',
        );
        break;
      }
      case 'user:create': {
        const role = await ctx
          .db('roles')
          .where({ name: flags.role || 'Administrator' })
          .first();
        if (!role) throw new Error(`Unknown role "${flags.role}"`);
        const password = flags.password || randomPassword();
        const u = await ctx.users.createUser(
          {
            email: flags.email,
            name: flags.name || flags.email,
            password,
            roleId: Number(role.id),
          },
          null,
        );
        console.log(
          `Created ${u.email} (${u.role}).${flags.password ? '' : ` Password: ${password}`}`,
        );
        break;
      }
      case 'user:reset-password':
      case 'user:unlock': {
        const u = await ctx
          .db('users')
          .where({ email: String(pos[0]).toLowerCase() })
          .first();
        if (!u) throw new Error('No such user');
        if (cmd === 'user:unlock') {
          await ctx.users.updateUser(Number(u.id), { unlock: true }, null);
          console.log('Unlocked.');
        } else {
          const password = flags.password || randomPassword();
          await ctx.users.updateUser(Number(u.id), { password }, null);
          console.log(`Password reset.${flags.password ? '' : ` New password: ${password}`}`);
        }
        break;
      }
      default:
        console.log(`Unknown command "${cmd}".\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    await ctx.shutdown();
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
