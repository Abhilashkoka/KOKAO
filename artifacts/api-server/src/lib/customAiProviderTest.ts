import type { CustomAiProvider } from "@workspace/db";
import { decryptCustomProviderKey, customProviderRef } from "./customAiProviders";
import { platformFetch } from "./platformFetch";
import { getTextGenSelection } from "./textGen";
import { getImageGenSelection } from "./imageGen";

/**
 * Live "does this provider actually work?" checks for admin-added
 * OpenAI-compatible providers (Admin → AI → Custom AI Providers → Test).
 *
 * One cheap request per ENABLED use case against the saved base URL/key:
 *   - text:  a tiny chat completion (max_tokens capped)
 *   - image: a single minimal images/generations request
 *   - video: the OpenRouter-shaped /videos/models catalog listing (free)
 *
 * The base URL passed the shared SSRF guard at save time (https + public
 * host), so this only ever calls what an admin could already point real
 * generations at. Errors are surfaced verbatim (truncated) so the admin sees
 * the provider's own message — wrong key, unknown model, wrong URL, etc.
 *
 * Model choice: if the use case's settings currently select this provider,
 * its configured default model is used; otherwise the first id from the
 * provider's GET /models catalog. No model at all fails with an actionable
 * message rather than guessing.
 */

export type CustomProviderTestUseCase = "text" | "image" | "video";

export interface CustomProviderTestResult {
  useCase: CustomProviderTestUseCase;
  ok: boolean;
  message: string;
}

const TEXT_TEST_TIMEOUT_MS = 20_000;
const IMAGE_TEST_TIMEOUT_MS = 60_000;
const CATALOG_TIMEOUT_MS = 15_000;

/** Provider error body → short human-readable message. */
async function responseError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
      };
      if (typeof json.error === "string") detail = json.error;
      else if (json.error?.message) detail = json.error.message;
      else if (json.message) detail = json.message;
      else detail = text;
    } catch {
      detail = text;
    }
  } catch {
    // keep status only
  }
  detail = detail.trim().slice(0, 300);
  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** First model ids from the provider's OpenAI-style GET /models catalog. */
async function fetchCatalogModels(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const res = await platformFetch(`${baseUrl}/models`, { headers }, CATALOG_TIMEOUT_MS);
  if (!res.ok) throw new Error(await responseError(res));
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((m) => (typeof m.id === "string" ? m.id : null))
    .filter((id): id is string => Boolean(id));
}

export async function testCustomAiProvider(
  row: CustomAiProvider,
): Promise<CustomProviderTestResult[]> {
  const ref = customProviderRef(row.id);
  const baseUrl = row.baseUrl.replace(/\/+$/, "");
  const apiKey = decryptCustomProviderKey(row);
  const headers = buildHeaders(apiKey);

  // GET /models is fetched at most once and shared by the text/image tests
  // when no configured model points at this provider.
  let catalogPromise: Promise<string[]> | null = null;
  const catalogModels = () => {
    catalogPromise ??= fetchCatalogModels(baseUrl, headers);
    return catalogPromise;
  };

  /** Configured model if this provider is selected for the use case, else
   * the first catalog model. Throws with an actionable message when neither
   * yields a model id. */
  async function resolveModel(configured: string | null): Promise<string> {
    if (configured) return configured;
    let catalog: string[] = [];
    let catalogError: string | null = null;
    try {
      catalog = await catalogModels();
    } catch (err) {
      catalogError = errMessage(err);
    }
    if (catalog.length > 0) return catalog[0];
    throw new Error(
      catalogError
        ? `Could not pick a model to test: the provider's /models catalog failed (${catalogError}). Configure a model for this provider in its use case's card, then test again.`
        : "Could not pick a model to test: the provider's /models catalog is empty. Configure a model for this provider in its use case's card, then test again.",
    );
  }

  async function testText(): Promise<CustomProviderTestResult> {
    try {
      const selection = await getTextGenSelection();
      const configured =
        selection.provider === ref
          ? (selection.defaultModel ?? selection.models[0] ?? null)
          : null;
      const model = await resolveModel(configured);
      const res = await platformFetch(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the single word OK." }],
            max_tokens: 5,
          }),
        },
        TEXT_TEST_TIMEOUT_MS,
      );
      if (!res.ok) {
        return { useCase: "text", ok: false, message: await responseError(res) };
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      if (!Array.isArray(json.choices) || json.choices.length === 0) {
        return {
          useCase: "text",
          ok: false,
          message: `Chat completion returned no choices (model ${model}). The endpoint may not be OpenAI-compatible.`,
        };
      }
      return { useCase: "text", ok: true, message: `Chat completion succeeded (model ${model}).` };
    } catch (err) {
      return { useCase: "text", ok: false, message: errMessage(err) };
    }
  }

  async function testImage(): Promise<CustomProviderTestResult> {
    try {
      const selection = await getImageGenSelection();
      const configured = selection.provider === ref ? selection.model : null;
      const model = await resolveModel(configured);
      const res = await platformFetch(
        `${baseUrl}/images/generations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            prompt: "A plain solid blue circle on a white background",
            n: 1,
          }),
        },
        IMAGE_TEST_TIMEOUT_MS,
      );
      if (!res.ok) {
        return { useCase: "image", ok: false, message: await responseError(res) };
      }
      const json = (await res.json()) as {
        data?: Array<{ url?: unknown; b64_json?: unknown }>;
      };
      const first = Array.isArray(json.data) ? json.data[0] : undefined;
      if (!first || (typeof first.url !== "string" && typeof first.b64_json !== "string")) {
        return {
          useCase: "image",
          ok: false,
          message: `Image request returned no image data (model ${model}). The endpoint may not be OpenAI-compatible.`,
        };
      }
      return { useCase: "image", ok: true, message: `Image generation succeeded (model ${model}).` };
    } catch (err) {
      return { useCase: "image", ok: false, message: errMessage(err) };
    }
  }

  // Real video generations are slow and expensive, so the cheap live check is
  // the OpenRouter-shaped catalog listing every compatible video API exposes.
  async function testVideo(): Promise<CustomProviderTestResult> {
    try {
      const res = await platformFetch(
        `${baseUrl}/videos/models`,
        { headers },
        CATALOG_TIMEOUT_MS,
      );
      if (!res.ok) {
        return { useCase: "video", ok: false, message: await responseError(res) };
      }
      const json = (await res.json()) as { data?: unknown };
      if (!Array.isArray(json.data)) {
        return {
          useCase: "video",
          ok: false,
          message:
            "The /videos/models catalog did not return a model list. The endpoint may not expose the OpenRouter-shaped video API.",
        };
      }
      return {
        useCase: "video",
        ok: true,
        message: `Video model catalog reachable (${json.data.length} model${json.data.length === 1 ? "" : "s"}).`,
      };
    } catch (err) {
      return { useCase: "video", ok: false, message: errMessage(err) };
    }
  }

  const tests: Array<Promise<CustomProviderTestResult>> = [];
  if (row.textEnabled) tests.push(testText());
  if (row.imageEnabled) tests.push(testImage());
  if (row.videoEnabled) tests.push(testVideo());
  return Promise.all(tests);
}
