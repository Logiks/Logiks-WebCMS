import { createVisual } from './service.js';

export default {
  id: 'visual',
  label: 'Visual check',
  description:
    'Screenshots of the site and design capture from reference sites, for the AI builders.',
  provides: { services: ['visual'], permissions: [], settings: ['visual'] },
  create(ctx) {
    ctx.visual = createVisual({
      settings: ctx.settings,
      log: ctx.log,
      web: () => ctx.research?.web,
      // The server calls itself: the public site is rendered by this very process.
      origin: () => `http://127.0.0.1:${ctx.env.PORT}`,
    });
  },
};
