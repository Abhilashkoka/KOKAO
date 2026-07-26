---
name: DIY Playwright e2e fallback
description: How to run browser e2e yourself when the testing subagent kind is unavailable; Clerk ticket sign-in, consent dialog, missing codegen.
---
Rule: if `subagent({config:{$kind:"testing"}})` keeps failing with "Unknown config kind: testing", run the e2e yourself: workspace root has `playwright` (npm) and a Nix `chromium` binary (`executablePath: $(which chromium)`, `--no-sandbox`). Scripts must live inside the workspace (e.g. `scripts/src/`) so `import "playwright"` resolves — /tmp scripts can't.
**Why:** the testing kind was unavailable for a whole session (8+ retries over 30+ min); DIY Playwright completed the browser verification.
**How to apply:**
- Clerk sign-in without UI: backend API `POST /v1/users` (or list by email) + `POST /v1/sign_in_tokens {user_id}` with CLERK_SECRET_KEY, then in-page after `window.Clerk.loaded`: `Clerk.client.signIn.create({strategy:"ticket", ticket})` + `Clerk.setActive({session: res.createdSessionId})`.
- A first-visit consent/location dialog blocks the studio page (buttons Continue/Close) — dismiss any `[role=dialog]` before clicking; it can appear a few seconds after load.
- Toast text also exists in an aria-live region — always `.first()` on getByText or strict mode fails.
- Blank/500 preview after task-env setup: `lib/api-client-react/src/generated` may be missing; run `pnpm --filter @workspace/api-spec run codegen`.
- Reusable harness: `scripts/src/e2e-image-cancel.mjs` (image-job cancel flows; dev-only `IMAGE_JOB_CLAIM_DELAY_MS` holds the runner pre-claim so "queued" is observable; late-cancel = click Cancel within the client's first 2s poll window).
