/* global document, innerWidth -- the page.evaluate callbacks run inside the browser */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from './helpers.js';
import { chrome, playwright, skipBrowser, adminPage } from './helpers-browser.js';

test(
  'Database screen, in a real browser: the list shows records, engine and size on one line per table, with no Drop or Truncate; the table view has three tabs in a row',
  { skip: skipBrowser },
  async () => {
    const node = await startNode({ seed: true });
    await node.ctx.db.schema.createTable('data_things', (t) => {
      t.increments('id');
      t.string('name', 40);
      t.text('notes').nullable();
    });
    await node.ctx
      .db('data_things')
      .insert([{ name: 'First', notes: 'x'.repeat(300) }, { name: 'Second' }]);
    await node.ctx.db.raw('create view data_things_view as select id, name from data_things');
    const browser = await playwright.chromium.launch({ executablePath: chrome });
    try {
      const page = await adminPage(browser, node, { width: 1440, hash: '/dbms' });
      await page.waitForSelector('[data-tables] tbody tr');
      const list = await page.evaluate(() => {
        const top = (el) => Math.round(el.getBoundingClientRect().top);
        const t = document.querySelector('[data-tables]');
        const heads = [...t.querySelectorAll('thead th')]
          .filter((h) => h.offsetParent)
          .map((h) => h.textContent.trim());
        const rows = [...t.querySelectorAll('tbody tr')].map((r) => {
          const cells = [...r.children].filter((c) => c.offsetParent !== null);
          return {
            name: r.children[1].textContent.trim(),
            spread: Math.max(...cells.map(top)) - Math.min(...cells.map(top)),
            text: r.textContent,
          };
        });
        const buttons = [...document.querySelectorAll('section button')].map((b) =>
          b.textContent.trim(),
        );
        return {
          heads,
          rows,
          buttons,
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.deepEqual(
        list.heads.slice(1).map((h) => h.toLowerCase()),
        ['name', 'type', 'engine', 'records', 'size', 'maintenance'],
        'the columns',
      );
      for (const r of list.rows)
        assert.ok(r.spread < 8, `one line per table: ${r.name} (${r.spread}px apart)`);
      const mine = list.rows.find((r) => r.name === 'data_things');
      assert.match(mine.text, /SQLite|InnoDB|heap/);
      assert.match(mine.text, /\b2\b/, 'its record count');
      assert.ok(list.buttons.includes('Optimise') && list.buttons.includes('Analyse'));
      assert.ok(
        !list.buttons.includes('Drop') && !list.buttons.includes('Truncate'),
        'no Drop or Truncate',
      );
      assert.equal(list.overflowX, false);

      await page.click('a:text-is("data_things")');
      await page.waitForSelector('[data-table-tabs]');
      await page.waitForSelector('[data-rows] tbody tr');
      const view = await page.evaluate(() => {
        const top = (el) => Math.round(el.getBoundingClientRect().top);
        const tabs = [...document.querySelectorAll('[data-table-tabs] .nav-link')];
        return {
          names: tabs.map((x) => x.textContent.trim().split(' ')[0]),
          tabsSpread: Math.max(...tabs.map(top)) - Math.min(...tabs.map(top)),
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          actionsOneLine: [...document.querySelectorAll('[data-rows] tbody tr')].every((r) => {
            const b = [...r.querySelectorAll('button')].filter((x) => x.offsetParent);
            return Math.max(...b.map(top)) - Math.min(...b.map(top)) < 4;
          }),
        };
      });
      assert.deepEqual(view.names, ['Structure', 'Data', 'Editor']);
      assert.ok(view.tabsSpread < 4, 'the tabs sit in one row');
      assert.equal(view.actionsOneLine, true, 'View, Edit and Delete sit on one line');
      assert.equal(view.overflowX, false);

      await page.click('[data-view-row] >> nth=0');
      await page.waitForSelector('[data-editor] textarea');
      const ed = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        readonly: [
          ...document.querySelectorAll('[data-editor] input.form-control, [data-editor] textarea'),
        ].every((e) => e.readOnly),
      }));
      assert.equal(ed.overflowX, false);
      assert.equal(ed.readonly, true, 'viewing a record does not allow typing');
    } finally {
      await browser.close();
      await node.close();
    }
  },
);
