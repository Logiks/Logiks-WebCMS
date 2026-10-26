import { blocksToText } from './blocks.js';
import { excerptOf } from '../site/seo.js';

/**
 * Writing aids for the content editor (D-126): focus-keyword checks, readability, basic quality, duplicate-content
 * warnings and suggested internal links. Everything here advises; nothing blocks a save. The wording rules are
 * English-minded (syllable counting, "click here"), so the readability score is a guide, not a verdict, in other languages.
 */

/** Lower case, no accents, every run of non-letters/digits a single space. Both sides of a match go through this. */
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** How many times the phrase `kw` (already normalised) occurs in `text` (normalised), as whole words. */
export function occurrences(text, kw) {
  if (!kw) return 0;
  const t = ` ${text} `;
  const k = ` ${kw} `;
  let n = 0;
  for (let i = t.indexOf(k); i !== -1; i = t.indexOf(k, i + kw.length + 1)) n++;
  return n;
}

const strip = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const words = (s) => String(s).split(/\s+/).filter(Boolean);

/** A rough English syllable count, good enough for a reading-ease score. */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const n = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, n ? n.length : 1);
}

/** Everything the checks need to know about a block document, in one pass. */
export function readDoc(doc) {
  const blocks = doc?.blocks ?? [];
  const headings = [];
  const paragraphs = [];
  const alts = [];
  const linkTexts = [];
  /** words of body text since the last heading, to spot long stretches with no subheading */
  let run = 0;
  let longestRun = 0;
  for (const b of blocks) {
    const d = b.data ?? {};
    if (b.type === 'header') {
      headings.push({ level: Number(d.level) || 2, text: strip(d.text) });
      longestRun = Math.max(longestRun, run);
      run = 0;
    } else if (b.type === 'paragraph') {
      const t = strip(d.text);
      if (t) {
        paragraphs.push(t);
        run += words(t).length;
      }
      for (const m of String(d.text ?? '').matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/gi))
        linkTexts.push(strip(m[1]));
    } else if (b.type === 'list') run += words(strip((d.items ?? []).join(' '))).length;
    else if (b.type === 'image') alts.push(strip(d.alt));
  }
  longestRun = Math.max(longestRun, run);
  return { headings, paragraphs, alts, linkTexts, longestRun, text: blocksToText(doc) };
}

const item = (id, status, message) => ({ id, status, message });

/**
 * @param {{keyword?: string, title?: string, seoTitle?: string, description?: string, suggestedDescription?: string, slug?: string}} f
 * @param {ReturnType<typeof readDoc>} r
 */
export function keywordItems(f, r) {
  const kw = norm(f.keyword);
  if (!kw)
    return [
      item(
        'kw-missing',
        'info',
        'Add a focus keyword: the phrase you want this page to be found for. The checks below then run.',
      ),
    ];
  const out = [];
  const inText = (text) => occurrences(norm(text), kw) > 0;
  const seoTitle = f.seoTitle || f.title;
  out.push(
    inText(seoTitle)
      ? item('kw-title', 'good', 'The keyword is in the search title.')
      : item(
          'kw-title',
          'bad',
          'The keyword is not in the search title. Work it in, near the start.',
        ),
  );
  const desc = f.description || f.suggestedDescription;
  out.push(
    inText(desc)
      ? item('kw-description', 'good', 'The keyword is in the search description.')
      : item('kw-description', 'bad', 'The keyword is not in the search description.'),
  );
  const slug = ` ${norm(String(f.slug ?? '').replace(/[-_/]+/g, ' '))} `;
  out.push(
    slug.includes(` ${kw} `)
      ? item('kw-slug', 'good', 'The keyword is in the address.')
      : item(
          'kw-slug',
          'warn',
          `The keyword is not in the address. Something like “${kw.replace(/ /g, '-')}” reads clearly, if the page is not live yet.`,
        ),
  );
  const first = r.paragraphs[0] ?? '';
  out.push(
    inText(words(first).slice(0, 100).join(' '))
      ? item('kw-intro', 'good', 'The keyword is in the opening paragraph.')
      : item('kw-intro', 'warn', 'The keyword is not in the opening paragraph. Mention it early.'),
  );
  const count = occurrences(norm(r.text), kw);
  const total = words(r.text).length;
  const density = total ? ((count * kw.split(' ').length) / total) * 100 : 0;
  if (!count) out.push(item('kw-content', 'bad', 'The keyword never appears in the content.'));
  else if (density > 3)
    out.push(
      item(
        'kw-content',
        'warn',
        `The keyword appears ${count} times (${density.toFixed(1)}% of the words). That reads as stuffing; use it more sparingly.`,
      ),
    );
  else
    out.push(
      item(
        'kw-content',
        'good',
        `The keyword appears ${count} time${count === 1 ? '' : 's'} in the content (${density.toFixed(1)}% of the words).`,
      ),
    );
  const subs = r.headings.filter((h) => h.level >= 2);
  if (subs.length)
    out.push(
      subs.some((h) => inText(h.text))
        ? item('kw-heading', 'good', 'The keyword is in a subheading.')
        : item('kw-heading', 'warn', 'The keyword is not in any subheading.'),
    );
  if (r.alts.length)
    out.push(
      r.alts.some(inText)
        ? item('kw-alt', 'good', 'The keyword is in an image description.')
        : item('kw-alt', 'info', 'The keyword is not in any image description.'),
    );
  return out;
}

