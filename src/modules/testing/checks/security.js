/**
 * Security and headers (docs/DECISIONS.md D-087): what a stranger can learn from the response headers, and which
 * private-looking addresses answer. Plain HTTP requests, so it works with or without a browser.
 * @param {import('./env.js').CheckEnv} env
 */
export async function securityChecks(env) {
  const { base, add } = env;
  const https = new URL(base).protocol === 'https:';
  const site = (severity, rule, message, key = '') =>
    add('/', 'site', 'security', severity, rule, message, key);

  const res = await env.get('/');
  if (!res)
    return site(
      'error',
      'unreachable',
      'The home page could not be reached, so the security checks were skipped.',
    );
  const h = res.headers;
  const csp = h.get('content-security-policy') || '';
  if (!csp)
    site(
      'error',
      'csp-missing',
      'There is no Content-Security-Policy header, so the browser will run any script an attacker manages to inject.',
    );
  if (!/nosniff/i.test(h.get('x-content-type-options') || ''))
    site('warn', 'nosniff', 'The X-Content-Type-Options: nosniff header is missing.');
  if (!h.get('referrer-policy'))
    site(
      'info',
      'referrer-policy',
      'There is no Referrer-Policy header, so full addresses may be sent to other sites.',
    );
  if (!h.get('x-frame-options') && !/frame-ancestors/i.test(csp))
    site(
      'warn',
      'clickjacking',
      'Other sites can show this one inside a frame (no X-Frame-Options and no frame-ancestors).',
    );
  if (https && !h.get('strict-transport-security'))
    site(
      'warn',
      'hsts',
      'The Strict-Transport-Security (HSTS) header is missing on this https site.',
    );
  if (!h.get('permissions-policy'))
    site(
      'info',
      'permissions-policy',
      'There is no Permissions-Policy header limiting camera, microphone and location use.',
    );
  if (h.get('x-powered-by'))
    site(
      'info',
      'x-powered-by',
      `The server announces what it runs on (X-Powered-By: ${h.get('x-powered-by')}).`,
    );
  for (const c of h.getSetCookie?.() ?? []) {
    const name = c.split('=')[0];
    if (https && !/;\s*secure/i.test(c))
      site('warn', 'cookie-secure', `The cookie “${name}” is not marked Secure.`, name);
    if (/sid|session/i.test(name) && !/;\s*httponly/i.test(c))
      site(
        'warn',
        'cookie-httponly',
        `The session cookie “${name}” is readable by scripts (no HttpOnly).`,
        name,
      );
  }

  // Files that must never be served.
  const secrets = [
    '/.env',
    '/.git/config',
    '/package.json',
    '/src/server.js',
    '/docker-compose.yml',
    '/migrations/',
    '/node_modules/.package-lock.json',
    '/config/ai-models.json',
  ];
  for (const p of secrets) {
    const r = await env.get(p);
    if (!r || r.status !== 200) continue;
    const type = r.headers.get('content-type') || '';
    const body = (await r.text().catch(() => '')).slice(0, 2000);
    if (
      !/html/i.test(type) ||
      /APP_MASTER_KEY|DB_URL|\[core\]|"dependencies"|createContext/.test(body)
    )
      site('error', 'exposed-file', `${p} can be downloaded by anyone.`, p);
  }
  const api = await env.get('/api/admin/users');
  if (api && api.status === 200)
    site(
      'error',
      'admin-api-open',
      'An admin API answers without signing in (/api/admin/users).',
      '/api/admin/users',
    );

  // Folder listings and error pages that give away internals.
  for (const p of ['/media/', '/lib/']) {
    const r = await env.get(p);
    if (r?.status === 200 && /Index of|<title>Directory/i.test(await r.text().catch(() => '')))
      site('warn', 'directory-listing', `${p} lists the files in the folder.`, p);
  }
  for (const p of ['/this-page-should-not-exist-9f3a', '/api/public/__nope__', '/%E0%A4%A']) {
    const r = await env.get(p);
    const body = r ? await r.text().catch(() => '') : '';
    if (
      /\bat\s+\S+\s+\(.*:\d+:\d+\)|node_modules\/|\bSyntaxError\b|\bTypeError\b|ECONNREFUSED|SQLITE_|ER_[A-Z_]+/.test(
        body,
      )
    )
      site('error', 'error-leak', `An error page shows technical details (${p}).`, p);
  }

  // A public https site should send plain http visitors to https.
  if (env.publicBase && https) {
    const plain = base.replace(/^https:/, 'http:');
    try {
      const r = await fetch(plain, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      r.body?.cancel().catch(() => {});
      if (!(r.status >= 301 && r.status <= 308 && /^https:/i.test(r.headers.get('location') || '')))
        site('warn', 'http-to-https', 'Visitors who type http:// are not sent on to https://.');
    } catch {
      /* port 80 closed: nothing to redirect */
    }
  }
}
