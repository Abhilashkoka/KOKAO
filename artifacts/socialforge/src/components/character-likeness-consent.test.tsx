import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CharacterLikenessConsent } from "./character-likeness-consent";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockGetConsent = vi.fn();
const mockGrantConsent = vi.fn();
const mockRevokeConsent = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...createApiClientMock(),
    ...actual,
    useGetCharacterLikenessConsent: (...args: any[]) => mockGetConsent(...args),
    useGrantCharacterLikenessConsent: () => mockGrantConsent(),
    useRevokeCharacterLikenessConsent: () => mockRevokeConsent(),
    getGetCharacterLikenessConsentQueryKey: (id: number) => ["consent", id],
    getListCharactersQueryKey: () => ["characters"],
  };
});

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("CharacterLikenessConsent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeConsent.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("renders nothing if status is not_required", () => {
    mockGetConsent.mockReturnValue({
      data: { data: { status: "not_required" } },
      isLoading: false,
      error: null,
    });
    const { container } = render(
      <TestWrapper>
        <CharacterLikenessConsent characterId={1} testId="consent" />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it("displays missing status and allows granting for self", async () => {
    mockGetConsent.mockReturnValue({
      data: {
        data: {
          status: "missing",
          sourceSha256: "abc",
          policyVersion: "1.0",
          statement: "Test statement.",
          eligibility: [{ provider: "atlascloud", modelFamily: "wan3", status: "consent_required" }]
        }
      },
      isLoading: false,
    });
    
    let mutateVars: any = null;
    mockGrantConsent.mockReturnValue({
      mutate: (vars: any, opts: any) => { mutateVars = vars; opts.onSuccess(); },
      isPending: false,
    });

    render(<TestWrapper><CharacterLikenessConsent characterId={1} testId="consent" /></TestWrapper>);
    
    expect(screen.getByText("Likeness authorization")).toBeDefined();
    
    const user = userEvent.setup();
    await user.click(screen.getByTestId("consent-btn-open-grant"));
    
    expect(screen.getByText(/Test statement\./)).toBeDefined();
    
    expect(screen.getByTestId("consent-btn-submit-grant").hasAttribute("disabled")).toBe(true);
    
    await user.click(screen.getByTestId("consent-chk-rights"));
    await user.click(screen.getByTestId("consent-chk-adult"));
    await user.click(screen.getByTestId("consent-chk-likeness"));
    
    expect(screen.getByTestId("consent-btn-submit-grant").hasAttribute("disabled")).toBe(false);
    
    await user.click(screen.getByTestId("consent-btn-submit-grant"));
    
    expect(mutateVars.data).toMatchObject({
      subject: "self",
      imageRightsConfirmed: true,
      adultConfirmed: true,
      likenessConfirmed: true,
      providers: ["atlascloud"],
    });
  });

  it("requires written permission for authorized_person", async () => {
    mockGetConsent.mockReturnValue({
      data: {
        data: {
          status: "missing",
          sourceSha256: "abc",
          policyVersion: "1.0",
          statement: "Test statement.",
          eligibility: []
        }
      },
      isLoading: false,
    });
    mockGrantConsent.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<TestWrapper><CharacterLikenessConsent characterId={1} testId="consent" /></TestWrapper>);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("consent-btn-open-grant"));
    
    await user.click(screen.getByTestId("consent-radio-authorized"));
    
    await user.click(screen.getByTestId("consent-chk-rights"));
    await user.click(screen.getByTestId("consent-chk-adult"));
    await user.click(screen.getByTestId("consent-chk-likeness"));
    
    expect(screen.getByTestId("consent-btn-submit-grant").hasAttribute("disabled")).toBe(true);
    
    await user.click(screen.getByTestId("consent-chk-written"));
    expect(screen.getByTestId("consent-btn-submit-grant").hasAttribute("disabled")).toBe(false);
  });

  it("handles stale state correctly", async () => {
    mockGetConsent.mockReturnValue({
      data: {
        data: {
          status: "stale",
          sourceSha256: "def",
          policyVersion: "1.0",
          statement: "Test statement.",
          eligibility: []
        }
      },
      isLoading: false,
    });
    mockGrantConsent.mockReturnValue({ mutate: vi.fn(), isPending: false });
    
    render(<TestWrapper><CharacterLikenessConsent characterId={1} testId="consent" /></TestWrapper>);
    expect(screen.getByText("Authorization stale")).toBeDefined();
    
    const user = userEvent.setup();
    await user.click(screen.getByTestId("consent-btn-open-grant"));
    expect(screen.getByText(/Test statement\./)).toBeDefined();
  });

  it("handles successful active state and allows revocation", async () => {
    mockGetConsent.mockReturnValue({
      data: {
        data: {
          status: "active",
          sourceSha256: "abc",
          policyVersion: "1.0",
          statement: "Test statement.",
          consent: { subject: "self" },
          eligibility: [{ provider: "atlascloud", modelFamily: "wan3", status: "eligible" }]
        }
      },
      isLoading: false,
    });
    
    let mutateVars: any = null;
    mockRevokeConsent.mockReturnValue({
      mutate: (vars: any, opts: any) => { mutateVars = vars; opts.onSuccess(); },
      isPending: false,
    });

    render(<TestWrapper><CharacterLikenessConsent characterId={1} testId="consent" /></TestWrapper>);
    expect(screen.getByText("Authorization recorded")).toBeDefined();
    
    const user = userEvent.setup();
    await user.click(screen.getByTestId("consent-btn-open-revoke"));
    
    expect(screen.getByText(/withdraw likeness permission/)).toBeDefined();
    
    await user.click(screen.getByTestId("consent-btn-submit-revoke"));
    
    expect(mutateVars).toEqual({ characterId: 1 });
  });

  it("displays revoked status", () => {
    mockGetConsent.mockReturnValue({
      data: {
        data: {
          status: "revoked",
          sourceSha256: "abc",
          policyVersion: "1.0",
          statement: "Test statement.",
          eligibility: []
        }
      },
      isLoading: false,
    });
    
    render(<TestWrapper><CharacterLikenessConsent characterId={1} testId="consent" /></TestWrapper>);
    expect(screen.getByText("Authorization revoked")).toBeDefined();
  });
});
