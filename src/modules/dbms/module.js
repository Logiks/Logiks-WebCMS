import dbmsRoutes from './routes.js';

export default {
  id: 'dbms',
  label: 'Database',
  optional: true,
  description: 'Browse, edit and query the database.',
  provides: { services: ['dbms'], permissions: ['dbms.read', 'dbms.write', 'dbms.query'] },
  routes: { admin: [dbmsRoutes] },
};
