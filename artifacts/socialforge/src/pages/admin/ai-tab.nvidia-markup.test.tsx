import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNvidiaTextDeploymentReady, NvidiaAdminCard } from "./ai-tab";

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

let settings: any = {
  hosted: {
    configured: false,
    keyMasked: null,
    lastTestStatus: null,
    lastTestError: null,
  },
  deployments: [
    {
      capability: "text",
      kind: "self-hosted",
      baseUrl: "https://nim.example.com/v1",
      model: "example/model",
      protocol: "openai-chat",
      enabled: false,
      configured: true,
      compatible: true,
      apiKeyMasked: null,
      adminPriceUsd: 1,
      priceKnown: true,
      activationBlockedReason: null,
      lastTestStatus: null,
      lastTestError: null,
    },
  ],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetNvidiaSettings: () => ({
      data: settings,
      isLoading: false,
      isError: false,
    }),
    useAdminGetTextGenSettings: () => ({
      data: {
        provider: "builtin",
        models: [],
        defaultModel: null,
        keySource: null,
        envKey: null,
        customProviders: [],
      },
      isLoading: false,
      isError: false,
    }),
    useAdminDiscoverNvidiaModels: () => idleMutation(),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NvidiaAdminCard />
    </QueryClientProvider>,
  );
}

describe("NvidiaAdminCard markup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("contains credential fields in forms and does not nest blocks in paragraphs", async () => {
    const { container } = renderCard();

    await userEvent.click(screen.getByTestId("button-toggle-nvidia-admin"));
    const hostedKey = screen.getByTestId("input-nvidia-hosted-key");
    const deploymentKey = screen.getByTestId("input-nvidia-key-text");
    expect(hostedKey.closest("form")).not.toBeNull();
    expect(deploymentKey.closest("form")).not.toBeNull();
    expect(container.querySelector("p div")).toBeNull();
  });

  it("keeps a configured hosted key compact until Change key is selected", async () => {
    settings = {
      ...settings,
      hosted: {
        configured: true,
        keyMasked: "••••url",
        lastTestStatus: "ok",
        lastTestError: null,
      },
    };
    renderCard();

    expect(screen.getByTestId("summary-nvidia-admin").textContent).toContain("Key configured");
    expect(screen.queryByTestId("section-nvidia-hosted-key")).toBeNull();
    await userEvent.click(screen.getByTestId("button-toggle-nvidia-admin"));
    expect(screen.queryByTestId("input-nvidia-hosted-key")).toBeNull();
    expect(screen.getByTestId("section-nvidia-hosted-key").textContent).toContain("Configured");
    await userEvent.click(screen.getByTestId("button-change-nvidia-hosted-key"));
    expect(screen.getByTestId("input-nvidia-hosted-key")).toBeTruthy();
  });

  it("requires a canonical text deployment, not a multimodal deployment, for text generation", () => {
    settings = {
      ...settings,
      deployments: [
        {
          ...settings.deployments[0],
          capability: "multimodal",
          enabled: true,
          lastTestStatus: "ok",
          adminPriceUsd: 1,
          priceKnown: true,
        },
      ],
    };
    expect(isNvidiaTextDeploymentReady(settings)).toBe(false);
  });
});