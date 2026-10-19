/**
 * Permission registry. Modules declare what can be granted; roles hold permission strings.
 *   permissions.define('Settings', { 'settings.read': 'View settings' })
 * Matching: exact ('users.write'), namespace wildcard ('users.*'), or '*' (administrator).
 */
export function createPermissions() {
  const groups = new Map(); // group -> {perm: label}
  const known = new Set();
  return {
    define(group, perms) {
      const g = groups.get(group) ?? {};
      for (const [p, label] of Object.entries(perms)) {
        g[p] = label;
        known.add(p);
      }
      groups.set(group, g);
    },
    has: (p) => known.has(p),
    all: () =>
      [...groups].map(([group, perms]) => ({
        group,
        permissions: Object.entries(perms).map(([key, label]) => ({ key, label })),
      })),
    /** @param {string[]} granted @param {string} required */
    matches(granted, required) {
      if (granted.includes('*') || granted.includes(required)) return true;
      const dot = required.lastIndexOf('.');
      for (let i = dot; i > 0; i = required.lastIndexOf('.', i - 1)) {
        if (granted.includes(`${required.slice(0, i)}.*`)) return true;
      }
      return false;
    },
    /** Grantable strings a role may hold: known permissions, wildcards of known groups, and '*'. */
    isValid(p) {
      if (p === '*' || known.has(p)) return true;
      return p.endsWith('.*') && [...known].some((k) => k.startsWith(p.slice(0, -1)));
    },
  };
}

