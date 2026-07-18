import "express";

declare global {
  namespace Express {
    interface Request {
      tenantId: number;
      clerkUserId: string;
      tenantEmail: string | null;
      isSuperadmin: boolean;
      tenantIsSuperadmin: boolean;
      memberRole: "owner" | "admin" | "member";
      /** Raw request body bytes (utf8) captured for webhook signature checks. */
      rawBody?: string;
    }
  }
}

export {};
