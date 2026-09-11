import { describe, expect, it, vi } from "vitest";
import { MeterDispatchReplayError } from "../meterErrors";
import { withRetries } from "./retry";

describe("withRetries", () => {
  it("does not retry a metered replay block", async () => {
    const operation = vi.fn(async () => {
      throw new MeterDispatchReplayError();
    });

    await expect(withRetries(operation)).rejects.toBeInstanceOf(
      MeterDispatchReplayError,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});