/** The shape of the page's headings: one top-level title, no skipped levels, subheadings where the text is long. */
export function structureItems(r) {
  const out = [];
  const total = words(r.text).length;
  const h1 = r.headings.filter((h) => h.level === 1).length;
  out.push(
    h1 > 0
      ? item(
          'st-h1',
          'warn',
          `The content has ${h1} heading 1. The page title is already heading 1; start the content at heading 2.`,
        )
      : item('st-h1', 'good', 'The page title is the only heading 1.'),
  );
  let skipped = null;
  let prev = 1;
  for (const h of r.headings) {
    if (h.level > prev + 1 && !skipped) skipped = h;
    prev = h.level;
  }
  if (skipped)
    out.push(
      item(
        'st-skip',
        'warn',
        `“${skipped.text || 'A heading'}” jumps from level ${prev === skipped.level ? skipped.level - 1 : prev} to ${skipped.level}. Headings step down one level at a time, so screen readers and search engines follow the outline.`,
      ),
    );
  if (r.headings.some((h) => !h.text))
    out.push(item('st-empty', 'warn', 'A heading is empty. Fill it in or remove it.'));
  if (total > 300 && !r.headings.length)
    out.push(
      item(
        'st-none',
        'warn',
        'The text is long and has no subheadings. Break it up with heading 2s.',
      ),
    );
  else if (r.longestRun > 350)
    out.push(
      item(
        'st-run',
        'warn',
        `One stretch runs about ${r.longestRun} words without a subheading. Aim for one every 300 words or so.`,
      ),
    );
  else if (r.headings.length && !out.some((i) => i.status === 'warn'))
    out.push(item('st-ok', 'good', 'The headings break the text up well.'));
  return out;
}

