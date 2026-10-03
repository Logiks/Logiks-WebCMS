import settingsRoutes from './routes.js';

export default {
  id: 'settings',
  label: 'Settings',
  description: 'Every admin-editable setting, declared in code and stored in the database.',
  provides: {
    services: ['settings', 'registry'],
    permissions: ['settings.read', 'settings.write', 'settings.secrets.write'],
    settings: ['general', 'security', 'login', 'mail', 'features', 'system'],
  },
  routes: { admin: [settingsRoutes] },
};
