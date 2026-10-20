// @ts-nocheck -- these functions run in the browser page and use its DOM freely; the server side is type-checked.
/* global document, window, getComputedStyle, location, performance, NodeFilter, PerformanceObserver */
/**
 * Functions that run INSIDE the browser page (Playwright serialises them), so they must be self-contained: no imports,
 * no closure over module variables. Each returns plain JSON.
 */

/** What is mechanically wrong with a page of this site, as a person would notice it. */
export function pageReport() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '');
  const all = [...document.body.querySelectorAll('*')].slice(0, 4000);
  const overflowing = all
    .filter((el) => vis(el) && el.getBoundingClientRect().right > vw + 2)
    .filter((el) => !el.closest('[style*="overflow"], .table-responsive'))
    .slice(0, 5)
    .map(label);
  const imgs = [...document.images];
  return {
    title: document.title || '',
    metaDescription: !!(
      /** @type {any} */ (document.querySelector('meta[name="description"]'))?.content
    ),
    lang: de.lang || '',
    h1Count: document.querySelectorAll('h1').length,
    horizontalScroll: de.scrollWidth > vw + 1,
    overflowingElements: overflowing,
    brokenImages: imgs
      .filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc)
      .slice(0, 5)
      .map((i) => i.getAttribute('src')),
    imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
    emptyLinks: [...document.querySelectorAll('a')].filter((a) => {
      const h = (a.getAttribute('href') || '').trim();
      return h === '' || h === '#';
    }).length,
    formsWithoutAction: [...document.querySelectorAll('form')].filter(
      (f) =>
        !f.getAttribute('action') && !f.hasAttribute('data-cms-form') && !f.hasAttribute('@submit'),
    ).length,
    tinyText: all.filter((el) => {
      if (!vis(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        return false;
      return parseFloat(getComputedStyle(el).fontSize) < 12;
    }).length,
    smallTouchTargets:
      vw < 600
        ? [...document.querySelectorAll('a, button')].filter(
            (el) => vis(el) && el.getBoundingClientRect().height < 32,
          ).length
        : null,
    pageHeight: de.scrollHeight,
  };
}

/** Scroll the whole page once, so content that appears on scroll (and lazy pictures) is in the screenshot. */
export async function sweepScroll() {
  const step = Math.max(400, window.innerHeight - 100);
  for (let y = 0; y < document.documentElement.scrollHeight && y < 12000; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 90));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 150));
}

