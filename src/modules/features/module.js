import featuresRoutes from './routes.js';
import { createFeatures } from './service.js';
import { featureDefinitions } from './definitions.js';

export default {
  id: 'features',
  label: 'Features',
  description: 'Switch whole subsystems (Blog, eCommerce, Support tickets…) on and off.',
  requires: ['settings'],
  provides: {
    services: ['features'],
    permissions: ['features.read', 'features.manage'],
    settings: ['featureset'],
  },
  create(ctx) {
    ctx.features = createFeatures({ ctx, definitions: featureDefinitions });
  },
  routes: { admin: [featuresRoutes] },
};
