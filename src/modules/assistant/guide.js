/**
 * "Where is that in the admin?" for the assistant's `find_in_admin` tool. It mirrors the sidebar in admin/static/app.js
 * (`get nav`) and the task list behind Search there; test/assistant-guide.test.js fails if a screen id here is not in the
 * sidebar, so the two cannot quietly drift apart. Settings are read from the live registry, so a new setting is found
 * without touching this file.
 *
 * Each screen: [id, group, label, permission, optional module, search words].
 */
const SCREENS = [
  ['overview', '', 'Overview', 'admin.access', null, 'dashboard home status health summary'],
  ['pages', 'Webmaster', 'Site pages', 'pages.read', null, 'edit html layout page manager'],
  [
    'components',
    'Webmaster',
    'Components',
    'components.read',
    null,
    'blocks sections reusable widgets template',
  ],
  [
    'pageDesigner',
    'Webmaster',
    'AI Page Designer',
    'pages.write',
    'page-designer',
    'ai build page design generate landing',
  ],
  [
    'services',
    'Webmaster',
    'Services',
    'services.read',
    'services',
    'api endpoint data query sql script',
  ],
  [
    'seo',
    'Webmaster',
    'SEO Manager',
    'seo.read',
    'seo',
    'search engine title description meta og twitter schema json-ld',
  ],
  ['terms', 'Content', 'Categories and tags', 'content.terms.manage', null, 'taxonomy'],
  [
    'research',
    'Content',
    'AI Research',
    'research.read',
    'research',
    'research findings sources references links web notes saved ai',
  ],
  [
    'media',
    'Media Manager',
    'Media Library',
    'media.read',
    null,
    'images files upload pictures photos',
  ],
  [
    'media-generator',
    'Media Manager',
    'Media Generator',
    'media.upload',
    'media-generator',
    'ai image generate picture dall-e imagen stability',
  ],
  [
    'media-analytics',
    'Media Manager',
    'Media Analytics',
    'media.read',
    null,
    'media usage unused files',
  ],
  [
    'plugins',
    'Applications',
    'Plugin Manager',
    'plugins.read',
    null,
    'plugin extensions add-ons install',
  ],
  [
    'analytics-overview',
    'Analytics',
    'Overview',
    'analytics.read',
    'analytics',
    'traffic visitors page views statistics stats',
  ],
  [
    'analytics-active',
    'Analytics',
    'Active Now',
    'analytics.read',
    'analytics',
    'live online users right now',
  ],
  [
    'analytics-pages',
    'Analytics',
    'Page Analytics',
    'analytics.read',
    'analytics',
    'popular pages views',
  ],
  ['analytics-sessions', 'Analytics', 'Sessions', 'analytics.read', 'analytics', 'visits'],
  [
    'analytics-users',
    'Analytics',
    'User-wise Analytics',
    'analytics.read',
    'analytics',
    'visitors behaviour',
  ],
  ['audit', 'Logs', 'Audit log', 'audit.read', null, 'who changed what history security events'],
  [
    'content-activity',
    'Logs',
    'Activity',
    'content.activity',
    null,
    'content log editors who edited published',
  ],
  ['events', 'Logs', 'Events', 'events.read', 'events', 'event log webhooks fired'],
  [
    'themes',
    'Appearance',
    'Themes',
    'themes.read',
    null,
    'switch activate change look design skin install duplicate clone export',
  ],
  [
    'customize',
    'Appearance',
    'Customize',
    'themes.read',
    null,
    'theme options colors colours fonts custom css style branding',
  ],
  [
    'theme-editor',
    'Appearance',
    'Theme editor',
    'themes.read',
    null,
    'theme files layout template css edit code header footer',
  ],
  ['menus', 'Appearance', 'Menus', 'menus.manage', null, 'navigation header footer links nav'],
  [
    'requirements',
    'System',
    'Requirements',
    'requirements.read',
    'assistant',
    'documentation spec brief project',
  ],
  [
    'history',
    'System',
    'Change history',
    'history.read',
    'assistant',
    'git commit diff revert undo push versions',
  ],
  ['locales', 'System', 'Translations', 'locales.read', null, 'languages wording text locale i18n'],
  ['redirects', 'System', 'Redirects', 'redirects.manage', null, '301 302 moved urls'],
  ['messages', 'System', 'Messages', 'site.messages', null, 'contact form inbox enquiries'],
  ['sitemap', 'System', 'Sitemap', 'sitemap.read', 'sitemap', 'xml robots search engines urls'],
  [
    'libraries',
    'System',
    'Libraries',
    'libraries.read',
    null,
    'npm packages cdn bootstrap fonts icons javascript css jquery download',
  ],
  ['dbms', 'System', 'Database', 'dbms.read', 'dbms', 'tables sql query browse rows'],
  ['api', 'System', 'API', 'api.read', null, 'api keys tokens public openapi swagger external'],
  ['modules', 'Settings', 'Modules', 'cluster.read', null, 'features switch on off enable disable'],
  ['settings', '', 'Settings', 'settings.read', null, 'configuration options preferences'],
  [
    'users',
    'Security',
    'Users',
    'users.read',
    null,
    'people accounts invite password reset lock unlock staff',
  ],
  [
    'roles',
    'Security',
    'Roles and permissions',
    'roles.read',
    null,
    'access rights administrator editor',
  ],
  ['cluster', 'Operations', 'Cluster', 'cluster.read', null, 'servers nodes health version drift'],
  [
    'system',
    'Operations',
    'System',
    'cluster.read',
    null,
    'queue jobs failed cache redis runtime health',
  ],
  [
    'updates',
    'Operations',
    'Updates',
    'system.update',
    null,
    'upgrade git pull restart deploy release servers',
  ],
  [
    'webhooks',
    'Automation',
    'Webhooks',
    'webhooks.read',
    'webhooks',
    'notify http callback integrations post',
  ],
  [
    'scheduler',
    'Automation',
    'Scheduler',
    'scheduler.read',
    'scheduler',
    'cron recurring tasks jobs timer',
  ],
];

