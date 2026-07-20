// Map web link URLs carried by notifications to the matching mobile screens.
// Unknown paths return null so a tap just marks the item read without navigating.

export type NotificationRoute =
  | "/(tabs)/accounts"
  | "/(tabs)/library"
  | "/settings"
  | "/ads"
  | { pathname: "/content/[id]"; params: { id: string } };

const LINK_ROUTES: Record<string, NotificationRoute> = {
  "/accounts": "/(tabs)/accounts",
  "/library": "/(tabs)/library",
  "/settings": "/settings",
  "/ads": "/ads",
};

/**
 * Extract a positive integer `item` query param from a /library link, so
 * publish-outcome notifications can open the exact post's edit screen.
 */
function libraryItemId(linkUrl: string): string | null {
  const query = linkUrl.split("#")[0]?.split("?")[1];
  if (!query) return null;
  const raw = new URLSearchParams(query).get("item");
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return raw;
  return null;
}

export function mapLinkUrlToRoute(
  linkUrl: string | null | undefined,
): NotificationRoute | null {
  if (!linkUrl) return null;
  const path = linkUrl.split(/[?#]/)[0]?.replace(/\/+$/, "") || "/";
  if (path === "/library") {
    const id = libraryItemId(linkUrl);
    if (id) return { pathname: "/content/[id]", params: { id } };
  }
  return LINK_ROUTES[path] ?? null;
}
