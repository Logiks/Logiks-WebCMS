import usersRoutes from './routes.js';

export default {
  id: 'users',
  label: 'Users & roles',
  description: 'Accounts, invitations, roles and the permissions they hold.',
  requires: ['settings'],
  provides: {
    services: ['users', 'access', 'permissions'],
    permissions: ['users.read', 'users.write', 'roles.read', 'roles.write'],
    events: ['user.created'],
  },
  routes: { admin: [usersRoutes] },
};
