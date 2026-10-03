export default {
  id: 'search',
  label: 'Search',
  description: 'Database-native full-text search over published content.',
  requires: ['content'],
  provides: {
    services: ['search'],
    jobs: ['search.reindex'],
    api: [
      {
        id: 'search.query',
        path: '/search',
        summary: 'Search published content.',
        query: {
          q: 'The search text (up to 100 characters)',
          page: 'Page number, starting at 1',
          per_page: 'Results per page, 1 to 50 (default 10)',
          locale: 'Language code when multiple languages are on',
        },
        returns: 'list',
        cacheable: false,
      },
    ],
  },
};
