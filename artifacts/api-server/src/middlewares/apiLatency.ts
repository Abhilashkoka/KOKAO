import type { Request, Response, NextFunction } from "express";
import { recordServerEvent } from "../lib/analytics";

/**
 * Sampled server-side API latency telemetry (own-infrastructure metering,
 * not consent-gated, no PII — endpoint group + timing + status only).
 * Fire-and-forget insert on a 10% sample; disabled under test.
 */
const SAMPLE_RATE = 0.1;

const SKIP_PREFIXES = ["/api/healthz", "/api/analytics/events", "/api/storage"];

function endpointGroup(path: string): string {
  // "/api/ai/generate-image" -> "ai"; "/api/content/123/..." -> "content"
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  return parts[1] ?? parts[0] ?? "root";
}

export function apiLatencySampler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    process.env.NODE_ENV === "test" ||
    Math.random() >= SAMPLE_RATE ||
    SKIP_PREFIXES.some((p) => req.path.startsWith(p))
  ) {
    next();
    return;
  }
  const start = Date.now();
  res.on("finish", () => {
    void recordServerEvent({
      name: "api_request",
      tenantId: req.tenantId ?? null,
      params: {
        group: endpointGroup(req.path),
        method: req.method,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      },
    });
  });
  next();
}
