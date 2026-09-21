/**
 * A middleware whose implementation is rebuilt when settings change, without a restart.
 * Used for things configured at construction time (session cookie/secret, CSP).
 * @param {import('../settings/service.js').SettingsService} settings
 * @param {string} namespace
 * @param {(values: any) => import('express').RequestHandler} build
 * @param {string[]} [keys] only rebuild when one of these keys changes
 */
export function hotSwap(settings, namespace, build, keys) {
  let current = build(settings.ns(namespace));
  settings.onChange(namespace, (next, prev) => {
    if (keys && prev && keys.every((k) => JSON.stringify(next[k]) === JSON.stringify(prev[k])))
      return;
    current = build(next);
  });
  return (req, res, next) => current(req, res, next);
}