/** Design facts about a page: palette by area, type scale, container width, section outline, calls to action. */
export function referenceTokens() {
  const clean = (s, n = 60) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const hex = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    if (p.length > 3 && p[3] < 0.5) return null;
    return `#${p
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')}`;
  };
  const sat = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
  };
  const light = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return (r * 299 + g * 587 + b * 114) / 1000;
  };
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);
  const bump = (map, k, w = 1) => k && map.set(k, (map.get(k) || 0) + w);
  const vw = document.documentElement.clientWidth;
  const els = [...document.body.querySelectorAll('*')]
    .filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT|LINK|META|SVG|PATH)$/i.test(e.tagName))
    .slice(0, 2500);

  const bg = new Map();
  const fg = new Map();
  const accent = new Map();
  const radius = new Map();
  const fonts = new Map();
  let shadows = 0;
  for (const e of els) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.top + window.scrollY > 6000) continue;
    const cs = getComputedStyle(e);
    const b = hex(cs.backgroundColor);
    if (b) bump(bg, b, Math.min(r.width, vw) * Math.min(r.height, 1500));
    const own = [...e.childNodes]
      .filter((n) => n.nodeType === 3)
      .reduce((n, t) => n + t.textContent.trim().length, 0);
    if (own) {
      bump(fg, hex(cs.color), own * parseFloat(cs.fontSize));
      bump(fonts, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), own);
    }
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows++;
    const isBtn = e.matches('a, button, [class*="btn"], [class*="button"]');
    if (b && isBtn && sat(b) > 0.25 && light(b) > 30 && light(b) < 235) bump(accent, b);
    if (b && parseFloat(cs.borderRadius) > 0 && r.width > 40 && (isBtn || r.width < vw * 0.6))
      bump(radius, `${Math.round(parseFloat(cs.borderRadius))}px`);
  }
  const style = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e);
    return {
      font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      sizePx: Math.round(parseFloat(cs.fontSize)),
      weight: cs.fontWeight,
      lineHeight:
        cs.lineHeight === 'normal' ? 'normal' : `${Math.round(parseFloat(cs.lineHeight))}px`,
      letterSpacing: cs.letterSpacing === 'normal' ? 'normal' : cs.letterSpacing,
      color: hex(cs.color),
    };
  };
  // The centred column most content sits in.
  const widths = new Map();
  for (const e of document.querySelectorAll(
    'main > *, body > *, header > *, footer > *, section > *',
  )) {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (
      r.width > 500 &&
      r.width < vw - 30 &&
      Math.abs(parseFloat(cs.marginLeft) - parseFloat(cs.marginRight)) < 2
    )
      bump(widths, Math.round(r.width / 10) * 10);
  }
  const root = document.querySelector('main') || document.body;
  const sections = [...root.children]
    .filter((e) => e.getBoundingClientRect().height > 60 && !/^(SCRIPT|STYLE)$/i.test(e.tagName))
    .slice(0, 14)
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      heading: clean(e.querySelector('h1, h2, h3')?.textContent),
      heightPx: Math.round(e.getBoundingClientRect().height),
      images: e.querySelectorAll('img, picture, video').length,
      buttons: e.querySelectorAll('a[class*="btn"], a[class*="button"], button').length,
      forms: e.querySelectorAll('form').length,
      columns: Math.max(
        0,
        ...[...e.querySelectorAll('*')].slice(0, 300).map((p) => {
          const kids = [...p.children];
          return kids.length >= 3 && new Set(kids.map((k) => k.tagName + k.className)).size === 1
            ? kids.length
            : 0;
        }),
      ),
    }));
  const navLinks = [
    ...new Set(
      [...document.querySelectorAll('header a, nav a')]
        .map((a) => clean(a.textContent, 24))
        .filter(Boolean),
    ),
  ].slice(0, 10);
  const ctas = [
    ...new Set(
      [...document.querySelectorAll('a, button')]
        .filter((e) => {
          const cs = getComputedStyle(e);
          return (
            hex(cs.backgroundColor) && parseFloat(cs.paddingLeft) >= 10 && clean(e.textContent, 30)
          );
        })
        .map((e) => clean(e.textContent, 30)),
    ),
  ].slice(0, 6);

  return {
    title: clean(document.title, 120),
    viewportWidth: vw,
    pageHeight: document.documentElement.scrollHeight,
    page: {
      background:
        hex(getComputedStyle(document.body).backgroundColor) ||
        hex(getComputedStyle(document.documentElement).backgroundColor) ||
        '#ffffff',
    },
    palette: { backgrounds: top(bg, 6), text: top(fg, 4), accent: top(accent, 3) },
    fonts: top(fonts, 3),
    type: {
      body: style('p') || style('body'),
      h1: style('h1'),
      h2: style('h2'),
      h3: style('h3'),
      button: style('a[class*="btn"], button'),
    },
    containerWidthPx: top(widths, 1)[0] || null,
    radius: top(radius, 3),
    shadowedElements: shadows,
    navLinks,
    ctas,
    sections,
    counts: {
      images: document.images.length,
      forms: document.forms.length,
      videos: document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]')
        .length,
    },
  };
}

export async function fontsReady() {
  await document.fonts?.ready;
}

/**
 * Every layout, accessibility, SEO and content check that a page can answer about itself (D-086). Runs inside the page;
 * returns findings as plain objects plus the visible text (for the spelling check) and the same-site links.
 * @param {{ text: boolean }} opts
 */
