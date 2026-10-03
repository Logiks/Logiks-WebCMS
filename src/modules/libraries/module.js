import librariesRoutes from './routes.js';

export default {
  id: 'libraries',
  label: 'Libraries',
  description: 'npm packages installed for the public site.',
  provides: {
    services: ['libraries'],
    permissions: ['libraries.read', 'libraries.manage'],
    settings: ['libraries'],
  },
  routes: { admin: [librariesRoutes] },
};
