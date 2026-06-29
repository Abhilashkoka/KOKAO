import "express";

declare global {
  namespace Express {
    interface Request {
      tenantId: number;
      clerkUserId: string;
    }
  }
}

export {};
