import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClerkBootstrapReady,
  ClerkBootstrapRecovery,
} from "./clerk-bootstrap-recovery";

describe("ClerkBootstrapRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reloads once when Clerk initialization stalls", () => {
    const reload = vi.fn();
    render(<ClerkBootstrapRecovery timeoutMs={100} reload={reload} />);

    act(() => vi.advanceTimersByTime(100));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows a manual recovery action instead of looping reloads", () => {
    const reload = vi.fn();
    sessionStorage.setItem("kokao-clerk-bootstrap-reload-v1", "1");
    render(<ClerkBootstrapRecovery timeoutMs={100} reload={reload} />);

    act(() => vi.advanceTimersByTime(100));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-clerk-bootstrap").textContent)
      .toContain("taking longer than expected");
  });

  it("clears the reload guard after Clerk initializes", () => {
    sessionStorage.setItem("kokao-clerk-bootstrap-reload-v1", "1");

    render(<ClerkBootstrapReady />);

    expect(sessionStorage.getItem("kokao-clerk-bootstrap-reload-v1")).toBeNull();
  });
});