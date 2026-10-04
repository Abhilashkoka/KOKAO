import type { NextFunction, Request, Response } from "express";
import { ComplianceConfigError, ComplianceUnavailableError } from "../lib/compliance/errors";

export function complianceErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof ComplianceUnavailableError || err instanceof ComplianceConfigError) {
    if (res.headersSent) return next(err);
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}