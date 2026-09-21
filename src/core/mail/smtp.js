import nodemailer from 'nodemailer';

/** Build a nodemailer transport from the `mail` settings namespace values. */
export function buildTransport(c, { pool = true } = {}) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: c.require_tls,
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    pool,
    maxConnections: 3,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
}

export const fromOf = (c) =>
  c.from_name ? { name: c.from_name, address: c.from_address } : c.from_address;

/** Human-readable message for the most common SMTP failures. */
export function explain(e) {
  // nodemailer often wraps the OS error (code "ESOCKET"), so look at the message too
  const text = `${e?.code ?? ''} ${e?.errno ?? ''} ${e?.message ?? ''}`;
  if (/EAUTH|Invalid login|authentication failed|Invalid username or password/i.test(text))
    return 'The server rejected the username or password.';
  if (/ECONNREFUSED/.test(text))
    return 'The server refused the connection. Check the host and port.';
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "That host name couldn't be found.";
  if (/ETIMEDOUT|ESOCKET|ECONNRESET|timeout|wrong version number/i.test(text))
    return 'Timed out or dropped the connection. Check the host, port and TLS setting.';
  return e?.message || 'Unknown error';
}

/** Log in to the server without sending anything. */
export async function verifySmtp(c) {
  if (!c.host) throw new Error('Enter an SMTP host first.');
  const t = buildTransport(c, { pool: false });
  try {
    await t.verify();
    return { message: `Connected to ${c.host}:${c.port}${c.user ? ' and signed in' : ''}.` };
  } catch (e) {
    throw new Error(explain(e), { cause: e });
  } finally {
    t.close();
  }
}
