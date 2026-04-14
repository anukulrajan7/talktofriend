// @ts-check
const { test, expect, chromium } = require('@playwright/test');

/**
 * Peer connectivity test — the REAL test.
 * Opens two browser contexts (host + guest), creates a room,
 * joins from the second, and verifies they can see each other.
 *
 * This catches:
 * - Signaling failures (peer-joined not received)
 * - Room creation/join issues
 * - WebRTC PeerConnection setup failures
 * - Media track exchange issues
 * - UI reactivity issues (peerCount not updating)
 */

test.describe('Two-peer connectivity', () => {
  // WebRTC negotiation can be slow (TURN creds fetch, ICE gathering)
  test.setTimeout(60000);

  test('host and guest can join the same room and see each other', async ({ browser }) => {
    // Create two independent browser contexts with fake media
    const hostContext = await browser.newContext({
      permissions: ['microphone', 'camera'],
    });
    const guestContext = await browser.newContext({
      permissions: ['microphone', 'camera'],
    });

    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    // Capture console logs for debugging
    const hostLogs = [];
    const guestLogs = [];
    hostPage.on('console', msg => hostLogs.push(`[HOST] ${msg.type()}: ${msg.text()}`));
    guestPage.on('console', msg => guestLogs.push(`[GUEST] ${msg.type()}: ${msg.text()}`));

    // Also capture errors
    hostPage.on('pageerror', err => hostLogs.push(`[HOST ERROR] ${err.message}`));
    guestPage.on('pageerror', err => guestLogs.push(`[GUEST ERROR] ${err.message}`));

    try {
      // --- STEP 1: Host opens room ---
      console.log('STEP 1: Host opening room...');
      await hostPage.goto('/room.html?mode=host&name=TestHost');

      // Wait for Alpine to boot
      await hostPage.waitForFunction(() => window.Alpine !== undefined, { timeout: 10000 });

      // Wait for room code to appear (room created + joined)
      await hostPage.waitForFunction(
        () => {
          const el = document.querySelector('[data-test="room-code"]');
          return el && el.textContent && el.textContent.length > 3 && el.textContent !== '...';
        },
        { timeout: 15000 }
      );

      const roomCode = await hostPage.locator('[data-test="room-code"]').textContent();
      console.log(`STEP 1 DONE: Room code = "${roomCode}"`);
      expect(roomCode).toBeTruthy();
      expect(roomCode.length).toBeGreaterThan(3);

      // Verify host sees peerCount = 1
      const hostPeerCount = await hostPage.locator('[data-test="peer-count"]').textContent();
      console.log(`Host peer count: "${hostPeerCount}"`);
      expect(hostPeerCount).toContain('1');

      // Verify host has self tile
      await hostPage.waitForSelector('[data-peer-id="self"]', { timeout: 5000 });
      console.log('Host has self tile');

      // --- STEP 2: Guest joins ---
      console.log('\nSTEP 2: Guest joining room...');
      await guestPage.goto(`/room.html?mode=guest&code=${roomCode}&name=TestGuest`);

      // Wait for Alpine
      await guestPage.waitForFunction(() => window.Alpine !== undefined, { timeout: 10000 });

      // Wait for guest to join (check for self tile)
      await guestPage.waitForSelector('[data-peer-id="self"]', { timeout: 15000 });
      console.log('Guest has self tile');

      // --- STEP 3: Verify host sees the guest ---
      console.log('\nSTEP 3: Checking if host sees the guest...');

      // Wait for host's peer count to update to 2
      try {
        await hostPage.waitForFunction(
          () => {
            const el = document.querySelector('[data-test="peer-count"]');
            return el && el.textContent && el.textContent.includes('2');
          },
          { timeout: 10000 }
        );
        console.log('HOST peer count is 2!');
      } catch (e) {
        // Dump debug info
        const finalHostCount = await hostPage.locator('[data-test="peer-count"]').textContent();
        console.log(`FAIL: Host peer count stuck at "${finalHostCount}"`);

        // Check Alpine state
        const hostState = await hostPage.evaluate(() => {
          const alpine = document.querySelector('[x-data]')?.__x?.$data;
          if (!alpine) return 'Alpine data not accessible';
          return {
            code: alpine.code,
            myId: alpine.myId,
            mode: alpine.mode,
            roomMode: alpine.roomMode,
            peerCount: alpine.peerCount,
            peers: alpine.peers,
            connState: alpine.connState,
            _initialized: alpine._initialized,
          };
        });
        console.log('Host Alpine state:', JSON.stringify(hostState, null, 2));

        const guestState = await guestPage.evaluate(() => {
          const alpine = document.querySelector('[x-data]')?.__x?.$data;
          if (!alpine) return 'Alpine data not accessible';
          return {
            code: alpine.code,
            myId: alpine.myId,
            mode: alpine.mode,
            roomMode: alpine.roomMode,
            peerCount: alpine.peerCount,
            peers: alpine.peers,
            connState: alpine.connState,
            _initialized: alpine._initialized,
          };
        });
        console.log('Guest Alpine state:', JSON.stringify(guestState, null, 2));

        throw e;
      }

      // --- STEP 4: Verify guest sees the host ---
      console.log('\nSTEP 4: Checking if guest sees the host...');
      await guestPage.waitForFunction(
        () => {
          const el = document.querySelector('[data-test="peer-count"]');
          return el && el.textContent && el.textContent.includes('2');
        },
        { timeout: 10000 }
      );
      console.log('GUEST peer count is 2!');

      // --- STEP 5: Wait for WebRTC negotiation and remote tiles ---
      console.log('\nSTEP 5: Waiting for remote video tiles (WebRTC negotiation)...');

      // WebRTC offer/answer/ICE takes time — wait up to 15s for remote tiles
      // WebRTC negotiation (offer/answer/ICE) can take several seconds
      await hostPage.waitForFunction(
        () => document.querySelectorAll('[data-peer-id]').length >= 2,
        { timeout: 30000 }
      );
      console.log('Host has remote tile!');

      await guestPage.waitForFunction(
        () => document.querySelectorAll('[data-peer-id]').length >= 2,
        { timeout: 30000 }
      );
      console.log('Guest has remote tile!');

      const hostTiles = await hostPage.locator('[data-peer-id]').count();
      const guestTiles = await guestPage.locator('[data-peer-id]').count();
      console.log(`Host tiles: ${hostTiles}, Guest tiles: ${guestTiles}`);

      expect(hostTiles).toBeGreaterThanOrEqual(2);
      expect(guestTiles).toBeGreaterThanOrEqual(2);

      console.log('\n=== ALL TESTS PASSED ===');

    } finally {
      // Dump logs on failure for debugging
      if (hostLogs.length) {
        console.log('\n--- HOST CONSOLE LOGS ---');
        hostLogs.forEach(l => console.log(l));
      }
      if (guestLogs.length) {
        console.log('\n--- GUEST CONSOLE LOGS ---');
        guestLogs.forEach(l => console.log(l));
      }

      await hostContext.close();
      await guestContext.close();
    }
  });
});
