/**
 * Describe an admin route for the OpenAPI document (D-070). It changes nothing at run time: it is a middleware that calls
 * next(), tagged with the Zod schemas the route already validates with, so the document is built from the same schemas the
 * handler uses and cannot drift from them.
 *
 *   r.post('/seo/rules', requirePermission('seo.write'), docs({ body: ruleSchema, response: oneRule }), handler)
 *
 * `body`/`query`/`params`: what the route accepts. A route with no JSON body says `noBody: true`; one that takes a raw file
 * says `binary: '<content type>'`; one whose body a service checks itself says `freeForm: '<what it is>'` (listed apart, since
 * that is a description, not a schema). `response`: what it answers with on success (a test parses real
 * answers against it). `status`: the success status when it is not 200.
 * @param {{summary?: string, noBody?: boolean, binary?: string, freeForm?: string, body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType, response?: import('zod').ZodType, status?: number}} d
 */
export const docs = (d) =>
  Object.assign(
    (/** @type {any} */ _req, /** @type {any} */ _res, /** @type {any} */ next) => next(),
    {
      docs: d,
    },
  );