/** Plain-language jobs that point at a place that does them. [title, go, words, note] */
const TASKS = [
  [
    'Change the Content Security Policy (CSP) headers',
    'settings/security/csp_img_sources',
    'csp content security policy headers script style font image connect sources blocked cdn',
    'Extra image and connect sources are Settings → Security. Scripts, styles and fonts load only from the site itself: add them under System → Libraries.',
  ],
  [
    'Allow another site to call the public API (CORS)',
    'settings/security/cors_origins',
    'cors cross origin allowed browsers public api headers',
    '',
  ],
  [
    'Load Bootstrap, icons or fonts without a CDN',
    'libraries',
    'bootstrap icons fonts cdn google fonts npm download offline',
    '',
  ],
  [
    'Switch the site to another theme',
    'themes',
    'theme switch activate change design look skin',
    '',
  ],
  [
    'Change colours, fonts or add custom CSS',
    'customize',
    'colours colors fonts custom css style branding look',
    '',
  ],
  [
    'Edit a theme’s layout, header or footer',
    'theme-editor',
    'layout header footer template css edit code',
    '',
  ],
  ['Edit a page', 'pages', 'edit page html content layout', ''],
  ['Change the navigation menu', 'menus', 'menu navigation header footer links nav', ''],
  ['Add a redirect from an old address', 'redirects', 'redirect 301 302 moved old url address', ''],
  [
    'Translate the site or change its wording',
    'locales',
    'translate translation language wording text',
    '',
  ],
  ['Edit SEO titles and descriptions', 'seo', 'seo title description meta open graph', ''],
  ['Upload images and files', 'media', 'upload images pictures photos files library', ''],
  [
    'Read what the assistant found on the web (research and source links)',
    'research',
    'research findings sources references links notes web',
    '',
  ],
  [
    'Change the site name or turn on maintenance mode',
    'settings/general',
    'site name maintenance mode offline under construction',
    '',
  ],
  [
    'Set up outgoing email (SMTP)',
    'settings/mail',
    'email smtp mail server sender password reset invite',
    '',
  ],
  [
    'Add the Anthropic key or choose the AI model',
    'settings/ai',
    'anthropic claude key api model ai assistant',
    '',
  ],
  [
    'Add the web search key for AI research',
    'settings/research',
    'brave search key web research',
    '',
  ],
  [
    'Add keys for image generation',
    'settings/media_generator',
    'openai google stability image generation key',
    '',
  ],
  [
    'Review or undo what the assistant changed',
    'history',
    'assistant changes diff revert undo git commit history push',
    '',
  ],
  [
    'Add a person or reset a password',
    'users',
    'invite add new user account person staff password reset unlock',
    '',
  ],
  ['Decide who can do what', 'roles', 'roles permissions access rights administrator editor', ''],
  [
    'Change password rules, lockout or session length',
    'settings/security/password_min_length',
    'password rules lockout session length sign in attempts rate limit',
    '',
  ],
  [
    'Create an API key for another app',
    'api',
    'api key token external integration public openapi',
    '',
  ],
  [
    'Send events to another system (webhooks)',
    'webhooks',
    'webhook notify callback http integration event',
    '',
  ],
  ['Run something on a schedule', 'scheduler', 'schedule cron recurring timer automation job', ''],
  [
    'Update or restart a server',
    'updates',
    'update upgrade restart deploy git pull release server',
    '',
  ],
  ['Browse the database or run SQL', 'dbms', 'database sql query tables rows browse', ''],
  [
    'Clear or tune the cache',
    'settings/cache',
    'cache clear ttl speed performance faster slow',
    '',
  ],
];

