import { Router } from 'express';
import { requirePermission } from '../../core/http/middleware.js';

const str = (v) => (typeof v === 'string' && v ? v : undefined);

/** Content-authoring action prefixes (Content Activity, docs/DECISIONS.md D-058) — everything an editor or
 * author would recognise as "someone changed a page/entry/file", never the security-sensitive rest of the
 * audit log (logins, settings, webhooks…). `site.file_*` covers pages/components/translations together —
 * the admin UI tells them apart from the file path prefix, since they share one underlying mechanism (siteFiles). */
const CONTENT_ACTIONS = [
  'content.',
  'term.',
  'site.file_',
  'media.',
  'menu.',
  'redirect.',
  'seo.rule_',
];

const sendExport = (res, format, entries, filename) => {
  res.set('Content-Disposition', `attachment; filename="${filename}.${format}"`);
  if (format === 'json') return res.json({ entries });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['id', 'at', 'action', 'actor', 'entity', 'entityId', 'ip', 'meta'];
  const lines = [cols.join(',')];
  for (const e of entries)
    lines.push(
      cols.map((c) => esc(c === 'meta' ? (e.meta ? JSON.stringify(e.meta) : '') : e[c])).join(','),
    );
  res.type('text/csv').send(lines.join('\r\n'));
};

export default function auditRoutes(ctx) {
  const r = Router();

  r.get('/audit', requirePermission('audit.read'), async (req, res) => {
    const { limit, before } = req.query;
    res.json({
      entries: await ctx.audit.list({
        limit,
        before,
        action: str(req.query.action),
        actorEmail: str(req.query.actorEmail),
        from: str(req.query.from),
        to: str(req.query.to),
      }),
    });
  });

  r.get('/audit/export', requirePermission('audit.read'), async (req, res) => {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const entries = await ctx.audit.export({
      action: str(req.query.action),
      actorEmail: str(req.query.actorEmail),
      from: str(req.query.from),
      to: str(req.query.to),
    });
    sendExport(res, format, entries, 'audit-log');
  });

  // ───────── Content Activity: the same audit_logs data, filtered to content-authoring actions ─────────

  r.get('/audit/content', requirePermission('content.activity'), async (req, res) => {
    const { limit, before } = req.query;
    res.json({
      entries: await ctx.audit.list({
        limit,
        before,
        actions: CONTENT_ACTIONS,
        actorEmail: str(req.query.actorEmail),
        from: str(req.query.from),
        to: str(req.query.to),
      }),
    });
  });

  r.get('/audit/content/export', requirePermission('content.activity'), async (req, res) => {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const entries = await ctx.audit.export({
      actions: CONTENT_ACTIONS,
      actorEmail: str(req.query.actorEmail),
      from: str(req.query.from),
      to: str(req.query.to),
    });
    sendExport(res, format, entries, 'content-activity');
  });

  return r;
}
