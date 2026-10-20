/**
 * The PDF report (docs/DECISIONS.md D-087): a summary a manager can read, then every error and warning grouped by page,
 * with the kept pictures. Notes are summarised by kind (the CSV has every one). Drawn with pdfkit, an optional dependency,
 * so it needs no browser. The built-in PDF fonts cover Western European text only; anything else prints as "?".
 */

const COLORS = {
  error: '#b3261e',
  warn: '#b26a00',
  info: '#51626f',
  ok: '#1f6a47',
  ink: '#1b2733',
  line: '#d9dde3',
  soft: '#f1f3f6',
};
const LABEL = { error: 'Error', warn: 'Warning', info: 'Note' };
const NAMES = {
  pages: 'Pages',
  responsive: 'Responsive',
  layout: 'Layout',
  accessibility: 'Accessibility',
  seo: 'SEO',
  content: 'Content',
  security: 'Security',
  performance: 'Speed',
  spelling: 'Spelling',
  links: 'Links',
  forms: 'Forms',
  search: 'Search',
  api: 'API',
  'content-model': 'Content model',
  plugins: 'Plugins',
  languages: 'Languages',
  cluster: 'Servers',
  keyboard: 'Keyboard',
  regression: 'Visual changes',
  journey: 'Journeys',
  redirects: 'Redirects',
};

/** The standard PDF fonts cannot draw most non-Latin text; keep what they can and mark the rest. */
const clean = (s) =>
  String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[^ -~¡-ÿ]/g, '?');

/**
 * @param {{ run: any, findings: any[], shots: { path: string, viewport: string, data: Buffer }[], site: string }} data
 * @param {{ compress?: boolean }} [opts] compress:false keeps text searchable (tests)
 * @returns {Promise<Buffer>}
 */
