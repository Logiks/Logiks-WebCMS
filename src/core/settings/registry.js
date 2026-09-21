import { z } from 'zod';

/**
 * Settings registry. Every module declares its settings in code:
 *
 *   registry.define('mail', {
 *     title: 'Email',
 *     fields: {
 *       host:     { type: 'string', label: 'SMTP host', default: '' },
 *       password: { type: 'string', label: 'Password', secret: true },
 *     },
 *   });
 *
 * The registry is the single source of truth for defaults, validation, the
 * auto-generated admin form, secret handling and restart/hot-reload behaviour.
 *
 * Field options:
 *   type            string | text | number | boolean | select | list | json
 *   label, help, placeholder, group
 *   default         used until an admin sets a value (must itself validate)
 *   required        string must be non-empty
 *   secret          encrypted at rest, write-only in the API/UI
 *   hidden          not shown in the UI or API (internal, e.g. generated keys)
 *   generate        () => value, called once on first boot if no value exists
 *   options         [{value,label}] for select
 *   min/max/int     number bounds  (min/max also bound string length)
 *   format          'url' | 'email' for strings
 *   validate        (value) => string | null   custom check, returns an error message
 *   restartRequired change is saved but only takes effect after a restart
 */

export class SettingsError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const TYPES = new Set(['string', 'text', 'number', 'boolean', 'select', 'list', 'json']);

export function buildValidator(name, f) {
  let s;
  switch (f.type) {
    case 'string': {
      s = z
        .string()
        .trim()
        .max(f.max ?? 500);
      if (f.min) s = s.min(f.min);
      if (f.format === 'url')
        s = s.refine((v) => v === '' || URL.canParse(v), 'Must be a valid URL');
      if (f.format === 'email')
        s = s.refine(
          (v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
          'Must be a valid email address',
        );
      if (f.required) s = s.min(1, 'Required');
      break;
    }
    case 'text':
      s = z.string().max(f.max ?? 20000);
      break;
    case 'number': {
      s = z.number({ error: 'Must be a number' });
      if (f.int !== false) s = s.int('Must be a whole number');
      if (f.min !== undefined) s = s.min(f.min, `Must be at least ${f.min}`);
      if (f.max !== undefined) s = s.max(f.max, `Must be at most ${f.max}`);
      break;
    }
    case 'boolean':
      s = z.boolean({ error: 'Must be true or false' });
      break;
    case 'select':
      s = z.enum(
        f.options.map((o) => o.value),
        { error: 'Choose one of the listed options' },
      );
      break;
    case 'list':
      s = z.array(z.string().trim().min(1).max(500)).max(100);
      break;
    case 'json':
      s = z.any();
      break;
  }
  return (value) => {
    const r = s.safeParse(value);
    if (!r.success)
      throw new SettingsError(422, 'invalid_value', r.error.issues[0].message, { field: name });
    if (f.validate) {
      const msg = f.validate(r.data);
      if (msg) throw new SettingsError(422, 'invalid_value', msg, { field: name });
    }
    return r.data;
  };
}

export function createRegistry() {
  /** @type {Map<string, any>} */
  const namespaces = new Map();

  function define(namespace, def) {
    if (!/^[a-z][a-z0-9_]*$/.test(namespace))
      throw new Error(`Invalid settings namespace "${namespace}"`);
    if (namespaces.has(namespace))
      throw new Error(`Settings namespace "${namespace}" already defined`);
    const fields = {};
    for (const [key, raw] of Object.entries(def.fields)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        throw new Error(`Invalid setting key ${namespace}.${key}`);
      if (!TYPES.has(raw.type))
        throw new Error(`Unknown type "${raw.type}" for ${namespace}.${key}`);
      const f = { label: key, ...raw, key };
      f.validator = buildValidator(`${namespace}.${key}`, f);
      if (f.default === undefined) {
        f.default = {
          string: '',
          text: '',
          number: 0,
          boolean: false,
          select: f.options?.[0]?.value,
          list: [],
          json: null,
        }[f.type];
      }
      f.validator(f.default); // a default that doesn't validate is a programming error — fail at boot
      fields[key] = f;
    }
    namespaces.set(namespace, {
      namespace,
      title: def.title ?? namespace,
      description: def.description ?? '',
      order: def.order ?? 100,
      fields,
      tests: def.tests ?? {},
    });
  }

  return {
    define,
    has: (ns) => namespaces.has(ns),
    /** Remove a namespace declared at runtime (a theme that was uninstalled). Core namespaces are never removed. */
    undefine: (ns) => namespaces.delete(ns),
    get(ns) {
      const d = namespaces.get(ns);
      if (!d)
        throw new SettingsError(404, 'unknown_namespace', `Unknown settings namespace "${ns}"`);
      return d;
    },
    field(ns, key) {
      const f = this.get(ns).fields[key];
      if (!f) throw new SettingsError(404, 'unknown_setting', `Unknown setting "${ns}.${key}"`);
      return f;
    },
    all: () =>
      [...namespaces.values()].sort(
        (a, b) => a.order - b.order || a.namespace.localeCompare(b.namespace),
      ),
    validate(ns, key, value) {
      return this.field(ns, key).validator(value);
    },
    /** Parse a CFG__ns__key environment override according to the field type. */
    parseEnv(field, raw) {
      switch (field.type) {
        case 'boolean':
          return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
        case 'number':
          return Number(raw);
        case 'list':
          return String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        case 'json':
          return JSON.parse(raw);
        default:
          return String(raw);
      }
    },
  };
}

/** @typedef {ReturnType<typeof createRegistry>} Registry */
