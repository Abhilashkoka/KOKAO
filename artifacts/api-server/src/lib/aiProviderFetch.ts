/**
 * Shared bounded-timeout fetch core for AI provider calls (image, video, ASR).
 *
 * Each provider family keeps its own thin wrapper (imageGenFetch,
 * videoGenFetch, asrFetch) with its own timeout constant and error class, but
 * the abort/timeout mechanics live here in one place. Social-platform calls
 * use lib/platformFetch.ts instead — that one is coupled to the shutdown
 * drain window and has a much shorter budget.
 */

/**
 * Fetch with a hard timeout. On timeout, throws whatever `onTimeout` returns
 * (each caller family wraps it in its own provider-error type so existing
 * catch blocks keep working).
 */
export async function boundedProviderFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw onTimeout();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Short upstream error detail for logs/messages without dumping whole bodies. */
export async function errorDetail(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}
