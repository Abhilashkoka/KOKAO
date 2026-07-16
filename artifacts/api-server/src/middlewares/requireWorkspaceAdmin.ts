import type { Request, Response, NextFunction } from "express";

/**
 * Gate for workspace-management actions (team management, workspace
 * settings). Allows the workspace owner and members with the "admin" role;
 * plain members get 403. Must run after requireTenant.
 */
export function requireWorkspaceAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.memberRole === "owner" || req.memberRole === "admin") {
    next();
    return;
  }
  res
    .status(403)
    .json({ error: "Only the workspace owner or an admin can do this" });
}
