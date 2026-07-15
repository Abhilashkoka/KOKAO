import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  handleAdminForbidden,
  handleAdminQuerySuccess,
  resetAdminAccessRevoked,
  useAdminAccessRevoked,
} from "./admin-guard";
import { renderHook, act } from "@testing-library/react";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function forbidden(url: string) {
  return { status: 403, url };
}

describe("admin-guard", () => {
  beforeEach(() => {
    resetAdminAccessRevoked();
  });

  it("flags revocation on a 403 from an /admin URL", () => {
    const qc = makeClient();
    const { result } = renderHook(() => useAdminAccessRevoked());
    expect(result.current).toBe(false);

    act(() => {
      handleAdminForbidden(qc, forbidden("https://x.test/api/admin/tenants"));
    });
    expect(result.current).toBe(true);
  });

  it("ignores non-403 errors and 403s from non-admin URLs", () => {
    const qc = makeClient();
    const { result } = renderHook(() => useAdminAccessRevoked());

    act(() => {
      handleAdminForbidden(qc, forbidden("https://x.test/api/content"));
      handleAdminForbidden(qc, { status: 500, url: "https://x.test/api/admin/tenants" });
      handleAdminForbidden(qc, new Error("network"));
      handleAdminForbidden(qc, null);
    });
    expect(result.current).toBe(false);
  });

  it("purges cached /admin queries and invalidates /me on revocation", () => {
    const qc = makeClient();
    qc.setQueryData(["/api/admin/tenants"], [{ id: 1 }]);
    qc.setQueryData(["/api/admin/stats"], { tenants: 1 });
    qc.setQueryData(["/api/me"], { isSuperadmin: true });
    qc.setQueryData(["/api/content"], [{ id: 9 }]);

    handleAdminForbidden(qc, forbidden("https://x.test/api/admin/stats"));

    expect(qc.getQueryData(["/api/admin/tenants"])).toBeUndefined();
    expect(qc.getQueryData(["/api/admin/stats"])).toBeUndefined();
    // Non-admin data untouched.
    expect(qc.getQueryData(["/api/content"])).toEqual([{ id: 9 }]);
    // /me kept but marked stale for refetch.
    expect(qc.getQueryData(["/api/me"])).toEqual({ isSuperadmin: true });
    expect(qc.getQueryState(["/api/me"])?.isInvalidated).toBe(true);
  });

  it("resets after a successful /admin query", () => {
    const qc = makeClient();
    const { result } = renderHook(() => useAdminAccessRevoked());

    act(() => {
      handleAdminForbidden(qc, forbidden("https://x.test/api/admin/tenants"));
    });
    expect(result.current).toBe(true);

    act(() => {
      handleAdminQuerySuccess(["/api/content"]);
    });
    expect(result.current).toBe(true);

    act(() => {
      handleAdminQuerySuccess(["/api/admin/tenants"]);
    });
    expect(result.current).toBe(false);
  });
});
