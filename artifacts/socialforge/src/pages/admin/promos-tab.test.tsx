import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PromosTab, promoCodeFieldError } from "./promos-tab";

const createMutate = vi.fn();
const toastFn = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListPromoCodes: () => ({ data: [], isLoading: false }),
    useAdminGetPromoMetrics: () => ({ data: undefined }),
    useAdminListPromoFailures: () => ({ data: [] }),
    useListPlans: () => ({ data: [] }),
    useAdminCreatePromoCodes: () => ({ mutate: createMutate, isPending: false }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

function renderTab() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PromosTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createMutate.mockClear();
  toastFn.mockClear();
});

describe("promoCodeFieldError", () => {
  it("rejects spaces with a specific message", () => {
    expect(promoCodeFieldError("welcome 25")).toMatch(/letters, numbers/);
  });
  it("accepts a valid code after trimming/uppercasing", () => {
    expect(promoCodeFieldError("  welcome-25 ")).toBeNull();
  });
  it("enforces length bounds", () => {
    expect(promoCodeFieldError("ab")).toMatch(/at least 3/);
    expect(promoCodeFieldError("A".repeat(65))).toMatch(/at most 64/);
    expect(promoCodeFieldError("")).toMatch(/Enter a code/);
  });
});

describe("PromosTab create form", () => {
  it("shows an inline error and blocks submit for an invalid code", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("input-new-promo-code"), {
      target: { value: "welcome 25" },
    });
    // Input auto-uppercases.
    expect(
      (screen.getByTestId("input-new-promo-code") as HTMLInputElement).value,
    ).toBe("WELCOME 25");
    expect(screen.getByTestId("text-promo-code-error").textContent).toMatch(
      /letters, numbers, hyphens, and underscores/,
    );
    const button = screen.getByTestId("button-create-promo") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("shows the server's actual error message when creation fails", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("input-new-promo-code"), {
      target: { value: "WELCOME25" },
    });
    fireEvent.change(screen.getByTestId("input-promo-captions"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("button-create-promo"));
    expect(createMutate).toHaveBeenCalledTimes(1);

    // Simulate an ApiError-shaped rejection: parsed body lives on `.data`.
    const opts = createMutate.mock.calls[0][1] as {
      onError: (error: unknown) => void;
    };
    const apiError = Object.assign(new Error("HTTP 409"), {
      name: "ApiError",
      status: 409,
      data: { error: "That code already exists." },
      response: new Response(),
    });
    opts.onError(apiError);

    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not create the code",
        description: "That code already exists.",
        variant: "destructive",
      }),
    );
  });
});
