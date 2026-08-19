---
name: DIY Playwright e2e fallback
description: How to run browser e2e yourself when the testing subagent kind is unavailable; Clerk ticket sign-in, consent dialog, missing codegen.
---
Rule: if `subagent({config:{$kind:"testing"}})` keeps failing with "Unknown config kind: testing", run the e2e yourself: workspace root has `playwright` (npm) and a Nix `chromium` binary (`executablePath: $(which chromium)`, `--no-sandbox`). Scripts must live inside the workspace (e.g. `scripts/src/`) so `import "playwright"` resolves — /tmp scripts can't.
**Why:** the testing kind can be unavailable for long stretches; DIY Playwright still completes browser verification.
**How to apply:**
- Clerk sign-in without UI: backend API `POST /v1/users` (or list by email) + `POST /v1/sign_in_tokens {user_id}` with CLERK_SECRET_KEY, then in-page after `window.Clerk.loaded`: `Clerk.client.signIn.create({strategy:"ticket", ticket})` + `Clerk.setActive({session: res.createdSessionId})`.
- A first-visit consent/location dialog blocks the studio page (buttons Continue/Close) — dismiss any `[role=dialog]` before clicking; it can appear a few seconds after load.
- Toast text also exists in an aria-live region — always `.first()` on getByText or strict mode fails.
- Blank/500 preview after task-env setup: `lib/api-client-react/src/generated` may be missing; run `pnpm --filter @workspace/api-spec run codegen`.
- Library cards open their edit dialog on DOUBLE-click of the card (single click no-ops); dblclick the card's `h3` title, or use the kebab menu → Edit.
- Seeding a post with a real image without AI spend: in-page authed fetch → `POST /api/storage/uploads/request-url`, PUT a canvas-generated PNG, then `POST /api/content` with the objectPath (see `scripts/src/e2e-image-layers-persist.mjs`).
- Reusable harness: `scripts/src/e2e-two-step-prompt.mjs` (multi-shot text_to_video storyboard review → approve → renderVisual + prompt_compiled DB checks; resumes an existing awaiting_review job on re-run; FINAL_POLLS bounds the render wait). Gotcha: the "Your storyboard is waiting" panel can sit under an open dialog overlay — dismiss dialogs again right before clicking Open storyboard.
- The shared Replicate account can be OUT OF CREDIT (402 "Insufficient credit") — video renders then fail for everyone; treat as environment, verify the settle path instead (quota jobs meter only on success, so a failed job must leave NO usage_events row).
- E2E harnesses that mutate shared dev state must snapshot the exact pre-existing rows (or absence), mutate only inside try/finally, restore/delete-only-own-inserts on cleanup, capture created identifiers at creation time, and treat cleanup failure as run failure — partial cleanup must stay retryable.
- Reusable harness: `scripts/src/e2e-image-cancel.mjs` (image-job cancel flows; dev-only `IMAGE_JOB_CLAIM_DELAY_MS` holds the runner pre-claim so "queued" is observable; late-cancel = click Cancel within the client's first 2s poll window).
- Reusable harness: `scripts/src/e2e-first-time-setup.mjs` (fresh Clerk user → consent Continue → skip onboarding → /brand-kits renders → create kit → Edit Brand dialog; scoped Clerk+DB cleanup). First-time-user overlays verified working; the earlier "stuck loading / blank brand-kits" report was environmental (dev servers down / missing codegen), not a product bug.
