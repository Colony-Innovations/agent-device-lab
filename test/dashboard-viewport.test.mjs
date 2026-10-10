// Display modes use one stream, keep the device ratio, and work without fullscreen support.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SessionFeed } from '../dist/core/feed.js';
import { Dashboard } from '../dist/dashboard/server.js';

let browser, dash, feed, page;
let starts = 0;
const device = (width, height) => ({ id: `test-${width}`, label: 'test', viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });

before(async () => {
  browser = await chromium.launch();
  const app = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await app.setContent('<h1>Desktop application</h1><p>Readable text at native resolution</p>');
  const jpeg = await app.screenshot({ type: 'jpeg' });
  await app.close();
  feed = new SessionFeed();
  dash = await Dashboard.listen({ feed, source: () => ({ active: true, screencast: async (onFrame) => {
    starts++;
    onFrame(jpeg);
    return async () => {};
  } }) });
  const d = device(1440, 900);
  feed.apply({ kind: 'starting', project: 'test', url: 'http://127.0.0.1:1/', device: d, headed: false });
  feed.apply({ kind: 'start', result: {
    session: { id: 's-1', device: d, browser: { engine: 'chromium', version: '153', headed: false }, environment: 'e' },
    server: { url: 'http://127.0.0.1:1', owned: false, reused: true, readyMs: 1 },
    observation: { gen: 1, url: 'http://127.0.0.1:1/', route: '/', title: 't', controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 } },
  } });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  await page.goto(dash.viewUrl);
  await page.waitForFunction(() => document.getElementById('viewport').naturalWidth === 1440);
});

after(async () => { await browser?.close(); await dash?.close(); });

const ratio = async () => {
  const box = await page.locator('#viewport').boundingBox();
  assert.ok(Math.abs(box.width / box.height - 1440 / 900) < 0.01, JSON.stringify(box));
  return box;
};

test('expand enlarges the desktop view, traps focus, and restores it without a second capture', async () => {
  const small = await ratio();
  const src = await page.locator('#viewport').getAttribute('src');
  await page.locator('#vp-expand').click();
  await page.locator('#vp-dialog').waitFor({ state: 'visible' });
  const big = await ratio();
  assert.ok(big.width > small.width * 1.5, `${small.width} -> ${big.width}`);
  assert.ok(big.y + big.height <= 1000);
  assert.equal(await page.locator('#vp-close').evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.locator('#viewport').getAttribute('src'), src);
  assert.equal(starts, 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('vp-dialog').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.locator('#vp-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#vp-expand').evaluate((el) => el === document.activeElement), true);
  assert.equal(starts, 1);
});

test('native full screen can be exited and the expanded view can be closed', async () => {
  await page.locator('#vp-fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  assert.equal(await page.locator('#vp-fullscreen').textContent(), 'Exit full screen');
  await ratio();
  await page.locator('#vp-fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('#vp-dialog').isVisible(), true);
  await page.locator('#vp-fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('#vp-dialog').isVisible(), true, 'first Escape exits full screen');
  await page.keyboard.press('Escape');
  await page.locator('#vp-dialog').waitFor({ state: 'hidden' });
  assert.equal(starts, 1);
});

test('denied full screen falls back to a responsive expanded view', async () => {
  await page.evaluate(() => { document.documentElement.requestFullscreen = async () => { throw new Error('unavailable'); }; });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('#vp-fullscreen').click();
  await page.locator('#vp-display-note', { hasText: 'Full screen is unavailable' }).waitFor();
  const b = await ratio();
  assert.ok(b.x >= 0 && b.x + b.width <= 320 && b.y + b.height <= 640, JSON.stringify(b));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#vp-close').click();
  await page.locator('#vp-dialog').waitFor({ state: 'hidden' });
  assert.equal(starts, 1);
});
