import { z } from 'zod';

/**
 * The module manifest (docs/DECISIONS.md D-067): what a feature module says about itself, in one place, so the
 * platform can order it, check it and show it — instead of that knowledge living in context.js and app.js.
 *
 * A module is a directory under src/modules/<id>/ with a `module.js` that default-exports one of these. `create`
 * builds its services onto the finished context; `routes` are the Express routers it contributes.
 */
const fn = z.custom((v) => typeof v === 'function', 'must be a function');
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const id = z
  .string()
  .regex(ID, 'use lowercase letters, numbers and hyphens, starting with a letter');

/** One declared public-API operation (D-068); the handler lives in the module's implementation, not here. */
export const apiOperation = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/, 'use "<module>.<operation>"'),
    method: z.enum(['GET', 'POST', 'PUT']).default('GET'),
    // /content/:type/*path — ":x" is one segment, "*x" the rest of the address. No version prefix.
    path: z.string().regex(/^\/[A-Za-z0-9_\-/:*]*$/, 'a path such as /content/:type'),
    summary: z.string().min(1).max(200),
    /** Query parameters this operation understands: name → short description. */
    query: z.record(z.string(), z.string()).default({}),
    /** What the answer looks like, for the OpenAPI document: 'list' | 'item' | 'object'. */
    returns: z.enum(['list', 'item', 'object']).default('object'),
    /** For POST/PUT: the JSON body's fields, name → description (for the OpenAPI document). */
    body: z.record(z.string(), z.string()).default({}),
    /** The HTTP status of a successful write (201 for a create). */
    status: z.number().int().min(200).max(299).default(200),
    /** A write that needs no API key (a contact form). Still only while "Public content API" is on, and rate-limited. */
    anonymous: z.boolean().default(false),
    /** false: the answer is per-visitor or too volatile to cache. */
    cacheable: z.boolean().default(true),
    /** An extra feature flag (a settings key) that must be on, besides the module being enabled. */
    flag: z.string().optional(),
  })
  .strict();

export const moduleManifest = z
  .object({
    id,
    label: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
    /** 'plugin' for an installed plugin (registered at run time, D-070); the built-ins are 'core'. */
    kind: z.enum(['core', 'plugin']).default('core'),
    /** true: an administrator may switch it off (System → Modules). Off hides its screens and API and stops its background work. */
    optional: z.boolean().default(false),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, 'use a version such as 1.0.0')
      .default('1.0.0'),
    requires: z.array(id).default([]),
    provides: z
      .object({
        /** Keys this module puts on the context. Checked after boot: a listed service that is missing fails start-up. */
        services: z.array(z.string()).default([]),
        /** Permission keys it uses. Each must be registered in ctx.permissions. */
        permissions: z.array(z.string()).default([]),
        /** Settings namespaces it owns. */
        settings: z.array(z.string()).default([]),
        /** Events it emits (names or patterns), for documentation and the Events screen. */
        events: z.array(z.string()).default([]),
        /** Background jobs it defines. Each must be defined on ctx.jobs. */
        jobs: z.array(z.string()).default([]),
        /** The public API operations it contributes (D-068). */
        api: z.array(apiOperation).default([]),
      })
      .default({
        services: [],
        permissions: [],
        settings: [],
        events: [],
        jobs: [],
        api: [],
      }),
    /** Builds this module's services onto the finished context. Omit when context.js already built them. */
    create: fn.optional(),
    /** `() => boolean`-style switch given ctx: is the module usable right now (e.g. behind a feature flag)? */
    enabled: fn.optional(),
    routes: z
      .object({
        /** Factories `(ctx) => Router` mounted under /api/admin, behind the admin.access check. */
        admin: z.array(fn).default([]),
        /** A factory mounted under /api/auth. */
        auth: fn.optional(),
      })
      .default({ admin: [] }),
  })
  .strict();

/** @typedef {z.infer<typeof moduleManifest>} ModuleManifest */

/**
 * Validate a descriptor; the message names the module and the first problem.
 * @param {unknown} raw
 * @returns {ModuleManifest}
 */
export function parseManifest(raw) {
  const r = moduleManifest.safeParse(raw);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  const name = /** @type {any} */ (raw)?.id ?? 'unknown';
  throw new Error(`Module "${name}": ${i.path.join('.') || 'manifest'}: ${i.message}`);
}
