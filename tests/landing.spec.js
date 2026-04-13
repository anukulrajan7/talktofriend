// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Landing page — smoke + interaction tests.
 * Uses [data-test="..."] hooks, not CSS classes, so restyling won't break tests.
 *
 * Note: The join form is hidden behind a "join with a code" toggle button —
 * tests that interact with the code/name inputs click [data-test="show-join"] first.
 */

test.describe('Landing page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads with correct title and meta', async ({ page }) => {
    await expect(page).toHaveTitle(/TalkToFriend/);
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc).toBeTruthy();
  });

  test('hero shows bold headline with italic accent', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /talk to your/i })).toBeVisible();
    await expect(page.locator('text=/friends/i').first()).toBeVisible();
  });

  test('start call button navigates to room as host', async ({ page }) => {
    await page.locator('[data-test="create-room"]').first().click();
    await page.waitForURL(/\/room\.html\?mode=host/);
    expect(page.url()).toContain('mode=host');
  });

  test('join with empty code shows error', async ({ page }) => {
    await page.locator('[data-test="show-join"]').click();
    await page.locator('[data-test="join-room"]').click();
    const err = page.locator('[data-test="error-message"]');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/enter a room code/i);
  });

  test('join with invalid code format shows error', async ({ page }) => {
    await page.locator('[data-test="show-join"]').click();
    await page.locator('[data-test="room-code"]').fill('bad-format');
    await page.locator('[data-test="join-room"]').click();
    const err = page.locator('[data-test="error-message"]');
    await expect(err).toBeVisible();
    await expect(err).toContainText(/happy-tiger-42/i);
  });

  test('join with valid code navigates to room', async ({ page }) => {
    await page.locator('[data-test="show-join"]').click();
    await page.locator('[data-test="room-code"]').fill('happy-tiger-42');
    await page.locator('[data-test="join-room"]').click();
    await page.waitForURL(/\/room\.html\?mode=guest/);
    expect(page.url()).toContain('code=happy-tiger-42');
  });

  test('name is persisted to localStorage', async ({ page }) => {
    await page.locator('[data-test="show-join"]').click();
    await page.locator('[data-test="name-input"]').fill('Anukul');
    await page.locator('[data-test="create-room"]').first().click();
    await page.waitForURL(/\/room\.html/);
    expect(page.url()).toContain('name=Anukul');
    await page.goto('/');
    const stored = await page.evaluate(() => localStorage.getItem('ttf_name'));
    expect(stored).toBe('Anukul');
  });

  test('features section renders all 5 rows', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /P2P.*SFU/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Up to 20 people/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Self-host/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Vibes/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Works on mobile/i })).toBeVisible();
  });

  test('how-it-works has 3 numbered steps', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Open a link' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Share the code' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Just talk' })).toBeVisible();
  });

  test('footer links to terms, privacy, github', async ({ page }) => {
    await expect(page.getByRole('link', { name: /terms/i }).last()).toBeVisible();
    await expect(page.getByRole('link', { name: /privacy/i }).last()).toBeVisible();
    await expect(page.getByRole('link', { name: /github|source/i }).first()).toBeVisible();
  });

  test('trust marquee mentions P2P + SFU', async ({ page }) => {
    await expect(page.locator('.marquee').first()).toContainText(/P2P \+ SFU/);
  });

  test('final CTA section has start-a-call button', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /ready/i })).toBeVisible();
  });

  test('auto-joins from ?room= URL param', async ({ page }) => {
    await page.goto('/?room=fuzzy-bear-07');
    await page.waitForURL(/\/room\.html\?mode=guest.*code=fuzzy-bear-07/, { timeout: 5000 });
    expect(page.url()).toContain('code=fuzzy-bear-07');
  });
});
