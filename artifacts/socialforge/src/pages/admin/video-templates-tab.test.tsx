import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  createCalls: [] as any[],
  toasts: [] as any[],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (value: unknown) => state.toasts.push(value) }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListVideoTemplates: () => ({ data: [], isLoading: false }),
    useAdminCreateVideoTemplate: () => ({
      ...idleMutation(),
      mutate: (vars: unknown, options: any) => {
        state.createCalls.push(vars);
        options?.onSuccess?.({});
      },
    }),
  });
});

import { VideoTemplatesTab } from "./video-templates-tab";

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VideoTemplatesTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.createCalls.length = 0;
  state.toasts.length = 0;
});

describe("admin video template creative direction", () => {
  it("uses the same aspect-ratio choices as Video Studio", () => {
    renderTab();
    expect(
      screen.getAllByLabelText("Aspect ratio").flatMap((select) =>
        Array.from((select as HTMLSelectElement).options, (option) => option.value),
      ),
    ).toEqual(["9:16", "4:5", "1:1", "16:9", "4:3", "3:4", "21:9"]);
  });

  it("applies a safe preset and submits structured direction", async () => {
    renderTab();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Launch format");
    await user.selectOptions(screen.getByTestId("creative-direction-preset"), "premium-product");
    await user.click(screen.getByTestId("button-save-video-template"));

    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0].data.payload.creativeDirection).toMatchObject({
      version: 1,
      narrative: { hookStyle: "demonstration", tone: "warm" },
      visual: { style: "commercial", composition: "close_detail" },
      sonic: { mood: "optimistic", energy: 3 },
      structure: { beats: expect.any(Array) },
    });
  });

  it("shows vocabulary conflicts and blocks saving", async () => {
    renderTab();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Conflicted format");
    await user.type(screen.getByLabelText("Required vocabulary (one per line)"), "Trust");
    await user.type(screen.getByLabelText("Forbidden vocabulary (one per line)"), "TRUST");

    expect(screen.getByTestId("creative-direction-errors").textContent).toMatch(/both required and forbidden/i);
    await user.click(screen.getByTestId("button-save-video-template"));
    expect(state.createCalls).toHaveLength(0);
    expect(state.toasts.at(-1)).toMatchObject({ title: "Resolve Creative Direction" });
  });
});