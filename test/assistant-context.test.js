import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, keptFrom } from '../src/modules/assistant/service.js';
import { charsOf } from '../src/modules/assistant/context.js';

const turn = (n, size = 10) => [
  { role: 'user', content: `question ${n}` },
  { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(size) }] },
];
const many = (count, size) => Array.from({ length: count }, (_, i) => turn(i, size)).flat();
const toolRound = (id, size) => [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'x' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r'.repeat(size) }] },
];

test('small turns all stay under a budget (the fixed count would have dropped them)', () => {
  const msgs = [...many(30, 20), { role: 'user', content: 'now' }];
  assert.equal(keptFrom(msgs, msgs.length - 1), 44); // legacy: last 8 turns
  assert.equal(keptFrom(msgs, msgs.length - 1, 100_000), 0);
});

test('big turns are cut sooner, and the cut jumps instead of creeping', () => {
  const msgs = [...many(40, 8000), { role: 'user', content: 'now' }];
  const cut = keptFrom(msgs, msgs.length - 1, 20_000);
  assert.ok(cut > 0 && cut < msgs.length - 2);
  // One more turn arrives: while the turns after the old cut still fit, the cut does not move (cache stays valid).
  const more = [...msgs.slice(0, -1), ...turn(99, 100), { role: 'user', content: 'again' }];
  const floor = cut; // the summary stopped at the cut
  assert.equal(keptFrom(more, more.length - 1, 20_000, floor), cut);
});

test('the newest earlier turn is always kept, even when it alone exceeds the budget', () => {
  const msgs = [...turn(0, 400_000), { role: 'user', content: 'now' }];
  assert.equal(keptFrom(msgs, msgs.length - 1, 1000), 0);
});

test('a long task shrinks old tool results in the current turn, keeping the latest whole', () => {
  const msgs = [{ role: 'user', content: 'build it' }];
  for (let i = 0; i < 12; i++) msgs.push(...toolRound(`t${i}`, 8000));
  const stats = {};
  const out = compactHistory(msgs, 0, new Map(), '', { budget: 12_000, stats });
  assert.ok(stats.stubbed > 0);
  assert.ok(charsOf(out) < charsOf(msgs) / 3);
  const results = out
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result');
  assert.equal(results.length, 12); // pairs intact
  assert.ok(results.at(-1).content.length >= 8000); // latest untouched
  assert.match(results[0].content, /dropped to save space/);
});

test('nothing is shrunk when the request fits, or when no budget is set', () => {
  const msgs = [{ role: 'user', content: 'go' }, ...toolRound('a', 3000), ...toolRound('b', 3000)];
  const stats = {};
  const out = compactHistory(msgs, 0, new Map(), '', { budget: 100_000, stats });
  assert.equal(stats.stubbed, 0);
  assert.deepEqual(out, msgs);
  assert.deepEqual(compactHistory(msgs, 0), msgs);
});
