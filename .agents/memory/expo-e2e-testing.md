---
name: Expo mobile e2e testing pitfalls
description: Why browser e2e against the Expo web artifact fails and how to verify mobile auth/API flows reliably.
---

- The Expo artifact lives on its own domain (`$REPLIT_EXPO_DEV_DOMAIN`), separate from the main dev domain. Clerk's programmatic test sign-in sets its session on the main domain only — it does NOT carry over to the Expo domain, so the mobile app still shows its sign-in screen afterward.
- The testing subagent repeatedly drifted to the desktop web app (top "KOKA" navbar) and reported its UI as "bugs" in the mobile app. Host-assertion instructions in the plan helped but did not fully prevent this.
- `runTest` runs inside the code_execution sandbox with a hard 10-minute cap; long mobile plans (sign-up + AI generation) time out. Keep plans short, and note that all workflows in this project restart periodically mid-test, causing false failures.
- **Reliable fallback:** verify the mobile app's server contract directly — use the Clerk backend API (`CLERK_SECRET_KEY`) to create a user, session, and session token, then curl the API with `Authorization: Bearer <jwt>` (same mechanism as the mobile client's `setAuthTokenGetter`). Clean up the Clerk user afterward.
- In-app sign-up can be tested with `<x>+clerk_test@example.com` emails and verification code 424242 (Clerk dev instances).
