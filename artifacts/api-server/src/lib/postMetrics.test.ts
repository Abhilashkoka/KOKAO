import { describe, it, expect } from "vitest";
import {
  nextPollAt,
  METRICS_HOT_INTERVAL_MS,
  METRICS_COLD_INTERVAL_MS,
  METRICS_TRACKING_WINDOW_MS,
  isMetricsPlatform,
} from "./postMetrics";

describe("nextPollAt decay schedule", () => {
  const now = new Date("2026-07-24T12:00:00Z");

  it("polls hourly for posts younger than 48h", () => {
    const publishedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const next = nextPollAt(publishedAt, now);
    expect(next).not.toBeNull();
    expect(next!.getTime() - now.getTime()).toBe(METRICS_HOT_INTERVAL_MS);
  });

  it("polls daily after the 48h hot window", () => {
    const publishedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const next = nextPollAt(publishedAt, now);
    expect(next).not.toBeNull();
    expect(next!.getTime() - now.getTime()).toBe(METRICS_COLD_INTERVAL_MS);
  });

  it("stops after the 14-day tracking window", () => {
    const publishedAt = new Date(
      now.getTime() - METRICS_TRACKING_WINDOW_MS - 1000,
    );
    expect(nextPollAt(publishedAt, now)).toBeNull();
  });

  it("treats exactly-at-window-end as done", () => {
    const publishedAt = new Date(now.getTime() - METRICS_TRACKING_WINDOW_MS);
    expect(nextPollAt(publishedAt, now)).toBeNull();
  });
});

describe("isMetricsPlatform", () => {
  it("accepts supported platforms only", () => {
    expect(isMetricsPlatform("facebook")).toBe(true);
    expect(isMetricsPlatform("instagram")).toBe(true);
    expect(isMetricsPlatform("linkedin")).toBe(true);
    expect(isMetricsPlatform("twitter")).toBe(false);
    expect(isMetricsPlatform("threads")).toBe(false);
  });
});
