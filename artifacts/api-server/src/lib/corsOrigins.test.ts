import { describe, it, expect } from "vitest";
import express from "express";
import cors from "cors";
import request from "supertest";
import { buildAllowedOrigins } from "./corsOrigins";

describe("buildAllowedOrigins", () => {
  it("includes every REPLIT_DOMAINS entry and REPLIT_EXPO_DEV_DOMAIN", () => {
    const origins = buildAllowedOrigins({
      REPLIT_DOMAINS: "app.example.replit.app, dev.example.replit.dev",
      REPLIT_EXPO_DEV_DOMAIN: "abc.expo.pike.replit.dev",
    } as NodeJS.ProcessEnv);

    expect(origins).toEqual(
      new Set([
        "https://app.example.replit.app",
        "https://dev.example.replit.dev",
        "https://abc.expo.pike.replit.dev",
      ]),
    );
  });

  it("omits the Expo origin only when the env var is unset, without blanks", () => {
    const origins = buildAllowedOrigins({
      REPLIT_DOMAINS: "app.example.replit.app",
    } as NodeJS.ProcessEnv);

    expect(origins).toEqual(new Set(["https://app.example.replit.app"]));
  });

  it("handles fully empty env without producing bogus origins", () => {
    expect(buildAllowedOrigins({} as NodeJS.ProcessEnv)).toEqual(new Set());
  });

  it("reflects the current process env (regression: Expo dev domain must be allowed)", () => {
    // The real dev environment always has both vars set; this guards against
    // a refactor of buildAllowedOrigins/app.ts dropping the Expo domain.
    if (!process.env.REPLIT_DOMAINS || !process.env.REPLIT_EXPO_DEV_DOMAIN) {
      return; // env not available (e.g. CI) — covered by the synthetic cases
    }
    const origins = buildAllowedOrigins();
    for (const d of process.env.REPLIT_DOMAINS.split(",")) {
      expect(origins.has(`https://${d.trim()}`)).toBe(true);
    }
    expect(
      origins.has(`https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`),
    ).toBe(true);
  });
});

describe("CORS middleware behavior with the allowlist", () => {
  // Mirror app.ts's cors() config exactly, but against a tiny app so we don't
  // import the full server (Clerk, DB, routes).
  function makeApp(allowedOrigins: Set<string>) {
    const app = express();
    app.use(
      cors({
        credentials: true,
        origin(origin, callback) {
          if (!origin || allowedOrigins.has(origin)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        },
      }),
    );
    app.get("/ping", (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  const allowed = buildAllowedOrigins({
    REPLIT_DOMAINS: "web.example.replit.app",
    REPLIT_EXPO_DEV_DOMAIN: "mobile.expo.pike.replit.dev",
  } as NodeJS.ProcessEnv);

  it("serves CORS headers for the Expo (mobile) origin", async () => {
    const res = await request(makeApp(allowed))
      .get("/ping")
      .set("Origin", "https://mobile.expo.pike.replit.dev");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://mobile.expo.pike.replit.dev",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("serves CORS headers for the web origin", async () => {
    const res = await request(makeApp(allowed))
      .get("/ping")
      .set("Origin", "https://web.example.replit.app");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://web.example.replit.app",
    );
  });

  it("does NOT emit CORS headers for an unknown origin (silent drop)", async () => {
    const res = await request(makeApp(allowed))
      .get("/ping")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows requests with no Origin header (same-origin / curl)", async () => {
    const res = await request(makeApp(allowed)).get("/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
