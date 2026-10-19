/**
 * Spelling for the text a page shows (docs/DECISIONS.md D-086). Built on nspell + the US English dictionary, both
 * optional dependencies: without them the check says so instead of failing. It is a hint, not a proofreader, so it
 * errs towards silence: proper nouns (a capitalised word inside a sentence), acronyms, words with digits or inner
 * capitals, and anything on the ignore list are left alone.
 */

let loaded = null;
const load = () =>
  (loaded ??= (async () => {
    try {
      const [{ default: nspell }, { default: dict }] = await Promise.all([
        import('nspell'),
        import('dictionary-en'),
      ]);
      return nspell(dict);
    } catch {
      return null;
    }
  })());

/** Words a website uses all the time that a general dictionary may not know. */
const COMMON = [
  'login',
  'logout',
  'signup',
  'username',
  'url',
  'urls',
  'seo',
  'faq',
  'faqs',
  'api',
  'apis',
  'cms',
  'html',
  'css',
  'javascript',
  'ecommerce',
  'webinar',
  'blog',
  'blogs',
  'cta',
  'ui',
  'ux',
  'saas',
  'b2b',
  'b2c',
  'app',
  'apps',
  'wifi',
  'online',
  'offline',
  'checkout',
  'timeline',
  'roadmap',
  'onboarding',
  'backend',
  'frontend',
  'unsubscribe',
  'newsletter',
  'podcast',
  'smartphone',
  'smartphones',
  'ok',
  'etc',
  'vs',
  'pdf',
  'usd',
  'inr',
];

const WORD = /[A-Za-z][A-Za-z'’]*/g;
const stripAddresses = (s) =>
  s.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/gi, ' ').replace(/[\u00ad\u200b]/g, '');

/**
 * @param {string} text visible text, one block per line
 * @param {{ ignore?: string[] }} [opts] extra words to accept (site name, brand words, Settings → Testing)
 * @returns {Promise<{ available: boolean, misspelled: { word: string, count: number, suggestions: string[] }[], repeated: string[] }>}
 */
export async function checkSpelling(text, { ignore = [] } = {}) {
  const speller = await load();
  const repeated = new Set();
  for (const m of stripAddresses(text).matchAll(/\b([A-Za-z]{2,})\s+\1\b/gi)) {
    const w = m[1].toLowerCase();
    if (!['that', 'had', 'very'].includes(w)) repeated.add(`${m[1]} ${m[1]}`);
  }
  if (!speller) return { available: false, misspelled: [], repeated: [...repeated].slice(0, 5) };
  const ok = new Set([...COMMON, ...ignore.map((w) => String(w).toLowerCase())]);
  const found = new Map();
  for (const line of stripAddresses(text).split('\n')) {
    for (const m of line.matchAll(WORD)) {
      let w = m[0].replace(/’/g, "'").replace(/'s$/i, '');
      if (w.length < 3 || w.length > 30) continue;
      const lower = w.toLowerCase();
      if (ok.has(lower)) continue;
      const before = line[m.index - 1];
      const after = line[m.index + m[0].length];
      if (/\d/.test(before ?? '') || /\d/.test(after ?? '')) continue; // part of a code like A4 or 3D
      if (/[a-z][A-Z]/.test(w) || w === w.toUpperCase()) continue; // camelCase, ACRONYM
      const lead = line.slice(0, m.index).trimEnd();
      const startsSentence = lead === '' || /[.!?:"“”(•-]$/.test(lead);
      if (/^[A-Z]/.test(w) && !startsSentence) continue; // a name inside a sentence
      if (speller.correct(w) || speller.correct(lower)) continue;
      found.set(lower, (found.get(lower) ?? 0) + 1);
    }
  }
  const misspelled = [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word, count]) => ({ word, count, suggestions: speller.suggest(word).slice(0, 3) }));
  return { available: true, misspelled, repeated: [...repeated].slice(0, 5) };
}
