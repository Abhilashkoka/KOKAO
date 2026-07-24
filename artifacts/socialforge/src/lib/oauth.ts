/**
 * Sends the browser to a platform sign-in page. Inside an embedded preview
 * frame (e.g. the canvas), providers like Facebook, Google, and LinkedIn
 * refuse to render their login pages, so open the flow in a new top-level tab
 * instead.
 */
export function openOAuthUrl(url: string): "tab" | "redirect" {
  // Open in a NEW top-level tab: OAuth providers send X-Frame-Options/CSP
  // headers that block loading inside the embedded preview iframe.
  const popup = window.open(url, "_blank", "noopener");
  if (!popup) {
    // Popup blocked — fall back to top-level navigation.
    window.location.href = url;
    return "redirect";
  }
  return "tab";
}
