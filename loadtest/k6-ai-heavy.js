// k6 scenario B: heavy AI endpoints (/ai/generate-caption, /ai/generate-image)
// Run: k6 run loadtest/k6-ai-heavy.js
//
// WARNING: every request costs real AI money and consumes the tenant's plan
// quota. Use a staging tenant with an unlimited plan (-1 limits) or you will
// get 402 responses. Keep total request counts low.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";

// ============================================================
// PASTE YOUR STAGING BASE URL HERE (no trailing slash)
// ============================================================
const BASE_URL = __ENV.BASE_URL || "https://PASTE-STAGING-URL-HERE";

// ============================================================
// PASTE YOUR CLERK SESSION COOKIE VALUE HERE ("__session" cookie
// from browser DevTools after signing in to staging).
// ============================================================
const SESSION_COOKIE = __ENV.SESSION_COOKIE || "PASTE-__session-VALUE-HERE";

const headers = {
  "Content-Type": "application/json",
  Cookie: `__session=${SESSION_COOKIE}`,
};

export const quotaExceeded = new Counter("quota_402");
export const rateLimited = new Rate("rate_limited");

export const options = {
  scenarios: {
    // Caption generation: modest concurrency, long timeout
    captions: {
      executor: "ramping-vus",
      exec: "caption",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 2 },  // safe start (stays under 30/min limiter)
        { duration: "3m", target: 5 },  // staging only
        { duration: "3m", target: 10 }, // staging only — watch AI spend
        { duration: "1m", target: 0 },
      ],
    },
    // Image generation: minimal concurrency, very long timeout.
    // Starts after captions ramp so the two don't stack at peak.
    images: {
      executor: "ramping-vus",
      exec: "image",
      startTime: "1m",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 1 },  // safe start
        { duration: "3m", target: 3 },
        { duration: "2m", target: 5 },  // absolute max — expensive
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration{endpoint:caption}": ["p(95)<20000"], // 20 s
    "http_req_duration{endpoint:image}": ["p(95)<60000"],   // 60 s
    http_req_failed: ["rate<0.02"], // <2% errors
  },
};

// ============================================================
// SAMPLE REQUEST BODIES — adjust to match your staging data.
// brandKitId is optional; add one if you want the brand-kit path exercised:
//   e.g. { prompt: "...", platform: "instagram", brandKitId: "PASTE-KIT-ID" }
// ============================================================
const captionBody = JSON.stringify({
  prompt: "Announce our summer sale with a friendly, upbeat tone",
  platform: "instagram",
  // brandKitId: "PASTE-BRAND-KIT-ID-HERE", // optional
});

const imageBody = JSON.stringify({
  prompt: "A bright flat-lay product photo of a coffee mug on a pastel background",
  // brandKitId: "PASTE-BRAND-KIT-ID-HERE", // optional
});

function post(path, body, tag, timeout) {
  const res = http.post(`${BASE_URL}${path}`, body, {
    headers,
    timeout,
    tags: { endpoint: tag },
  });
  if (res.status === 402) quotaExceeded.add(1); // plan quota exhausted
  rateLimited.add(res.status === 429);          // aiLimiter rejection
  check(res, {
    [`${tag}: status 200`]: (r) => r.status === 200,
    [`${tag}: not auth error`]: (r) => r.status !== 401 && r.status !== 403,
  });
}

export function caption() {
  post("/api/ai/generate-caption", captionBody, "caption", "30s");
  sleep(3); // think time keeps per-VU rate realistic
}

export function image() {
  post("/api/ai/generate-image", imageBody, "image", "120s");
  sleep(5);
}
