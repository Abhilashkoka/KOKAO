---
name: Meta credential framework (SocialForge)
description: Reusable encrypted social-credential pattern; how Meta (FB Page + IG) creds are stored, tested, and used to publish.
---

# Meta credential framework

Two credential layers, both encrypted at rest with AES-256-GCM (`lib/secretCrypto.ts`, key derived from `SESSION_SECRET`; save paths fail closed via `isEncryptionConfigured()` when it's missing):

- App-level (superadmin only): Meta App ID + App Secret in `app_credentials` (provider unique = "meta"). Managed via `/admin/platform-credentials/meta` GET/PUT with INLINE `requireSuperadmin` (credentials.ts is mounted as a plain router after `requireTenant`, so it does not inherit admin.ts's `/admin` gate).
- Tenant-level: Facebook Page (pageId + pageAccessToken) and Instagram (igUserId) stored in that tenant's `connected_accounts.encryptedCredentials`. Managed via `/social-credentials/{facebook,instagram}` GET/PUT.

Save auto-tests immediately and persists `verifyStatus`/`verifyError`. Responses are ALWAYS masked (`maskSecret`) — plaintext secrets never leave the server and are never logged.

**Secrets must never appear in a URL** (they leak into upstream/proxy access logs). Meta calls therefore pass tokens via the `Authorization: Bearer <token>` header for GET reads, and via the POST body for the OAuth app-token check. This was a code-review finding — keep it that way for any new Meta call.

Publishing (`routes/meta.ts`) uses the tenant's stored verified creds — no page picker. Instagram: image is MANDATORY, rides on the tenant's verified Facebook Page token, needs a PUBLIC image URL so it mints a short-lived signed GET URL (`ObjectStorageService.getSignedDownloadURL`, ~900s), then create media container -> media_publish. Content Library gates publish buttons on `verifyStatus === "verified"`.

**Why:** Multi-tenant SaaS — each tenant brings their own Page/IG; the app owner supplies one Meta app. Encryption + masking + no-URL-secrets are the security boundary.
