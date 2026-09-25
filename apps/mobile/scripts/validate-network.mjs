/**
 * Network-condition validation for the app UI (Phase 3, step 6).
 *
 *   EXPO_PUBLIC_API_URL=http://127.0.0.1:4555 pnpm --filter @signals/mobile export:web
 *   pnpm --filter @signals/mobile validate:network
 *
 * Drives the WEB build of the app in headless Chromium and intercepts every API call to
 * simulate: normal, slow, server error, offline, timeout, failed refresh after a good load,
 * going offline after a good load, and stale / market-closed / delayed / vendor-failure
 * responses. Checks that loading, error, stale, delayed and market-closed states are
 * distinguishable and that old data is never shown as if it were current.
 *
 * LIMITS: this is the React Native Web build, not Android. Rendering and state logic are
 * shared, but Android networking (OkHttp), NetInfo and backgrounding are not exercised. Run
 * the device protocol in docs/REAL_WORLD_VALIDATION.md on hardware for those.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve(process.argv[2] ?? 'dist-web');
const API = 'http://127.0.0.1:4555';
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No web export at ${DIST}. See the header of this file.`);
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.css': 'text/css',
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || path.endsWith('/'))
    file = join(DIST, 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${server.address().port}`;

const now = () => new Date().toISOString();
const quote = (over = {}) => ({
  symbol: 'AAPL',
  price: 227.52,
  previousClose: 225.1,
  change: 2.42,
  changePercent: 1.08,
  volume: 41_000_000,
  timestamp: now(),
  currency: 'USD',
  exchange: 'NASDAQ',
  marketOpen: true,
  delayed: false,
  source: 'twelvedata',
  ...over,
});
const fresh = { stale: false, ageSeconds: 5, marketOpen: true, reason: null };
const item = (over = {}) => ({
  symbol: 'AAPL',
  name: 'Apple Inc.',
  assetClass: 'EQUITY',
  exchange: 'NASDAQ',
  currency: 'USD',
  alertsEnabled: true,
  addedAt: now(),
  quote: quote(),
  dataStatus: fresh,
  quoteError: null,
  ...over,
});
const me = {
  id: 'u1',
  email: 'demo@example.com',
  displayName: null,
  settings: {
    alertsEnabled: true,
    disabledCategories: [],
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'UTC',
    notificationFrequency: 'REALTIME',
    minimumSignalStrength: 'LOW',
  },
};
const json = (route, status, body, delayMs = 0) =>
  new Promise((r) => setTimeout(r, delayMs)).then(() =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    }),
  );

/** watchlist: (callIndex) => handler; everything else gets a benign default. */
async function openApp(browser, watchlist) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let calls = 0;
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    }
    const path = new URL(req.url()).pathname;
    if (path === '/watchlist') return watchlist(route, calls++);
    if (path === '/me') return json(route, 200, me);
    if (path === '/signals/catalog') return json(route, 200, { catalog: [] });
    if (path.startsWith('/signal-events'))
      return json(route, 200, { events: [], nextCursor: null });
    return json(route, 404, { statusCode: 404, error: 'Not Found', message: 'not mocked' });
  });
  await page.goto(`${APP}/login`);
  await page.getByText('Sign in', { exact: true }).click();
  return { context, page };
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.info(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const visible = async (page, text, timeout = 5000) =>
  page
    .getByText(text)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(
      () => true,
      () => false,
    );
const PRICE = '$227.52';

const browser = await chromium.launch();
const scenarios = {
  async normal() {
    const { page, context } = await openApp(browser, (r) => json(r, 200, { items: [item()] }));
    const ok = await visible(page, PRICE, 15000);
    if (process.env.DEBUG_SHOT) {
      await page.screenshot({ path: process.env.DEBUG_SHOT });
      console.info(page.url(), (await page.locator('body').innerText()).slice(0, 800));
    }
    const badge =
      (await page.getByText(/Stale|Delayed|Market closed|Couldn.t refresh|Offline/).count()) === 0;
    check('normal: price shown with no warning badges', ok && badge);
    await context.close();
  },
  async slow() {
    const { page, context } = await openApp(browser, (r) =>
      json(r, 200, { items: [item()] }, 3000),
    );
    const skeleton = await page
      .getByLabel('Loading watchlist')
      .waitFor({ timeout: 2500 })
      .then(
        () => true,
        () => false,
      );
    const shown = await visible(page, PRICE, 10000);
    check(
      'slow (3 s): loading skeleton, then data',
      skeleton && shown,
      `skeleton=${skeleton} data=${shown}`,
    );
    await context.close();
  },
  async serverError() {
    const { page, context } = await openApp(browser, (r) =>
      json(r, 500, {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
      }),
    );
    const err = await visible(page, 'Internal server error', 15000);
    const retry = await visible(page, 'Retry', 1000);
    check(
      'API 500 on first load: error state with Retry, no prices',
      err && retry && !(await visible(page, PRICE, 500)),
    );
    await context.close();
  },
  async offlineFirstLoad() {
    const { page, context } = await openApp(browser, (r) => r.abort('internetdisconnected'));
    const err = await visible(page, /Cannot reach the server/, 15000);
    check(
      'offline on first load: "Cannot reach the server" with Retry',
      err && (await visible(page, 'Retry', 1000)),
    );
    await context.close();
  },
  async timeout() {
    const { page, context } = await openApp(browser, () => new Promise(() => {}));
    const err = await visible(page, /did not respond in time/, 45000);
    check('timeout (server never answers): error instead of an endless skeleton', err);
    await context.close();
  },
  async refreshFailsAfterGoodLoad() {
    const { page, context } = await openApp(browser, (r, i) =>
      i === 0
        ? json(r, 200, { items: [item()] })
        : json(r, 503, {
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'Service unavailable',
          }),
    );
    await visible(page, PRICE, 15000);
    const banner = await visible(page, /Couldn.t refresh/, 45000);
    const stillData = await visible(page, PRICE, 1000);
    check(
      'refresh fails after a good load: old prices kept AND flagged "Couldn\'t refresh"',
      banner && stillData,
      `banner=${banner} data=${stillData}`,
    );
    await context.close();
  },
  async offlineAfterGoodLoad() {
    const { page, context } = await openApp(browser, (r) => json(r, 200, { items: [item()] }));
    await visible(page, PRICE, 15000);
    await context.setOffline(true);
    const banner = await visible(page, /Offline|Couldn.t refresh/, 45000);
    check('connection lost after a good load: old prices flagged, not shown as current', banner);
    await context.close();
  },
  async staleQuote() {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { page, context } = await openApp(browser, (r) =>
      json(r, 200, {
        items: [
          item({
            quote: quote({ timestamp: old }),
            dataStatus: {
              stale: true,
              ageSeconds: 10800,
              marketOpen: true,
              reason: 'quote is 180 min old',
            },
          }),
        ],
      }),
    );
    check('stale quote: "Stale" badge', await visible(page, 'Stale', 15000));
    await context.close();
  },
  async marketClosed() {
    const { page, context } = await openApp(browser, (r) =>
      json(r, 200, {
        items: [
          item({
            quote: quote({ marketOpen: false }),
            dataStatus: { stale: false, ageSeconds: 50000, marketOpen: false, reason: null },
          }),
        ],
      }),
    );
    check('market closed: "Market closed" badge', await visible(page, 'Market closed', 15000));
    await context.close();
  },
  async delayed() {
    const { page, context } = await openApp(browser, (r) =>
      json(r, 200, { items: [item({ quote: quote({ delayed: true }) })] }),
    );
    check('delayed data: "Delayed" badge', await visible(page, 'Delayed', 15000));
    await context.close();
  },
  async vendorFailureOneSymbol() {
    const { page, context } = await openApp(browser, (r) =>
      json(r, 200, {
        items: [
          item({
            symbol: 'NVDA',
            name: 'NVIDIA',
            quote: null,
            dataStatus: null,
            quoteError: 'Price temporarily unavailable (rate limited)',
          }),
          item(),
        ],
      }),
    );
    const msg = await visible(page, 'Price temporarily unavailable (rate limited)', 15000);
    check(
      'vendor failure for one symbol: that row explains, others still load',
      msg && (await visible(page, PRICE, 1000)),
    );
    await context.close();
  },
};

const only = process.argv.slice(3);
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err).slice(0, 200));
  }
}
await browser.close();
server.close();

const failed = results.filter((r) => !r.pass).length;
const outDir = resolve(
  '../../validation-output/network',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 2));
console.info(
  `\n${results.length - failed}/${results.length} passed. Report: ${outDir}/report.json`,
);
process.exit(failed ? 1 : 0);
