import contentRoutes from './routes.js';

export default {
  id: 'content',
  label: 'Content',
  description: 'Content types, entries, the block editor, categories and tags.',
  requires: ['audit'],
  provides: {
    services: ['content'],
    permissions: ['content.terms.manage', 'content.activity'],
    settings: ['content'],
    events: ['content.published', 'content.updated', 'content.deleted'],
    jobs: ['content.publish_due', 'content.unpublish_due'],
    api: [
      {
        id: 'content.types',
        path: '/content',
        summary: 'List the content types that have entries.',
        returns: 'object',
      },
      {
        id: 'content.list',
        path: '/content/:type',
        summary: 'List published entries of one content type, newest first.',
        query: {
          page: 'Page number, starting at 1',
          per_page: 'Entries per page, 1 to 50 (default 10)',
          sort: '"newest" (default) or "path"',
          locale: 'Language code when multiple languages are on',
          category: 'Only entries with this term slug (any taxonomy the type uses, by its id)',
        },
        returns: 'list',
      },
      {
        id: 'content.item',
        path: '/content/:type/*path',
        summary:
          'One published entry by its address, with breadcrumbs and children where the type has a hierarchy.',
        query: { locale: 'Language code when multiple languages are on' },
        returns: 'item',
      },
      {
        id: 'content.create',
        method: 'POST',
        path: '/entries/:type',
        summary: 'Create a draft entry. Needs an API key with write access to the content module.',
        body: {
          title: 'The title (required)',
          slug: 'Address segment; made from the title when left out',
          data: 'The type’s fields, by name',
          termIds: 'Category and tag ids',
          locale: 'Language code',
        },
        status: 201,
        returns: 'item',
        cacheable: false,
      },
      {
        id: 'content.update',
        method: 'PUT',
        path: '/entries/:type/:id',
        summary:
          'Change a draft this API created. Published entries and other people’s entries are edited in the admin.',
        body: {
          title: 'The title',
          slug: 'Address segment',
          data: 'Fields to change; the rest are kept',
          termIds: 'Category and tag ids',
          version: 'The version you read; a mismatch is a 409',
        },
        returns: 'item',
        cacheable: false,
      },
      {
        id: 'content.terms',
        path: '/terms/:taxonomy',
        summary: 'List the terms of a taxonomy that are used by published content.',
        query: { locale: 'Language code when multiple languages are on' },
        returns: 'object',
      },
      {
        id: 'content.term',
        path: '/terms/:taxonomy/:slug',
        summary: 'One term of a taxonomy by its slug.',
        query: { locale: 'Language code when multiple languages are on' },
        returns: 'item',
      },
    ],
  },
  routes: { admin: [contentRoutes] },
};