export async function renderPdf(data, { compress = true } = {}) {
  let PDFDocument;
  try {
    ({ default: PDFDocument } = await import('pdfkit'));
  } catch {
    const e = new Error(
      'The PDF library (pdfkit) is not installed on this server. Run npm install, or download the CSV instead.',
    );
    /** @type {any} */ (e).status = 422;
    throw e;
  }
  const { run, findings, shots, site } = data;
  const s = run.summary ?? {
    counts: { error: 0, warn: 0, info: 0 },
    pages: 0,
    byCategory: {},
    viewports: [],
  };
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 56, left: 48, right: 48 },
    compress,
    bufferPages: true,
    info: { Title: `AI Testing report #${run.id}`, Author: clean(site) },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 96;
  const room = (h) => {
    if (doc.y + h > doc.page.height - 70) doc.addPage();
  };

  // ── title ──
  doc
    .fillColor(COLORS.ink)
    .font('Helvetica-Bold')
    .fontSize(22)
    .text('AI Testing report', { lineGap: 2 });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(COLORS.info)
    .text(clean(`${site}  ·  check #${run.id}  ·  ${new Date(run.createdAt).toLocaleString()}`));
  doc.moveDown(0.2);
  doc
    .fontSize(9.5)
    .text(
      clean(
        `${run.trigger === 'schedule' ? 'Automatic run' : run.trigger === 'publish' ? 'Check on publish' : 'Run by hand'}  ·  ${s.mode === 'basic' ? 'page source only (no browser)' : `real browser, ${(s.viewports || []).join(', ')}`}  ·  ${s.pages} pages  ·  ${Math.round((s.durationMs || 0) / 1000)} s  ·  status: ${run.status}`,
      ),
    );
  doc.moveDown(0.8);

  // ── headline numbers ──
  const boxes = [
    ['Errors', s.counts.error, COLORS.error],
    ['Warnings', s.counts.warn, COLORS.warn],
    ['Notes', s.counts.info, COLORS.info],
    ['Pages with errors', s.pagesWithErrors ?? 0, COLORS.ink],
  ];
  const bw = (W - 3 * 10) / 4;
  const top = doc.y;
  boxes.forEach(([label, n, color], i) => {
    const x = 48 + i * (bw + 10);
    doc.roundedRect(x, top, bw, 58, 6).fillAndStroke(COLORS.soft, COLORS.line);
    doc
      .fillColor(color)
      .font('Helvetica-Bold')
      .fontSize(24)
      .text(String(n), x + 10, top + 8, { width: bw - 20 });
    doc
      .fillColor(COLORS.info)
      .font('Helvetica')
      .fontSize(9)
      .text(label, x + 10, top + 38, { width: bw - 20 });
  });
  doc.y = top + 72;
  doc.x = 48;
  if (s.comparison) {
    doc
      .fillColor(COLORS.ink)
      .fontSize(10)
      .text(
        clean(
          `Since check #${s.comparison.previousRunId}: ${s.comparison.newCount} new problem${s.comparison.newCount === 1 ? '' : 's'}, ${s.comparison.resolvedCount} fixed.`,
        ),
      );
    doc.moveDown(0.4);
  }
  if (s.thresholdExceeded) {
    doc
      .fillColor(COLORS.error)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('The number of errors is above the alert limit set in Settings.');
    doc.font('Helvetica').moveDown(0.4);
  }

  // ── by kind (bars) ──
  const cats = Object.entries(s.byCategory || {}).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12).text('Where the findings are');
    doc.moveDown(0.3);
    const max = cats[0][1];
    for (const [cat, n] of cats.slice(0, 12)) {
      room(16);
      const y = doc.y;
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica')
        .fontSize(9)
        .text(clean(NAMES[cat] || cat), 48, y + 2, { width: 110 });
      doc.rect(160, y + 2, Math.max(2, ((W - 150) * n) / max), 9).fill(COLORS.info);
      doc.fillColor(COLORS.ink).text(String(n), 164 + Math.max(2, ((W - 150) * n) / max), y + 2);
      doc.y = y + 16;
    }
    doc.x = 48;
    doc.moveDown(0.6);
  }

  // ── what was and was not checked ──
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12).text('What was checked');
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(COLORS.ink)
    .text(clean(`Checks run: ${(s.checksRun || []).join(', ') || 'pages'}.`));
  if (s.checksSkipped?.length)
    doc.text(clean(`Not run: ${s.checksSkipped.map((c) => `${c.id} (${c.reason})`).join(', ')}.`));
  if (s.mode === 'basic')
    doc.text(
      'This server had no browser, so layout, sideways scrolling, colour contrast, cut-off text, tap targets and picture sizes were not checked.',
    );
  for (const j of s.journeys || [])
    doc.text(
      clean(
        `Journey "${j.name}": ${j.ok ? 'passed' : 'FAILED'} (${j.steps.filter((x) => x.ok).length} of ${j.steps.length} steps)`,
      ),
    );
  doc.moveDown(0.8);

  // ── errors and warnings, by page ──
  const serious = findings.filter((f) => f.severity !== 'info');
  const notes = findings.filter((f) => f.severity === 'info');
  const by = new Map();
  for (const f of serious) {
    if (!by.has(f.path)) by.set(f.path, []);
    by.get(f.path).push(f);
  }
  const pagesSorted = [...by.entries()].sort(
    (a, b) =>
      b[1].filter((f) => f.severity === 'error').length -
        a[1].filter((f) => f.severity === 'error').length || a[0].localeCompare(b[0]),
  );
  doc.addPage();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(14).text('Errors and warnings by page');
  doc.moveDown(0.5);
  if (!pagesSorted.length)
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(COLORS.ok)
      .text('No errors or warnings were found.');
  for (const [path, list] of pagesSorted) {
    room(60);
    const e = list.filter((f) => f.severity === 'error').length;
    doc.moveDown(0.4);
    doc.roundedRect(48, doc.y, W, 18, 3).fill(COLORS.soft);
    doc
      .fillColor(COLORS.ink)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(clean(path), 54, doc.y - 14, { width: W - 120, continued: false });
    doc
      .fillColor(e ? COLORS.error : COLORS.warn)
      .fontSize(9)
      .text(`${e} errors, ${list.length - e} warnings`, 48, doc.y - 12, {
        width: W - 6,
        align: 'right',
      });
    doc.y += 8;
    doc.x = 48;
    const pics = shots.filter((p) => p.path === path).slice(0, 2);
    if (pics.length) {
      room(130);
      let x = 54;
      const y = doc.y;
      for (const p of pics) {
        try {
          doc.image(p.data, x, y, { height: 110 });
          doc
            .fillColor(COLORS.info)
            .fontSize(7)
            .text(p.viewport, x, y + 112);
          x += 150;
        } catch {
          /* a picture that cannot be drawn is left out */
        }
      }
      doc.y = y + 126;
      doc.x = 48;
    }
    for (const f of list) {
      const text = clean(`${f.message}`);
      room(doc.heightOfString(text, { width: W - 90, fontSize: 9 }) + 8);
      const y = doc.y;
      doc.circle(54, y + 5, 3).fill(COLORS[f.severity]);
      doc
        .fillColor(COLORS[f.severity])
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(LABEL[f.severity].toUpperCase(), 62, y + 2, { width: 46 });
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica')
        .fontSize(9)
        .text(text, 112, y + 1, { width: W - 64 });
      const tag = clean(
        `${f.viewport === 'site' ? 'whole site' : f.viewport}${f.isNew ? ' - new' : ''}`,
      );
      doc
        .fillColor(COLORS.info)
        .fontSize(7.5)
        .text(tag, 112, doc.y, { width: W - 64 });
      doc.y += 3;
      doc.x = 48;
    }
  }

  // ── notes, by kind ──
  if (notes.length) {
    doc.addPage();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(14).text('Notes');
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORS.info)
      .text('Smaller suggestions, summed up by kind. The CSV lists every one.');
    doc.moveDown(0.5);
    const kinds = new Map();
    for (const n of notes) {
      const k = kinds.get(n.rule) ?? { n: 0, example: n.message, pages: new Set() };
      k.n++;
      k.pages.add(n.path);
      kinds.set(n.rule, k);
    }
    for (const [rule, k] of [...kinds.entries()].sort((a, b) => b[1].n - a[1].n)) {
      room(36);
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .text(clean(`${rule}  (${k.n} on ${k.pages.size} page${k.pages.size === 1 ? '' : 's'})`));
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.info).text(clean(k.example), { width: W });
      doc.moveDown(0.4);
    }
  }

  // ── footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .fillColor(COLORS.info)
      .font('Helvetica')
      .fontSize(8)
      .text(clean(`${site} - AI Testing report #${run.id}`), 48, doc.page.height - 38, {
        width: W / 2,
        lineBreak: false,
      });
    doc.text(`Page ${i + 1} of ${range.count}`, 48, doc.page.height - 38, {
      width: W,
      align: 'right',
      lineBreak: false,
    });
  }
  doc.end();
  return done;
}
