import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { docs } from '../../core/http/docs.js';

const name = z.string().trim().min(1, 'Required').max(128);
const createUser = z.object({
  email: z.string(),
  name,
  password: z.string(),
  roleId: z.number().int(),
  status: z.enum(['active', 'disabled']).optional(),
});
const inviteUser = z.object({ email: z.string(), name, roleId: z.number().int() });
const patchUser = z.object({
  email: z.string().optional(),
  name: name.optional(),
  roleId: z.number().int().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: z.string().optional(),
  unlock: z.boolean().optional(),
});
const roleName = z.string().trim().min(2, 'Use at least 2 characters').max(64);
const createRole = z.object({
  name: roleName,
  description: z.string().max(255).optional(),
  permissions: z.array(z.string()),
});
const patchRole = z.object({
  name: roleName.optional(),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string()).optional(),
});

const id = (req) => Number(req.params.id);

export default function usersRoutes(ctx) {
  const r = Router();
  const { users } = ctx;

  r.get('/users', requirePermission('users.read'), async (_req, res) =>
    res.json({ users: await users.listUsers() }),
  );
  r.post('/users', requirePermission('users.write'), docs({ body: createUser }), async (req, res) =>
    res.status(201).json(await users.createUser(parse(createUser, req.body), actorOf(req))),
  );

  // Invitations: the account is created with a random password nobody knows; the emailed link lets its owner choose one.
  const needMail = () => {
    if (!ctx.mailer.enabled())
      throw new HttpError(
        409,
        'mail_not_configured',
        'Email is not set up yet. Configure it under Settings → Email, or create the user with a password.',
      );
  };
  r.post(
    '/users/invite',
    requirePermission('users.write'),
    docs({ body: inviteUser }),
    async (req, res) => {
      needMail();
      const body = parse(inviteUser, req.body);
      const actor = actorOf(req);
      const user = await users.createUser(
        { ...body, password: randomBytes(32).toString('base64url') },
        actor,
      );
      await ctx.recovery.invite(user.id, { invitedBy: actor, ip: req.ip });
      res.status(201).json(user);
    },
  );
  r.post(
    '/users/:id/resend-invite',
    requirePermission('users.write'),
    docs({ noBody: true }),
    async (req, res) => {
      needMail();
      await ctx.recovery.invite(id(req), { invitedBy: actorOf(req), ip: req.ip });
      res.json({ ok: true });
    },
  );
  r.patch(
    '/users/:id',
    requirePermission('users.write'),
    docs({ body: patchUser }),
    async (req, res) =>
      res.json(await users.updateUser(id(req), parse(patchUser, req.body), actorOf(req))),
  );
  r.delete('/users/:id', requirePermission('users.write'), async (req, res) => {
    await users.deleteUser(id(req), actorOf(req));
    res.status(204).end();
  });

  r.post(
    '/users/:id/revoke-sessions',
    requirePermission('users.write'),
    docs({ noBody: true }),
    async (req, res) => {
      const revoked = await users.revokeSessions(id(req));
      await ctx.audit.log({
        actor: actorOf(req),
        action: 'user.sessions_revoked',
        entity: 'user',
        entityId: id(req),
        meta: { count: revoked },
      });
      res.json({ revoked });
    },
  );

  r.get('/roles', requirePermission('roles.read'), async (_req, res) =>
    res.json({ roles: await users.listRoles() }),
  );
  r.get('/permissions', requirePermission('roles.read'), (_req, res) =>
    res.json({ groups: ctx.permissions.all() }),
  );
  r.post('/roles', requirePermission('roles.write'), docs({ body: createRole }), async (req, res) =>
    res.status(201).json(await users.createRole(parse(createRole, req.body), actorOf(req))),
  );
  r.patch(
    '/roles/:id',
    requirePermission('roles.write'),
    docs({ body: patchRole }),
    async (req, res) =>
      res.json(await users.updateRole(id(req), parse(patchRole, req.body), actorOf(req))),
  );
  r.delete('/roles/:id', requirePermission('roles.write'), async (req, res) => {
    await users.deleteRole(id(req), actorOf(req));
    res.status(204).end();
  });

  return r;
}
