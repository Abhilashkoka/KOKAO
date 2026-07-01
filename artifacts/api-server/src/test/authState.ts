/**
 * Shared, mutable auth state used to drive the `@clerk/express` mock in tests.
 * Test files register a mock for `@clerk/express` whose `getAuth`/`clerkClient`
 * read from this singleton, so a test can control which user (if any) is
 * "signed in" and what verified email Clerk reports for them.
 */

export interface MockClerkEmail {
  id: string;
  emailAddress: string;
  verification: { status: string } | null;
}

export interface MockClerkUser {
  primaryEmailAddressId: string | null;
  emailAddresses: MockClerkEmail[];
}

export const authState: {
  userId: string | null;
  users: Record<string, MockClerkUser>;
} = {
  userId: null,
  users: {},
};

export function resetAuthState(): void {
  authState.userId = null;
  authState.users = {};
}

export function makeClerkUser(
  email: string | null,
  verified = true,
): MockClerkUser {
  if (!email) {
    return { primaryEmailAddressId: null, emailAddresses: [] };
  }
  const id = `email_${Math.random().toString(36).slice(2)}`;
  return {
    primaryEmailAddressId: id,
    emailAddresses: [
      {
        id,
        emailAddress: email,
        verification: { status: verified ? "verified" : "unverified" },
      },
    ],
  };
}

/** Make the given Clerk user the "current" authenticated user for requests. */
export function actAs(
  clerkUserId: string,
  email: string | null = null,
  verified = true,
): void {
  authState.userId = clerkUserId;
  authState.users[clerkUserId] = makeClerkUser(email, verified);
}
