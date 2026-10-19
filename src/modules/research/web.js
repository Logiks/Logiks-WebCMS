import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../../core/http/errors.js';
import { isPrivateIp } from '../libraries/mirror.js';

const MAX_REDIRECTS = 4;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PAGE_TEXT_CHARS = 12_000;
const UA = 'Mozilla/5.0 (compatible; CMS-Research/1.0)';

const fail = (m, status = 422) => new HttpError(status, 'web_failed', m);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)),
    )
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

const attr = (tag, name) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((x) => x != null);

/**
 * Plain text and pictures from an HTML page. A regex pass, not a browser: good enough to read an article, and it
 * never runs anything from the page.
 * @param {string} html
 * @param {string} base the page's address, for relative links
 */
export function extractPage(html, base) {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const metas = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(m[0], 'property') || attr(m[0], 'name');
    const val = attr(m[0], 'content');
    if (key && val) metas[key.toLowerCase()] ??= decode(val);
  }
  const abs = (u) => {
    try {
      const url = new URL(decode(u), base);
      return /^https?:$/.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const images = [];
  const seen = new Set();
  const add = (src, alt = '') => {
    const u = src && abs(src);
    if (
      !u ||
      seen.has(u) ||
      /\.(svg|ico)(\?|$)/i.test(u) ||
      /sprite|logo|icon|pixel|tracking/i.test(u)
    )
      return;
    seen.add(u);
    images.push({ src: u, alt: decode(alt).trim().slice(0, 200) });
  };
  add(metas['og:image'], metas['og:image:alt']);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    add(attr(m[0], 'src') || attr(m[0], 'data-src'), attr(m[0], 'alt'));
    if (images.length >= 20) break;
  }
  const text = decode(
    html
      .replace(
        /<(head|script|style|noscript|svg|template|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi,
        ' ',
      )
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|article|li|tr|td|th|h[1-6]|blockquote)\s*>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title,
    description: metas['og:description'] || metas.description || '',
    text: text.length > PAGE_TEXT_CHARS ? `${text.slice(0, PAGE_TEXT_CHARS)}\n…[cut]` : text,
    truncated: text.length > PAGE_TEXT_CHARS,
    images,
  };
}

/** Results from DuckDuckGo's HTML page. Its links go through a redirector; the real address is the `uddg` parameter. */
export function parseDuckDuckGo(html) {
  const out = [];
  const strip = (x) =>
    decode(x.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(attr(m[0], 'href') ?? '');
    let url;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      url = u.searchParams.get('uddg') ?? u.toString();
      if (!/^https?:\/\//i.test(url)) continue;
    } catch {
      continue;
    }
    // The snippet follows its title in the markup; take the first one after this link.
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest)?.[1] ?? '';
    out.push({ title: strip(m[1]).slice(0, 200), url, snippet: strip(snip).slice(0, 400) });
  }
  return out;
}

/**
 * Reaching out to other sites on behalf of an administrator or the assistant. A person who asks for an address is not
 * always the one who wrote it (a page can tell the assistant to fetch something), so every hop is checked against this
 * server's own network (docs/DECISIONS.md D-076's rule, reused here).
 * @param {{settings: any, fetchImpl?: typeof fetch, lookup?: (host: string) => Promise<{address: string}[]>}} deps
 */
