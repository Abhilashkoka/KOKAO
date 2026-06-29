import { clerkClient } from "@clerk/express";

/**
 * Best-effort lookup of a user's VERIFIED primary email from Clerk.
 *
 * Returns null on any failure (so a transient Clerk error never blocks an
 * authenticated request) and only returns an email whose verification status is
 * "verified" — an unverified address must never be trusted for authorization.
 */
export async function fetchVerifiedEmail(
  clerkUserId: string,
): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(clerkUserId);
    const candidate =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
      user.emailAddresses[0];
    if (!candidate) return null;
    if (candidate.verification?.status !== "verified") return null;
    return candidate.emailAddress;
  } catch {
    return null;
  }
}
