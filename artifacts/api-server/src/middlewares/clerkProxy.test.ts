import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./clerkProxyMiddleware";

vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("external Clerk proxy", () => {
  it("mounts the login transport before authentication and body parsing", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const mount = source.indexOf("app.use(CLERK_PROXY_PATH, clerkProxyMiddleware())");
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(source.indexOf("clerkMiddleware({"));
    expect(mount).toBeLessThan(source.indexOf("express.json("));
  });

  it("uses the configured secret and forwards the original public proxy URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_test_fixture");
    clerkProxyMiddleware();
    const options = vi.mocked(createProxyMiddleware).mock.calls[0][0];
    const setHeader = vi.fn();
    (options.on!.proxyReq as Function)({ setHeader }, {
      headers: {
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
    });
    expect(setHeader).toHaveBeenCalledWith("Clerk-Secret-Key", "sk_live_test_fixture");
    expect(setHeader).toHaveBeenCalledWith("Clerk-Proxy-Url", `https://app.example.com${CLERK_PROXY_PATH}`);
    expect((options.pathRewrite as Function)(`${CLERK_PROXY_PATH}/v1/client/sign_ins`))
      .toBe("/v1/client/sign_ins");
  });

  it("does not proxy development Clerk instances", () => {
    vi.stubEnv("NODE_ENV", "development");
    clerkProxyMiddleware();
    expect(createProxyMiddleware).not.toHaveBeenCalled();
  });
});
