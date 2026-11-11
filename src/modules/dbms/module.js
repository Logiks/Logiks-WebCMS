import dbmsRoutes from './routes.js';
import { createDbOps } from './ops.js';
import { createDbmsTransfer } from './transfer.js';

export default {
  id: 'dbms',
  label: 'Database',
  optional: true,
  description: 'Browse, edit and query the database; its health; and erase data with a copy kept.',
  provides: {
    services: ['dbms', 'dbMover', 'dbOps', 'dbTransfer'],
    permissions: ['dbms.read', 'dbms.write', 'dbms.query', 'dbms.migrate', 'dbms.flush'],
  },
  create(ctx) {
    ctx.dbOps = createDbOps(ctx);
    ctx.dbTransfer = createDbmsTransfer(ctx);
  },
  routes: { admin: [dbmsRoutes] },
};
