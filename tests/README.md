# TalkToFriend — Frontend Tests

Playwright-based UI regression tests. Runs in CI on every push/PR via `.github/workflows/ui-tests.yml`.

## What's covered

| Spec file | What it tests |
|---|---|
| `landing.spec.js` | Landing page: hero, form validation, navigation, features, how-it-works, footer, `?room=` auto-join |
| `room.spec.js` | Room page shell: header, control bar, reactions popup, mic/cam toggles, leave, mobile bottom-sheet chat |
| `visual.spec.js` | Screenshot diffing for landing (desktop + mobile) and room control bar — catches unintended pixel drift |

Tests use `[data-test="..."]` hooks, NOT CSS classes — restyling won't break them.

## Run locally

```bash
# One-time setup (root of repo)
npm install
npx playwright install chromium

# Run everything
npm test

# Visual UI (Playwright's test runner)
npm run test:ui

# Watch a run live in a real browser
npm run test:headed

# Update visual snapshots after an INTENTIONAL UI change
npm run test:update-snapshots
```

## CI behavior

On every push/PR touching `public/`, `server/`, `tests/`, or the config:

1. GitHub Actions spins up Ubuntu + Node 22
2. Installs server + Playwright deps
3. Starts the Node server via Playwright's `webServer` hook
4. Runs all specs against `chromium-desktop` AND `chromium-mobile` in parallel
5. On failure: uploads HTML report + videos + traces + diff screenshots as artifacts (14-day retention)

## Visual regression workflow

First run creates baselines in `tests/visual.spec.js-snapshots/`. Subsequent runs diff against them.

If a snapshot fails:

- **Unintended change?** → fix the UI, rerun tests.
- **Intended change?** → `npm run test:update-snapshots`, commit the new snapshots.

Tolerance: 2–5% pixel diff (configured in `playwright.config.js` + per-test). Generous enough to survive font rendering drift, tight enough to catch actual layout breaks.

## Known limitations

- We can't fully test WebRTC/media streams in CI (faked via Chromium flags).
- Room page is tested at the UI-shell level — Alpine bindings, DOM structure, control bar interactivity.
- Visual tests disable animations to keep diffs deterministic.
