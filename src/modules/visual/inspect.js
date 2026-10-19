/* global document, window, getComputedStyle */
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
