import fs from 'node:fs';
import { ADMIN } from './helpers.js';

/**
 * A real browser for layout tests (jsdom has no layout engine). Needs `playwright-core` and a Chrome/Chromium; without
 * them `skipBrowser` holds the reason and tests pass it as `{ skip }`.
 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
export const chrome = CANDIDATES.find((p) => fs.existsSync(p));
export let playwright = null;
try {
  playwright = await import('playwright-core');
} catch {
  /* not installed */
}
export const skipBrowser =
  !chrome || !playwright ? 'needs playwright-core and a Chrome/Chromium on this machine' : false;

/** Opens a page of the admin, signed in, at this width. */
export async function adminPage(browser, node, { width = 1440, height = 1000, hash = '' } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${node.url}/admin/`);
  await page.fill('#email', ADMIN.email);
  await page.fill('#pw', ADMIN.password);
  await page.press('#pw', 'Enter');
  await page.waitForSelector('.shell');
  if (hash) await page.goto(`${node.url}/admin/#${hash}`);
  return page;
}
