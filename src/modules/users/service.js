import { z } from 'zod';
import { dialect, now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import {
  hashPassword,
  needsRehash,
  verifyDummy,
  verifyPassword,
} from '../../core/auth/password.js';

const DEFAULT_ROLES = [
  {
    name: 'Administrator',
    description: 'Full access to everything.',
    permissions: ['*'],
    is_system: true,
  },
  {
    name: 'Viewer',
    description: 'Can sign in and look around, but not change anything.',
    permissions: [
      'admin.access',
      'settings.read',
      'users.read',
      'roles.read',
      'audit.read',
      'cluster.read',
    ],
    is_system: false,
  },
  {
    name: 'Editor',
    description: 'Writes, publishes and organises content, media, menus and redirects.',
    permissions: [
      'admin.access',
      'content.*',
      'media.read',
      'media.upload',
      'media.delete',
      'menus.manage',
      'redirects.manage',
      'themes.read',
      'site.messages',
    ],
    is_system: false,
  },
  {
    name: 'Author',
    description: 'Writes pages and posts as drafts for an editor to publish, and uploads images.',
    permissions: [
      'admin.access',
      'content.page.read',
      'content.page.write',
      'content.post.read',
      'content.post.write',
      'media.read',
      'media.upload',
    ],
    is_system: false,
  },
];

const publicUser = (u) => ({
  id: Number(u.id),
  email: u.email,
  name: u.name,
  roleId: Number(u.role_id),
  role: u.role_name ?? undefined,
  status: u.status,
  lastLoginAt: u.last_login_at ? Number(u.last_login_at) : null,
  lockedUntil: u.locked_until && Number(u.locked_until) > now() ? Number(u.locked_until) : null,
  createdAt: Number(u.created_at),
});
const publicRole = (r, userCount) => ({
  id: Number(r.id),
  name: r.name,
  description: r.description ?? '',
  isSystem: !!r.is_system,
  permissions: JSON.parse(r.permissions),
  ...(userCount !== undefined ? { userCount: Number(userCount) } : {}),
});

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(191);

/** Users, roles and sign-in. */
export function createUsersService({
  db,
  settings,
  access,
  audit,
  permissions,
  sessionStore,
  metrics,
  events,
}) {
  const d = dialect(db);

  function checkPasswordPolicy(password, email) {
    const min = settings.get('security.password_min_length');
    if (typeof password !== 'string' || password.length < min)
      throw new HttpError(
        422,
        'weak_password',
        `Use at least ${min} characters for the password.`,
        { field: 'password' },
      );
    if (password.length > 128)
      throw new HttpError(422, 'weak_password', 'Password is too long (max 128 characters).', {
        field: 'password',
      });
    if (email && password.toLowerCase() === email.toLowerCase())
      throw new HttpError(422, 'weak_password', "Password can't be the same as the email.", {
        field: 'password',
      });
  }

  /** Number of active users whose role grants everything. */
  async function activeAdminCount(exceptUserId) {
    const rows = await db('users as u')
      .join('roles as r', 'r.id', 'u.role_id')
      .where('u.status', 'active')
      .select('u.id', 'r.permissions');
    return rows.filter(
      (r) => Number(r.id) !== exceptUserId && JSON.parse(r.permissions).includes('*'),
    ).length;
  }

  const svc = {
    // ───────── seed ─────────
    async ensureDefaultRoles() {
      for (const r of DEFAULT_ROLES) {
        const exists = await db('roles').where({ name: r.name }).first();
        if (!exists)
          await db('roles').insert({
            ...r,
            permissions: JSON.stringify(r.permissions),
            created_at: now(),
            updated_at: now(),
          });
      }
    },

    async createInitialAdmin({ email, name = 'Administrator', password }) {
      await svc.ensureDefaultRoles();
      const role = await db('roles').where({ name: 'Administrator' }).first();
      return svc.createUser(
        { email, name, password, roleId: Number(role.id), status: 'active' },
        null,
      );
    },

    // ───────── sign-in ─────────
    async authenticate(emailRaw, password, ip) {
      const email = String(emailRaw ?? '')
        .trim()
        .toLowerCase();
      const user = await db('users').where({ email }).first();
      if (!user) {
        await verifyDummy(String(password ?? ''));
        metrics?.logins.inc({ result: 'failure' });
        await audit.log({
          action: 'auth.login_failed',
          meta: { email, reason: 'unknown_user' },
          ip,
        });
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      if (user.locked_until && Number(user.locked_until) > now()) {
        const mins = Math.ceil((Number(user.locked_until) - now()) / 60000);
        metrics?.logins.inc({ result: 'locked' });
        throw new HttpError(
          423,
          'locked',
          `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        );
      }
      const ok = await verifyPassword(user.password_hash, String(password ?? ''));
      if (!ok) {
        const attempts = Number(user.failed_attempts) + 1;
        const lock = attempts >= settings.get('security.max_login_attempts');
        metrics?.logins.inc({ result: lock ? 'locked' : 'failure' });
        await db('users')
          .where({ id: user.id })
          .update({
            failed_attempts: lock ? 0 : attempts,
            locked_until: lock ? now() + settings.get('security.lockout_minutes') * 60000 : null,
          });
        await audit.log({
          actor: { id: Number(user.id), email },
          action: lock ? 'auth.locked' : 'auth.login_failed',
          meta: { attempts },
          ip,
        });
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      if (user.status !== 'active')
        throw new HttpError(
          403,
          'disabled',
          'This account is disabled. Ask an administrator to re-enable it.',
        );

      const patch = { failed_attempts: 0, locked_until: null, last_login_at: now() };
      if (needsRehash(user.password_hash)) patch.password_hash = await hashPassword(password);
      await db('users').where({ id: user.id }).update(patch);
      await audit.log({ actor: { id: Number(user.id), email }, action: 'auth.login', ip });
      metrics?.logins.inc({ result: 'success' });
      return Number(user.id);
    },

    /**
     * Set a user's password (policy-checked), clear lockout, and sign out their sessions.
     * @param {number} userId
     * @param {string} password
     * @param {{actor?: any, ip?: string, action?: string, exceptSid?: string}} [opts]
     */
    async setPassword(
      userId,
      password,
      { actor = null, ip, action = 'auth.password_changed', exceptSid } = {},
    ) {
      const user = await db('users').where({ id: userId }).first();
      if (!user) throw notFound('User');
      checkPasswordPolicy(password, user.email);
      await db('users')
        .where({ id: userId })
        .update({
          password_hash: await hashPassword(password),
          failed_attempts: 0,
          locked_until: null,
          updated_at: now(),
        });
      const revoked = await sessionStore.destroyForUser(userId, exceptSid);
      await audit.log({
        actor: actor ?? { id: userId, email: user.email },
        action,
        entity: 'user',
        entityId: userId,
        ip,
        meta: { sessionsRevoked: Number(revoked) },
      });
      return { user, revoked: Number(revoked) };
    },

    checkPasswordPolicy,

    /** Change your own password. Every other session is signed out; the current one stays. */
    async changeOwnPassword(userId, current, next, ip, currentSid) {
      const user = await db('users').where({ id: userId }).first();
      if (!(await verifyPassword(user.password_hash, String(current ?? ''))))
        throw new HttpError(422, 'invalid_credentials', 'Current password is incorrect.', {
          field: 'current',
        });
      if (current === next)
        throw new HttpError(422, 'weak_password', 'Choose a password you have not used just now.', {
          field: 'next',
        });
      return svc.setPassword(userId, next, { ip, exceptSid: currentSid });
    },

    /** Change your own display name. (Email and role are administrator-only.) */
    async updateOwnName(userId, nameRaw, actor) {
      const name = String(nameRaw ?? '').trim();
      if (!name || name.length > 128)
        throw new HttpError(422, 'invalid_input', 'Enter a name up to 128 characters.', {
          field: 'name',
        });
      await db('users').where({ id: userId }).update({ name, updated_at: now() });
      await audit.log({
        actor: actor ?? { id: userId },
        action: 'auth.profile_updated',
        entity: 'user',
        entityId: userId,
      });
      await access.invalidate(); // the cached principal carries the name
      return name;
    },

    /** Sign a user out everywhere (or everywhere except one session). */
    async revokeSessions(userId, exceptSid) {
      return Number(await sessionStore.destroyForUser(userId, exceptSid));
    },

    // ───────── users ─────────
    async listUsers() {
      const rows = await db('users as u')
        .join('roles as r', 'r.id', 'u.role_id')
        .select('u.*', 'r.name as role_name')
        .orderBy('u.id');
      return rows.map(publicUser);
    },

    async getUser(id) {
      const u = await db('users as u')
        .join('roles as r', 'r.id', 'u.role_id')
        .where('u.id', id)
        .select('u.*', 'r.name as role_name')
        .first();
      if (!u) throw notFound('User');
      return publicUser(u);
    },

    async createUser({ email, name, password, roleId, status = 'active' }, actor) {
      email = emailSchema.parse(email);
      checkPasswordPolicy(password, email);
      if (!(await db('roles').where({ id: roleId }).first()))
        throw new HttpError(422, 'invalid_input', 'Choose a valid role.', { field: 'roleId' });
      if (await db('users').where({ email }).first())
        throw new HttpError(409, 'email_taken', 'A user with this email already exists.', {
          field: 'email',
        });
      const id = await d.insertGetId(db('users'), {
        email,
        name,
        password_hash: await hashPassword(password),
        role_id: roleId,
        status,
        created_at: now(),
        updated_at: now(),
      });
      await audit.log({
        actor,
        action: 'user.create',
        entity: 'user',
        entityId: id,
        meta: { email, roleId },
      });
      await events().emit('user.created', { id, email });
      return svc.getUser(id);
    },

    async updateUser(id, patch, actor) {
      const user = await db('users').where({ id }).first();
      if (!user) throw notFound('User');
      const row = { updated_at: now() };
      const meta = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.email !== undefined) {
        const email = emailSchema.parse(patch.email);
        const clash = await db('users').where({ email }).whereNot({ id }).first();
        if (clash)
          throw new HttpError(409, 'email_taken', 'A user with this email already exists.', {
            field: 'email',
          });
        row.email = email;
        meta.email = email;
      }
      if (patch.roleId !== undefined && patch.roleId !== Number(user.role_id)) {
        if (!(await db('roles').where({ id: patch.roleId }).first()))
          throw new HttpError(422, 'invalid_input', 'Choose a valid role.', { field: 'roleId' });
        row.role_id = patch.roleId;
        meta.roleId = patch.roleId;
      }
      if (patch.status !== undefined && patch.status !== user.status) {
        row.status = patch.status;
        meta.status = patch.status;
        if (patch.status === 'active')
          Object.assign(row, { failed_attempts: 0, locked_until: null });
      }
      if (patch.unlock) Object.assign(row, { failed_attempts: 0, locked_until: null });
      if (patch.password) {
        checkPasswordPolicy(patch.password, row.email ?? user.email);
        row.password_hash = await hashPassword(patch.password);
        meta.passwordReset = true;
      }
      // Never lock everyone out: the last active administrator can't be demoted or disabled, and you can't disable yourself.
      const losesAdmin = row.role_id !== undefined || row.status === 'disabled';
      if (losesAdmin) {
        if (actor?.id === id && row.status === 'disabled')
          throw new HttpError(409, 'self_disable', "You can't disable your own account.");
        const wasAdmin =
          JSON.parse((await db('roles').where({ id: user.role_id }).first()).permissions).includes(
            '*',
          ) && user.status === 'active';
        const stillAdmin =
          row.role_id === undefined
            ? row.status !== 'disabled'
            : JSON.parse(
                (await db('roles').where({ id: row.role_id }).first()).permissions,
              ).includes('*') && (row.status ?? user.status) === 'active';
        if (wasAdmin && !stillAdmin && (await activeAdminCount(id)) === 0)
          throw new HttpError(
            409,
            'last_admin',
            'This is the last active administrator. Make someone else an administrator first.',
          );
      }
      await db('users').where({ id }).update(row);
      if (row.password_hash || row.status === 'disabled') await sessionStore.destroyForUser(id);
      await audit.log({ actor, action: 'user.update', entity: 'user', entityId: id, meta });
      await access.invalidate();
      return svc.getUser(id);
    },

    async deleteUser(id, actor) {
      const user = await db('users').where({ id }).first();
      if (!user) throw notFound('User');
      if (actor?.id === id)
        throw new HttpError(409, 'self_delete', "You can't delete your own account.");
      const role = await db('roles').where({ id: user.role_id }).first();
      if (
        JSON.parse(role.permissions).includes('*') &&
        user.status === 'active' &&
        (await activeAdminCount(id)) === 0
      ) {
        throw new HttpError(
          409,
          'last_admin',
          "This is the last active administrator and can't be deleted.",
        );
      }
      await sessionStore.destroyForUser(id);
      await db('users').where({ id }).del();
      await audit.log({
        actor,
        action: 'user.delete',
        entity: 'user',
        entityId: id,
        meta: { email: user.email },
      });
      await access.invalidate();
    },

    // ───────── roles ─────────
    async listRoles() {
      const rows = await db('roles').orderBy('id');
      const counts = await db('users').select('role_id').count({ n: '*' }).groupBy('role_id');
      const byRole = new Map(counts.map((c) => [Number(c.role_id), Number(c.n)]));
      return rows.map((r) => publicRole(r, byRole.get(Number(r.id)) ?? 0));
    },

    _checkPerms(perms) {
      const bad = perms.filter((p) => !permissions.isValid(p));
      if (bad.length)
        throw new HttpError(422, 'invalid_input', `Unknown permission: ${bad[0]}`, {
          field: 'permissions',
        });
      return [...new Set(perms)].sort();
    },

    async createRole({ name, description = '', permissions: perms }, actor) {
      if (await db('roles').where({ name }).first())
        throw new HttpError(409, 'name_taken', 'A role with this name already exists.', {
          field: 'name',
        });
      const list = svc._checkPerms(perms);
      const id = await d.insertGetId(db('roles'), {
        name,
        description,
        is_system: false,
        permissions: JSON.stringify(list),
        created_at: now(),
        updated_at: now(),
      });
      await audit.log({
        actor,
        action: 'role.create',
        entity: 'role',
        entityId: id,
        meta: { name, permissions: list },
      });
      return publicRole(await db('roles').where({ id }).first(), 0);
    },

    async updateRole(id, patch, actor) {
      const role = await db('roles').where({ id }).first();
      if (!role) throw notFound('Role');
      const row = { updated_at: now() };
      if (patch.name !== undefined && patch.name !== role.name) {
        if (role.is_system)
          throw new HttpError(409, 'system_role', "System roles can't be renamed.");
        if (await db('roles').where({ name: patch.name }).whereNot({ id }).first())
          throw new HttpError(409, 'name_taken', 'A role with this name already exists.', {
            field: 'name',
          });
        row.name = patch.name;
      }
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.permissions !== undefined) {
        if (role.is_system)
          throw new HttpError(
            409,
            'system_role',
            "The permissions of a system role can't be changed.",
          );
        const list = svc._checkPerms(patch.permissions);
        if (JSON.parse(role.permissions).includes('*') && !list.includes('*')) {
          const others = await db('users as u')
            .join('roles as r', 'r.id', 'u.role_id')
            .where('u.status', 'active')
            .whereNot('r.id', id)
            .select('r.permissions');
          if (!others.some((r) => JSON.parse(r.permissions).includes('*')))
            throw new HttpError(409, 'last_admin', 'That would leave nobody with full access.');
        }
        row.permissions = JSON.stringify(list);
      }
      await db('roles').where({ id }).update(row);
      await audit.log({
        actor,
        action: 'role.update',
        entity: 'role',
        entityId: id,
        meta: {
          name: row.name,
          permissions: row.permissions ? JSON.parse(row.permissions) : undefined,
        },
      });
      await access.invalidate();
      return publicRole(await db('roles').where({ id }).first());
    },

    async deleteRole(id, actor) {
      const role = await db('roles').where({ id }).first();
      if (!role) throw notFound('Role');
      if (role.is_system) throw new HttpError(409, 'system_role', "System roles can't be deleted.");
      const [{ n }] = await db('users').where({ role_id: id }).count({ n: '*' });
      if (Number(n) > 0)
        throw new HttpError(
          409,
          'role_in_use',
          `${n} user${Number(n) === 1 ? ' still has' : 's still have'} this role. Move them to another role first.`,
        );
      await db('roles').where({ id }).del();
      await audit.log({
        actor,
        action: 'role.delete',
        entity: 'role',
        entityId: id,
        meta: { name: role.name },
      });
      await access.invalidate();
    },
  };
  return svc;
}
