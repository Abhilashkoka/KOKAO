---
name: Mobile billing e2e (Expo web + Razorpay mock)
description: How to e2e-test the mobile Plan & Billing screen in the Expo web preview with a mocked Razorpay API.
---

- Razorpay API can be mocked locally: `scripts/src/razorpayMockServer.mjs` (orders/subscriptions/plans/payments, plus POST /subscriptions/:id/cancel — cycle-end cancel returns status "active" with `cancel_at_cycle_end`) run as a temporary workflow, with dev-only env `RAZORPAY_API_BASE_URL` pointing the server's Razorpay client at it (honored only outside production). Remove the workflow + env var after testing.
- Navigating expo-router web: `history.pushState` + synthetic `popstate` renders a BLANK page. A full `page.goto('/settings')` works fine — the Clerk dev-browser session survives full reloads (contrary to earlier fears), so just goto the route directly.
- Team-member e2e: seed the pending `team_invites` row (lowercased email + owner seat_limit) BEFORE the member's first authenticated request; if seeded after, requireTenant already provisioned them a personal tenant and the invite never auto-accepts.
- The mock has TEST-ONLY endpoints `POST /orders/:id/mark-paid` and `POST /subscriptions/:id/mark-active` to simulate checkout completing; the full verify round trip (real HMAC signatures, real HTTP to the spawned mock, DB credit/plan assertions) is covered by `billing.mockRoundtrip.test.ts`, which spawns the mock as a child process and seeds the razorpay app-credential row with a known key secret.
- On web, `react-native-webview` renders "React Native WebView does not support this platform" inside the checkout modal — modal header/title still renders, which is enough to verify checkout opens.
- Non-owner members must not see Buy/Upgrade buttons at all (not just disabled) — pack rows hide the Buy button unless `isOwner`.

**Why:** these three pitfalls (blank popstate nav, late invite seeding, WebView-on-web) each cost a failed run before diagnosis.
**How to apply:** any future Expo-web e2e that needs deep routes, team membership, or Razorpay checkout.
