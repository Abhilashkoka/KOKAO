---
name: LinkedIn publishing
description: How real LinkedIn posting is wired in SocialForge and the LinkedIn API gotchas.
---

# LinkedIn publishing

There is NO Replit first-class connector for posting to LinkedIn (searchIntegrations only returns LinkedIn-adjacent tools: HeyReach, Wiza, ContactOut, Sprout Social, Typefully). Real posting therefore requires a user-owned LinkedIn Developer app.

**Why:** Decided after confirming integration search; documents the constraint so future work doesn't re-search expecting a connector.

**How to apply:**
- Requires `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` (user creates app at developer.linkedin.com) plus the "Sign In with LinkedIn using OpenID Connect" AND "Share on LinkedIn" products (the latter grants `w_member_social`). Posting is gated by LinkedIn product approval, same friction class as Facebook's `pages_manage_posts`.
- OAuth scope used: `openid profile w_member_social`. Member id comes from `GET /v2/userinfo` -> `sub`; author URN is `urn:li:person:{sub}`.
- redirect_uri must EXACTLY match the registered one; build it from request host as `https://<host>/api/linkedin/auth/callback`. Callback runs behind requireTenant so the session cookie supplies the tenant.
- OAuth state is HMAC-signed with `SESSION_SECRET` and tied to tenantId; fail closed (503 / reject) when `SESSION_SECRET` is missing — never use a hardcoded fallback secret.
- Posts API: `POST https://api.linkedin.com/rest/posts` with headers `LinkedIn-Version` (e.g. 202405) + `X-Restli-Protocol-Version: 2.0.0`. New post id is returned in the `x-restli-id` response header (status 201, no JSON body). Permalink: `https://www.linkedin.com/feed/update/{urn}`.
- `commentary` uses LinkedIn "Little Text" format: escape reserved chars `\ < > @ ~ # * _ ( ) { } [ ] |` with a leading backslash (escape backslash first) or the request is rejected.
- Images: `POST /rest/images?action=initializeUpload` with `{initializeUploadRequest:{owner: author}}` -> `{value:{uploadUrl, image}}`; PUT the raw bytes to uploadUrl (set Content-Type from the asset extension); then reference `content.media.id = <image urn>` in the post body.
