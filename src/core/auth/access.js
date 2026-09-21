/**
 * Loads the signed-in principal (user + role permissions) for a session.
 * Cached briefly per node; role/user edits publish `rbac:changed` so every node drops its cache
 * at once (the short TTL covers a missed message).
 */
export function createAccess({ db, bus, permissions, log }) {
  const TTL_MS = 15_000;
  const cache = new Map(); // userId -> { at, principal }

  bus
    .subscribe('rbac:changed', () => cache.clear())
    .catch((e) => log.error({ err: e.message }, 'rbac subscribe failed'));

  return {
    async principal(userId) {
      const hit = cache.get(userId);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.principal;
      const row = await db('users as u')
        .join('roles as r', 'r.id', 'u.role_id')
        .where('u.id', userId)
        .select(
          'u.id',
          'u.email',
          'u.name',
          'u.status',
          'u.role_id',
          'r.name as role_name',
          'r.permissions',
        )
        .first();
      const principal =
        row && row.status === 'active'
          ? {
              id: Number(row.id),
              email: row.email,
              name: row.name,
              roleId: Number(row.role_id),
              role: row.role_name,
              permissions: JSON.parse(row.permissions),
              can(p) {
                return permissions.matches(this.permissions, p);
              },
            }
          : null;
      cache.set(userId, { at: Date.now(), principal });
      return principal;
    },
    /** Call after any user/role change. */
    async invalidate() {
      cache.clear();
      await bus.publish('rbac:changed', {}).catch(() => {});
    },
  };
}
