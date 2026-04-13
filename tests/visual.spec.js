// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Visual regression tests — catches unintended UI drift.
 *
 * How it works:
 *   First run:  creates baseline screenshots in tests/visual.spec.js-snapshots/
 *   Next runs:  compares current render vs baseline, fails if diff > 2%
 *
 * To update baselines after intentional UI changes:
 *   npm run test:update-snapshots
 */

// Freeze animations so diffs are deterministic
test.beforeEach(async ({ page }) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
});

test.describe('Visual regression — landing page', () => {
  test('desktop snapshot', async ({ page }) => {
    await page.goto('/');
    // Wait for fonts & Alpine so rendering is stable
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.fonts.ready);
    // Override mesh-bg since it's animated — keep it still
    await page.addStyleTag({ content: '.mesh-bg, .mesh-bg::before, .mesh-bg::after { animation: none !important; }' });
    await expect(page).toHaveScreenshot('landing-desktop.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('mobile snapshot', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.fonts.ready);
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
      `,
    });
    await expect(page).toHaveScreenshot('landing-mobile.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
    await ctx.close();
  });
});

test.describe('Visual regression — room page shell', () => {
  test('room shell renders', async ({ page, context }) => {
    await context.grantPermissions(['microphone', 'camera']);
    await page.goto('/room.html?mode=host&name=tester');
    await page.waitForFunction(() => window.Alpine !== undefined, { timeout: 10_000 });
    await page.waitForTimeout(500); // let layout settle
    await page.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        video { visibility: hidden !important; }
      `,
    });
    // Only screenshot the control bar region — video tiles are non-deterministic
    const controls = page.locator('[data-test="controls"]');
    await expect(controls).toHaveScreenshot('room-controls.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
