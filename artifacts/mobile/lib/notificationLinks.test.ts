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

  it("returns null for unmapped web-only paths", () => {
    expect(mapLinkUrlToRoute("/admin")).toBeNull();
    expect(mapLinkUrlToRoute("/ads")).toBeNull();
    expect(mapLinkUrlToRoute("/settings")).toBeNull();
  });

  it("returns null for empty or missing linkUrl", () => {
    expect(mapLinkUrlToRoute(null)).toBeNull();
    expect(mapLinkUrlToRoute(undefined)).toBeNull();
    expect(mapLinkUrlToRoute("")).toBeNull();
    expect(mapLinkUrlToRoute("/")).toBeNull();
  });
});
