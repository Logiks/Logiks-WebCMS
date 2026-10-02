import sanitizeHtml from 'sanitize-html';
import { HttpError } from '../../core/http/errors.js';

/**
 * SVG is not HTML's ordinary case-insensitive tag soup: attributes like `viewBox` and tags like `clipPath` are
 * case-sensitive. `sanitize-html` is still the right tool (it's an existing, already-reviewed production
 * dependency — see `content/blocks.js` — not a second parser to trust), configured with `lowerCaseTags: false` /
 * `lowerCaseAttributeNames: false` so those names survive, plus an allow-list tight enough that nothing here can
 * run script, load a remote resource, or escape the SVG's own box:
 *   - no <script>, no <style> (inline presentation attributes only — avoids a stylesheet import or an
 *     expression() trick entirely), no <foreignObject> (arbitrary embedded HTML), no <image> (can point at a
 *     remote URL)
 *   - `allowedSchemes: []` — every href/xlink:href must be an internal `#fragment` reference (gradients, clipPaths,
 *     <use>), never an external URL or a `javascript:`/`data:` URI
 *   - `sanitize-html` already strips every `on*` handler and any tag/attribute not on these lists by default
 */
const TAGS = [
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'text',
  'tspan',
  'title',
  'desc',
];
const ATTRS = [
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'transform',
  'id',
  'class',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'preserveAspectRatio',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'xmlns',
  'href', // `allowedSchemes: []` below restricts this to internal #fragment references only
  'xlink:href', // the pre-SVG2 spelling of href; same restriction
];

/** @type {import('sanitize-html').IOptions} */
const OPTIONS = {
  allowedTags: TAGS,
  allowedAttributes: { '*': ATTRS },
  allowedSchemes: [],
  allowProtocolRelative: false,
  parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
  disallowedTagsMode: 'discard',
};

/**
 * @param {string} markup
 * @returns {string} sanitized SVG markup, ready to store as-is
 */
export function sanitizeSvg(markup) {
  const src = String(markup ?? '').trim();
  if (!/^<svg[\s>]/.test(src))
    throw new HttpError(422, 'invalid_image', "That file isn't an SVG (it must start with <svg>).");
  const clean = sanitizeHtml(src, OPTIONS).trim();
  if (!/^<svg[\s>]/.test(clean) || !clean.length)
    throw new HttpError(
      422,
      'invalid_image',
      'That SVG had nothing left after removing unsafe content.',
    );
  // Any href that survived the allow-list must still be an internal fragment reference, not an external URL —
  // allowedSchemes: [] blocks scheme-prefixed URLs, but a bare `path/to/thing` or `//host/thing` has no scheme to
  // reject, so it's checked explicitly here too (belt and braces: this is the one real XSS/SSRF surface in this
  // module, so it doesn't rely on a single layer of the library's config alone).
  const hrefs = [...clean.matchAll(/(?:xlink:href|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  for (const h of hrefs)
    if (h && !h.startsWith('#'))
      throw new HttpError(
        422,
        'invalid_image',
        'SVG href/xlink:href attributes may only reference an internal #fragment (no external URLs).',
      );
  return clean;
}

/** Pulls width/height out of a sanitized SVG's own viewBox or width/height attributes — best effort, never throws. */
export function svgDimensions(markup) {
  const vb = /viewBox\s*=\s*"([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)"/.exec(markup);
  if (vb) {
    const w = Math.round(Number(vb[3]));
    const h = Math.round(Number(vb[4]));
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const w = /\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/.exec(markup);
  const h = /\bheight\s*=\s*"(\d+(?:\.\d+)?)"/.exec(markup);
  if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
  return { width: null, height: null };
}
