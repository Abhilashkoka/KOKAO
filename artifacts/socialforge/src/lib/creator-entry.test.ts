import { describe, expect, it } from "vitest";
import { authEntryTarget, authFlowTarget, authSwitchUrl, safeReturnPath, updateAuthFlowTarget } from "./creator-entry";

describe("creator authentication return path", () => {
  it("defaults to the regular workspace but honors creator and ordinary deep links", () => {
    expect(authEntryTarget("")).toBe("/dashboard");
    expect(authEntryTarget("?redirect_url=%2Fcreator")).toBe("/creator");
    expect(authEntryTarget("?redirect_url=%2Fadmin%3Ftab%3Dusers")).toBe("/admin?tab=users");
    expect(authEntryTarget("?redirect_url=%2Fapp%2Fcreator", "/app")).toBe("/creator");
    expect(authSwitchUrl("sign-up", "/creator")).toBe("/sign-up?redirect_url=%2Fcreator");
    expect(authSwitchUrl("sign-in", "/admin?tab=users")).toBe("/sign-in?redirect_url=%2Fadmin%3Ftab%3Dusers");
  });

  it("rejects externally navigable, encoded, malformed and nonlocal destinations", () => {
    for (const value of ["//evil.test", "/\\evil.test", "/%2fevil.test", "/%5cevil.test",
      "https://evil.test", "javascript:alert(1)", " /creator", "/%2e%2e/creator",
      "/creator\n", "/creator\r", "/creator%0a"]) {
      expect(safeReturnPath(value)).toBeNull();
    }
    expect(authEntryTarget("?redirect_url=%2F%2Fevil.test")).toBe("/dashboard");
    expect(authEntryTarget("?redirect_url=https%3A%2F%2Fevil.test")).toBe("/dashboard");
  });

  it("accepts only this app's exact origin when Clerk makes the return URL absolute", () => {
    const origin = window.location.origin;
    expect(safeReturnPath(`${origin}/creator`)).toBe("/creator");
    expect(authEntryTarget(`?redirect_url=${encodeURIComponent(`${origin}/app/admin?tab=users`)}`, "/app"))
      .toBe("/admin?tab=users");
    expect(authEntryTarget(`?redirect_url=${encodeURIComponent(`${origin}/creator`)}`)).toBe("/creator");
    expect(safeReturnPath("https://evil.test/creator")).toBeNull();
    expect(safeReturnPath("//evil.test/creator")).toBeNull();
    expect(safeReturnPath(`${origin.replace("localhost", "evil.test")}/creator`)).toBeNull();
  });

  it("retains a choice only for the current tab's in-progress Clerk callback and clears it after sign-in or fresh entry", () => {
    sessionStorage.clear();
    updateAuthFlowTarget("?redirect_url=%2Fcreator", "/sign-in", false);
    expect(authFlowTarget("", "/sign-in/sso-callback")).toBe("/creator");
    expect(authFlowTarget("", "/sign-up/factor-one")).toBe("/creator");
    updateAuthFlowTarget("", "/sign-in/sso-callback", true);
    expect(authFlowTarget("", "/sign-in/sso-callback")).toBe("/dashboard");
    updateAuthFlowTarget("?redirect_url=%2Fadmin", "/sign-in", false);
    updateAuthFlowTarget("", "/sign-in", false);
    expect(authFlowTarget("", "/sign-up/sso-callback")).toBe("/dashboard");
    sessionStorage.clear();
  });
});