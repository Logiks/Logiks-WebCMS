/**
 * A small line diff for the Change history screen and the chat's change cards. Not git's algorithm: it only has to be
 * correct and readable. Longest common subsequence on lines, with unchanged stretches folded to `context` lines.
 * Very large inputs fall back to "everything removed, everything added" instead of an O(n·m) table.
 * @param {string|null} before null = the file did not exist
 * @param {string|null} after null = the file was deleted
 * @returns {{hunks: {t: ' '|'+'|'-'|'…', s: string}[], added: number, removed: number}}
 */
export function lineDiff(before, after, context = 3) {
  const a = before == null ? [] : before.split('\n');
  const b = after == null ? [] : after.split('\n');
  /** @type {{t: string, s: string}[]} */
  let ops = [];
  if (a.length * b.length > 4_000_000) {
    ops = [...a.map((s) => ({ t: '-', s })), ...b.map((s) => ({ t: '+', s }))];
  } else {
    // Trim the shared head and tail first: most edits touch a small middle.
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ea = a.length;
    let eb = b.length;
    while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
      ea--;
      eb--;
    }
    const x = a.slice(lo, ea);
    const y = b.slice(lo, eb);
    const w = y.length + 1;
    const t = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        t[i * w + j] =
          x[i] === y[j]
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    for (let i = 0; i < lo; i++) ops.push({ t: ' ', s: a[i] });
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        ops.push({ t: ' ', s: x[i] });
        i++;
        j++;
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ t: '-', s: x[i++] });
      else ops.push({ t: '+', s: y[j++] });
    }
    while (i < x.length) ops.push({ t: '-', s: x[i++] });
    while (j < y.length) ops.push({ t: '+', s: y[j++] });
    for (let k = ea; k < a.length; k++) ops.push({ t: ' ', s: a[k] });
  }
  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  // Fold long unchanged runs.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++)
      keep[k] = true;
  });
  const hunks = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) hunks.push({ t: '…', s: `${skipped} unchanged lines` });
      skipped = 0;
      hunks.push(o);
    } else skipped++;
  });
  if (skipped && hunks.length) hunks.push({ t: '…', s: `${skipped} unchanged lines` });
  return { hunks, added, removed };
}
