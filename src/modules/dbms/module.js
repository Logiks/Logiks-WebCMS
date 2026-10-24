import dbmsRoutes from './routes.js';
import { createDbOps } from './ops.js';

export default {
  id: 'dbms',
  label: 'Database',
  optional: true,
  description: 'Browse, edit and query the database; its health; and erase data with a copy kept.',
  provides: {
    services: ['dbms', 'dbMover', 'dbOps'],
    permissions: ['dbms.read', 'dbms.write', 'dbms.query', 'dbms.migrate', 'dbms.flush'],
  },
  create(ctx) {
    ctx.dbOps = createDbOps(ctx);
  },
  routes: { admin: [dbmsRoutes] },
};
