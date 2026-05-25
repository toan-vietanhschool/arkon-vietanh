# Arkon frontend E2E

Playwright tests against the running dev (or built) Arkon stack. Tests log in
with a real account and exercise full UI flows.

## Prerequisites

- Frontend dev server on `http://localhost:3000` (or set `PLAYWRIGHT_BASE_URL`).
- API on `http://localhost:5055` (or set `ARKON_API_URL`).
- A test account that can sign in. Defaults to `admin@arkon.local` /
  `truongvietanh`; override with `ARKON_ADMIN_EMAIL` and
  `ARKON_ADMIN_PASSWORD`.
- A workspace UUID for tests that exercise workspace flows. Defaults to
  the seed workspace `5f03d0ba-...`; override with
  `ARKON_TEST_WORKSPACE_ID`.

Browsers (Chromium) are downloaded on first run:

```bash
npx playwright install chromium
```

## Run

```bash
# headless, list reporter
npm run test:e2e

# interactive UI mode (great for writing new tests)
npm run test:e2e:ui

# single spec
npx playwright test e2e/workspace-add-source.spec.ts
```

## Adding tests

Tests live under `e2e/*.spec.ts`. Use `loginAsAdmin(page)` from
`e2e/fixtures/login.ts` at the top of any spec that needs an authenticated
session. Prefer testing API contracts via `request` for regression coverage,
and use the UI layer for flows that span multiple components.

The current suite is intentionally small and focused on regressions — each
spec should document the bug it guards against in a top-of-file comment.
