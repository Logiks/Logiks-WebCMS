import themesRoutes from './routes.js';

export default {
  id: 'themes',
  label: 'Themes',
  description: 'The frame around the site: layouts, styles and theme options.',
  provides: {
    services: ['themes'],
    permissions: ['themes.read', 'themes.manage', 'themes.edit', 'themes.customize'],
    settings: ['themes'],
  },
  routes: { admin: [themesRoutes] },
};
