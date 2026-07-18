/**
 * Guard: the content detail screen's expired-connection banner
 * (app/content/[id].tsx via buildExpiredNames/buildExpiredBannerText) must
 * list exactly the platforms whose tokens expired, with correct
 * singular/plural grammar, so a regression can't silently show the wrong
 * platforms or broken wording.
 */
import { describe, it, expect } from "vitest";

import {
  buildExpiredNames,
  buildExpiredBannerText,
} from "./expiredConnectionBanner";

const none = { linkedinExpired: false, twitterExpired: false, threadsExpired: false };

describe("buildExpiredNames", () => {
  it("returns nothing when no connection is expired", () => {
    expect(buildExpiredNames(none)).toEqual([]);
  });

  it("returns the single expired platform's display name", () => {
    expect(buildExpiredNames({ ...none, linkedinExpired: true })).toEqual(["LinkedIn"]);
    expect(buildExpiredNames({ ...none, twitterExpired: true })).toEqual(["X"]);
    expect(buildExpiredNames({ ...none, threadsExpired: true })).toEqual(["Threads"]);
  });

  it("returns multiple expired platforms in a stable order", () => {
    expect(
      buildExpiredNames({ linkedinExpired: true, twitterExpired: true, threadsExpired: false }),
    ).toEqual(["LinkedIn", "X"]);
    expect(
      buildExpiredNames({ linkedinExpired: true, twitterExpired: true, threadsExpired: true }),
    ).toEqual(["LinkedIn", "X", "Threads"]);
  });
});

describe("buildExpiredBannerText", () => {
  it("returns null when nothing is expired (banner hidden)", () => {
    expect(buildExpiredBannerText([])).toBeNull();
  });

  it("uses singular wording for one expired platform", () => {
    expect(buildExpiredBannerText(["X"])).toBe(
      "Your X connection expired. Reconnect it from KOKAO on the web.",
    );
  });

  it("uses plural wording for two expired platforms", () => {
    expect(buildExpiredBannerText(["LinkedIn", "X"])).toBe(
      "Your LinkedIn and X connections expired. Reconnect them from KOKAO on the web.",
    );
  });

  it("joins three expired platforms with 'and' separators", () => {
    expect(buildExpiredBannerText(["LinkedIn", "X", "Threads"])).toBe(
      "Your LinkedIn and X and Threads connections expired. Reconnect them from KOKAO on the web.",
    );
  });
});
