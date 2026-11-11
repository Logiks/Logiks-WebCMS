/* global document, scrollY, innerWidth -- the page.evaluate/waitForFunction callbacks run inside the browser */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from './helpers.js';
import { chrome, playwright, skipBrowser as skip, adminPage } from './helpers-browser.js';

test(
  'Service editor, in a real browser: the preview sits beside the form and every Where condition stays on one line',
  { skip },
  async () => {
    const node = await startNode({ seed: true });
    await node.ctx.settings.update('features', { values: { public_api: true, services: true } });
    const browser = await playwright.chromium.launch({ executablePath: chrome });
    try {
      const page = await adminPage(browser, node, { hash: '/services/new' });
      await page.waitForSelector('#s-name');
      await page.click('label[for=src-table]');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('#t-table option')].some((o) => o.value === 'entries'),
      );
      await page.selectOption('#t-table', 'entries');
      await page.waitForSelector('#tc-title');
      await page.click('text=Add parameter');
      await page.fill('input[aria-label="Parameter name"]', 'q');
      await page.click('[data-add-where]');
      await page.click('[data-add-group]');
      await page.click('[data-group] >> text=Add to group');
      await page.waitForFunction(
        () => document.querySelectorAll('select[aria-label="Condition"]').length === 3,
      );
      // Make the widest case: a fixed value (an input beside the dropdown) and a parameter (with its tick).
      await page.selectOption('select[aria-label="Compare with"] >> nth=0', 'q');
      await page.selectOption('select[aria-label="Compare with"] >> nth=1', '__value__');
      await page.selectOption('select[aria-label="Compare with"] >> nth=2', 'q');
      await page.waitForTimeout(300);

      const m = await page.evaluate(() => {
        const top = (el) => el.getBoundingClientRect().top + scrollY;
        const sec = document.querySelector('section[x-data^="servicesEditor"]');
        const form = sec.querySelector('.row.g-3 > .col-lg-7');
        const side = sec.querySelector('.row.g-3 > .col-lg-5');
        const rows = [...form.querySelectorAll('.where-row')].map((r) => {
          const tops = [...r.children].filter((c) => c.offsetParent !== null).map(top);
          return { parts: tops.length, spread: Math.max(...tops) - Math.min(...tops) };
        });
        const clipped = [
          ...form.querySelectorAll('.where-row select, .where-row input.form-control'),
        ]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => el.getBoundingClientRect().width < 60).length;
        return {
          sideBesideForm:
            Math.abs(top(form) - top(side)) < 8 &&
            side.getBoundingClientRect().left > form.getBoundingClientRect().left,
          rows,
          clipped,
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.equal(m.sideBesideForm, true, 'the preview column is beside the form');
      assert.equal(m.rows.length, 3);
      for (const r of m.rows)
        assert.ok(r.spread < 8, `a condition wrapped onto another line: ${JSON.stringify(m.rows)}`);
      assert.equal(m.clipped, 0, 'no control is squeezed to nothing');
      assert.equal(m.overflowX, false, 'the page does not scroll sideways');
    } finally {
      await browser.close();
      await node.close();
    }
  },
);
