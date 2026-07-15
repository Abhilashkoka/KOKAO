// k6 scenario A: light read endpoints (/me, /content, /accounts)
// Run: k6 run loadtest/k6-light-reads.js
// Override stages quickly: k6 run --vus 5 --duration 1m loadtest/k6-light-reads.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

// ============================================================
// PASTE YOUR STAGING BASE URL HERE (no trailing slash)
// e.g. "https://your-staging-app.replit.app"
// Do NOT point this at production without reading PLAN.md rate-limit notes.
// ============================================================
const BASE_URL = __ENV.BASE_URL || "https://PASTE-STAGING-URL-HERE";

// ============================================================
// PASTE YOUR CLERK SESSION COOKIE VALUE HERE.
// How to get it: sign in to the staging app in your browser, open
// DevTools > Application > Cookies, copy the value of the "__session" cookie.
// It expires — refresh it before each test run.
// ============================================================
const SESSION_COOKIE = __ENV.SESSION_COOKIE || "PASTE-__session-VALUE-HERE";

const params = {
  headers: { Cookie: `__session=${SESSION_COOKIE}` },
  timeout: "10s",
};

// 429s are rate-limiter rejections, tracked separately from real errors
export const rateLimited = new Rate("rate_limited");

export const options = {
  scenarios: {
    light_reads: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 5 },   // safe start
        { duration: "2m", target: 25 },  // ramp
        { duration: "2m", target: 50 },  // ramp
        { duration: "5m", target: 50 },  // hold
        { duration: "1m", target: 0 },   // ramp down
      ],
    },
  },
  thresholds: {
    "http_req_duration{endpoint:me}": ["p(95)<300"],
    "http_req_duration{endpoint:content}": ["p(95)<400"],
    "http_req_duration{endpoint:accounts}": ["p(95)<300"],
    http_req_failed: ["rate<0.01"], // <1% errors
  },
};

function get(path, tag) {
  const res = http.get(`${BASE_URL}${path}`, {
    ...params,
    tags: { endpoint: tag },
  });
  rateLimited.add(res.status === 429);
  check(res, {
    [`${tag}: status 200`]: (r) => r.status === 200,
    [`${tag}: not auth error`]: (r) => r.status !== 401 && r.status !== 403,
  });
  return res;
}

export default function () {
  // Realistic page-load mix: /me and /content fire on every load,
  // /accounts about half as often.
  get("/api/me", "me");
  get("/api/content", "content");
  if (__ITER % 2 === 0) {
    get("/api/accounts", "accounts");
  }
  sleep(1); // 1s think time per virtual user loop
}
