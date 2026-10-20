import * as cheerio from 'cheerio';

const TEST_NAME = '[Site test] please ignore';

/**
 * Forms that really work (D-087). Only the site's own contact form and search are used: they are the two with a known,
 * harmless destination. The contact message a test creates is deleted again. Other forms are listed, not submitted.
 * @param {import('./env.js').CheckEnv} env
 */
export async function formChecks(env) {
  const { ctx, base, meta, add } = env;
  const seen = new Set();
  let contactDone = false;
  let searchDone = false;

  for (const [page, m] of meta) {
    for (const f of m.forms ?? []) {
      const action = f.action || page;
      const key = `${f.method}:${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.method === 'post' && /\/contact\/?$/.test(action)) {
        if (!contactDone) {
          contactDone = true;
          await contactForm(page);
        }
      } else if (f.method === 'get' && /\/search\/?$/.test(action)) {
        if (!searchDone) {
          searchDone = true;
          await searchForm(page, f);
        }
      } else if (f.method === 'post')
        add(
          page,
          'site',
          'forms',
          'info',
          'form-not-submitted',
          `A form that sends data to ${action} was not tried, because what it does is not known. Test it with a journey.`,
          action,
        );
    }
  }

  async function contactForm(page) {
    const res = await env.get(page);
    if (!res || res.status !== 200) return;
    const $ = cheerio.load(await res.text());
    const form = $('form[action$="/contact"]').first();
    if (!form.length) return;
    const hidden = {};
    form.find('input[type="hidden"]').each((_, e) => {
      hidden[/** @type {any} */ (e).attribs.name] = /** @type {any} */ (e).attribs.value ?? '';
    });
    const post = async (fields) => {
      const r = await fetch(new URL('/contact', base), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'CMS-SiteTest/1.0',
        },
        body: new URLSearchParams({ ...hidden, back: page, ...fields }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      r?.body?.cancel().catch(() => {});
      return r;
    };
    try {
      const bad = await post({ name: '', email: 'not-an-email', message: '' });
      const where = bad?.headers.get('location') || '';
      if (!bad || bad.status === 429)
        add(
          page,
          'site',
          'forms',
          'info',
          'contact-rate-limited',
          'The contact form refused the test because of its rate limit. Try again later.',
          'limit',
        );
      else if (!/error=invalid/.test(where))
        add(
          page,
          'site',
          'forms',
          'error',
          'contact-validation',
          'The contact form accepted an empty message with a bad email address.',
          'invalid',
        );
      const good = await post({
        name: TEST_NAME,
        email: 'site-test@example.com',
        message: 'Automatic check of the contact form. Safe to delete.',
      });
      const ok = good?.headers.get('location') || '';
      if (good && good.status !== 429) {
        if (!/sent=1/.test(ok))
          add(
            page,
            'site',
            'forms',
            'error',
            'contact-failed',
            `The contact form did not accept a valid message (${good.status}${ok ? `, ${ok.slice(0, 60)}` : ''}).`,
            'send',
          );
        else if (!(await findAndRemove()))
          add(
            page,
            'site',
            'forms',
            'warn',
            'contact-not-stored',
            'The contact form said “sent”, but the message does not appear under Messages.',
            'store',
          );
      }
    } finally {
      await findAndRemove().catch(() => {});
    }
  }

  async function findAndRemove() {
    const list = await ctx.site.contact.list({ limit: 20 });
    const mine = (list.items ?? list).filter((x) => x.name === TEST_NAME);
    for (const x of mine) await ctx.site.contact.remove(x.id, null);
    return mine.length > 0;
  }

  async function searchForm(page, f) {
    const q = f.fields.find((n) => ['q', 'query', 's', 'search'].includes(n)) || 'q';
    const t0 = Date.now();
    const r = await env.get(`/search?${q}=test`);
    const ms = Date.now() - t0;
    r?.body?.cancel().catch(() => {});
    if (!r || r.status >= 400)
      add(
        page,
        'site',
        'forms',
        'error',
        'search-form-failed',
        `The search form leads to a page that answers ${r?.status ?? 'nothing'}.`,
        'search',
      );
    else if (ms > 1500)
      add(
        page,
        'site',
        'forms',
        'warn',
        'search-slow',
        `Searching took ${(ms / 1000).toFixed(1)} s.`,
        'slow',
      );
  }
}
