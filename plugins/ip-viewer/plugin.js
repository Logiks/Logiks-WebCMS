import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

// Strips the IPv6-mapped-IPv4 prefix (e.g. "::ffff:127.0.0.1" -> "127.0.0.1"),
// which is how Node often reports an IPv4 peer on a dual-stack socket.
function normalizeIp(addr) {
  if (!addr) return addr;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1] : addr;
}

function getClientIp(req) {
  // Check common proxy / CDN headers first (most specific / trustworthy first).
  const headerCandidates = [
    'cf-connecting-ip',   // Cloudflare
    'true-client-ip',
    'x-real-ip',          // nginx proxy
    'x-client-ip',
    'x-forwarded-for',    // generic, may be a comma-separated list
  ];

  for (const header of headerCandidates) {
    const value = req.headers[header];
    if (value) {
      // x-forwarded-for can be "client, proxy1, proxy2" — the first is the original client.
      const first = String(value).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }

  // Fall back to whatever Express/Node computed directly.
  if (req.ip) return normalizeIp(req.ip);
  if (req.socket && req.socket.remoteAddress) return normalizeIp(req.socket.remoteAddress);
  if (req.connection && req.connection.remoteAddress) return normalizeIp(req.connection.remoteAddress);

  return null;
}

export default async (ctx) => {
  const { Router } = ctx.require('express');
  const router = Router();

  // The front-end component ships in this plugin's own folder (components/ip-detector.html) and is rendered with
  // {% render "plugin/ip-viewer/ip-detector" %} — it is not copied into the site tree. Before 1.1.0 it was, so an
  // unedited old copy is removed here (an edited one is the admin's own and stays).
  try {
    const dest = 'components/ip-viewer/ip-detector.html';
    const old = ctx.siteFiles.snapshot().files.get(dest);
    if (old) {
      const shipped = await readFile(path.join(PLUGIN_DIR, 'components', 'ip-detector.html'), 'utf8');
      if (old.content === shipped) await ctx.siteFiles.remove(dest, { id: null, email: null, can: () => true });
    }
  } catch (err) {
    ctx.log.warn({ err: err.message }, 'ip-viewer: could not clean up its old component copy');
  }

  // Used by the admin screen (admin/index.html).
  router.get('/ip', (req, res) => {
    const ip = getClientIp(req);
    res.json({
      ip: ip || null,
      remoteAddress: normalizeIp((req.socket && req.socket.remoteAddress) || null),
      forwardedFor: req.headers['x-forwarded-for'] || null,
      realIp: req.headers['x-real-ip'] || null,
      cfConnectingIp: req.headers['cf-connecting-ip'] || null,
      trueClientIp: req.headers['true-client-ip'] || null,
      userAgent: req.headers['user-agent'] || null,
      user: req.user ? { id: req.user.id, email: req.user.email } : null,
      // Full raw header dump, handy for diagnosing unusual proxy setups.
      headers: req.headers,
    });
  });

  return router;
};
