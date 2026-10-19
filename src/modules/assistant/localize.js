import { externalAssets } from './validate.js';

/**
 * A page that links a CDN would be broken twice: the site's security policy blocks it, and a live site may have no
 * internet. So when the assistant writes one, each such file is downloaded into the site (System → Libraries: npm
 * packages from npm itself, anything else as a stored copy) and the document is rewritten to use the local address.
 * What cannot be fetched stays as written and is reported, never silently dropped.
 *
 * @param {string} path
 * @param {string} text
 * @param {{libraries: any, actor: any}} deps
 * @returns {Promise<{text: string, localized: {from: string, to: string}[], failed: {url: string, reason: string}[]}>}
 */
export async function localizeAssets(path, text, { libraries, actor }) {
  const assets = externalAssets(path, text);
  if (!assets.length) return { text, localized: [], failed: [] };
  const localized = [];
  const failed = [];
  if (!actor?.can('libraries.manage')) {
    const reason =
      'You need permission to manage libraries ("libraries.manage") to download files into the site.';
    return {
      text,
      localized,
      failed: assets
        .filter((a) => a.kind !== 'data-font')
        .map((a) => ({ url: a.url.slice(0, 120), reason })),
    };
  }
  let out = text;
  for (const a of assets) {
    try {
      const r =
        a.kind === 'data-font'
          ? await libraries.mirrors.mirrorData(a.url, actor)
          : await libraries.mirrors.mirror(
              a.url.startsWith('//') ? `https:${a.url}` : a.url,
              actor,
            );
      out = out.split(a.url).join(r.url);
      localized.push({
        from: a.kind === 'data-font' ? 'embedded font' : a.url.slice(0, 80),
        to: r.url,
      });
      for (const f of r.failed ?? []) failed.push(f);
    } catch (e) {
      failed.push({
        url: a.kind === 'data-font' ? 'embedded font' : a.url.slice(0, 120),
        reason: e.message,
      });
    }
  }
  return { text: out, localized, failed };
}