export function createWebAccess({ settings, fetchImpl = fetch, lookup }) {
  const resolveHost = lookup ?? ((host) => dns.lookup(host, { all: true }));
  const cfg = () => settings.ns('research');

  async function assertPublic(u) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      throw fail('Only http:// and https:// addresses can be opened.');
    if (u.username || u.password) throw fail('An address with a password in it cannot be opened.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host)
      ? [{ address: host }]
      : await resolveHost(host).catch(() => {
          throw fail(
            `Could not find "${host}". This server needs internet access for this step.`,
            502,
          );
        });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
      throw fail('That address points at a private network, so it cannot be opened.');
  }

  /** GET with redirects followed by hand (each hop re-checked) and a hard size cap. */
  /** @param {string} url @param {{maxBytes: number, accept?: string, headers?: Record<string,string>, method?: string, body?: string, trustedOrigin?: string}} opts */
  async function get(
    url,
    { maxBytes, accept = '*/*', headers = {}, method = 'GET', body, trustedOrigin },
  ) {
    let current;
    try {
      current = new URL(url);
    } catch {
      throw fail('That is not a valid web address. Include https://.');
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // An address the administrator typed into Settings (their own SearXNG) may be on their network; nothing else may.
      if (current.origin !== trustedOrigin) await assertPublic(current);
      let res;
      try {
        res = await fetchImpl(current, {
          method: hop === 0 ? method : 'GET',
          body: hop === 0 ? body : undefined,
          headers: { 'user-agent': UA, accept, ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw fail(
          `Could not reach ${current.hostname} (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}).`,
          502,
        );
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current);
        continue;
      }
      if (!res.ok) throw fail(`${current.hostname} answered ${res.status}.`, 502);
      if (Number(res.headers.get('content-length') || 0) > maxBytes)
        throw fail(`That file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes)
        throw fail(`That file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      return { buf, type: res.headers.get('content-type') || '', finalUrl: current.toString() };
    }
    throw fail('That address redirects too many times.');
  }

  const json = async (url, headers, extra = {}) => {
    const { buf } = await get(url, {
      maxBytes: MAX_PAGE_BYTES,
      accept: 'application/json',
      headers,
      ...extra,
    });
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw fail('The search service answered with something unreadable.', 502);
    }
  };

  return {
    /** Which engine a search will use right now (Settings → AI Research → search engine). */
    engine() {
      const { search_engine: pick, brave_api_key: key } = cfg();
      if (pick && pick !== 'auto') return pick;
      return key ? 'brave' : 'duckduckgo';
    },

    /** Engines this server can use right now, for the Search screen. */
    engines() {
      const c = cfg();
      const need = {
        brave: c.brave_api_key,
        tavily: c.tavily_api_key,
        serper: c.serper_api_key,
        google: c.google_api_key && c.google_cx,
        searxng: c.searxng_url,
        duckduckgo: true,
      };
      return Object.entries(need).map(([id, ok]) => ({
        id,
        ready: Boolean(ok),
        current: id === this.engine(),
      }));
    },

    /**
     * Web search through the engine chosen in Settings → AI Research. DuckDuckGo needs no key but has no official API
     * (it is read from its results page), so it can change or turn us away; the error says so instead of returning nothing.
     */
    async search(query, count = 6) {
      const n = Math.min(10, Math.max(1, Number(count) || 6));
      const c = cfg();
      const engine = this.engine();
      const need = (v, what) => {
        if (!v)
          throw fail(
            `${what} is not set up. Add it under Settings → AI Research, or pick another search engine there.`,
            503,
          );
        return v;
      };
      const clip = (r) => ({
        title: decode(String(r.title ?? '')).slice(0, 200),
        url: r.url,
        snippet: decode(String(r.snippet ?? '').replace(/<[^>]+>/g, '')).slice(0, 400),
      });
      const q = encodeURIComponent(query);
      let out;
      if (engine === 'brave') {
        const r = await json(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${n}`, {
          'x-subscription-token': need(c.brave_api_key, 'The Brave Search key'),
        });
        out = (r.web?.results ?? []).map((x) => ({
          title: x.title,
          url: x.url,
          snippet: x.description,
        }));
      } else if (engine === 'tavily') {
        const r = await json(
          'https://api.tavily.com/search',
          {
            'content-type': 'application/json',
            authorization: `Bearer ${need(c.tavily_api_key, 'The Tavily key')}`,
          },
          {
            method: 'POST',
            body: JSON.stringify({ query, max_results: n }),
          },
        );
        out = (r.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
      } else if (engine === 'serper') {
        const r = await json(
          'https://google.serper.dev/search',
          {
            'content-type': 'application/json',
            'x-api-key': need(c.serper_api_key, 'The Serper key'),
          },
          {
            method: 'POST',
            body: JSON.stringify({ q: query, num: n }),
          },
        );
        out = (r.organic ?? []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet }));
      } else if (engine === 'google') {
        const r = await json(
          `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(need(c.google_api_key, 'The Google search key'))}&cx=${encodeURIComponent(need(c.google_cx, 'The Google search engine ID'))}&q=${q}&num=${Math.min(n, 10)}`,
        );
        out = (r.items ?? []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet }));
      } else if (engine === 'searxng') {
        const base = new URL(need(c.searxng_url, 'The SearXNG address'));
        const r = await json(
          `${base.origin}${base.pathname.replace(/\/$/, '')}/search?q=${q}&format=json`,
          {},
          { trustedOrigin: base.origin },
        );
        out = (r.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
      } else {
        const { buf } = await get(`https://html.duckduckgo.com/html/?q=${q}`, {
          maxBytes: MAX_PAGE_BYTES,
          accept: 'text/html',
        });
        out = parseDuckDuckGo(buf.toString('utf8'));
      }
      out = out
        .filter((x) => /^https?:\/\//i.test(x.url ?? ''))
        .slice(0, n)
        .map(clip);
      if (!out.length)
        throw fail(
          engine === 'duckduckgo'
            ? 'DuckDuckGo returned no results (it may have blocked this server, or changed its page). Pick another search engine under Settings → AI Research, or give me addresses to read.'
            : `${engine} returned no results for that search.`,
          502,
        );
      return out;
    },

    /** Openly licensed pictures (Openverse): no key, and each result says who made it and under what licence. */
    async searchImages(query, count = 8) {
      const n = Math.min(20, Math.max(1, Number(count) || 8));
      const r = await json(
        `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${n}&mature=false`,
      );
      return (r.results ?? []).slice(0, n).map((x) => ({
        url: x.url,
        thumbnail: x.thumbnail,
        title: String(x.title ?? '').slice(0, 200),
        creator: x.creator || '',
        license: `${x.license ?? ''} ${x.license_version ?? ''}`.trim(),
        pageUrl: x.foreign_landing_url,
      }));
    },

    /** Throws unless the address is a public http(s) one. The browser check on a reference page asks this for every request it makes. */
    async check(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        throw fail('That is not a valid web address. Include https://.');
      }
      await assertPublic(u);
    },

    /** The raw text of a page or stylesheet (same checks and size cap as every other read). */
    async source(url, maxBytes = MAX_PAGE_BYTES) {
      const { buf, type, finalUrl } = await get(url, {
        maxBytes,
        accept: 'text/html,text/css,*/*;q=0.5',
      });
      return { text: buf.toString('utf8'), type, finalUrl };
    },

    /** Read one page as text, with the pictures it shows. */
    async page(url) {
      const { buf, type, finalUrl } = await get(url, {
        maxBytes: MAX_PAGE_BYTES,
        accept: 'text/html,*/*;q=0.5',
      });
      if (/^image\//i.test(type))
        throw fail('That address is a picture. Use download_image for pictures.');
      if (/pdf|zip|octet-stream|audio|video/i.test(type))
        throw fail(`That address is a ${type.split(';')[0]} file, which can't be read as a page.`);
      const raw = buf.toString('utf8');
      if (/text\/plain|json/i.test(type))
        return {
          url: finalUrl,
          title: '',
          description: '',
          text: raw.slice(0, PAGE_TEXT_CHARS),
          truncated: raw.length > PAGE_TEXT_CHARS,
          images: [],
        };
      return { url: finalUrl, ...extractPage(raw, finalUrl) };
    },

    /** The bytes of a picture. The media library decides whether they really are one. */
    async image(url) {
      const { buf, type, finalUrl } = await get(url, {
        maxBytes: MAX_IMAGE_BYTES,
        accept: 'image/*',
      });
      if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type))
        throw fail('That address is not a picture.');
      return { buffer: buf, finalUrl };
    },
  };
}
