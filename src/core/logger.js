import pino from 'pino';

/** @param {import('./env.js').Env} env */
export function createLogger(env) {
  const transport =
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined;
  return pino({
    level: env.LOG_LEVEL,
    base: { node: env.nodeId, role: env.ROLE },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.password_hash',
      ],
      censor: '[redacted]',
    },
    transport,
  });
}
