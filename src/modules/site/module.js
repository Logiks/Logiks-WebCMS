import siteRoutes from './routes.js';
import siteFilesRoutes from './files-routes.js';
import siteBuilderRoutes from './builder-routes.js';
import siteLocalesRoutes from './locales-routes.js';
import { createI18n } from './i18n.js';
import { createAiTranslator } from './translate.js';
import { createPublicData } from './data.js';
import { createSitePages } from './sitepages.js';
import { fileURLToPath } from 'node:url';

export default {
  id: 'site',
  label: 'Site',
  description:
    'The public website: pages, components, menus, redirects, languages and the data layer they read.',
  requires: ['content', 'media', 'themes', 'search'],
  provides: {
    services: ['site', 'siteFiles', 'i18n', 'publicData', 'sitePages'],
    permissions: [
      'pages.read',
      'pages.write',
      'components.read',
      'components.write',
      'locales.read',
      'locales.write',
      'menus.manage',
      'redirects.manage',
      'site.messages',
    ],
    settings: ['site'],
    events: ['contact.submitted'],
    api: [
      {
        id: 'site.contact',
        method: 'POST',
        path: '/contact',
        summary: 'Send a message through the site’s contact form.',
        body: {
          name: 'Your name (required)',
          email: 'Your email (required)',
          message: 'The message, up to 5000 characters (required)',
        },
        status: 201,
        anonymous: true,
        flag: 'site.contact_enabled',
        returns: 'object',
        cacheable: false,
      },
      {
        id: 'site.menu',
        path: '/menus/:name',
        summary: 'A navigation menu with its resolved links.',
        returns: 'object',
      },
    ],
  },
  create(ctx) {
    // These read the finished context (content, media, site, search…) on every call.
    ctx.i18n = createI18n(ctx, {
      shippedDir: fileURLToPath(new URL('../../../site/locales', import.meta.url)),
    });
    ctx.aiTranslator = createAiTranslator(ctx);
    ctx.publicData = createPublicData(ctx);
    ctx.publicData.verify(); // every declared API operation has a handler, and the other way round (D-068)
    ctx.sitePages = createSitePages(ctx);
  },
  routes: { admin: [siteRoutes, siteFilesRoutes, siteBuilderRoutes, siteLocalesRoutes] },
};
