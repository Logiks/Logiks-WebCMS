/** Settings → Testing (docs/DECISIONS.md D-086). */
export function defineTestingSettings(registry) {
  registry.define('testing', {
    title: 'AI Testing',
    description:
      'Site-wide checks under Automation → AI Testing: layout, responsiveness, accessibility, SEO, content and spelling. They run in a real browser (see Visual check).',
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
      checks: {
        type: 'list',
        label: 'Checks to run',
        default: [
          'performance',
          'keyboard',
          'security',
          'redirects',
          'seo',
          'search',
          'content',
          'plugins',
          'languages',
          'cluster',
          'journeys',
        ],
        help: 'One per line. Available: performance, keyboard, regression, security, redirects, seo, forms, search, content, plugins, languages, cluster, external, journeys. Page checks (layout, accessibility, SEO, content, spelling, links) always run. “forms” sends a test contact message and deletes it; “external” and “regression” are off unless listed.',
        validate: (v) => {
          const ok = [
            'performance',
            'keyboard',
            'regression',
            'security',
            'redirects',
            'seo',
            'forms',
            'search',
            'content',
            'plugins',
            'languages',
            'cluster',
            'external',
            'journeys',
          ];
          const bad = (Array.isArray(v) ? v : []).filter((x) => !ok.includes(x));
          return bad.length ? `Not a check: ${bad.join(', ')}.` : null;
        },
      },
      budget_lcp_ms: {
        type: 'number',
        label: 'Speed budget: main content appears within (ms)',
        default: 2500,
        min: 100,
        max: 20000,
        help: 'Largest contentful paint. 2500 is “good” by Google’s measure. On phones the page is loaded on a throttled 4G connection.',
      },
      budget_cls: {
        type: 'number',
        label: 'Speed budget: layout shift',
        default: 0.1,
        min: 0,
        max: 1,
        int: false,
        help: 'How much the page jumps while loading. 0.1 or less is good.',
      },
      budget_tbt_ms: {
        type: 'number',
        label: 'Speed budget: blocked by scripts (ms)',
        default: 300,
        min: 50,
        max: 5000,
        help: 'Total blocking time.',
      },
      budget_page_kb: {
        type: 'number',
        label: 'Speed budget: page weight (KB)',
        default: 3000,
        min: 100,
        max: 50000,
      },
      regression_percent: {
        type: 'number',
        label: 'Visual change that counts (%)',
        default: 2,
        min: 0.1,
        max: 50,
        int: false,
        help: 'How much of the top of a page may look different from its accepted version before it is reported.',
      },
      error_threshold: {
        type: 'number',
        label: 'Alert when errors exceed',
        default: 0,
        min: 0,
        help: '0 means never alert. Above that, a finished run sends the “testing.threshold_exceeded” event (for Webhooks) and emails the address below.',
      },
      notify_email: {
        type: 'string',
        label: 'Email for alerts',
        format: 'email',
        default: '',
        help: 'Needs email set up under Settings → Mail.',
      },
      check_on_publish: {
        type: 'boolean',
        label: 'Check pages as they are published',
        default: false,
        help: 'A quick check of a page right after it is saved or published: layout, accessibility, SEO, spelling and links of that page alone.',
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
