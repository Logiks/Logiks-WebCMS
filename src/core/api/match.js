/**
 * Path templates for the public API (D-068): "/content/:type/*path".
 *   ":x"  exactly one segment, bound to x
 *   "*x"  one or more remaining segments, joined with "/" and bound to x (last position only)
 * No regular expressions are built from user input: the template is split once, and a request is compared segment by segment.
 */

/** @typedef {{lit: string}|{param: string}|{rest: string}} Part */

/** @param {string} template @returns {Part[]} */
export function compilePath(template) {
  const parts = template.split('/').filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('*')) {
      if (i !== parts.length - 1) throw new Error(`"${template}": a * segment must come last.`);
      return { rest: p.slice(1) };
    }
    return p.startsWith(':') ? { param: p.slice(1) } : { lit: p };
  });
}

/**
 * @param {Part[]} parts @param {string[]} segments
 * @param {{loose?: boolean}} [o] `loose`: a segment holding Liquid ("{{ slug }}") is unknown until render time, so it matches any one part
 * @returns {Record<string, string>|null}
 */
export function matchPath(parts, segments, { loose = false } = {}) {
  const params = /** @type {Record<string, string>} */ ({});
  const unknown = (/** @type {string} */ s) => loose && s.includes('{');
  for (let i = 0; i < parts.length; i++) {
    const p = /** @type {any} */ (parts[i]);
    const s = segments[i];
    if (p.rest !== undefined) {
      if (segments.length <= i) return null;
      params[p.rest] = segments.slice(i).join('/');
      return params;
    }
    if (s === undefined) return null;
    if (p.lit !== undefined) {
      if (p.lit !== s && !unknown(s)) return null;
    } else params[p.param] = s;
  }
  return segments.length === parts.length ? params : null;
}

/** The version prefixes the public API answers on. `/api/public` is the original address of /api/v1 and stays. */
export const API_PREFIXES = ['/api/v1', '/api/public'];

/** "/api/v1/content/post?x=1" → { prefix, segments } (or null if it isn't under a known prefix). */
export function splitApiPath(/** @type {string} */ pathname) {
  const prefix = API_PREFIXES.find((p) => pathname.startsWith(`${p}/`) || pathname === p);
  if (!prefix) return null;
  return {
    prefix,
    segments: pathname.slice(prefix.length).split('/').filter(Boolean),
  };
}
