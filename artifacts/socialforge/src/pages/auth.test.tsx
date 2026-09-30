import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignInPage, SignUpPage } from "./auth";

const state = vi.hoisted(() => ({
  loaded: true, signedIn: false, location: "/sign-in",
  listeners: new Set<() => void>(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: state.loaded, isSignedIn: state.signedIn }),
  SignIn: (props: Record<string, string>) => <div data-testid="clerk-sign-in" data-props={JSON.stringify(props)} />,
  SignUp: (props: Record<string, string>) => <div data-testid="clerk-sign-up" data-props={JSON.stringify(props)} />,
}));
vi.mock("wouter", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
  useLocation: () => [state.location, vi.fn()],
  useSearch: () => useSyncExternalStore(
    (listener) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
    () => window.location.search,
    () => "",
  ),
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props} onClick={(event) => {
      event.preventDefault();
      window.history.pushState({}, "", href);
      state.listeners.forEach((listener) => listener());
    }}>{children}</a>,
  };
});
vi.mock("@/lib/brand", () => ({ useBrand: () => ({ logoUrl: "", appName: "KOKAO" }) }));
vi.mock("@/lib/seo", () => ({ usePageMeta: vi.fn() }));
vi.mock("@/lib/planIntent", () => ({ savePlanIntent: vi.fn() }));

beforeEach(() => {
  sessionStorage.clear();
  state.loaded = true;
  state.signedIn = false;
  state.location = "/sign-in";
  window.history.replaceState({}, "", "/sign-in");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function clerkProps(id: string) {
  return JSON.parse(screen.getByTestId(id).getAttribute("data-props") ?? "{}") as Record<string, string>;
}

describe("KOKAO auth entry", () => {
  it("keeps regular workspace sign-in and safe admin deep links", () => {
    render(<SignInPage />);
    expect(clerkProps("clerk-sign-in").forceRedirectUrl).toBe("/dashboard");
    expect(screen.getByTestId("link-auth-creator").getAttribute("href")).toBe("/sign-in?redirect_url=%2Fcreator");
    cleanup();
    window.history.replaceState({}, "", "/sign-in?redirect_url=%2Fadmin%3Ftab%3Dusers");
    render(<SignInPage />);
    expect(clerkProps("clerk-sign-in").forceRedirectUrl).toBe("/admin?tab=users");
    expect(screen.getByTestId("link-auth-workspace").getAttribute("aria-current")).toBe("page");
  });

  it("preserves creator choice through Clerk sign-in/sign-up links and OAuth callback paths", () => {
    window.history.replaceState({}, "", "/sign-in?redirect_url=%2Fcreator");
    render(<SignInPage />);
    expect(clerkProps("clerk-sign-in")).toMatchObject({
      routing: "path", forceRedirectUrl: "/creator",
      signUpUrl: "/sign-up?redirect_url=%2Fcreator",
    });
    cleanup();
    state.location = "/sign-up/sso-callback";
    window.history.replaceState({}, "", "/sign-up/sso-callback");
    render(<SignUpPage />);
    expect(clerkProps("clerk-sign-up")).toMatchObject({
      forceRedirectUrl: "/creator", signInUrl: "/sign-in?redirect_url=%2Fcreator",
    });
  });

  it("reacts to a query-only choice change without changing the wouter pathname", () => {
    render(<SignInPage />);
    expect(screen.getByTestId("link-auth-workspace").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("link-auth-creator"));
    expect(state.location).toBe("/sign-in");
    expect(screen.getByTestId("link-auth-creator").getAttribute("aria-current")).toBe("page");
    expect(clerkProps("clerk-sign-in")).toMatchObject({
      forceRedirectUrl: "/creator", signUpUrl: "/sign-up?redirect_url=%2Fcreator",
    });
    fireEvent.click(screen.getByTestId("link-auth-workspace"));
    expect(screen.getByTestId("link-auth-workspace").getAttribute("aria-current")).toBe("page");
    expect(clerkProps("clerk-sign-in").forceRedirectUrl).toBe("/dashboard");
  });

  it("does not show signed-in users a Clerk sign-in widget or persist a choice on sign-out", () => {
    state.signedIn = true;
    window.history.replaceState({}, "", "/sign-in?redirect_url=%2Fcreator");
    render(<SignInPage />);
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
    expect(screen.getByTestId("link-auth-continue").getAttribute("href")).toBe("/creator");
    expect(screen.getByTestId("link-auth-workspace").getAttribute("href")).toBe("/dashboard");
    cleanup();
    state.signedIn = false;
    window.history.replaceState({}, "", "/sign-in");
    render(<SignInPage />);
    expect(clerkProps("clerk-sign-in").forceRedirectUrl).toBe("/dashboard");
  });

  it("never passes an external redirect to Clerk", () => {
    window.history.replaceState({}, "", "/sign-up?redirect_url=https%3A%2F%2Fevil.test");
    render(<SignUpPage />);
    expect(clerkProps("clerk-sign-up").forceRedirectUrl).toBe("/dashboard");
  });

  it("honors Clerk's same-origin absolute signup return URL", () => {
    window.history.replaceState({}, "", `/sign-up?redirect_url=${encodeURIComponent(`${window.location.origin}/creator`)}`);
    render(<SignUpPage />);
    expect(screen.getByTestId("link-auth-creator").getAttribute("aria-current")).toBe("page");
    expect(clerkProps("clerk-sign-up").forceRedirectUrl).toBe("/creator");
  });

  it("gives stalled Clerk initialization a bounded, user-triggered recovery without redirecting automatically", () => {
    vi.useFakeTimers();
    state.loaded = false;
    window.history.replaceState({}, "", "/sign-in?redirect_url=%2Fcreator");
    render(<SignInPage />);
    expect(screen.getByTestId("status-auth-loading")).toBeTruthy();
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
    expect(screen.queryByTestId("link-auth-retry")).toBeNull();
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByTestId("link-auth-retry").getAttribute("href")).toContain("redirect_url=%2Fcreator");
    expect(window.location.pathname).toBe("/sign-in");
  });
});