const STOP = new Set(
  'how to do i my the a an of in on for can where is what and or with it me we'.split(' '),
);
const words = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** Score one candidate against the query words: title hits count most, then keywords, then the path and help text. */
function score(e, tokens) {
  let total = 0;
  let matched = 0;
  for (const t of tokens) {
    const s = e.title.includes(t)
      ? 8
      : e.words.includes(t)
        ? 4
        : e.path.includes(t)
          ? 3
          : e.help.includes(t)
            ? 2
            : 0;
    if (s) matched++;
    total += s;
  }
  // Most of what was asked must be found, so "csp headers" does not return every screen with "headers" in it.
  return matched >= Math.ceil(tokens.length * 0.6) ? total + (e.kind === 'task' ? 2 : 0) : 0;
}

/**
 * @param {{settings: any, content: any, ctx: any}} deps
 */
export function createGuide({ settings, content, ctx }) {
  /** Everything this person could open, as searchable entries. */
  function catalog(actor) {
    const on = (m) => !m || ctx.modules.isEnabled(m, ctx);
    const out = [];
    const screens = SCREENS.filter(([, , , perm, mod]) => actor.can(perm) && on(mod));
    for (const [id, group, label, , , w] of screens) {
      out.push({
        kind: 'screen',
        go: id,
        where: group ? `${group} → ${label}` : label,
        title: label,
        words: w,
        help: '',
      });
    }
    for (const t of content.registry.types()) {
      if (!actor.can(`content.${t.id}.read`)) continue;
      out.push({
        kind: 'screen',
        go: `content/${t.id}`,
        where: `Content → ${t.plural}`,
        title: t.plural,
        words: `${t.label} entries`,
        help: '',
      });
    }
    const reachable = (go) =>
      go.startsWith('settings')
        ? actor.can('settings.read') && settings.registry.has(go.split('/')[1])
        : out.some((e) => e.go === go);
    const placeOf = (go) =>
      go.startsWith('settings')
        ? `Settings → ${settings.registry.get(go.split('/')[1]).title}`
        : out.find((e) => e.go === go)?.where;
    for (const [title, go, w, note] of TASKS)
      if (reachable(go))
        out.push({ kind: 'task', go, where: placeOf(go), title, words: w, help: note });
    if (actor.can('settings.read')) {
      for (const ns of settings.registry.all()) {
        out.push({
          kind: 'setting',
          go: `settings/${ns.namespace}`,
          where: `Settings → ${ns.title}`,
          title: `${ns.title} settings`,
          words: ns.namespace.replace(/_/g, ' '),
          help: ns.description,
        });
        for (const f of Object.values(ns.fields)) {
          if (f.hidden) continue;
          out.push({
            kind: 'setting',
            go: `settings/${ns.namespace}/${f.key}`,
            where: `Settings → ${ns.title}`,
            title: f.label,
            words: f.key.replace(/_/g, ' '),
            help: f.help ?? '',
          });
        }
      }
    }
    return out.map((e) => ({
      ...e,
      // `raw` keeps the readable text for the answer; the rest are normalised copies to match on.
      title: words(e.title).join(' '),
      words: words(e.words).join(' '),
      path: words(e.where).join(' '),
      help: words(e.help).join(' '),
      raw: e,
    }));
  }

  return {
    /** The best few places in the admin for a plain-language question, each with a link the chat turns into a button. */
    find(actor, query, limit = 5) {
      const tokens = words(query).filter((t) => !STOP.has(t));
      if (!tokens.length) return [];
      const where = (r) => r.where || r.title;
      return catalog(actor)
        .map((e) => ({ e, s: score(e, tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.min(10, Math.max(1, Number(limit) || 5)))
        .map(({ e }) => {
          const r = e.raw;
          return {
            name: r.title,
            menu: where(r),
            link: `[${where(r)}](#/${r.go})`,
            ...(r.help && r.kind !== 'setting' ? { note: r.help } : {}),
            ...(r.kind === 'setting' && r.help ? { about: r.help.slice(0, 160) } : {}),
          };
        });
    },
  };
}

/** The screen ids named here, for the drift test. */
export const GUIDE_SCREEN_IDS = SCREENS.map((s) => s[0]);
