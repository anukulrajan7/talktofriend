// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Room page — UI shell tests.
 * We can't test actual WebRTC connectivity in CI, but we can verify
 * that every major UI element renders, control bar appears, and
 * Alpine bindings are alive.
 */

test.describe('Room page', () => {
  test.beforeEach(async ({ context, page }) => {
    // Re-grant permissions per-context so faked media works
    await context.grantPermissions(['microphone', 'camera']);
    await page.goto('/room.html?mode=host&name=tester');
    // Wait for Alpine to boot
    await page.waitForFunction(() => window.Alpine !== undefined, { timeout: 10_000 });
  });

  test('header shows room code placeholder', async ({ page }) => {
    const code = page.locator('[data-test="room-code"]');
    await expect(code).toBeVisible();
  });

  test('copy link button exists', async ({ page }) => {
    await expect(page.locator('[data-test="copy-link"]')).toBeVisible();
  });

  test('connection status indicator shows', async ({ page }) => {
    await expect(page.locator('[data-test="connection-status"]')).toBeVisible();
  });

  test('peer count shows N/20 format', async ({ page }) => {
    const peers = page.locator('[data-test="peer-count"]');
    await expect(peers).toBeVisible();
    await expect(peers).toContainText('/20');
  });

  test('floating pill control bar is visible', async ({ page }) => {
    await expect(page.locator('[data-test="controls"]')).toBeVisible();
  });

  test('control bar has all essential buttons', async ({ page }) => {
    await expect(page.locator('[data-test="toggle-mic"]')).toBeVisible();
    await expect(page.locator('[data-test="toggle-cam"]')).toBeVisible();
    await expect(page.locator('[data-test="toggle-reactions"]')).toBeVisible();
    await expect(page.locator('[data-test="leave-call"]')).toBeVisible();
  });

  test('reactions popup opens on click', async ({ page }) => {
    await page.locator('[data-test="toggle-reactions"]').click();
    await expect(page.locator('[data-test="reactions-popup"]')).toBeVisible();
    // Should contain emoji buttons
    const popup = page.locator('[data-test="reactions-popup"]');
    await expect(popup.getByText('🎉')).toBeVisible();
    await expect(popup.getByText('❤️')).toBeVisible();
  });

  test('leave button goes home', async ({ page }) => {
    await page.locator('[data-test="leave-call"]').click();
    await page.waitForURL('/', { timeout: 5000 });
    expect(page.url()).toMatch(/\/$/);
  });

  test('mic toggle flips state', async ({ page }) => {
    const btn = page.locator('[data-test="toggle-mic"]');
    const beforeClass = await btn.getAttribute('class');
    await btn.click();
    await page.waitForTimeout(200);
    const afterClass = await btn.getAttribute('class');
    expect(beforeClass).not.toBe(afterClass);
  });

  test('cam toggle flips state', async ({ page }) => {
    const btn = page.locator('[data-test="toggle-cam"]');
    const beforeClass = await btn.getAttribute('class');
    await btn.click();
    await page.waitForTimeout(200);
    const afterClass = await btn.getAttribute('class');
    expect(beforeClass).not.toBe(afterClass);
  });

  test('guest mode without code redirects to home', async ({ page }) => {
    await page.goto('/room.html?mode=guest');
    await page.waitForURL('/', { timeout: 5000 });
  });
});

test.describe('Room page — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(['microphone', 'camera']);
    await page.goto('/room.html?mode=host&name=tester');
    await page.waitForFunction(() => window.Alpine !== undefined, { timeout: 10_000 });
  });

  test('chat toggle button exists on mobile', async ({ page }) => {
    await expect(page.locator('[data-test="toggle-chat"]')).toBeVisible();
  });

  test('chat bottom sheet opens on mobile', async ({ page }) => {
    const sheet = page.locator('[data-test="chat-sheet"]');
    const before = await sheet.evaluate((el) => el.classList.contains('open'));
    expect(before).toBe(false);
    await page.locator('[data-test="toggle-chat"]').click();
    await page.waitForTimeout(400);
    const after = await sheet.evaluate((el) => el.classList.contains('open'));
    expect(after).toBe(true);
  });

  test('chat bottom sheet closes on X click', async ({ page }) => {
    await page.locator('[data-test="toggle-chat"]').click();
    await page.waitForTimeout(400);
    await page.locator('[data-test="close-chat"]').click();
    await page.waitForTimeout(400);
    const sheet = page.locator('[data-test="chat-sheet"]');
    const closed = await sheet.evaluate((el) => !el.classList.contains('open'));
    expect(closed).toBe(true);
  });

  test('screen share button hidden on mobile', async ({ page }) => {
    await expect(page.locator('[data-test="toggle-share"]')).toBeHidden();
  });
});
