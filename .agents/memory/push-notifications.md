---
name: Mobile push notifications
description: Expo push channel design — dispatch placement, recipient gating, token lifecycle, and test pitfalls.
---

# Mobile push notifications (Expo)

- Push is a third channel beside in-app/email, dispatched from the same choke point (`lib/notifications.ts`) via `sendTenantPush` — but ONLY after a FRESH notification insert. Update-in-place dedupe branches (unread banners) must never re-push, mirroring email behavior.
- **Why:** callers already decide fresh-vs-update; putting push next to each insert inherits that dedupe for free.
- Recipient rule: owner devices are gated by the tenant-scoped effective `push` pref; each member's devices by their own member-scoped push pref (missing row = on). Neither party's choice silences the other.
- Expo push API is keyless (`exp.host/--/api/v2/push/send`); tokens returned as `DeviceNotRegistered` must be deleted so dead devices stop consuming sends. Everything is best-effort/never-throws.
- Dead-token cleanup is three-layered: immediate ticket `DeviceNotRegistered`, delayed Expo receipt check (in-memory pending queue, flushed on next send + 15-min maintenance loop; process restart loses only the check, not correctness), and a 90-day `lastSeenAt` prune for uninstalled apps that never error. `lastSeenAt` refreshes on every registration (mobile re-registers each launch).
- Token table is keyed by TOKEN, not user: re-registering re-binds to the current signer so a handed-over device stops pushing to its previous user. Unregister deletes only when the token belongs to the caller.
- API change compat: `push` is REQUIRED in the settings response but OPTIONAL in the update input — omitted means "keep stored", so older web clients that only send inApp/email never clobber the push choice.

## Test pitfalls
- `createTestApp` mounts routers EXPLICITLY — a new router added to `routes/index.ts` still 404s in tests until added to `src/test/testApp.ts`.
- `createTenant()` test helper returns `{ tenantId, clerkUserId }` — NOT `id`. Passing `tenant.id` silently queries with undefined and functions "succeed" doing nothing.
- expo-notifications' `NotificationPermissionsStatus` extends expo's `PermissionResponse`, which doesn't resolve across the monorepo's hoisted types — read `granted`/`status` through a narrow local cast.
