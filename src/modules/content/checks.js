import { blocksToText, headingIds } from './blocks.js';
import { excerptOf } from '../site/seo.js';

const LIMITS = {
  seoTitle: 60,
  descMin: 70,
  descMax: 160,
  bigImage: 500 * 1024,
  bigFile: 5_000_000,
};
const HREF = /href\s*=\s*"([^"]*)"/gi;

/** Every inline-HTML field of a block document, so links can be pulled out of any of them. */
function htmlOf(doc) {
  const out = [];
  for (const b of doc?.blocks ?? []) {
    const d = b.data ?? {};
    for (const k of ['text', 'caption']) if (typeof d[k] === 'string') out.push(d[k]);
    if (Array.isArray(d.items)) out.push(...d.items);
    if (Array.isArray(d.rows)) for (const r of d.rows) out.push(...r);
  }
  return out;
}

/**
 * The pre-publish checklist: what is missing or likely wrong, each with how to fix it. Nothing here blocks saving —
 * the person decides — except content that the server would refuse anyway, which is reported as an error.
 *
 * Links are checked against this site only (pages of the site tree, published entries, redirects). External addresses
 * are not fetched: doing that from the server on an editor's behalf would be an open door to internal networks.
 * @param {any} ctx
 * @param {string} typeId
 * @param {{title?: string, slug?: string, data?: any}} input what the editor currently shows
 * @param {number|null} [entryId]
 */
