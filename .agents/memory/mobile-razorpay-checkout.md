---
name: Mobile Razorpay checkout
description: How the Expo app runs Razorpay Checkout without a native SDK
---

Razorpay has no Expo-friendly native module, so the mobile app hosts Checkout in a
`react-native-webview` modal: a generated HTML page loads
`https://checkout.razorpay.com/v1/checkout.js`, opens Checkout, and posts
success/failure/dismiss back via `window.ReactNativeWebView.postMessage`.

**Why:** keeps the exact same server contract as the web app (subscribe /
purchase-credits create, then verify-subscription / verify-purchase). The app —
not the WebView — calls the verify endpoints over its own authenticated Clerk
bearer session, so nothing from the WebView is trusted beyond the Razorpay ids;
the server re-fetches the canonical Razorpay entity anyway.

**How to apply:** for any new in-app payment surface, reuse
`artifacts/mobile/components/RazorpayCheckoutModal.tsx` rather than embedding the
web billing page (which would lack the app's session) or adding a native SDK.
WebView `source={{ html }}` needs a `baseUrl` (an https origin) or checkout.js
can misbehave. In tests, mock the modal component to avoid importing
react-native-webview under jsdom.

**WebView transform pitfall:** any jsdom test that renders a screen importing `RazorpayCheckoutModal` must `vi.mock("@/components/RazorpayCheckoutModal")` (and `@/lib/verifyFailureNotice` if imported) — react-native-webview's untransformed source throws `SyntaxError: Unexpected token 'typeof'` at suite import, failing the whole file with "0 test".
