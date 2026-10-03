import pageDesignerRoutes from './routes.js';
import { createPageDesigner } from './service.js';

export default {
  id: 'page-designer',
  label: 'AI Page Designer',
  optional: true,
  description: 'A chat session that plans and builds a complete page.',
  requires: ['site', 'services', 'media-generator', 'plugin-editor'],
  provides: { services: ['pageDesigner'], permissions: ['pages.write'] },
  create(ctx) {
    ctx.pageDesigner = createPageDesigner(ctx);
  },
  routes: { admin: [pageDesignerRoutes] },
};
