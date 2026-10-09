---
name: External Clerk ownership
description: Use the owner's Clerk instance rather than managed auth or hostname-derived keys.
---
Use Clerk with the owner's keys from Secrets; do not introduce Replit Auth or provision a replacement Clerk instance.

**Why:** The owner explicitly requested their own Clerk keys. Clerk management detection confirmed external ownership. Hostname-derived live publishable keys can silently select a different instance than the configured secret.

**How to apply:** Preserve explicit configured keys across web, API, and mobile. Do not reintroduce managed Clerk proxy or hostname-based key derivation. Production keys must belong to the same external Clerk instance.
