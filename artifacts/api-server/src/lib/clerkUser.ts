import { clerkClient } from "@clerk/express";
import { PLATFORM_FETCH_TIMEOUT_MS } from "./platformFetch";

/**
 * Best-effort lookup of a user's VERIFIED primary email from Clerk.
 *
 * Returns null on any failure (so a transient Clerk error never blocks an
 * authenticated request) and only returns an email whose verification status is
 * "verified" — an unverified address must never be trusted for authorization.
 *
 * The Clerk SDK call is raced against the shared platform timeout so a hung
 * Clerk API call can never stall a caller (notably the background connection
 * sweep's notification path) — a timeout resolves to null like any other
 * failure.
 */
export async function fetchVerifiedEmail(
  clerkUserId: string,
): Promise<string | null> {
  try {
    const user = await Promise.race([
      clerkClient.users.getUser(clerkUserId),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("Clerk user lookup timed out")),
          PLATFORM_FETCH_TIMEOUT_MS,
        );
        t.unref?.();
      }),
    ]);
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
