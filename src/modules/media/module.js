import mediaRoutes from './routes.js';

export default {
  id: 'media',
  label: 'Media',
  description: 'Uploaded files, their metadata and responsive renditions.',
  provides: {
    services: ['media', 'storage'],
    permissions: ['media.read', 'media.upload', 'media.delete'],
    settings: ['media'],
  },
  routes: { admin: [mediaRoutes] },
};
