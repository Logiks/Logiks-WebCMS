import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { buildTransport, explain, fromOf, verifySmtp } from '../mail/smtp.js';
import { render } from '../mail/templates.js';
import { checkCustomCss, CUSTOM_CSS_MAX } from '../../modules/themes/package.js';

const tz = (v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return null;
  } catch {
    return 'Unknown timezone (use an IANA name such as Asia/Kolkata or UTC)';
  }
};

/**
 * Core settings. Feature modules register their own the same way (registry.define(...)),
 * and the admin Settings screen renders them automatically.
 * @param {import('./registry.js').Registry} registry
 */
export function defineCoreSettings(registry) {
  registry.define('general', {
    title: 'General',
    description: 'Site identity and basic behaviour.',
    order: 10,
    fields: {
      site_name: {
        type: 'string',
        label: 'Site name',
        default: 'My Site',
        required: true,
        max: 120,
      },
      tagline: { type: 'string', label: 'Tagline', default: '' },
      site_url: {
        type: 'string',
        label: 'Public URL',
        format: 'url',
        default: 'http://localhost:3000',
        help: 'Used for canonical links, sitemaps and emails.',
      },
      admin_email: {
        type: 'string',
        label: 'Admin email',
        format: 'email',
        default: '',
        help: 'Receives system notifications.',
      },
      timezone: {
        type: 'string',
        label: 'Timezone',
        default: 'Asia/Kolkata',
        validate: tz,
        help: 'Used to display dates. Everything is stored in UTC.',
      },
      default_locale: {
        type: 'string',
        label: 'Default language',
        default: 'en',
        validate: (v) =>
          /^[a-z]{2}(-[A-Z]{2})?$/.test(v) ? null : 'Use a language code such as en or en-IN',
      },
      maintenance_mode: {
        type: 'boolean',
        label: 'Maintenance mode',
        default: false,
        help: 'Shows a maintenance page on the public site. The admin stays available.',
      },
      maintenance_message: {
        type: 'text',
        label: 'Maintenance message',
        default: "We're making improvements and will be back shortly.",
        max: 1000,
      },
    },
  });

  registry.define('security', {
    title: 'Security',
    description: 'Sessions, sign-in protection, rate limits and browser policies.',
    order: 20,
    fields: {
      session_secret: {
        type: 'string',
        secret: true,
        hidden: true,
        generate: () => randomBytes(48).toString('hex'),
      },
      session_cookie_name: {
        type: 'string',
        label: 'Session cookie name',
        default: 'cms.sid',
        validate: (v) =>
          /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Letters, numbers, dot, dash and underscore only',
      },
      session_ttl_hours: {
        type: 'number',
        label: 'Session length (hours)',
        default: 12,
        min: 1,
        max: 720,
        help: 'People are signed out after this long without activity.',
      },
      password_min_length: {
        type: 'number',
        label: 'Minimum password length',
        default: 10,
        min: 8,
        max: 128,
      },
      max_login_attempts: {
        type: 'number',
        label: 'Failed sign-ins before lockout',
        default: 5,
        min: 3,
        max: 20,
      },
      lockout_minutes: {
        type: 'number',
        label: 'Lockout duration (minutes)',
        default: 15,
        min: 1,
        max: 1440,
      },
      rate_limit_per_minute: {
        type: 'number',
        label: 'API requests per minute (per IP)',
        default: 300,
        min: 10,
        max: 100000,
      },
      login_rate_limit_per_15min: {
        type: 'number',
        label: 'Sign-in attempts per 15 minutes (per IP)',
        default: 20,
        min: 3,
        max: 1000,
      },
      cors_origins: {
        type: 'list',
        label: 'Allowed CORS origins',
        default: [],
        help: 'For the public API. One origin per line, e.g. https://shop.example.com',
      },
      csp_img_sources: {
        type: 'list',
        label: 'Extra image sources (CSP)',
        default: [],
        help: 'Hosts allowed to serve images in the admin, e.g. https://cdn.example.com',
      },
      csp_connect_sources: { type: 'list', label: 'Extra connect sources (CSP)', default: [] },
      reset_token_minutes: {
        type: 'number',
        label: 'Password reset link lifetime (minutes)',
        default: 60,
        min: 5,
        max: 1440,
      },
      invite_token_hours: {
        type: 'number',
        label: 'Invitation link lifetime (hours)',
        default: 72,
        min: 1,
        max: 720,
      },
      contact_rate_limit_per_hour: {
        type: 'number',
        label: 'Contact form messages per address per hour',
        default: 10,
        min: 1,
        max: 1000,
      },
      forgot_rate_limit_per_hour: {
        type: 'number',
        label: 'Password reset requests per hour (per IP)',
        default: 5,
        min: 1,
        max: 100,
      },
      services_rate_limit_per_minute: {
        type: 'number',
        label: 'Services requests per minute (per IP)',
        default: 60,
        min: 1,
        max: 100000,
        help: 'Shared across every Service; a SQL-mode one can be expensive to run.',
      },
      analytics_rate_limit_per_minute: {
        type: 'number',
        label: 'Analytics beacon requests per minute (per IP)',
        default: 120,
        min: 1,
        max: 100000,
        help: 'The click/exit beacon a visitor’s browser sends, roughly once per page.',
      },
      services_sql_timeout_ms: {
        type: 'number',
        label: 'Services: SQL statement timeout (ms)',
        default: 3000,
        min: 100,
        max: 30000,
        help: 'Cuts off a slow query on MySQL and PostgreSQL. SQLite cannot be interrupted this way (it is dev/test only, D-018) — write efficient queries and a LIMIT.',
      },
      services_sql_row_limit: {
        type: 'number',
        label: 'Services: rows returned per SQL query',
        default: 500,
        min: 1,
        max: 10000,
      },
      services_script_timeout_ms: {
        type: 'number',
        label: 'Services: script response timeout (ms)',
        default: 5000,
        min: 100,
        max: 60000,
        help: 'A script that doesn’t respond in time is reported as failed; the code itself may keep running (D-046).',
      },
    },
  });

  registry.define('login', {
    title: 'Login page',
    description: 'What the sign-in, forgot-password and reset-password screens look like.',
    order: 22,
    fields: {
      logo: {
        type: 'number',
        media: true,
        label: 'Logo',
        default: 0,
        min: 0,
        help: 'Shown above the welcome heading. Choose one from the Media library.',
      },
      favicon: {
        type: 'number',
        media: true,
        label: 'Favicon',
        default: 0,
        min: 0,
        help: 'Replaces the browser-tab icon only while the sign-in screens are shown.',
      },
      background_type: {
        type: 'select',
        label: 'Background',
        default: 'default',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'color', label: 'Solid color' },
          { value: 'image', label: 'Image' },
        ],
      },
      background_color: {
        type: 'string',
        label: 'Background color',
        default: '',
        max: 32,
        help: 'A CSS color, e.g. #0f172a. Used when the background is set to Solid color.',
      },
      background_image: {
        type: 'number',
        media: true,
        label: 'Background image',
        default: 0,
        min: 0,
        help: 'Used when the background is set to Image. Choose one from the Media library.',
      },
      welcome_heading: {
        type: 'string',
        label: 'Welcome heading',
        default: '',
        max: 120,
        help: 'Falls back to the site name under General when empty.',
      },
      welcome_text: {
        type: 'text',
        label: 'Welcome text',
        default: '',
        max: 500,
      },
      custom_css: {
        type: 'text',
        label: 'Custom CSS',
        default: '',
        max: CUSTOM_CSS_MAX,
        help: 'Added after the built-in sign-in page styles, so it wins over them.',
        validate: checkCustomCss,
      },
    },
  });

  registry.define('mail', {
    title: 'Email',
    description:
      'Outgoing email for password resets and notifications. Messages are queued and retried, so a slow mail server never slows the site down.',
    order: 30,
    fields: {
      transport: {
        type: 'select',
        label: 'Delivery',
        default: 'none',
        options: [
          { value: 'none', label: 'Disabled' },
          { value: 'smtp', label: 'SMTP server' },
          { value: 'log', label: 'Write to the server log (development only)' },
        ],
        help: 'While disabled, "Forgot password" is hidden from the sign-in page.',
      },
      host: { type: 'string', label: 'SMTP host', default: '' },
      port: { type: 'number', label: 'SMTP port', default: 587, min: 1, max: 65535 },
      secure: { type: 'boolean', label: 'Use TLS from the start (port 465)', default: false },
      require_tls: {
        type: 'boolean',
        label: 'Require STARTTLS',
        default: false,
        help: 'Refuse to send if the server cannot upgrade to an encrypted connection (recommended for port 587).',
      },
      user: { type: 'string', label: 'SMTP username', default: '' },
      password: {
        type: 'string',
        label: 'SMTP password',
        secret: true,
        help: 'Stored encrypted. Leave blank to keep the current password.',
      },
      from_name: { type: 'string', label: 'Sender name', default: '' },
      from_address: { type: 'string', label: 'Sender address', format: 'email', default: '' },
    },
    tests: {
      connect: {
        label: 'Test connection',
        run: (v) => verifySmtp(v),
      },
      send_test: {
        label: 'Send me a test email',
        async run(v, { actor, settings }) {
          if (!actor?.email) throw new Error('Sign in to send a test email.');
          if (!v.from_address) throw new Error('Enter a sender address first.');
          const msg = render('test', { siteName: settings.get('general.site_name') });
          const t =
            v.transport === 'log'
              ? nodemailer.createTransport({ jsonTransport: true })
              : buildTransport(v, { pool: false });
          try {
            if (v.transport === 'smtp' && !v.host) throw new Error('Enter an SMTP host first.');
            if (v.transport === 'none')
              throw new Error('Choose SMTP as the delivery method first.');
            await t.sendMail({ from: fromOf(v), to: actor.email, ...msg });
          } catch (e) {
            throw new Error(explain(e), { cause: e });
          } finally {
            t.close?.();
          }
          return { message: `Sent to ${actor.email}. Check your inbox.` };
        },
      },
    },
  });

  // Which optional modules an administrator has switched off (System → Modules, D-070). Hidden: it is edited through
  // that screen, which also checks what depends on what, not as a free-text list.
  registry.define('modules', {
    title: 'Modules',
    description: 'Optional modules that are switched off. Change these under System → Modules.',
    order: 41,
    fields: {
      disabled: { type: 'list', label: 'Switched-off modules', default: [], hidden: true },
    },
  });

  registry.define('features', {
    title: 'Features',
    description:
      'Turn optional modules on or off. Unfinished modules stay behind a flag so main is always deployable.',
    order: 40,
    fields: {
      commerce: { type: 'boolean', label: 'Online store', default: false },
      multilingual: { type: 'boolean', label: 'Multiple languages', default: false },
      public_api: { type: 'boolean', label: 'Public content API', default: false },
      services: {
        type: 'boolean',
        label: 'Services',
        default: false,
        help: 'Let components and, when the public content API is also on, external callers read data through admin-defined Services (Webmaster → Services).',
      },
    },
  });

  registry.define('system', {
    title: 'System',
    description: 'Operational settings that apply to every server in the cluster.',
    order: 50,
    fields: {
      log_level: {
        type: 'select',
        label: 'Log level',
        default: 'default',
        options: [
          { value: 'default', label: 'Use server default' },
          { value: 'debug', label: 'Debug' },
          { value: 'info', label: 'Info' },
          { value: 'warn', label: 'Warnings only' },
          { value: 'error', label: 'Errors only' },
        ],
        help: 'Applies immediately on every server, no restart.',
      },
      audit_retention_days: {
        type: 'number',
        label: 'Keep audit log for (days)',
        default: 365,
        min: 0,
        max: 3650,
        help: '0 keeps entries forever.',
      },
      metrics_enabled: {
        type: 'boolean',
        label: 'Expose Prometheus metrics',
        default: false,
        help: 'Serves /metrics on every server. Requires the token below.',
      },
      metrics_token: {
        type: 'string',
        label: 'Metrics access token',
        secret: true,
        help: 'Prometheus sends this as a bearer token. Use a long random value.',
      },
    },
  });

  registry.define('updates', {
    title: 'Updates',
    description:
      'How Operations → Updates pulls new code from git on each server. Only applies to servers running from a git checkout.',
    order: 55,
    fields: {
      remote: {
        type: 'string',
        label: 'Git remote',
        default: 'origin',
        max: 64,
        validate: (v) =>
          /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(v)
            ? null
            : 'Use the name of a git remote, like origin (letters, numbers, dots, dashes).',
        help: 'Servers pull the branch they have checked out from this remote. Git needs read access already (an SSH key or stored credential); no passwords are kept here.',
      },
      install_dependencies: {
        type: 'boolean',
        label: 'Install dependencies when they change',
        default: true,
        help: 'Runs npm ci after a pull that changed package.json or package-lock.json.',
      },
      run_migrations: {
        type: 'boolean',
        label: 'Run database migrations after a pull',
        default: true,
        help: 'Production servers refuse to start with pending migrations, so leave this on unless your pipeline runs them.',
      },
      restart_mode: {
        type: 'select',
        label: 'How a restart happens',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'supervisor', label: 'Exit and let systemd, PM2 or Docker start it again' },
          { value: 'self', label: 'Start a new copy of itself (no supervisor)' },
        ],
        help: 'Automatic picks the first when a supervisor is detected (systemd, PM2, Docker, Kubernetes, node --watch). Without one, an exit would leave the site down.',
      },
    },
  });

  registry.define('site', {
    title: 'Website',
    description: 'How the public website is served. Changes apply on every server within seconds.',
    order: 20,
    fields: {
      theme: {
        type: 'string',
        label: 'Active theme',
        default: 'default',
        validate: (v) =>
          /^[a-z][a-z0-9_]{1,31}$/.test(v)
            ? null
            : 'A theme id is lowercase letters, numbers and underscores.',
        help: 'Switch themes under Appearance → Themes, which checks the theme exists first.',
      },
      home_page: {
        type: 'string',
        label: 'Home page',
        default: 'home',
        help: 'The address (slug) of the content page shown at "/" by the starter home page. If it does not exist, the home page shows the latest posts instead.',
      },
      posts_per_page: { type: 'number', label: 'Posts per page', default: 10, min: 1, max: 100 },
      page_cache_seconds: {
        type: 'number',
        label: 'Page cache lifetime (seconds)',
        default: 300,
        min: 0,
        max: 86400,
        help: 'How long servers and CDNs may keep a rendered page. Editing content refreshes it sooner. 0 turns the page cache off.',
      },
      noindex: {
        type: 'boolean',
        label: 'Ask search engines not to index this site',
        default: false,
        help: 'Adds a noindex header and meta tag and blocks everything in robots.txt. Use it on staging.',
      },
      sitemap_enabled: { type: 'boolean', label: 'Publish sitemap.xml', default: true },
      robots_extra: {
        type: 'text',
        label: 'Extra robots.txt lines',
        default: '',
        help: 'Added after the standard rules, for example a Disallow line.',
      },
      og_image: {
        type: 'number',
        label: 'Default social image (media id)',
        default: 0,
        min: 0,
        help: 'Used when a page has no featured image. Find the id in the Media library.',
      },
      contact_enabled: { type: 'boolean', label: 'Accept contact form messages', default: true },
      contact_recipient: {
        type: 'string',
        label: 'Contact form recipient',
        format: 'email',
        default: '',
        help: 'Leave empty to use the admin email under General.',
      },
    },
  });

  registry.define('seo', {
    title: 'SEO',
    description:
      'Site-wide tags used on every page. Per-page defaults live in a page’s own SEO section (Webmaster → Pages); overriding one specific address is done in Webmaster → SEO Manager.',
    order: 28,
    fields: {
      twitter_site: {
        type: 'string',
        label: 'Twitter/X handle',
        default: '',
        help: 'Your site’s own account, e.g. @smartinfologiks. Shown as twitter:site.',
      },
      facebook_app_id: { type: 'string', label: 'Facebook App ID', default: '' },
      default_twitter_card: {
        type: 'select',
        label: 'Default Twitter card',
        default: 'summary',
        options: [
          { value: 'summary', label: 'Summary' },
          { value: 'summary_large_image', label: 'Summary with large image' },
        ],
        help: 'Used when a page has no image and no override says otherwise.',
      },
      google_site_verification: {
        type: 'string',
        label: 'Google Search Console verification',
        default: '',
      },
      bing_site_verification: { type: 'string', label: 'Bing Webmaster verification', default: '' },
      pinterest_site_verification: { type: 'string', label: 'Pinterest verification', default: '' },
    },
  });

  registry.define('automation', {
    title: 'Automation',
    description: 'Events, webhooks and their retention.',
    order: 29,
    fields: {
      webhook_timeout_seconds: {
        type: 'number',
        label: 'Webhook delivery timeout (seconds)',
        default: 10,
        min: 1,
        max: 60,
      },
      events_retention_days: {
        type: 'number',
        label: 'Keep the events log for (days)',
        default: 30,
        min: 1,
        max: 365,
      },
      webhook_delivery_retention_days: {
        type: 'number',
        label: 'Keep webhook delivery history for (days)',
        default: 30,
        min: 1,
        max: 365,
      },
    },
  });

  registry.define('media', {
    title: 'Media',
    description: 'Uploads and the image sizes made from them.',
    order: 26,
    fields: {
      max_upload_mb: { type: 'number', label: 'Largest upload (MB)', default: 10, min: 1, max: 50 },
      variant_widths: {
        type: 'list',
        label: 'Image widths to generate (pixels)',
        default: ['320', '640', '1280', '1920'],
        validate: (v) =>
          v.every((w) => /^\d{2,4}$/.test(w) && Number(w) >= 64 && Number(w) <= 4000)
            ? null
            : 'Each width is a number between 64 and 4000.',
        help: 'One per line. Smaller copies are made only for widths below the original image.',
      },
      quality: {
        type: 'number',
        label: 'Quality of generated images (1–100)',
        default: 80,
        min: 30,
        max: 100,
      },
      avif: {
        type: 'boolean',
        label: 'Also generate AVIF',
        default: false,
        help: 'Smaller files, but slower uploads. WebP is always generated.',
      },
    },
  });

  registry.define('themes', {
    title: 'Themes',
    description:
      'Limits that keep a theme from harming the site. They apply to installed and built-in themes alike.',
    order: 27,
    fields: {
      allow_js: {
        type: 'boolean',
        label: 'Let installed themes include JavaScript',
        default: false,
        help: 'A theme script runs in your visitors’ browsers, on the same address as the admin. Only turn this on for themes you would trust with your own admin session.',
      },
      max_zip_mb: {
        type: 'number',
        label: 'Largest theme upload (MB)',
        default: 5,
        min: 1,
        max: 20,
      },
      render_ms: {
        type: 'number',
        label: 'Longest a page may take to render (milliseconds)',
        default: 500,
        min: 50,
        max: 10000,
        help: 'A template that runs longer is stopped, so an endless loop can’t hang a server.',
      },
      render_memory_mb: {
        type: 'number',
        label: 'Most memory a page may use while rendering (MB)',
        default: 64,
        min: 4,
        max: 512,
      },
    },
  });

  registry.define('content', {
    title: 'Content',
    description: 'Editing rules for pages, posts and other content.',
    order: 25,
    fields: {
      max_revisions: {
        type: 'number',
        label: 'Revisions kept per entry',
        default: 50,
        min: 1,
        max: 1000,
        help: 'Older revisions are deleted as new ones are saved.',
      },
      locales: {
        type: 'list',
        label: 'Languages',
        default: ['en'],
        help: 'Language codes, one per line. Only used when "Multiple languages" is on under Features.',
      },
    },
  });

  registry.define('analytics', {
    title: 'Analytics',
    description:
      'Page views, clicks and bounces for the public site and the admin panel, tracked separately.',
    order: 60,
    fields: {
      enabled: {
        type: 'boolean',
        label: 'Track activity',
        default: true,
        help: 'A global switch. Turn off to stop recording page views, clicks and sessions entirely.',
      },
      track_clicks: {
        type: 'boolean',
        label: 'Track clicks on the public site',
        default: true,
        help: 'Elements marked data-track. Page views are always recorded server-side regardless of this.',
      },
      respect_dnt: {
        type: 'boolean',
        label: 'Honor "Do Not Track"',
        default: false,
      },
      visitor_cookie_days: {
        type: 'number',
        label: 'Visitor cookie lifetime (days)',
        default: 400,
        min: 1,
        max: 3650,
      },
      retention_days: {
        type: 'number',
        label: 'Keep activity data for (days)',
        default: 180,
        min: 1,
        max: 3650,
      },
    },
  });

  registry.define('cache', {
    title: 'Cache',
    description: 'Redis-backed cache with a small in-memory layer on each server.',
    order: 45,
    fields: {
      enabled: {
        type: 'boolean',
        label: 'Use the cache',
        default: true,
        help: 'Turn off to debug stale content. Everything is then computed on every request.',
      },
      default_ttl_seconds: {
        type: 'number',
        label: 'Default lifetime (seconds)',
        default: 300,
        min: 1,
        max: 86400,
      },
      l1_ttl_seconds: {
        type: 'number',
        label: 'In-memory lifetime per server (seconds)',
        default: 30,
        min: 1,
        max: 3600,
        help: 'Entries are re-read from Redis after this long.',
      },
      l1_max_entries: {
        type: 'number',
        label: 'In-memory entries per server',
        default: 1000,
        min: 10,
        max: 100000,
      },
    },
  });
}
