/**
 * What a check is given. Every check adds findings through `add`; none of them knows how a run is stored.
 * @typedef {object} CheckEnv
 * @property {any} ctx
 * @property {number} runId
 * @property {{ id: number, name: string, ok: boolean, steps: any[], jpeg: Buffer | null }[]} [journeys]   filled in by the journeys check
 * @property {string} base   address of the site being checked, no trailing slash
 * @property {boolean} publicBase   true when `base` is the public address (not this server's own loopback)
 * @property {string[]} pages   the addresses that were page-checked
 * @property {Map<string, any>} meta   per page: title, description, canonical, noindex, hreflang, jsonld, forms…
 * @property {Map<string, number>} status   per page: the HTTP status it answered
 * @property {Map<string, Set<string>>} links   internal link → pages that contain it
 * @property {Map<string, Set<string>>} external   outside address → pages that contain it
 * @property {Record<string, any>} config
 * @property {(path: string, viewport: string, category: string, severity: 'error'|'warn'|'info', rule: string, message: string, key?: string, detail?: any) => void} add
 * @property {(path: string, init?: RequestInit) => Promise<Response | null>} get   one request to the site (no redirects followed); null if unreachable
 * @property {() => Promise<boolean>} cancelled
 */
export {};
