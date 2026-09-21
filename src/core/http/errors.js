import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}
export const unauthorized = (msg = 'Sign in to continue.') =>
  new HttpError(401, 'unauthenticated', msg);
export const forbidden = (msg = "You don't have permission to do that.") =>
  new HttpError(403, 'forbidden', msg);
export const notFound = (what = 'Item') => new HttpError(404, 'not_found', `${what} not found.`);

/** Validate with a Zod schema; throws a 422 whose message names the first problem. */
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    const field = i.path.join('.');
    throw new HttpError(422, 'invalid_input', field ? `${field}: ${i.message}` : i.message, {
      field,
    });
  }
  return r.data;
}

export const apiNotFound = (_req, _res, next) =>
  next(new HttpError(404, 'not_found', 'No such endpoint.'));

/** @param {import('pino').Logger} log @param {boolean} isProd */
export function errorHandler(log, isProd) {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    let status = err.status || err.statusCode || 500;
    let code = err.code || 'internal_error';
    let message = err.message;

    if (err.code === 'EBADCSRFTOKEN') {
      status = 403;
      code = 'bad_csrf';
      message = 'Your session token expired. Reload the page and try again.';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      code = 'bad_json';
      message = 'Request body is not valid JSON.';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      code = 'too_large';
      message = 'Request body is too large.';
    } else if (err instanceof z.ZodError) {
      status = 422;
      code = 'invalid_input';
      message = err.issues[0]?.message ?? 'Invalid input';
    }

    if (status >= 500) {
      (req.log ?? log).error({ err }, 'unhandled error');
      if (isProd) message = 'Something went wrong on our side.';
    }
    res.status(status).json({
      error: {
        code: typeof code === 'string' ? code : 'error',
        message,
        ...(err.field ? { field: err.field } : {}),
        ...(err.currentVersion !== undefined ? { currentVersion: err.currentVersion } : {}),
      },
    });
  };
}