export function defineCorePermissions(permissions) {
  permissions.define('Admin', { 'admin.access': 'Sign in to the admin' });
  permissions.define('Settings', {
    'settings.read': 'View settings',
    'settings.write': 'Change settings',
    'settings.secrets.write': 'Change secret settings (passwords, API keys)',
  });
  permissions.define('Users & roles', {
    'users.read': 'View users',
    'users.write': 'Create and edit users',
    'roles.read': 'View roles',
    'roles.write': 'Create and edit roles',
  });
  permissions.define('Media', {
    'media.read': 'View the media library',
    'media.upload': 'Upload and describe files',
    'media.delete': 'Delete files',
  });
  permissions.define('AI Research', {
    'research.read': 'View saved AI research',
    // Lets the assistant (acting as this person) read other sites and save findings; downloading pictures also needs media.upload.
    'research.write': 'Research on the web and save the findings',
    'research.delete': 'Delete saved AI research',
  });
  permissions.define('Site testing', {
    'testing.read': 'View site check reports',
    // A run opens every page of the site in a browser on the server, so it is not free.
    'testing.run': 'Start, cancel and delete site checks',
  });
  permissions.define('Prompts', {
    'prompts.read': 'View the AI prompts and project types',
    // Prompts steer an AI that can edit the whole site as the person using it, so treat this like a Webmaster permission.
    'prompts.write': 'Edit the AI prompts and project types',
  });
  permissions.define('Webmaster', {
    // Raw HTML and CSS reach every visitor, so treat these like administrator-level permissions.
    'pages.read': 'View site pages (public/pages)',
    'pages.write': 'Create, edit and delete site pages',
    'components.read': 'View site components (public/components)',
    'components.write': 'Create, edit and delete site components',
    'locales.read': 'View the site’s translations (public/locales)',
    'locales.write': 'Edit the site’s translations',
    'services.read': 'View Services (admin-defined API endpoints)',
    'services.write': 'Create and edit query-builder Services',
    // A SQL-mode service (or a query-builder one reading a raw table) can read any table, so this is stronger
    // than pages.write/components.write: don't grant it in a seed role other than the wildcard administrator.
    'services.sql':
      'Create and edit raw-SQL Services, or a query-builder Service over a database table',
    // A script Service runs full, unsandboxed Node.js with complete access to the platform — the database,
    // decrypted settings (including secrets), email, everything. Same trust level as shell access to the server.
    // Never grant this in a seed role other than the wildcard administrator (D-046).
    'services.script': 'Create and edit Node.js script Services (full server access, no sandbox)',
  });
  permissions.define('Appearance', {
    'themes.read': 'View themes',
    'themes.manage': 'Install, switch, duplicate and remove themes',
    // Theme templates and CSS reach every visitor: like pages.write/components.write, an administrator-level permission.
    'themes.edit': 'Edit the files of installed themes (templates, styles, scripts)',
    'themes.customize': 'Change theme options and custom CSS',
    'menus.manage': 'Edit navigation menus',
    'redirects.manage': 'Manage redirects',
    'site.messages': 'Read contact form messages',
  });
  permissions.define('Assistant', {
    // The chat itself needs only admin.access: every tool it calls checks the signed-in user's own permission.
    'requirements.read': 'View the site requirements document',
    'requirements.write': 'Edit the site requirements document',
    'history.read': 'View the change history and what each change altered',
    'history.commit':
      'Commit the site as it is now to the change history (including edits made by hand)',
    'history.push': 'Push the change history to the git remote',
  });
  permissions.define('SEO', {
    'seo.read': 'View SEO Manager rules',
    'seo.write': 'Create, edit and delete SEO Manager rules',
    'sitemap.read': 'View the sitemap and its settings',
    'sitemap.manage': 'Change what the sitemap lists, and rebuild it',
  });
  permissions.define('Automation', {
    'events.read': 'View the events log',
    // Firing a test event can trigger real webhooks with real side effects at the receiving end, so it's gated
    // separately from just viewing the log — same reasoning as services.sql sitting above services.write.
    'events.write': 'Fire a test event',
    'webhooks.read': 'View webhooks',
    'webhooks.write': 'Create, edit and delete webhooks',
    'scheduler.read': 'View scheduled tasks',
    // A scheduled task runs an existing Service or fires a Webhook automatically and unattended, so creating one
    // is as powerful as whatever it targets already allows — same "automation, not a new capability" reasoning
    // Services and Webhooks already rely on.
    'scheduler.write': 'Create, edit and delete scheduled tasks',
  });
  permissions.define('API', {
    'api.read': 'View the API reference and API keys',
    // A key lets a machine read the site's public data without the public API being switched on. It cannot write,
    // and only reaches the modules it is scoped to, but handing one out is still an access decision.
    'api.keys.manage': 'Create, edit, rotate and delete API keys',
  });
  permissions.define('Analytics', {
    'analytics.read': 'View site and admin activity: page views, sessions and user activity',
  });
  permissions.define('Database', {
    'dbms.read': 'Browse database tables, their data and structure',
    'dbms.write': 'Add, edit and delete records; create and drop tables',
    // Runs literally anything the database engine allows — no keyword blocklist, no read-only restriction, same
    // trust tier as services.script. Never grant this in a seed role other than the wildcard administrator (D-047).
    'dbms.query': 'Run raw SQL in the database console',
  });
  permissions.define('Applications', {
    'plugins.read': 'View installed plugins',
    // A plugin's server.js is full, unsandboxed Node.js with complete access to the platform — the database,
    // decrypted settings (including secrets), email, everything. Same trust level as shell access to the server.
    // Never grant this in a seed role other than the wildcard administrator (D-060).
    'plugins.manage':
      'Install, enable, disable and remove plugins (full server access, no sandbox)',
  });
  permissions.define('System', {
    'audit.read': 'View the audit log',
    'cluster.read': 'View cluster, queue and cache status',
    'cache.flush': 'Flush the cache',
    'modules.manage': 'Switch optional modules on or off',
    'jobs.manage': 'Retry or discard failed background jobs',
    'system.update': 'Check for and install application updates (git pull)',
    'system.restart': 'Restart servers',
    'libraries.read': 'View installed libraries (npm packages)',
    // A library's files are served on the site's own address and can be added to every page: administrator-level.
    'libraries.manage': 'Install, configure and remove libraries (npm packages)',
  });
}
