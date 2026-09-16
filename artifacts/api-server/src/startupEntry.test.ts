import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
}));

vi.mock("./lib/assertEnv", () => ({
  assertRequiredEnv: () => {
    mocks.order.push("required-env");
  },
}));

vi.mock("./lib/productionCreditBootstrap", () => ({
  initializeProductionCreditBootstrap: async () => {
    mocks.order.push("production-bootstrap");
    return { status: "skipped" };
  },
}));

vi.mock("./serverRuntime", () => ({
  startServerRuntime: async () => {
    mocks.order.push("server-runtime");
  },
}));

afterEach(() => {
  delete process.env.PORT;
  mocks.order.length = 0;
});

describe("startup entrypoint ordering", () => {
  it("loads the runtime only after the startup bootstrap resolves", async () => {
    process.env.PORT = "0";
    await import("./index");
    expect(mocks.order).toEqual([
      "required-env",
      "production-bootstrap",
      "server-runtime",
    ]);
  });
});