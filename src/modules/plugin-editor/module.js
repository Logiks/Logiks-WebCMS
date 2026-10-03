import pluginEditorRoutes from './routes.js';
import { createPluginEditor } from './service.js';

export default {
  id: 'plugin-editor',
  label: 'Plugin Editor',
  optional: true,
  description: 'A chat session that creates or edits a plugin’s files.',
  requires: ['plugins'],
  provides: { services: ['pluginEditor'], permissions: ['plugins.manage'], settings: ['ai'] },
  create(ctx) {
    ctx.pluginEditor = createPluginEditor(ctx, { pluginsDir: ctx.env.PLUGINS_DIR });
  },
  routes: { admin: [pluginEditorRoutes] },
};