export async function runChecks(ctx, typeId, input, entryId = null) {
  const type = ctx.content.registry.type(typeId);
  const checks = [];
  const add = (id, level, message, fix) => checks.push({ id, level, message, fix });

  let data;
  try {
    data = ctx.content.registry.cleanData(typeId, input.data);
  } catch (e) {
    add('invalid', 'error', e.message, 'Fix this before saving.');
    return { checks, suggestedDescription: '' };
  }
  const fields = type.fields;
  const title = String(input.title ?? '').trim();
  const body = data.body && fields.body?.type === 'blocks' ? data.body : null;
  const bodyText = body ? blocksToText(body) : '';
  const suggestedDescription = excerptOf(data.excerpt || bodyText, 155);

  if ('seo_description' in fields) {
    const d = String(data.seo_description ?? '').trim();
    if (!d)
      add(
        'meta-description',
        'warn',
        suggestedDescription
          ? 'No search description. Search engines will show this instead: “' +
              suggestedDescription +
              '”'
          : 'No search description.',
        'Write one in “Search description”, about 150 characters.',
      );
    else if (d.length < LIMITS.descMin || d.length > LIMITS.descMax)
      add(
        'meta-description-length',
        'info',
        `The search description is ${d.length} characters. Around 120–160 shows in full.`,
        'Shorten or extend it.',
      );
  }
  if ('seo_title' in fields && String(data.seo_title ?? '').length > LIMITS.seoTitle)
    add(
      'seo-title-length',
      'info',
      `The search title is ${String(data.seo_title).length} characters. Search results cut it off after about ${LIMITS.seoTitle}.`,
      'Shorten “Search title”.',
    );
  if ('featured_image' in fields && !data.featured_image)
    add(
      'featured-image',
      'warn',
      'No featured image, so shares and lists show a blank.',
      'Choose one under “Featured image”.',
    );

  // Images: description for screen readers, and weight.
  const ids = [
    ...new Set(
      [
        ...(body?.blocks ?? []).filter((b) => b.type === 'image').map((b) => b.data.mediaId),
        data.featured_image,
      ].filter(Boolean),
    ),
  ];
  const described = ids.length ? await ctx.media.describeMany(ids) : new Map();
  const noAlt = (body?.blocks ?? []).filter(
    (b) =>
      b.type === 'image' && b.data.mediaId && !b.data.alt && !described.get(b.data.mediaId)?.alt,
  ).length;
  if (noAlt)
    add(
      'image-alt',
      'warn',
      `${noAlt} image${noAlt === 1 ? ' has' : 's have'} no description, so screen readers and search engines can't tell what ${noAlt === 1 ? 'it shows' : 'they show'}.`,
      'Fill in “Describe the image” on each one.',
    );
  const heavy = [...described.values()].filter((m) => m.size > LIMITS.bigImage);
  if (heavy.length)
    add(
      'image-size',
      'info',
      `${heavy.length} image${heavy.length === 1 ? ' is' : 's are'} over ${LIMITS.bigImage / 1024} KB (${heavy
        .map((m) => m.filename)
        .slice(0, 3)
        .join(', ')}). Large images slow the page down.`,
      'Compress them in the Media library, or upload a smaller one.',
    );

  // Headings and length.
  if (body) {
    const h1 = body.blocks.filter((b) => b.type === 'header' && b.data.level === 1).length;
    if (h1 > 1)
      add(
        'multiple-h1',
        'info',
        `There are ${h1} top-level headings. A page reads best with one; the title is already one.`,
        'Use heading 2 or smaller inside the content.',
      );
    if (bodyText.length < 150)
      add(
        'thin',
        'info',
        'The content is very short.',
        'Pages with more substance rank and read better.',
      );
  }

  // Links on this site that lead nowhere.
  const hrefs = new Set();
  if (body) for (const h of htmlOf(body)) for (const m of h.matchAll(HREF)) hrefs.add(m[1]);
  const internal = [...hrefs].filter((h) => /^\/(?!\/)/.test(h));
  if (internal.length) {
    const redirects = await ctx.site.redirects.map();
    const live = new Set();
    await ctx.content.eachPublished((e) => {
      if (live.size > 20_000) return;
      const u = ctx.site.urls.entry(e);
      if (u) live.add(u.replace(/\/+$/, '') || '/');
    });
    const broken = internal.filter((h) => {
      const path = h.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
      if (path.startsWith('/media/') || path.startsWith('/theme/')) return false;
      if (redirects[path]) return false;
      const m = ctx.sitePages.match(path);
      if (m && !Object.keys(m.params ?? {}).length) return false;
      return !live.has(path);
    });
    if (broken.length)
      add(
        'broken-links',
        'warn',
        `${broken.length} link${broken.length === 1 ? '' : 's'} on this site lead${broken.length === 1 ? 's' : ''} nowhere: ${broken.slice(0, 5).join(', ')}`,
        'Fix the address, or publish the page it points to.',
      );
  }
  // "#section" links point at a heading of this same content; headings get their ids from their words, so a renamed
  // heading silently orphans the link.
  if (body) {
    const anchors = new Set(headingIds(body).values());
    const lost = [...hrefs].filter(
      (h) => h.length > 1 && h.startsWith('#') && !anchors.has(h.slice(1)),
    );
    if (lost.length)
      add(
        'broken-anchors',
        'warn',
        `${lost.length} link${lost.length === 1 ? '' : 's'} to a heading on this page lead${lost.length === 1 ? 's' : ''} nowhere: ${lost.slice(0, 5).join(', ')}`,
        'The address of a heading is its words in lower case with hyphens, for example #getting-started. Fix the link, or rename the heading back.',
      );
  }
  const bad = [...hrefs].filter((h) => h && !/^(https?:\/\/\S+|mailto:|tel:|\/|#|\?)/i.test(h));
  if (bad.length)
    add(
      'bad-links',
      'warn',
      `Unusable link address: ${bad.slice(0, 3).join(', ')}`,
      'Links start with https://, mailto:, tel:, or / for this site.',
    );

  // The address of something that is live.
  if (entryId) {
    const prev = await ctx.content.get(entryId).catch(() => null);
    if (prev?.status === 'published' && input.slug && input.slug !== prev.slug)
      add(
        'slug-changed',
        'warn',
        `This is live at /${prev.path}. Changing the address breaks links and search results that point to it.`,
        'Tick “Redirect the old address” so visitors still arrive.',
      );
  }
  if (!title) add('title', 'error', 'The title is empty.', 'Give it a title.');
  return { checks, suggestedDescription };
}
