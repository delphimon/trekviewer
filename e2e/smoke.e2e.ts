import { expect, test } from '@playwright/test';

// 1x1 transparent PNG: every external tile/elevation host gets this, so CI needs no network.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('loads the default route without console errors', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route(url => url.origin !== origin, route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  await page.goto('/');
  // The route is committed once the stats panel names it (the "Loaded:" banner is transient).
  await expect(page.locator('#statsTitle')).toContainText('Rainier', { timeout: 90_000 });
  await page.waitForTimeout(3000); // let post-load imagery work report any errors
  // Mocked tiles are not real imagery/elevation; only failures about external data are allowed.
  const unexpected = errors.filter(text => !/https?:\/\/(?!127\.0\.0\.1)|Failed to load resource|net::|tile|elevation|imagery|decode/i.test(text));
  expect(unexpected).toEqual([]);
});
