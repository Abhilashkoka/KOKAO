---
name: Auth return routing
description: Query-only entry selection and Clerk's absolute callback URLs.
---
Subscribe to search parameters separately from the pathname when login choices are encoded in the URL.

**Why:** Wouter pathname subscriptions did not rerender when switching only the login return query, leaving the visual selection and Clerk destination stale despite a changed browser URL.

**How to apply:** use a reactive search subscription for auth destination state and test query-only transitions.

Normalize Clerk's same-origin absolute return URLs to local paths before applying local-path validation; continue rejecting foreign origins and unsafe separators.

**Why:** Clerk's sign-up link can turn a local creator return path into an absolute same-origin URL. Rejecting every absolute URL loses the selected portal.

**How to apply:** bind origin validation to the current browser origin, never to a request-controlled or guessed host, and keep creator selection through sign-in/sign-up callbacks.