export function auditPage(opts) {
  const findings = [];
  const add = (category, severity, rule, message, key = '', detail = null) =>
    findings.push({ category, severity, rule, message, key: String(key).slice(0, 120), detail });
  const de = document.documentElement;
  const vw = de.clientWidth;
  const small = vw < 600;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const label = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '');
  const nameOf = (el) =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent ||
      el.querySelector('img[alt]')?.getAttribute('alt') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const all = [...document.body.querySelectorAll('*')].slice(0, 5000);

  // ── layout and responsiveness ──
  if (!document.querySelector('meta[name="viewport"]'))
    add(
      'responsive',
      'error',
      'viewport-meta',
      'The page has no viewport meta tag, so phones show it zoomed out.',
    );
  if (de.scrollWidth > vw + 1) {
    const wide = all
      .filter((el) => vis(el) && el.getBoundingClientRect().right > vw + 2)
      .filter((el) => !el.closest('.table-responsive, [style*="overflow"]'))
      .slice(0, 4)
      .map(label);
    add(
      'responsive',
      'error',
      'horizontal-scroll',
      `The page scrolls sideways (${de.scrollWidth}px wide on a ${vw}px screen).${wide.length ? ` Widest: ${wide.join(', ')}.` : ''}`,
      wide[0] || '',
      { elements: wide },
    );
  }
  const clipped = all
    .filter((el) => {
      if (!vis(el) || !el.childNodes.length) return false;
      const cs = getComputedStyle(el);
      if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') return false;
      return (
        el.scrollWidth > el.clientWidth + 3 &&
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      );
    })
    .slice(0, 4);
  for (const el of clipped)
    add('layout', 'warn', 'text-clipped', `Text is cut off inside ${label(el)}.`, label(el));
  const imgs = [...document.images].filter(vis);
  for (const i of imgs) {
    const r = i.getBoundingClientRect();
    const src = i.getAttribute('src') || '';
    if (i.complete && i.naturalWidth === 0) {
      add('content', 'error', 'image-broken', `A picture did not load: ${src.slice(0, 100)}`, src);
      continue;
    }
    if (!i.naturalWidth) continue;
    const fit = getComputedStyle(i).objectFit;
    const natural = i.naturalWidth / i.naturalHeight;
    const shown = r.width / r.height;
    if ((fit === 'fill' || !fit) && Math.abs(natural - shown) / natural > 0.15 && r.width > 40)
      add(
        'layout',
        'warn',
        'image-distorted',
        `A picture is stretched out of proportion: ${src.slice(0, 100)}`,
        src,
      );
    else if (r.width > i.naturalWidth * 1.6 && r.width > 200)
      add(
        'layout',
        'info',
        'image-blurry',
        `A picture is shown much larger than it is (${i.naturalWidth}px file at ${Math.round(r.width)}px), so it may look blurry: ${src.slice(0, 100)}`,
        src,
      );
    if (i.naturalWidth > 1800 && i.naturalWidth > r.width * 3)
      add(
        'performance',
        'info',
        'image-oversized',
        `A picture is ${i.naturalWidth}px wide but shown at ${Math.round(r.width)}px: ${src.slice(0, 100)}`,
        src,
      );
  }
  const noAlt = [...document.images].filter((i) => !i.hasAttribute('alt'));
  if (noAlt.length)
    add(
      'accessibility',
      'warn',
      'image-alt',
      `${noAlt.length} picture(s) have no alt attribute.`,
      noAlt[0].getAttribute('src') || '',
    );
  const tiny = all.filter(
    (el) =>
      vis(el) &&
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) &&
      parseFloat(getComputedStyle(el).fontSize) < 12,
  );
  if (tiny.length)
    add(
      'layout',
      'info',
      'small-text',
      `${tiny.length} text elements are smaller than 12px.`,
      label(tiny[0]),
    );
  if (small) {
    const targets = [
      ...document.querySelectorAll('a[href], button, input, select, textarea'),
    ].filter((el) => vis(el) && el.type !== 'hidden' && el.getBoundingClientRect().height < 32);
    if (targets.length)
      add(
        'responsive',
        'warn',
        'touch-target',
        `${targets.length} buttons or links are shorter than 32px, hard to tap (for example ${label(targets[0])}).`,
        label(targets[0]),
      );
  }

  // ── contrast ──
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const rgba = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
  };
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // a picture or gradient: cannot tell
      const c = rgba(cs.backgroundColor);
      if (c && c[3] > 0.95) return c;
    }
    return [255, 255, 255, 1];
  };
  const bad = [];
  for (const el of all) {
    if (bad.length >= 8) break;
    if (
      !vis(el) ||
      ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
    )
      continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 1) continue;
    const fg = rgba(cs.color);
    const bg = bgOf(el);
    if (!fg || !bg || fg[3] < 0.95) continue;
    const a = lum(fg);
    const b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5))
      bad.push({
        el,
        ratio: Math.round(ratio * 10) / 10,
        text: el.textContent.trim().slice(0, 30),
      });
  }
  for (const x of bad)
    add(
      'accessibility',
      'warn',
      'contrast',
      `Low contrast (${x.ratio}:1) for “${x.text}” in ${label(x.el)}.`,
      `${label(x.el)}|${x.ratio}`,
    );

  // ── accessibility ──
  const noName = [...document.querySelectorAll('a[href], button, [role="button"]')].filter(
    (el) => vis(el) && !nameOf(el),
  );
  if (noName.length)
    add(
      'accessibility',
      'error',
      'link-name',
      `${noName.length} link(s) or button(s) have no readable name (for example ${label(noName[0])}).`,
      label(noName[0]),
    );
  const fields = [...document.querySelectorAll('input, select, textarea')].filter(
    (el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type) && vis(el),
  );
  const unlabeled = fields.filter(
    (el) =>
      !(el.labels && el.labels.length) &&
      !el.getAttribute('aria-label') &&
      !el.getAttribute('aria-labelledby') &&
      !el.getAttribute('title'),
  );
  const onlyPlaceholder = unlabeled.filter((el) => el.getAttribute('placeholder'));
  if (unlabeled.length - onlyPlaceholder.length)
    add(
      'accessibility',
      'warn',
      'form-label',
      `${unlabeled.length - onlyPlaceholder.length} form field(s) have no label.`,
      label(unlabeled.find((e) => !e.getAttribute('placeholder'))),
    );
  if (onlyPlaceholder.length)
    add(
      'accessibility',
      'info',
      'form-placeholder-only',
      `${onlyPlaceholder.length} form field(s) rely on placeholder text instead of a label.`,
      label(onlyPlaceholder[0]),
    );
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis);
  const h1s = heads.filter((h) => h.tagName === 'H1');
  if (h1s.length !== 1)
    add(
      'seo',
      'warn',
      'h1-count',
      h1s.length
        ? `The page has ${h1s.length} h1 headings; it should have one.`
        : 'The page has no h1 heading.',
    );
  let prev = 0;
  for (const h of heads) {
    const n = Number(h.tagName[1]);
    if (prev && n > prev + 1) {
      add(
        'accessibility',
        'warn',
        'heading-order',
        `Heading levels skip from h${prev} to h${n} (“${h.textContent.trim().slice(0, 40)}”).`,
        `${prev}-${n}`,
      );
      break;
    }
    prev = n;
  }
  if (!de.lang)
    add(
      'accessibility',
      'warn',
      'html-lang',
      'The page does not say what language it is in (the lang attribute on <html>).',
    );
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  const dup = [...ids.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dup.length)
    add(
      'accessibility',
      'warn',
      'duplicate-id',
      `The same id is used more than once: ${dup.slice(0, 5).join(', ')}.`,
      dup[0],
    );
  if (!document.querySelector('main, [role="main"]'))
    add(
      'accessibility',
      'info',
      'main-landmark',
      'The page has no <main> area, which screen readers use to skip to the content.',
    );

  // ── SEO and content ──
  const title = document.title.trim();
  if (!title) add('seo', 'error', 'title', 'The page has no title.');
  else if (title.length > 65)
    add(
      'seo',
      'warn',
      'title-length',
      `The title is ${title.length} characters; search results cut it off after about 60.`,
    );
  else if (title.length < 10)
    add('seo', 'info', 'title-length', `The title is only ${title.length} characters.`);
  const desc =
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
  if (!desc) add('seo', 'warn', 'meta-description', 'The page has no meta description.');
  else if (desc.length > 170 || desc.length < 50)
    add(
      'seo',
      'info',
      'meta-description-length',
      `The meta description is ${desc.length} characters; 50–160 works best.`,
    );
  if (!document.querySelector('meta[property="og:image"]'))
    add('seo', 'info', 'og-image', 'No social sharing picture (og:image).');
  const hashLinks = [...document.querySelectorAll('a')].filter(
    (a) => ['', '#'].includes((a.getAttribute('href') || '').trim()) && vis(a),
  );
  if (hashLinks.length)
    add(
      'content',
      'warn',
      'empty-link',
      `${hashLinks.length} link(s) go nowhere (empty or "#" address), for example “${nameOf(hashLinks[0]).slice(0, 40)}”.`,
      nameOf(hashLinks[0]),
    );
  const blank = [...document.querySelectorAll('a[target="_blank"]')].filter(
    (a) => !/noopener|noreferrer/.test(a.rel),
  );
  if (blank.length)
    add(
      'security',
      'info',
      'target-blank',
      `${blank.length} link(s) open a new tab without rel="noopener".`,
      blank[0].getAttribute('href') || '',
    );
  const body = document.body.innerText || '';
  const placeholders = [
    /lorem ipsum/i,
    /dolor sit amet/i,
    /your text here/i,
    /insert (?:text|heading|content)/i,
    /\bTODO\b/,
    /\bFIXME\b/,
    /dummy text/i,
    /\bplaceholder\b/i,
    /example\.(?:com|org)/i,
    /\bfeature (?:one|two|three)\b/i,
  ];
  for (const re of placeholders) {
    const m = re.exec(body);
    if (m)
      add(
        'content',
        'warn',
        'placeholder-text',
        `Placeholder text left on the page: “${body
          .slice(Math.max(0, m.index - 20), m.index + 40)
          .replace(/\s+/g, ' ')
          .trim()}”.`,
        m[0].toLowerCase(),
      );
  }

  const blockers = document.querySelectorAll(
    'head script[src]:not([async]):not([defer]):not([type="module"])',
  ).length;
  if (blockers > 1)
    add(
      'performance',
      'info',
      'render-blocking',
      `${blockers} scripts in the head block the page from showing until they load (add defer).`,
      String(blockers),
    );

  // ── text for the spelling check, and the site's own links ──
  let text = '';
  if (opts?.text) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const out = [];
    for (let n = walker.nextNode(); n && out.join(' ').length < 40000; n = walker.nextNode()) {
      const p = n.parentElement;
      if (
        !p ||
        p.closest(
          'code, pre, kbd, samp, script, style, noscript, svg, [translate="no"], [data-no-spell], textarea, option',
        )
      )
        continue;
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t.length > 1 && vis(p)) out.push(t);
    }
    text = out.join('\n');
  }
  const origin = location.origin;
  const links = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href, location.href);
      if (u.origin !== origin || !/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      if (!links.has(u.pathname + u.search))
        links.set(u.pathname + u.search, nameOf(a).slice(0, 40));
      if (links.size >= 300) break;
    } catch {
      /* not a link we can follow */
    }
  }
  // Facts about the page that checks across pages need (duplicates, canonical, structured data, forms…).
  const external = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href, location.href);
      if (/^https?:$/.test(u.protocol) && u.origin !== origin) external.add(u.href.split('#')[0]);
    } catch {
      /* not a link */
    }
  }
  const meta = {
    title,
    description: desc,
    lang: de.lang || '',
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
    noindex: /noindex/i.test(
      document.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
    ),
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => ({
      lang: l.getAttribute('hreflang'),
      href: l.getAttribute('href'),
    })),
    jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')]
      .slice(0, 6)
      .map((s) => s.textContent.slice(0, 20000)),
    forms: [...document.forms].slice(0, 6).map((f) => ({
      action: f.getAttribute('action') || '',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: [...f.elements]
        .filter((e) => e.name)
        .map((e) => e.name)
        .slice(0, 20),
    })),
    renderBlocking: [
      ...document.querySelectorAll(
        'head script[src]:not([async]):not([defer]):not([type="module"])',
      ),
    ].length,
  };
  const nav = /** @type {any} */ (performance.getEntriesByType('navigation')[0]);
  const resources = /** @type {any[]} */ (performance.getEntriesByType('resource'));
  return {
    findings,
    text,
    meta,
    external: [...external].slice(0, 100),
    lang: de.lang || '',
    links: [...links.keys()],
    perf: {
      loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : null,
      requests: resources.length + 1,
      bytes: resources.reduce((n, r) => n + (r.transferSize || 0), 0) + (nav?.transferSize || 0),
    },
  };
}

