/** Text helpers every AI feature shares: secret masking, compaction and answer checks (D-146). */

const MASK = '[hidden]';
// High-confidence shapes only. A broad "anything called password" rule would also rewrite the code a person is asking the
// assistant to change, which is the opposite of what they want; the model is told names, never values, by the tools.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\benc:v1:[A-Za-z0-9+/=:_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g,
];

/** @param {string} s */
export function redact(s) {
  if (typeof s !== 'string' || s.length < 16) return s;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  return out;
}

const SKIP_KEYS = new Set([
  'type',
  'id',
  'name',
  'tool_use_id',
  'model',
  'role',
  'media_type',
  'data',
]);

/**
 * A copy of an Anthropic request with secrets masked in every text. Returns the same object when nothing needed masking,
 * so the common case costs a walk and no allocation.
 * @template T @param {T} v @returns {T}
 */
export function redactParams(v, key = '') {
  if (typeof v === 'string') return /** @type {any} */ (SKIP_KEYS.has(key) ? v : redact(v));
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = redactParams(x, key);
      if (r !== x) changed = true;
      return r;
    });
    return /** @type {any} */ (changed ? out : v);
  }
  if (v && typeof v === 'object') {
    let changed = false;
    /** @type {any} */
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = redactParams(x, k);
      if (r !== x) changed = true;
      out[k] = r;
    }
    return changed ? out : v;
  }
  return v;
}

/**
 * Shrinks text fetched for a model: trailing spaces, runs of blank lines and long runs of the same character go, and
 * anything over `max` is cut with a marker. Idempotent: compactText(compactText(x)) === compactText(x), because the marker
 * is counted inside the limit and the first pass leaves nothing for the second to change.
 * @param {string} text @param {number} [max]
 */
export function compactText(text, max = 8000) {
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([=\-_*#~.])\1{9,}/g, '$1$1$1$1$1$1$1$1')
    .trim();
  if (s.length > max) {
    const mark = '\n…[shortened]';
    s = s.slice(0, Math.max(0, max - mark.length)).trimEnd() + mark;
  }
  return s;
}

/** True when `text` holds a JSON object (the model may wrap it in a fence or a sentence, as `jsonIn` accepts). */
export function jsonValid(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) return false;
  try {
    JSON.parse(s.slice(a, b + 1));
    return true;
  } catch {
    return false;
  }
}

export const textOfMessage = (res) =>
  (res?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

/** The default answer check: some text, or a tool call. */
export const notEmpty = (res) =>
  (res?.content ?? []).some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim()));
