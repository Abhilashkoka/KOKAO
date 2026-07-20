import { describe, expect, it } from "vitest";

import { mapLinkUrlToRoute } from "./notificationLinks";

describe("mapLinkUrlToRoute", () => {
  it("maps /accounts to the Accounts tab", () => {
    expect(mapLinkUrlToRoute("/accounts")).toBe("/(tabs)/accounts");
  });

  it("maps /library to the Library tab", () => {
    expect(mapLinkUrlToRoute("/library")).toBe("/(tabs)/library");
  });

  it("ignores query strings, hashes, and trailing slashes", () => {
    expect(mapLinkUrlToRoute("/accounts?platform=facebook")).toBe("/(tabs)/accounts");
    expect(mapLinkUrlToRoute("/library/")).toBe("/(tabs)/library");
    expect(mapLinkUrlToRoute("/library#recent")).toBe("/(tabs)/library");
  });

  it("maps /settings to the plan & billing screen", () => {
    expect(mapLinkUrlToRoute("/settings")).toBe("/settings");
    expect(mapLinkUrlToRoute("/settings?tab=billing")).toBe("/settings");
    expect(mapLinkUrlToRoute("/settings/")).toBe("/settings");
  });

  it("maps /ads to the ads status screen", () => {
    expect(mapLinkUrlToRoute("/ads")).toBe("/ads");
    expect(mapLinkUrlToRoute("/ads?platform=meta")).toBe("/ads");
    expect(mapLinkUrlToRoute("/ads/")).toBe("/ads");
  });

  it("returns null for unmapped web-only paths", () => {
    expect(mapLinkUrlToRoute("/admin")).toBeNull();
    expect(mapLinkUrlToRoute("/analytics")).toBeNull();
  });

  it("returns null for empty or missing linkUrl", () => {
    expect(mapLinkUrlToRoute(null)).toBeNull();
    expect(mapLinkUrlToRoute(undefined)).toBeNull();
    expect(mapLinkUrlToRoute("")).toBeNull();
    expect(mapLinkUrlToRoute("/")).toBeNull();
  });
});
