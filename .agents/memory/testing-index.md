---
name: Testing lessons index
description: Links to specialized web, mobile, authentication and database test-harness lessons.
---

- [API server test harness](api-server-testing.md) — DB-backed API testing and shared-state cleanup.
- [API route integration tests](api-route-integration-tests.md) — router-level tests and mocked external services.
- [SocialForge frontend tests](socialforge-frontend-tests.md) — generated API hook mocks.
- [E2E test flakiness](e2e-test-flakiness.md) — timing and timeout lessons.
- [Expo e2e testing](expo-e2e-testing.md) — separate-domain authentication.
- [Platform API mocking](platform-api-e2e-mocking.md) — workflow-hosted browser test providers.
- [React Native Web modal tests](react-native-web-modal-tests.md) — exit-state assertions.
- [Expo router test files](expo-router-test-files.md) — tests must stay outside the route directory.
- [Dead social connection seeding](dead-connection-e2e-seeding.md) — seed expiry and reverify timestamps so reconnect prompts are visible.
- [Sweep test harness](sweep-test-mocking.md) — stub every reverifier family and serialize real sweeps.
- [Sweep alert verification](sweep-alert-e2e-verification.md) — force transient failures safely and check notification suppression.
- [Tenant seeding](e2e-tenant-seeding.md) — resolve the exact test tenant, never the newest row.
- [Mobile billing](mobile-billing-e2e.md) — mocked checkout, full Expo navigation and invite timing.
- [Shared payment credentials](shared-razorpay-creds-race.md) — credential validation races can cause unrelated temporary failures.
- [FX alert seeding](fx-stale-e2e-seeding.md) — boot sweeps and cached banners can obscure seeded alerts.
- [Sweep alert interference](sweep-alert-test-interference.md) — live-server sweeps can consume seeded notifications.