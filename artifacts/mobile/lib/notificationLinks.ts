// Map web link URLs carried by notifications to the matching mobile screens.
// Unknown paths return null so a tap just marks the item read without navigating.

export type NotificationRoute = "/(tabs)/accounts" | "/(tabs)/library";

const LINK_ROUTES: Record<string, NotificationRoute> = {
  "/accounts": "/(tabs)/accounts",
  "/library": "/(tabs)/library",
};

export function mapLinkUrlToRoute(
  linkUrl: string | null | undefined,
): NotificationRoute | null {
  if (!linkUrl) return null;
  const path = linkUrl.split(/[?#]/)[0]?.replace(/\/+$/, "") || "/";
  return LINK_ROUTES[path] ?? null;
}
