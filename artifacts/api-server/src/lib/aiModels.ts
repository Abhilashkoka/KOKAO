/**
 * Canonical list of AI text models tenants may pick for caption/topic
 * generation. The Replit AI proxy only serves specific model names; anything
 * else fails every AI call with an "unsupported model" error. Keep this list
 * in sync with the Settings page dropdown in the web app.
 */
export const SUPPORTED_AI_MODELS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"] as const;

export const DEFAULT_AI_MODEL = "gpt-5.4";

export function isSupportedAiModel(model: string): boolean {
  return (SUPPORTED_AI_MODELS as readonly string[]).includes(model);
}

/**
 * Map a stored tenant model to one the provider actually supports. Legacy
 * rows may still hold retired names (gpt-4o, claude-3-5-sonnet, ...); those
 * fall back to the default instead of failing every AI request.
 */
export function resolveAiModel(model: string): string {
  return isSupportedAiModel(model) ? model : DEFAULT_AI_MODEL;
}
