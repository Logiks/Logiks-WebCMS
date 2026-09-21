import nodemailer from 'nodemailer';
import { buildTransport, explain, fromOf } from './smtp.js';
import { render } from './templates.js';

/**
 * Outgoing email.
 *  - Configured entirely from Admin → Settings → Email; the transport is rebuilt live when settings change.
 *  - send()/sendTemplate() never block a request on SMTP: they enqueue a `mail.send` job
 *    (BullMQ in a cluster → retries with backoff, runs on worker nodes; in-process without Redis).
 *  - Job payloads are sealed with the master key: they contain recipients and reset links, and
 *    Redis keeps completed/failed job data for a while.
 */
export function createMailer({ env, settings, jobs, crypto, log, metrics }) {
  let transport = null;

  const cfg = () => settings.ns('mail');

  function build() {
    transport?.close?.();
    transport = null;
    const c = cfg();
    if (c.transport === 'smtp') {
      if (c.host) transport = buildTransport(c);
    } else if (c.transport === 'log') {
      if (env.isProd)
        log.error(
          'mail transport "log" writes reset links to the log and is ignored in production',
        );
      else transport = nodemailer.createTransport({ jsonTransport: true });
    }
  }
  build();
  settings.onChange('mail', build);

  const site = () => ({ siteName: settings.get('general.site_name') });

  const mailer = {
    /** True when a message can actually be sent. */
    enabled: () => transport !== null && Boolean(cfg().from_address),

    /** Deliver now (used by the queue worker). Throws on failure so the queue retries. */
    async deliver({ to, subject, text, html, replyTo }) {
      if (!mailer.enabled()) throw new Error('Email is not configured.');
      try {
        const info = await transport.sendMail({
          from: fromOf(cfg()),
          to,
          subject,
          text,
          html,
          ...(replyTo ? { replyTo } : {}),
        });
        if (cfg().transport === 'log')
          log.info({ to, subject, body: text }, 'email (log transport)');
        metrics?.mail.inc({ result: 'sent' });
        return info;
      } catch (e) {
        metrics?.mail.inc({ result: 'failed' });
        throw new Error(explain(e), { cause: e });
      }
    },

    /** Queue a message. Returns false (and drops it) when email isn't configured. */
    async send(message) {
      if (!mailer.enabled()) {
        metrics?.mail.inc({ result: 'dropped' });
        log.warn({ subject: message.subject }, 'email not sent: mail is not configured');
        return false;
      }
      await jobs.enqueue('mail.send', {
        sealed: crypto.encrypt(JSON.stringify(message), 'mail.job'),
      });
      return true;
    },

    sendTemplate(to, template, data = {}) {
      return mailer.send({
        to,
        ...(data.replyTo ? { replyTo: data.replyTo } : {}),
        ...render(template, { ...site(), ...data }),
      });
    },

    /** Called once at startup so worker nodes can process the queue. */
    register() {
      jobs.define('mail.send', async ({ sealed }) => {
        await mailer.deliver(JSON.parse(crypto.decrypt(sealed, 'mail.job')));
        // Return nothing on purpose: BullMQ stores a job's return value in Redis, and
        // nodemailer's delivery receipt lists the recipient addresses in plain text.
      });
    },

    async close() {
      transport?.close?.();
    },
  };
  return mailer;
}