/** Let entrance animations finish (and stop endless ones) so a screenshot shows the settled page, not a frame of it. */
export async function settleAnimations() {
  for (const a of document.getAnimations?.() ?? []) {
    try {
      const t = a.effect?.getComputedTiming?.();
      if (t && t.iterations === Infinity) a.cancel();
      else a.finish();
    } catch {
      /* some animations cannot be finished; leave them */
    }
  }
  await new Promise((r) => setTimeout(r, 120));
}

/** Installed before the page loads: collects the numbers behind Core Web Vitals. */
export function installVitals() {
  window.__vitals = { lcp: 0, cls: 0, tbt: 0 };
  const watch = (type, fn) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true });
    } catch {
      /* this browser does not report it */
    }
  };
  watch('largest-contentful-paint', (e) => (window.__vitals.lcp = e.startTime));
  watch('layout-shift', (e) => {
    if (!e.hadRecentInput) window.__vitals.cls += e.value;
  });
  watch('longtask', (e) => (window.__vitals.tbt += Math.max(0, e.duration - 50)));
}
export const readVitals = () => window.__vitals || null;

/** Marks every keyboard-reachable element and records how it looks when NOT focused; also counts mouse-only controls. */
export function prepareFocus() {
  const sig = (el) => {
    const cs = getComputedStyle(el);
    return [
      cs.outlineStyle,
      cs.outlineWidth,
      cs.outlineColor,
      cs.boxShadow,
      cs.backgroundColor,
      cs.borderColor,
      cs.textDecorationLine,
      cs.color,
    ].join('|');
  };
  const sel =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const els = [...document.querySelectorAll(sel)].filter((e) => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 && r.height > 0 && !e.disabled && getComputedStyle(e).visibility !== 'hidden'
    );
  });
  els.forEach((e, i) => {
    e.setAttribute('data-test-i', String(i));
    e.__base = sig(e);
  });
  const reachable = new Set(els);
  const mouseOnly = [
    ...document.querySelectorAll(
      '[onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
    ),
  ].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return !reachable.has(e) && ![...reachable].some((f) => f.contains(e) || e.contains(f));
  });
  return {
    focusable: els.length,
    mouseOnly: mouseOnly.slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '')),
    mouseOnlyCount: mouseOnly.length,
    positiveTabindex: [...document.querySelectorAll('[tabindex]')].filter(
      (e) => Number(e.getAttribute('tabindex')) > 0,
    ).length,
  };
}

/** What has keyboard focus right now, and whether it shows that it has. */
export function focusInfo() {
  const e = document.activeElement;
  if (!e || e === document.body || e === document.documentElement) return { body: true };
  const cs = getComputedStyle(e);
  const sig = [
    cs.outlineStyle,
    cs.outlineWidth,
    cs.outlineColor,
    cs.boxShadow,
    cs.backgroundColor,
    cs.borderColor,
    cs.textDecorationLine,
    cs.color,
  ].join('|');
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const r = e.getBoundingClientRect();
  return {
    i: e.getAttribute('data-test-i'),
    name: (e.getAttribute('aria-label') || e.textContent || e.getAttribute('name') || e.id || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40),
    tag: e.tagName.toLowerCase(),
    href: e.getAttribute('href') || '',
    visible: outline || (e.__base !== undefined && e.__base !== sig),
    top: Math.round(r.top + window.scrollY),
    inView: r.bottom > 0 && r.top < window.innerHeight,
  };
}
