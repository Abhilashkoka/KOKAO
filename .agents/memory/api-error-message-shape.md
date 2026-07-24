---
name: ApiError message extraction
description: How to read server error text from the shared API client's ApiError; axios-style paths silently fail.
---

The shared API client's `ApiError` exposes the parsed JSON body on `error.data`; `error.response` is a raw fetch `Response` with no `.data`.

**Why:** Mobile billing/team screens once used axios-style `err?.response?.data?.error` — it compiles, always yields `undefined`, and every server rejection surfaced as a generic "please try again", hiding real reasons (expired promo, already-cancelled subscription, etc.).

**How to apply:** In any client (web or mobile), extract server error text with the `apiErrorMessage(error, fallback)` helper (web: `artifacts/socialforge/src/lib/apiErrorMessage.ts`; mobile: `artifacts/mobile/lib/apiErrorMessage.ts`), which reads `error.data.error|message|detail`. Never write `err.response.data` reads — they are dead code with this client. Server error bodies are `{ error: "..." }`.
