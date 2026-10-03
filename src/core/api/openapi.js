/**
 * OpenAPI 3.1 documents generated from the module manifests (D-068), so the documentation cannot drift from the
 * operations that actually exist. The public document is complete for requests and describes responses by shape;
 * the admin document lists every route with the permission that guards it but does NOT describe bodies (the admin
 * routes validate with Zod inside their handlers, not in a declaration the platform can read).
 */

const ERROR = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
};

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/** "/content/:type/*path" → { path: "/content/{type}/{path}", params: ["type", "path"] } */
function toOpenApiPath(/** @type {string} */ template) {
  const params = [];
  const path = template
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':') || seg.startsWith('*')) {
        params.push(seg.slice(1));
        return `{${seg.slice(1)}}`;
      }
      return seg;
    })
    .join('/');
  return { path, params };
}

const SHAPES = {
  list: {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: { type: 'array', items: { type: 'object' } },
      meta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          perPage: { type: 'integer' },
          total: { type: 'integer' },
          pages: { type: 'integer' },
        },
      },
    },
  },
  item: {
    type: 'object',
    required: ['data', 'meta'],
    properties: { data: { type: 'object' }, meta: { type: 'object' } },
  },
  object: {
    type: 'object',
    required: ['data', 'meta'],
    properties: { data: { type: 'object' }, meta: { type: 'object' } },
  },
};

/**
 * @param {{operations: any[], version: string, title: string, serverUrl?: string}} o
 */
