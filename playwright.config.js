// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * TalkToFriend — Playwright config for UI regression tests.
 *
 * Runs the existing Node server via webServer hook, then hits it with headless Chromium.
 * Camera/mic are faked via Chromium flags so the room page can proceed past media gates.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Grant mic/camera permissions globally for every test.
    permissions: ['microphone', 'camera'],
  },

  // Visual regression tolerances — small enough to catch UI changes,
  // tolerant enough to survive subpixel/font rendering diffs across OSes.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02, // ≤2% pixel diff
      animations: 'disabled',
    },
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'cd server && npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
