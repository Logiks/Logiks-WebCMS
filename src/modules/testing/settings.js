/** Settings → Testing (docs/DECISIONS.md D-086). */
export function defineTestingSettings(registry) {
  registry.define('testing', {
    title: 'Testing',
    description:
      'Site-wide checks under Automation → Testing: layout, responsiveness, accessibility, SEO, content and spelling. They run in a real browser (see Visual check).',
    order: 37,
    fields: {
      viewports: {
        type: 'list',
        label: 'Screen sizes',
        default: ['mobile', 'tablet', 'desktop'],
        help: 'Any of mobile (390 px), tablet (768 px) and desktop (1280 px), one per line.',
        validate: (v) =>
          Array.isArray(v) &&
          v.length &&
          v.every((x) => ['mobile', 'tablet', 'desktop'].includes(x))
            ? null
            : 'Use mobile, tablet and desktop, one per line.',
      },
      max_pages: {
        type: 'number',
        label: 'Most pages to check',
        default: 40,
        min: 1,
        max: 300,
        help: 'A section with many addresses (every post of a blog) is sampled, so one section cannot use up the whole budget.',
      },
      spelling: {
        type: 'boolean',
        label: 'Check spelling',
        default: true,
        help: 'US English. Names, acronyms and words on the list below are left alone.',
      },
      ignore_words: {
        type: 'list',
        label: 'Words that are spelled correctly',
        default: [],
        help: 'Brand names, British spellings you use on purpose, product words. One per line.',
      },
      screenshots: {
        type: 'boolean',
        label: 'Keep pictures of pages with problems',
        default: true,
        help: 'Up to 30 per run, the top of each page.',
      },
      keep_runs: {
        type: 'number',
        label: 'Reports to keep',
        default: 10,
        min: 1,
        max: 100,
        help: 'Older reports, with their pictures, are deleted after each run.',
      },
      schedule: {
        type: 'select',
        label: 'Run automatically',
        default: 'off',
        options: [
          { value: 'off', label: 'Never: only when I start it' },
          { value: 'daily', label: 'Every night at 03:00' },
          { value: 'weekly', label: 'Every Monday at 03:00' },
        ],
        help: 'A worker server runs it and needs a browser. It checks the public address below.',
      },
      base_url: {
        type: 'string',
        label: 'Address for automatic runs',
        default: '',
        format: 'url',
        help: 'Leave empty to use the Public URL in Settings → General. A run you start yourself checks this server directly.',
      },
    },
  });
}
