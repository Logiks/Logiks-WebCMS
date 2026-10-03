/**
 * The /api/v1 response envelope (D-068): every success is `{ data, meta }`.
 *   a list (`items`+`total`, or search `results`+`total`)  →  data: the array, meta: page, perPage, total, pages…
 *   anything else                                          →  data: the body as it is, meta: {}
 * Errors keep the platform-wide `{ error: { code, message } }`. The older /api/public/… addresses return the raw body.
 * @param {any} body
 */
export function envelope(body) {
  for (const key of ['items', 'results']) {
    if (body && Array.isArray(body[key]) && 'total' in body) {
      const { [key]: data, ...meta } = body;
      return { data, meta };
    }
  }
  return { data: body, meta: {} };
}
