import backupRoutes from './routes.js';
import { createBackup } from './service.js';

export default {
  id: 'backup',
  label: 'Backups',
  optional: true,
  description:
    'Back up the database and uploaded files, download the backup, and restore it here or on another server.',
  provides: {
    services: ['backup'],
    permissions: ['backup.read', 'backup.create', 'backup.restore'],
  },
  create(ctx) {
    ctx.backup = createBackup(ctx);
  },
  routes: { admin: [backupRoutes] },
};
