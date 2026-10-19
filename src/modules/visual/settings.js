/** Settings → Visual check (docs/DECISIONS.md D-083). */
export function defineVisualSettings(registry) {
  registry.define('visual', {
    title: 'Visual check',
    description:
      'Lets the assistant and the page designer look at the pages they build (screenshots) and study a reference site’s look. Needs Chromium or Chrome on each web server.',
    order: 36,
    fields: {
      enabled: {
        type: 'boolean',
        label: 'Allow screenshots',
        default: true,
        help: 'The assistant renders a page in a headless browser, looks at it, and fixes what it sees. Needs a little memory on the server while it does. Everything outside this site is blocked while a page of this site is captured.',
      },
      browser_path: {
        type: 'string',
        label: 'Browser program',
        default: '',
        help: 'Leave empty to look for Google Chrome or Chromium automatically. Otherwise the full path, for example /usr/bin/chromium.',
      },
    },
  });
}