export function publicSpec({ operations, version, title, serverUrl = '/api/v1' }) {
  /** @type {Record<string, any>} */
  const paths = {};
  for (const op of operations) {
    const { path, params } = toOpenApiPath(op.path);
    const write = op.method !== 'GET';
    const props = Object.fromEntries(
      Object.entries(op.body ?? {}).map(([k, d]) => [k, { description: d }]),
    );
    (paths[path] ??= {})[op.method.toLowerCase()] = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.module],
      'x-module': op.module,
      'x-cacheable': op.cacheable,
      // Reads: anonymous (when the public API is on) or a key. Writes: a key scoped "<module>:write" (a contact form
      // also accepts anonymous callers).
      security: [...(!write || op.anonymous ? [{}] : []), { bearerKey: [] }, { headerKey: [] }],
      parameters: [
        ...params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        ...Object.entries(op.query).map(([name, description]) => ({
          name,
          in: 'query',
          required: false,
          description,
          schema: { type: 'string' },
        })),
      ],
      ...(write
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { type: 'object', properties: props } },
              },
            },
          }
        : {}),
      responses: {
        [op.status ?? 200]: {
          description: 'The answer, in the standard envelope.',
          content: { 'application/json': { schema: SHAPES[op.returns] } },
        },
        ...(write ? { 422: errorResponse('The request body is not valid.') } : {}),
        401: errorResponse(
          write
            ? 'An API key is needed, or the key is invalid, disabled or expired.'
            : 'The API key is invalid, disabled or expired.',
        ),
        403: errorResponse(
          write
            ? 'The API key is not allowed to write to this module.'
            : 'The API key is not allowed to read this module.',
        ),
        404: errorResponse(
          'Nothing is there, the module is switched off, or the public API is off and no API key was sent.',
        ),
        429: errorResponse('Too many requests.'),
      },
    };
  }
  paths['/info'] = {
    get: {
      operationId: 'api.info',
      summary: 'Site name, tagline and sign-in page branding.',
      tags: ['api'],
      security: [{}, { bearerKey: [] }, { headerKey: [] }],
      responses: {
        200: {
          description: 'The answer, in the standard envelope.',
          content: { 'application/json': { schema: SHAPES.object } },
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description:
        'Data from the site. Reads are open to anyone only while "Public content API" is switched on in Settings → Features; an API key works either way. Every success is `{ data, meta }`; every error is `{ error: { code, message } }`.',
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: { Error: ERROR },
      securitySchemes: {
        bearerKey: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer cms_…' },
        headerKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  };
}

import { z } from 'zod';

/** A Zod schema as JSON Schema; a schema JSON Schema can't express (a transform, a custom check) becomes "any" rather than failing the document. */
function jsonSchema(/** @type {any} */ schema, /** @type {'input'|'output'} */ io) {
  try {
    const { $schema, ...rest } = /** @type {any} */ (
      z.toJSONSchema(schema, { io, unrepresentable: 'any' })
    );
    void $schema;
    return rest;
  } catch {
    return {};
  }
}

/**
 * What share of the admin routes carry a declared schema, so the gap is a number, not a claim.
 * @param {{routesOf: (id: string) => {method: string, docs: any}[], ids: string[]}} o
 */
export function adminCoverage({ routesOf, ids }) {
  let routes = 0;
  let writes = 0;
  let bodies = 0;
  let described = 0;
  let free = 0;
  let responses = 0;
  for (const id of ids)
    for (const r of routesOf(id)) {
      routes++;
      const write = ['POST', 'PUT', 'PATCH'].includes(r.method);
      if (write) writes++;
      if (write && r.docs?.body) bodies++;
      if (write && (r.docs?.noBody || r.docs?.binary)) described++;
      if (write && r.docs?.freeForm) free++;
      if (r.docs?.response) responses++;
    }
  return {
    routes,
    writeRoutes: writes,
    withRequestSchema: bodies,
    noBodyOrFile: described,
    freeForm: free,
    withResponseSchema: responses,
  };
}

/**
 * @param {{modules: {id: string, label: string}[], routesOf: (id: string) => {method: string, path: string, permissions: string[]|null, docs?: any}[], version: string}} o
 */
export function adminSpec({ modules, routesOf, version }) {
  /** @type {Record<string, any>} */
  const paths = {};
  for (const m of modules) {
    for (const r of routesOf(m.id)) {
      if (typeof r.path !== 'string') continue;
      const path = `/admin${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
      const d = r.docs ?? {};
      const query = d.query ? jsonSchema(d.query, 'input') : null;
      (paths[path] ??= {})[r.method.toLowerCase()] = {
        operationId: `${m.id}.${r.method.toLowerCase()}.${path.replace(/[^A-Za-z0-9]+/g, '_')}`,
        tags: [m.id],
        summary: `${r.method} ${r.path}`,
        description: r.permissions
          ? `Requires: ${r.permissions.join(', ')}.`
          : 'The handler checks permissions itself.',
        'x-permissions': r.permissions,
        parameters: [
          ...params.map((name) => ({
            name,
            in: 'path',
            required: true,
            schema: d.params
              ? (jsonSchema(d.params, 'input').properties?.[name] ?? { type: 'string' })
              : { type: 'string' },
          })),
          ...Object.entries(query?.properties ?? {}).map(([name, schema]) => ({
            name,
            in: 'query',
            required: (query?.required ?? []).includes(name),
            schema,
          })),
        ],
        ...(d.body
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: jsonSchema(d.body, 'input') } },
              },
            }
          : {}),
        'x-documented': {
          request: Boolean(d.body || d.query || d.params),
          response: Boolean(d.response),
        },
        security: [{ sessionCookie: [] }],
        responses: {
          [d.status ?? 200]: d.response
            ? {
                description: 'Success.',
                content: { 'application/json': { schema: jsonSchema(d.response, 'output') } },
              }
            : { description: 'Success. The body is not described for this route.' },
          401: errorResponse('Not signed in.'),
          403: errorResponse('Missing permission, or an invalid CSRF token.'),
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Admin API',
      version,
      description:
        'Every admin route and the permission that guards it. Calls use the signed-in session cookie and an x-csrf-token header on anything that changes data. Where a route declares its schemas (docs()), its request and response are described; the rest say so.',
    },
    servers: [{ url: '/api' }],
    paths,
    components: {
      schemas: { Error: ERROR },
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'cms.sid' } },
    },
  };
}
