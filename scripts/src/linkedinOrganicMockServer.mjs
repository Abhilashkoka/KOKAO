// Minimal LinkedIn OAuth token-endpoint mock for browser e2e runs of the
// ORGANIC silent-refresh path (lib/linkedinOrganicRefresh.ts).
//
// Point the API server at it with (development env only):
//   LINKEDIN_TOKEN_URL_OVERRIDE=http://localhost:9097/oauth/v2/accessToken
// Run as a workflow: PORT=9097 node scripts/src/linkedinOrganicMockServer.mjs
//
// POST /oauth/v2/accessToken (grant_type=refresh_token):
//   - normal mode: 200 with a fresh access token (expires_in 60 days) and a
//     rotated refresh token (refresh_token_expires_in ~1 year)
//   - revoked mode: 400 invalid_grant (definitive rejection -> reconnect)
// POST /oauth/v2/accessToken (grant_type=authorization_code):
//   - always succeeds with fresh tokens and UN-REVOKES the mock (a user
//     completing OAuth is exactly the reconnect flow). Used with
//     LINKEDIN_TOKEN_URL_OVERRIDE to drive the OAuth callback end to end.
// GET /v2/userinfo: 200 {sub, name} for freshly minted mock tokens, 401 for
//   anything else (pair with LINKEDIN_USERINFO_URL_OVERRIDE).
// POST /__control {"revoked": true|false} toggles the mode.
// GET  /__log returns the persisted request log.
//
// State + request log persist to /tmp so workflow restarts around test runs
// don't lose evidence.

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9097);
const STATE_FILE = "/tmp/linkedin-organic-mock-state.json";
const LOG_FILE = "/tmp/linkedin-organic-mock-log.json";

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
let state = load(STATE_FILE, { revoked: false, tokenCounter: 0 });
let log = load(LOG_FILE, []);

function persist() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log.push({ at: new Date().toISOString(), method: req.method, url: req.url, body });

    if (req.method === "POST" && req.url === "/__control") {
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed.revoked === "boolean") state.revoked = parsed.revoked;
      } catch {}
      persist();
      return json(res, 200, { ok: true, state });
    }
    if (req.method === "GET" && req.url === "/__log") {
      persist();
      return json(res, 200, { state, log });
    }

    if (req.method === "POST" && req.url?.startsWith("/oauth/v2/accessToken")) {
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        // A completed OAuth connect un-revokes the grant — this IS the
        // reconnect flow.
        state.revoked = false;
        state.tokenCounter += 1;
        persist();
        return json(res, 200, {
          access_token: `mock-connect-access-${state.tokenCounter}`,
          expires_in: 60 * 24 * 60 * 60, // 60 days
          refresh_token: `mock-connect-refresh-${state.tokenCounter}`,
          refresh_token_expires_in: 360 * 24 * 60 * 60, // ~1 year
          scope: "openid,profile,w_member_social",
          token_type: "Bearer",
        });
      }
      if (grantType !== "refresh_token") {
        persist();
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (state.revoked) {
        persist();
        return json(res, 400, {
          error: "invalid_grant",
          error_description: "The provided refresh token is revoked (mock)",
        });
      }
      state.tokenCounter += 1;
      persist();
      return json(res, 200, {
        access_token: `mock-renewed-access-${state.tokenCounter}`,
        expires_in: 60 * 24 * 60 * 60, // 60 days
        refresh_token: `mock-rotated-refresh-${state.tokenCounter}`,
        refresh_token_expires_in: 360 * 24 * 60 * 60, // ~1 year
        scope: "openid,profile,w_member_social",
        token_type: "Bearer",
      });
    }

    if (req.method === "GET" && req.url?.startsWith("/v2/userinfo")) {
      const auth = req.headers.authorization || "";
      persist();
      if (/^Bearer mock-(connect|renewed)-access-/.test(auth)) {
        return json(res, 200, {
          sub: "mock-linkedin-member-1",
          name: "Mock LinkedIn Member",
        });
      }
      return json(res, 401, { error: "invalid_token" });
    }

    persist();
    json(res, 404, { error: "not_found", url: req.url });
  });
});

server.listen(PORT, () => {
  console.log(`linkedin organic mock listening on :${PORT} (revoked=${state.revoked})`);
});
