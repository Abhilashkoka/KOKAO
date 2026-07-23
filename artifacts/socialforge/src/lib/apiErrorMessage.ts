/**
 * Extract a human-readable message from an API error.
 *
 * The shared API client throws `ApiError`, which exposes the parsed JSON
 * body on `error.data` (its `error.response` is a raw fetch Response with
 * no `.data`). Our server error bodies look like `{ error: "..." }`, so we
 * read `data.error` first, then a few sensible fallbacks.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === "object") {
    const body = data as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
  }
  if (typeof data === "string" && data.trim() !== "") return data.trim();
  return fallback;
}
