/**
 * Tolerant JSON-object parse for model output. Some models wrap JSON in
 * markdown fences or surrounding prose despite response_format=json_object.
 */
export function parseModelJsonObject(
  raw: string,
): Record<string, unknown> | null {
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw.trim());
  if (direct) return direct;

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fenceRe.exec(raw); match; match = fenceRe.exec(raw)) {
    const fromFence = tryParse(match[1].trim());
    if (fromFence) return fromFence;
  }

  let attempts = 0;
  for (
    let start = raw.indexOf("{");
    start >= 0 && attempts < 10;
    start = raw.indexOf("{", start + 1)
  ) {
    attempts++;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
      } else if (inString) {
        if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(raw.slice(start, i + 1));
          if (candidate) return candidate;
          break;
        }
      }
    }
  }
  return null;
}
