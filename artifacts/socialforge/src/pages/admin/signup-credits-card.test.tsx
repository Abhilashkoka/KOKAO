import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SignupCreditsCard } from "./signup-credits-card";

const mockState = {
  settings: {
    enabled: true,
    captionCredits: 5,
    imageCredits: 2,
    videoCredits: 1,
  },
};

const updateMutate = vi.fn();
const toastFn = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetSignupCreditSettings: () => ({
      data: mockState.settings,
      isLoading: false,
    }),
    useAdminUpdateSignupCreditSettings: () => ({
      mutate: updateMutate,
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

function renderCard() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SignupCreditsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
  toastFn.mockClear();
});

describe("SignupCreditsCard", () => {
  it("loads the saved settings into the form", () => {
    renderCard();
    expect(
      (screen.getByTestId("input-signup-captions") as HTMLInputElement).value,
    ).toBe("5");
    expect(
      (screen.getByTestId("input-signup-images") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      (screen.getByTestId("input-signup-videos") as HTMLInputElement).value,
    ).toBe("1");
    expect(screen.getByText("Granting to new workspaces")).toBeTruthy();
  });

  it("saves the edited bundle including video credits", () => {
    renderCard();
    fireEvent.change(screen.getByTestId("input-signup-videos"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("button-save-signup-credits"));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({
      data: {
        enabled: true,
        captionCredits: 5,
        imageCredits: 2,
        videoCredits: 3,
      },
    });
  });

  it("blocks saving an enabled all-zero bundle", () => {
    renderCard();
    for (const id of [
      "input-signup-captions",
      "input-signup-images",
      "input-signup-videos",
    ]) {
      fireEvent.change(screen.getByTestId(id), { target: { value: "0" } });
    }
    fireEvent.click(screen.getByTestId("button-save-signup-credits"));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Add some credits" }),
    );
  });
});
