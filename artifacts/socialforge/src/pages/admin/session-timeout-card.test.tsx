/**
 * The superadmin session-timeout card: it saves valid settings and blocks a
 * save when the warning window is not shorter than the timeout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionTimeoutSettingsView } from "@workspace/api-client-react";

const mockState: { settings: SessionTimeoutSettingsView } = {
  settings: { enabled: true, timeoutMinutes: 30, warningSeconds: 60 },
};

const saveMutate = vi.fn();
const toastFn = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetSessionTimeout: () => ({
      data: mockState.settings,
      isLoading: false,
    }),
    useAdminSaveSessionTimeout: () => ({ mutate: saveMutate, isPending: false }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));

import { SessionTimeoutCard } from "./credentials-tab";

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionTimeoutCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  saveMutate.mockClear();
  toastFn.mockClear();
  mockState.settings = { enabled: true, timeoutMinutes: 30, warningSeconds: 60 };
});

describe("SessionTimeoutCard", () => {
  it("loads saved settings into the form", () => {
    renderCard();
    expect(
      (screen.getByTestId("input-session-timeout-minutes") as HTMLInputElement)
        .value,
    ).toBe("30");
    expect(
      (screen.getByTestId("input-session-timeout-warning") as HTMLInputElement)
        .value,
    ).toBe("60");
  });

  it("saves valid settings", () => {
    renderCard();
    fireEvent.change(screen.getByTestId("input-session-timeout-minutes"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByTestId("input-session-timeout-warning"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByTestId("button-save-session-timeout"));

    expect(saveMutate).toHaveBeenCalledTimes(1);
    expect(saveMutate.mock.calls[0][0]).toEqual({
      data: { enabled: true, timeoutMinutes: 20, warningSeconds: 90 },
    });
  });

  it("blocks saving when the warning is not shorter than the timeout", () => {
    renderCard();
    // timeout 5 min = 300s; a 300s warning is not shorter.
    fireEvent.change(screen.getByTestId("input-session-timeout-minutes"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("input-session-timeout-warning"), {
      target: { value: "300" },
    });

    expect(screen.getByTestId("session-timeout-error").textContent).toContain(
      "shorter than the timeout",
    );
    expect(
      (screen.getByTestId("button-save-session-timeout") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("button-save-session-timeout"));
    expect(saveMutate).not.toHaveBeenCalled();
  });

  it("can save while disabled without validating the numbers", () => {
    mockState.settings = { enabled: false, timeoutMinutes: 30, warningSeconds: 60 };
    renderCard();
    expect(screen.queryByTestId("session-timeout-error")).toBeNull();
    fireEvent.click(screen.getByTestId("button-save-session-timeout"));
    expect(saveMutate).toHaveBeenCalledTimes(1);
    expect(saveMutate.mock.calls[0][0].data.enabled).toBe(false);
  });
});
