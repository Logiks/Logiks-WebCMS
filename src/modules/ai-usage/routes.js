import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

const dates = (req) => ({
  from: typeof req.query.from === 'string' ? req.query.from : undefined,
  to: typeof req.query.to === 'string' ? req.query.to : undefined,
  kind: req.query.kind === 'text' || req.query.kind === 'media' ? req.query.kind : undefined,
});

/** System → AI Usage: read-only reporting over the AI call log. */
export default function aiUsageRoutes(ctx) {
  const r = Router();
  const { aiUsage } = ctx;

  r.get('/ai-usage/summary', requirePermission('aiusage.read'), async (req, res) => {
    const period = ['day', 'week', 'month'].includes(String(req.query.period))
      ? String(req.query.period)
      : 'day';
    res.json(await aiUsage.summary({ ...dates(req), period }));
  });

  r.get('/ai-usage/messages', requirePermission('aiusage.read'), async (req, res) => {
    const { limit, before } = req.query;
    res.json({ messages: await aiUsage.messages({ ...dates(req), limit, before }) });
  });

  // A download of every message with its cost and the full text. CSV cells that start with = + - @ get a leading
  // quote, because the message is whatever a person typed and spreadsheets run those as formulas.
  r.get('/ai-usage/export', requirePermission('aiusage.read'), async (req, res) => {
    const q = dates(req);
    const rows = await aiUsage.exportMessages({ ...q, kind: q.kind ?? 'text' });
    const name = `${q.kind === 'media' ? 'media' : 'text'}-usage-${new Date().toISOString().slice(0, 10)}`;
    const format = req.query.format === 'json' ? 'json' : 'csv';
    res.set('Content-Disposition', `attachment; filename="${name}.${format}"`);
    if (format === 'json') return res.json({ messages: rows });
    const cols = Object.keys(rows[0] ?? { id: 0, at: 0, email: 0, message: 0 });
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const lines = [cols.join(',')];
    for (const m of rows) lines.push(cols.map((c) => cell(m[c])).join(','));
    res.type('text/csv').send('\uFEFF' + lines.join('\r\n'));
  });

  r.get('/ai-usage/recent', requirePermission('aiusage.read'), async (req, res) => {
    const { limit, before } = req.query;
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    res.json({ calls: await aiUsage.recent({ ...dates(req), provider, limit, before }) });
  });

  return r;
}
