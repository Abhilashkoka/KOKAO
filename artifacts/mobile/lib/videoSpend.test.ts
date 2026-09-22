import { describe, expect, it } from "vitest";

import { formatVideoCreditsUsed } from "./videoSpend";

describe("formatVideoCreditsUsed", () => {
  it("formats the server aggregate with up to three decimal places", () => {
    expect(formatVideoCreditsUsed(12)).toBe("Total credits used: 12");
    expect(formatVideoCreditsUsed(12.5)).toBe("Total credits used: 12.5");
    expect(formatVideoCreditsUsed(12.3456)).toBe("Total credits used: 12.346");
  });

  it("preserves an authoritative zero", () => {
    expect(formatVideoCreditsUsed(0)).toBe("Total credits used: 0");
  });

  it("marks null and missing historical aggregates unavailable", () => {
    expect(formatVideoCreditsUsed(null)).toBe("Credits used: unavailable");
    expect(formatVideoCreditsUsed(undefined)).toBe("Credits used: unavailable");
  });

  it("uses Indian digit grouping without an INR label or symbol", () => {
    const formatted = formatVideoCreditsUsed(125000.25);
    expect(formatted).toBe("Total credits used: 1,25,000.25");
    expect(formatted).not.toMatch(/₹|INR/i);
  });
});