/** Flesch reading ease and the habits that make text heavy going. */
export function readability(text, paragraphs) {
  const sentences = String(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
  const all = words(text);
  if (all.length < 30)
    return {
      score: null,
      label: 'Too short to measure',
      items: [
        item('rd-short', 'info', 'Write a few more sentences and the reading checks appear.'),
      ],
    };
  const syl = all.reduce((n, w) => n + syllables(w), 0);
  const avg = all.length / Math.max(1, sentences.length);
  const score = Math.max(
    0,
    Math.min(100, Math.round(206.835 - 1.015 * avg - 84.6 * (syl / all.length))),
  );
  const label =
    score >= 80
      ? 'Easy to read'
      : score >= 60
        ? 'Plain English'
        : score >= 40
          ? 'Fairly difficult'
          : 'Difficult';
  const items = [
    item(
      'rd-score',
      score >= 60 ? 'good' : score >= 40 ? 'warn' : 'bad',
      `Reading ease ${score} of 100: ${label.toLowerCase()}.`,
    ),
  ];
  const long = sentences.filter((s) => words(s).length > 25);
  const share = long.length / sentences.length;
  items.push(
    share > 0.25
      ? item(
          'rd-long',
          'warn',
          `${Math.round(share * 100)}% of sentences run past 25 words. Split a few.`,
        )
      : item('rd-long', 'good', 'Sentences are a comfortable length.'),
  );
  const fat = paragraphs.filter((p) => words(p).length > 150).length;
  if (fat)
    items.push(
      item(
        'rd-para',
        'warn',
        `${fat} paragraph${fat === 1 ? ' is' : 's are'} over 150 words. Shorter paragraphs are easier on the eye.`,
      ),
    );
  let streak = 1;
  let repeated = false;
  for (let i = 1; i < sentences.length; i++) {
    const a = norm(sentences[i - 1]).split(' ')[0];
    const b = norm(sentences[i]).split(' ')[0];
    streak = a && a === b ? streak + 1 : 1;
    if (streak >= 3) repeated = true;
  }
  if (repeated)
    items.push(
      item(
        'rd-repeat',
        'info',
        'Three sentences in a row start with the same word. Vary the opening.',
      ),
    );
  return { score, label, items };
}

/** Plain-sense quality checks that are not about search. */
export function qualityItems(f, r, { isPost }) {
  const out = [];
  const total = words(r.text).length;
  const t = String(f.title ?? '').trim();
  if (t && t.length < 15)
    out.push(item('q-title-short', 'info', 'The title is very short. A few more words say more.'));
  if (t.length > 70)
    out.push(
      item(
        'q-title-long',
        'info',
        `The title is ${t.length} characters. Under 70 reads better in lists and shares.`,
      ),
    );
  if (t.length > 8 && t === t.toUpperCase() && /[A-Z]/.test(t))
    out.push(item('q-caps', 'info', 'The title is all capitals. Sentence case reads more calmly.'));
  if (total < (isPost ? 300 : 100))
    out.push(
      item(
        'q-thin',
        'warn',
        `${total} words is thin${isPost ? ' for an article; 300 or more gives readers and search engines something to hold' : ''}.`,
      ),
    );
  if (/lorem ipsum|\bTODO\b|\bTBD\b|\bXXX\b|\{[a-z ]+\}/i.test(r.text))
    out.push(
      item(
        'q-placeholder',
        'bad',
        'Placeholder text is still in the content (lorem ipsum, TODO, or {braces}). Replace it before publishing.',
      ),
    );
  const vague = r.linkTexts.filter((x) =>
    /^(click here|here|read more|link|this)$/i.test(x),
  ).length;
  if (vague)
    out.push(
      item(
        'q-link-text',
        'warn',
        `${vague} link${vague === 1 ? ' says' : 's say'} “here” or “read more”. Link words that say where it goes.`,
      ),
    );
  if (!r.paragraphs.length && !r.headings.length)
    out.push(item('q-empty', 'bad', 'There is no text in the content yet.'));
  if (!out.length) out.push(item('q-ok', 'good', 'Nothing looks off.'));
  return out;
}

const shingles = (text, n = 5) => {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};

/**
 * Other entries that say the same thing: the same title or search text, or a good part of the same body.
 * Looks at up to 1,000 of the most recently changed entries of any type, drafts included.
 */
export async function duplicates(ctx, { title, seoTitle, description, text, entryId }) {
  const rows = await ctx
    .db('entries')
    .select('id', 'type', 'title', 'status', 'data')
    .modify((q) => entryId && q.whereNot('id', Number(entryId)))
    .orderBy('updated_at', 'desc')
    .limit(1000);
  const nt = norm(title);
  const ns = norm(seoTitle);
  const nd = norm(description);
  const mine = words(text).length >= 60 ? shingles(text) : null;
  const found = [];
  for (const r of rows) {
    let data = {};
    try {
      data = JSON.parse(r.data || '{}');
    } catch {
      /* an unreadable row is not a duplicate */
    }
    const where = { id: Number(r.id), type: r.type, title: r.title, status: r.status };
    if (nt && norm(r.title) === nt)
      found.push({ ...where, kind: 'title', message: `“${r.title}” has the same title.` });
    else if (ns && norm(data.seo_title) === ns)
      found.push({
        ...where,
        kind: 'seo_title',
        message: `“${r.title}” has the same search title.`,
      });
    else if (nd && nd.length > 40 && norm(data.seo_description) === nd)
      found.push({
        ...where,
        kind: 'seo_description',
        message: `“${r.title}” has the same search description.`,
      });
    if (mine && mine.size) {
      const other = Object.values(data).find((v) => v && Array.isArray(v.blocks));
      const theirs = other ? shingles(blocksToText(other)) : new Set();
      if (theirs.size) {
        let same = 0;
        for (const s of mine) if (theirs.has(s)) same++;
        const share = same / Math.min(mine.size, theirs.size);
        if (share >= 0.5)
          found.push({
            ...where,
            kind: 'body',
            share: Math.round(share * 100),
            message: `${Math.round(share * 100)}% of the text matches “${r.title}”${share >= 0.8 ? ' (almost the same page)' : ''}.`,
          });
      }
    }
  }
  return found.slice(0, 8);
}

/**
 * Published entries a writer might link to: those whose title the text already mentions, then ones about the keyword.
 * @param {any} ctx
 * @param {{text: string, keyword?: string, html?: string, entryId?: any, locale?: string}} a
 */
export async function suggestLinks(ctx, { text, keyword, html, entryId, locale }) {
  const body = ` ${norm(text)} `;
  const kw = norm(keyword);
  const linked = new Set(
    [...String(html ?? '').matchAll(/href\s*=\s*"([^"]*)"/gi)].map((m) => m[1].replace(/\/+$/, '')),
  );
  const out = [];
  await ctx.content.eachPublished(async (e) => {
    if (out.length >= 40 || e.id === Number(entryId) || (locale && e.locale !== locale)) return;
    const url = ctx.site.urls.entry(e);
    if (!url || linked.has(url.replace(/\/+$/, ''))) return;
    const t = norm(e.title);
    if (t.length < 5) return;
    if (body.includes(` ${t} `))
      out.push({ id: e.id, type: e.type, title: e.title, url, reason: 'mentioned' });
    else if (kw && occurrences(t, kw))
      out.push({ id: e.id, type: e.type, title: e.title, url, reason: 'related' });
  });
  out.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'mentioned' ? -1 : 1));
  return out.slice(0, 8);
}

