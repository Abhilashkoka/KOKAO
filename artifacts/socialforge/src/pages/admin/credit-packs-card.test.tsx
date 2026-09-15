import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreditPacksCard } from "./plans-tab";

const state = vi.hoisted(() => ({
  packs: [] as any[],
  create: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListCreditPacks: () => ({ data: state.packs, isLoading: false }),
    useAdminCreateCreditPack: () => ({ mutate: state.create, isPending: false }),
    useAdminUpdateCreditPack: () => ({ mutate: state.update, isPending: false }),
  });
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.packs = [];
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CreditPacksCard /></QueryClientProvider>);
  return client;
}

it("creates a general-purpose pack with independent price and credits and refreshes billing", () => {
  const client = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  fireEvent.click(screen.getByText("Add credit pack"));
  expect(screen.queryByText("Caption credits")).toBeNull();
  expect(screen.queryByText("Image credits")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "SUPER" } });
  fireEvent.change(screen.getByLabelText("Price (INR)"), { target: { value: "2000" } });
  fireEvent.change(screen.getByLabelText("Credits included"), { target: { value: "300" } });
  fireEvent.click(screen.getByText("Create pack"));
  expect(state.create.mock.calls[0][0].data).toEqual({
    name: "SUPER", pricePaise: 200000, credits: 300,
    captionCredits: 0, imageCredits: 0, active: true,
  });
  state.create.mock.calls[0][1].onSuccess();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["getBillingGetOverviewQueryKey"] });
});

it("rejects an empty, negative, or fractional credit quantity", () => {
  setup();
  fireEvent.click(screen.getByText("Add credit pack"));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByLabelText("Price (INR)"), { target: { value: "100" } });
  for (const value of ["", "0", "-1", "1.5"]) {
    fireEvent.change(screen.getByLabelText("Credits included"), { target: { value } });
    fireEvent.click(screen.getByText("Create pack"));
  }
  expect(state.create).not.toHaveBeenCalled();
});

it("edits unified packs without exposing legacy fields", () => {
  state.packs = [{ id: 1, name: "Unified", pricePaise: 10000, credits: 20, captionCredits: 0, imageCredits: 0, videoCredits: 0, active: true }];
  setup();
  expect(screen.queryByText("Caption credits")).toBeNull();
  fireEvent.change(screen.getByLabelText("Credits included"), { target: { value: "30" } });
  fireEvent.click(screen.getByText("Save"));
  expect(state.update.mock.calls[0][0].data.credits).toBe(30);
});

it("preserves video-only legacy packs without converting them", () => {
  state.packs = [{ id: 2, name: "Legacy", pricePaise: 10000, credits: 0, captionCredits: 0, imageCredits: 0, videoCredits: 5, active: true }];
  setup();
  expect(screen.getByText(/5 video credits/)).toBeTruthy();
  fireEvent.click(screen.getByText("Save"));
  const data = state.update.mock.calls[0][0].data;
  expect(data.credits).toBe(0);
  expect(data).not.toHaveProperty("videoCredits");
});