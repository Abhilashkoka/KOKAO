import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Accounts page reconnect prompts.
 *
 * The "Reconnect needed" callouts for Facebook / Instagram / LinkedIn are pure
 * functions of the status data returned by the API hooks. A future refactor of
 * the Accounts UI could silently drop them, leaving users with cards that look
 * "connected" but fail on publish. These tests mock the status hooks to seed
 * dead-connection state and assert the prompts still render (and, as a negative
 * control, that a healthy/verified connection shows the connected state and NO
 * reconnect prompt).
 *
 * Seeding rules mirror the real backend semantics (see
 * .agents/memory/dead-connection-e2e-seeding.md):
 *  - Facebook/Instagram dead = saved + appConfigured + verifyStatus "failed".
 *  - Instagram's own failed prompt only renders when Facebook is verified, so
 *    FB-failed and IG-failed are exercised in separate render scenarios.
 *  - LinkedIn dead = configured + not connected + expired (token expired).
 */

type Mutable = { data: any; isLoading: boolean };

const mockState: {
  accounts: Mutable;
  linkedin: any;
  facebook: any;
  instagram: any;
  twitter: any;
} = {
  accounts: { data: [], isLoading: false },
  linkedin: {},
  facebook: {},
  instagram: {},
  twitter: {},
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useListAccounts: () => mockState.accounts,
    useGetLinkedinStatus: () => ({ data: mockState.linkedin }),
    useGetFacebookCredentials: () => ({ data: mockState.facebook, isLoading: false }),
    useGetInstagramCredentials: () => ({ data: mockState.instagram, isLoading: false }),
    useGetTwitterStatus: () => ({ data: mockState.twitter, isLoading: false }),
    useCreateAccount: mutation,
    useDeleteAccount: mutation,
    useDisconnectLinkedin: mutation,
    useRetestLinkedin: mutation,
    useSaveFacebookCredentials: mutation,
    useDisconnectFacebook: mutation,
    useRetestFacebookCredentials: mutation,
    useSaveInstagramCredentials: mutation,
    useDisconnectInstagram: mutation,
    useRetestInstagramCredentials: mutation,
    useDisconnectTwitter: mutation,
    useRetestTwitterCredentials: mutation,
    getListAccountsQueryKey: () => ["accounts"],
    getGetLinkedinStatusQueryKey: () => ["linkedin-status"],
    getGetFacebookCredentialsQueryKey: () => ["facebook-credentials"],
    getGetInstagramCredentialsQueryKey: () => ["instagram-credentials"],
    getGetTwitterStatusQueryKey: () => ["twitter-status"],
    getLinkedinAuthUrl: async () => ({ url: "https://linkedin.example/auth" }),
    getTwitterAuthUrl: async () => ({ url: "https://x.example/auth" }),
  };
});

// Imported after the mock so the mocked module is picked up.
import { AccountsPage } from "./accounts";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountsPage />
    </QueryClientProvider>,
  );
}

/**
 * Find the card body that holds a given heading. Each platform card renders its
 * heading and its status pill / reconnect callout inside a shared `.flex-1`
 * wrapper, so scoping to that element isolates one platform's UI.
 */
function cardFor(heading: string) {
  const h = screen.getByRole("heading", { name: heading });
  const card = h.closest(".flex-1");
  if (!card) throw new Error(`No card body found for heading "${heading}"`);
  return within(card as HTMLElement);
}

beforeEach(() => {
  cleanup();
  mockState.accounts = { data: [], isLoading: false };
  mockState.linkedin = {};
  mockState.facebook = {};
  mockState.instagram = {};
  // Keep Twitter card harmless/unconfigured for FB/IG/LinkedIn-focused tests.
  mockState.twitter = { configured: false };
});

describe("Accounts page reconnect prompts", () => {
  it("warns about a dead Facebook connection and an expired LinkedIn connection", () => {
    mockState.facebook = {
      saved: true,
      appConfigured: true,
      verifyStatus: "failed",
      verifyError: "Meta rejected the Page token.",
      pageId: "123",
    };
    // Instagram cannot show its own failed prompt while Facebook is not verified;
    // it correctly falls back to the "connect Facebook first" state here.
    mockState.instagram = { saved: true, appConfigured: true, verifyStatus: "failed", igUserId: "456" };
    mockState.linkedin = {
      configured: true,
      connected: false,
      expired: true,
      accountName: "Jane Doe",
      redirectUri: "https://app.example/linkedin/callback",
    };

    renderPage();

    // Facebook dead-connection prompt.
    const fb = cardFor("Facebook Page Publishing");
    expect(fb.getByText("Reconnect needed")).toBeTruthy();
    expect(fb.getByText(/Enter a fresh Page access token below to reconnect/i)).toBeTruthy();
    expect(fb.getByText("Verification failed")).toBeTruthy();

    // LinkedIn expired-connection prompt.
    const li = cardFor("LinkedIn Publishing");
    expect(li.getByText("Reconnect needed")).toBeTruthy();
    expect(li.getByText(/access token has expired or been revoked/i)).toBeTruthy();
    expect(li.getByRole("button", { name: /Reconnect LinkedIn/i })).toBeTruthy();
  });

  it("warns about a dead Instagram connection when Facebook is verified", () => {
    // Facebook healthy so the Instagram card renders its own re-enter form.
    mockState.facebook = {
      saved: true,
      appConfigured: true,
      verifyStatus: "verified",
      pageId: "123",
    };
    mockState.instagram = {
      saved: true,
      appConfigured: true,
      verifyStatus: "failed",
      verifyError: "Instagram account no longer verifies.",
      igUserId: "456",
    };

    renderPage();

    // Instagram dead-connection prompt.
    const ig = cardFor("Instagram Publishing");
    expect(ig.getByText("Reconnect needed")).toBeTruthy();
    expect(ig.getByText(/Re-enter your Instagram Business account ID below to reconnect/i)).toBeTruthy();
    expect(ig.getByText("Verification failed")).toBeTruthy();

    // Negative control: the healthy Facebook card shows Verified and NO prompt.
    const fb = cardFor("Facebook Page Publishing");
    expect(fb.getByText("Verified")).toBeTruthy();
    expect(fb.queryByText("Reconnect needed")).toBeNull();
  });

  it("shows the connected/verified state and no reconnect prompts when everything is healthy", () => {
    mockState.facebook = {
      saved: true,
      appConfigured: true,
      verifyStatus: "verified",
      pageId: "123",
    };
    mockState.instagram = {
      saved: true,
      appConfigured: true,
      verifyStatus: "verified",
      igUserId: "456",
    };
    mockState.linkedin = {
      configured: true,
      connected: true,
      expired: false,
      accountName: "Jane Doe",
      redirectUri: "https://app.example/linkedin/callback",
    };

    renderPage();

    // Facebook + Instagram verified.
    expect(cardFor("Facebook Page Publishing").getByText("Verified")).toBeTruthy();
    expect(cardFor("Instagram Publishing").getByText("Verified")).toBeTruthy();

    // LinkedIn connected.
    const li = cardFor("LinkedIn Publishing");
    expect(li.getByText("Connected")).toBeTruthy();

    // No reconnect prompts anywhere.
    expect(screen.queryAllByText("Reconnect needed")).toHaveLength(0);
    expect(screen.queryByText(/Enter a fresh Page access token below to reconnect/i)).toBeNull();
    expect(screen.queryByText(/Re-enter your Instagram Business account ID below to reconnect/i)).toBeNull();
  });
});
