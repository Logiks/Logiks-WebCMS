import * as cheerio from 'cheerio';

/**
 * A journey is written as one step per line (docs/DECISIONS.md D-087):
 *   goto /pricing                    open an address on this site
 *   click Buy now                    click the button or link with that text (css=.btn for a CSS selector)
 *   fill Email = a@example.com       type into the field with that label, placeholder or name
 *   press Enter                      press a key
 *   wait 500                         pause (milliseconds, at most 5000)
 *   expect text Thank you            this text is visible
 *   expect no text Error             this text is not
 *   expect url /checkout             the address contains this
 *   expect status 200                the last page answered this
 *   expect selector .receipt         a CSS selector is visible
 *   expect title Checkout            the page title contains this
 * Lines starting with # are notes.
 * @param {string} text
 * @returns {{ steps: any[], errors: string[] }}
 */
export function parseSteps(text) {
  const steps = [];
  const errors = [];
  String(text ?? '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const at = `Line ${i + 1}`;
      let m;
      if ((m = /^goto\s+(\/\S*)$/i.exec(line))) steps.push({ line, action: 'goto', value: m[1] });
      else if (/^goto\b/i.test(line))
        errors.push(`${at}: “goto” needs an address on this site starting with /.`);
      else if ((m = /^click\s+(.+)$/i.exec(line)))
        steps.push({ line, action: 'click', value: m[1].trim() });
      else if ((m = /^fill\s+(.+?)\s*=\s*(.*)$/i.exec(line)))
        steps.push({ line, action: 'fill', target: m[1].trim(), value: m[2] });
      else if (/^fill\b/i.test(line)) errors.push(`${at}: write “fill Label = value”.`);
      else if ((m = /^press\s+(\S+)$/i.exec(line)))
        steps.push({ line, action: 'press', value: m[1] });
      else if ((m = /^wait\s+(\d{1,4})$/i.exec(line)))
        steps.push({ line, action: 'wait', value: m[1] });
      else if ((m = /^expect\s+no\s+text\s+(.+)$/i.exec(line)))
        steps.push({ line, action: 'expect-no-text', value: m[1].trim() });
      else if ((m = /^expect\s+(text|url|status|selector|title)\s+(.+)$/i.exec(line)))
        steps.push({ line, action: `expect-${m[1].toLowerCase()}`, value: m[2].trim() });
      else
        errors.push(
          `${at}: “${line.slice(0, 40)}” is not a step. Start with goto, click, fill, press, wait or expect.`,
        );
    });
  if (steps.length > 40) errors.push('A journey can have at most 40 steps.');
  if (steps.length && steps[0].action !== 'goto') errors.push('Start the journey with “goto /…”.');
  return { steps, errors };
}

/**
 * The same steps, run without a browser. Only what plain HTTP can do: goto, following a link by its text, and the
 * expectations. Steps that need a page to be rendered or typed into are reported as skipped.
 * @param {{ steps: any[], base: string }} o
 */
export async function runJourneyBasic({ steps, base }) {
  const results = [];
  let html = '';
  let url = null;
  let status = 0;
  const load = async (u) => {
    const r = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'CMS-SiteTest/1.0' },
    });
    status = r.status;
    url = r.url;
    html = await r.text();
  };
  for (const st of steps) {
    const t0 = Date.now();
    try {
      const $ = cheerio.load(html || '<html></html>');
      const text = $('body').text().replace(/\s+/g, ' ');
      switch (st.action) {
        case 'goto':
          await load(new URL(st.value, base).href);
          break;
        case 'click': {
          const a = $('a[href]')
            .toArray()
            .find((e) =>
              $(e).text().replace(/\s+/g, ' ').toLowerCase().includes(st.value.toLowerCase()),
            );
          if (!a)
            throw new Error(
              `No link with the text “${st.value}”. Buttons and scripts need a browser.`,
            );
          await load(new URL(/** @type {any} */ (a).attribs.href, url).href);
          break;
        }
        case 'wait':
          break;
        case 'expect-text':
          if (!text.toLowerCase().includes(st.value.toLowerCase()))
            throw new Error(`“${st.value}” is not on the page.`);
          break;
        case 'expect-no-text':
          if (text.toLowerCase().includes(st.value.toLowerCase()))
            throw new Error(`“${st.value}” is on the page.`);
          break;
        case 'expect-url':
          if (!String(url).includes(st.value))
            throw new Error(`The address is ${String(url).replace(base, '')}.`);
          break;
        case 'expect-status':
          if (status !== Number(st.value))
            throw new Error(`The page answered ${status}, not ${st.value}.`);
          break;
        case 'expect-selector':
          if (!$(st.value).length) throw new Error(`Nothing matches ${st.value}.`);
          break;
        case 'expect-title':
          if (!$('title').text().includes(st.value))
            throw new Error(`The page title is “${$('title').text().trim()}”.`);
          break;
        default:
          results.push({ line: st.line, ok: true, skipped: true, ms: 0 });
          continue;
      }
      results.push({ line: st.line, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      results.push({
        line: st.line,
        ok: false,
        ms: Date.now() - t0,
        error: String(e.message).slice(0, 200),
      });
      break;
    }
  }
  return {
    ok: results.every((r) => r.ok) && results.length === steps.length,
    results,
    jpeg: null,
    skipped: results.filter((r) => r.skipped).length,
  };
}

/**
 * Journeys as checks (D-087).
 * @param {import('./env.js').CheckEnv} env
 */
export async function journeyChecks(env) {
  const { ctx, add } = env;
  const rows = await ctx.db('test_journeys').where({ enabled: true }).orderBy('id');
  for (const j of rows) {
    if (await env.cancelled()) return;
    const { steps, errors } = parseSteps(j.steps);
    const where = `journey:${j.name}`;
    if (errors.length) {
      add(
        where,
        'journey',
        'journeys',
        'error',
        'journey-invalid',
        `The journey “${j.name}” cannot run: ${errors[0]}`,
        String(j.id),
      );
      continue;
    }
    const browser = env.config.mode === 'browser';
    const r = browser
      ? await ctx.visual.journey({ steps, origin: env.base })
      : await runJourneyBasic({ steps, base: env.base });
    const failed = r.results.find((x) => !x.ok);
    if (failed)
      add(
        where,
        'journey',
        'journeys',
        'error',
        'journey-failed',
        `The journey “${j.name}” stopped at “${failed.line}”: ${failed.error}`,
        `${j.id}:${failed.line}`,
        { steps: r.results },
      );
    else if (!r.ok)
      add(
        where,
        'journey',
        'journeys',
        'error',
        'journey-incomplete',
        `The journey “${j.name}” did not run all its steps.`,
        String(j.id),
      );
    if (r.skipped)
      add(
        where,
        'journey',
        'journeys',
        'info',
        'journey-needs-browser',
        `${r.skipped} step(s) of “${j.name}” need a browser (typing, buttons) and were skipped.`,
        String(j.id),
      );
    env.journeys?.push({
      id: Number(j.id),
      name: j.name,
      ok: !failed && r.ok,
      steps: r.results,
      jpeg: r.jpeg,
    });
  }
}