/**
 * Search published entries by title, for the link picker.
 * @param {any} ctx
 * @param {string} q
 * @param {{limit?: number, locale?: string}} [opts]
 */
export async function searchLinks(ctx, q, { limit = 10, locale } = {}) {
  const like = `%${String(q ?? '').replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await ctx
    .db('entries')
    .where('status', 'published')
    .where('published_at', '<=', Date.now())
    .where('title', 'like', like)
    .modify((b) => locale && b.where('locale', locale))
    .orderBy('updated_at', 'desc')
    .limit(60);
  const out = [];
  for (const r of rows) {
    const url = ctx.site.urls.entry({
      id: Number(r.id),
      type: r.type,
      path: r.path,
      slug: r.slug,
      locale: r.locale,
      parentId: r.parent_id,
    });
    if (url) out.push({ id: Number(r.id), type: r.type, title: r.title, url });
    if (out.length >= limit) break;
  }
  return out;
}

/** The whole analysis for what the editor currently shows. */
export async function analyse(ctx, typeId, input, entryId = null) {
  const type = ctx.content.registry.type(typeId);
  const data = ctx.content.registry.cleanData(typeId, input.data);
  const fields = type.fields;
  const bodyKey = Object.keys(fields).find((k) => fields[k].type === 'blocks');
  const body = bodyKey ? data[bodyKey] : null;
  const r = readDoc(body);
  const suggestedDescription = excerptOf(data.excerpt || r.text, 155);
  const title = String(input.title ?? '').trim();
  const f = {
    keyword: data.focus_keyword,
    title,
    seoTitle: data.seo_title,
    description: data.seo_description,
    suggestedDescription,
    slug: input.slug,
  };
  const html = JSON.stringify(body?.blocks ?? []).replace(/\\"/g, '"');
  return {
    keyword: keywordItems(f, r),
    structure: structureItems(r),
    readability: readability(r.text, r.paragraphs),
    quality: qualityItems(f, r, { isPost: type.routing === 'blog' }),
    duplicates: await duplicates(ctx, {
      title,
      seoTitle: data.seo_title,
      description: data.seo_description,
      text: r.text,
      entryId,
    }),
    links: await suggestLinks(ctx, { text: r.text, keyword: data.focus_keyword, html, entryId }),
    wordCount: words(r.text).length,
  };
}
