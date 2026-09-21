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
  permissions.define('Webmaster', {
    // Raw HTML and CSS reach every visitor, so treat these like administrator-level permissions.
    'pages.read': 'View site pages (public/pages)',
    'pages.write': 'Create, edit and delete site pages',
    'components.read': 'View site components (public/components)',
    'components.write': 'Create, edit and delete site components',
    'locales.read': 'View the site’s translations (public/locales)',
    'locales.write': 'Edit the site’s translations',
  });
  permissions.define('Appearance', {
    'themes.read': 'View themes',
    'themes.manage': 'Install, switch and remove themes',
    'menus.manage': 'Edit navigation menus',
    'redirects.manage': 'Manage redirects',
    'site.messages': 'Read contact form messages',
  });
  permissions.define('System', {
    'audit.read': 'View the audit log',
    'cluster.read': 'View cluster, queue and cache status',
    'cache.flush': 'Flush the cache',
    'jobs.manage': 'Retry or discard failed background jobs',
    'system.update': 'Check for and install application updates (git pull)',
    'system.restart': 'Restart servers',
  });
}
