import mediaGeneratorRoutes from './routes.js';
import { createMediaGenerator } from './service.js';

export default {
  id: 'media-generator',
  label: 'Media Generator',
  optional: true,
  description: 'Generate images with an AI provider and save them to the media library.',
  requires: ['media'],
  provides: {
    services: ['mediaGenerator'],
    permissions: ['media.upload'],
    settings: ['media_generator'],
  },
  create(ctx) {
    ctx.mediaGenerator = createMediaGenerator(ctx);
  },
  routes: { admin: [mediaGeneratorRoutes] },
};
