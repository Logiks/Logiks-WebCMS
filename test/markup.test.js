import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkMarkup } from './helpers-markup.js';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

const root = path.resolve(import.meta.dirname, '..');

test('the checker catches a stray or missing closing tag, and leaves attribute text and comments alone', () => {
  assert.deepEqual(checkMarkup('<div><span>a</span></div>'), []);
  assert.deepEqual(checkMarkup('<div x-show="a > b && c < d"><input value="</div>"></div>'), []);
  assert.deepEqual(checkMarkup('<!-- </div> --><div></div>'), []);
  assert.deepEqual(
    checkMarkup('<ul><li>a<li>b</ul>'),
    [],
    'tags whose end tag is optional are not tracked',
  );
  assert.match(checkMarkup('<div></div></div>')[0], /<\/div> closes nothing/);
  assert.match(checkMarkup('<div><template></div></template>')[0], /<\/div> found, but <template>/);
  assert.match(checkMarkup('<div><div></div>')[0], /never closed/);
  // The kind of slip that moved a whole column of the Service editor: the tail of an old block left behind.
  const spliced =
    '<div class="row"><template x-for="a"><div>x</div></template></select></div></div></template>';
  assert.ok(checkMarkup(spliced).length > 0);
});

/** Every admin screen is a hand-written fragment; the browser repairs a broken one silently and the layout moves. */
function fragments() {
  const out = [path.join(root, 'admin/static/index.html')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (p.endsWith('.html') && p.includes(`${path.sep}admin${path.sep}`)) out.push(p);
    }
  };
  walk(path.join(root, 'src'));
  if (fs.existsSync(path.join(root, 'plugins'))) walk(path.join(root, 'plugins'));
  return out;
}

test('every admin screen has balanced tags', () => {
  const files = fragments();
  assert.ok(files.length > 40, `found ${files.length} files`);
  const bad = {};
  for (const f of files) {
    const problems = checkMarkup(fs.readFileSync(f, 'utf8'));
    if (problems.length) bad[path.relative(root, f)] = problems.slice(0, 5);
  }
  assert.deepEqual(bad, {});
});

test('Service editor: the form and the preview stay side by side, whatever is built in the Where section', async () => {
  const node = await startNode({ seed: true });
  await node.ctx.settings.update('features', { values: { public_api: true, services: true } });
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 10000, every: 50 });
    const ed = () => b.$('section[x-data^="servicesEditor"]');
    const set = (el, v) => {
      el.value = v;
      el.dispatchEvent(new b.win.Event('input', { bubbles: true }));
      el.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    };
    b.go('#/services/new');
    await wait(() => ed() && ed().querySelector('#s-name'));
    const src = ed().querySelector('#src-table');
    src.checked = true;
    src.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() =>
      [...ed().querySelectorAll('#t-table option')].some((o) => o.value === 'entries'),
    );
    set(ed().querySelector('#t-table'), 'entries');
    await wait(() => ed().querySelector('[data-add-where]'));

    const layout = () => {
      const row = ed().querySelector('.row.g-3');
      const cols = [...row.children].map((c) => c.className);
      return {
        cols,
        preview: row.querySelector(':scope > .col-lg-5 pre, :scope > .col-lg-5 .empty'),
      };
    };
    const before = layout();
    assert.deepEqual(before.cols.length, 2, `two columns side by side: ${before.cols}`);
    assert.ok(before.preview, 'the preview is in the second column');

    // Add conditions and a group, then look again.
    b.click(ed().querySelector('[data-add-where]'));
    b.click(ed().querySelector('[data-add-group]'));
    await wait(() => ed().querySelector('[data-group]'));
    b.click(
      [...ed().querySelectorAll('[data-group] button')].find(
        (x) => x.textContent === 'Add to group',
      ),
    );
    await wait(() => ed().querySelectorAll('select[aria-label="Condition"]').length === 3);
    const after = layout();
    assert.deepEqual(after.cols, before.cols, 'still the same two columns');
    assert.ok(after.preview, 'the preview is still in the second column');

    // Everything the Where section drew is inside the form column, and the rows are real Bootstrap rows.
    const form = ed().querySelector('.row.g-3 > .col-lg-7');
    for (const sel of [
      '[data-where]',
      '[data-group]',
      '[data-where-summary]',
      'select[aria-label="Condition"]',
    ])
      for (const el of ed().querySelectorAll(sel))
        assert.ok(form.contains(el), `${sel} is inside the form column`);
    assert.equal(ed().querySelectorAll('.row.g-3 > *').length, 2);
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
