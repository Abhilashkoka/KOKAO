import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  CharacterProvenance,
  CharacterProvenanceRecovery,
  characterProvenance,
} from "@/components/CharacterProvenance";

const { recoverMutate } = vi.hoisted(() => ({
  recoverMutate: vi.fn(),
}));

vi.mock("@/components/ui", () => ({
  Button: ({
    title,
    onPress,
    disabled,
    testID,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled} data-testid={testID}>
      {title}
    </button>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useRecoverCharacterProvenance: () => ({
      isPending: false,
      mutate: recoverMutate,
    }),
  });
});

describe("mobile character provenance", () => {
  it("keeps missing provenance status unknown", () => {
    expect(
      characterProvenance({
        provenanceStatus: undefined,
        provenanceSummary: undefined,
      }),
    ).toMatchObject({
      status: "unknown",
      label: "Origin not verified",
    });
  });

  it("renders compact status and safe detail fields", () => {
    render(
      <CharacterProvenance
        character={{
          provenanceStatus: "uploaded",
          provenanceSummary: ({
            provider: "Upload",
            model: null,
            createdAt: "2026-02-03",
            method: "upload",
            prompt: "not shown",
          } as unknown) as never,
        }}
        testID="mobile-provenance"
      />,
    );

    expect(screen.getByTestId("mobile-provenance").textContent).toContain(
      "Uploaded origin",
    );
    fireEvent.click(screen.getByTestId("mobile-provenance-toggle"));
    const details = screen.getByTestId("mobile-provenance-details");
    expect(details.textContent).toContain("Provider: Upload");
    expect(details.textContent).toContain("Date: 2026-02-03");
    expect(details.textContent).toContain("Method: upload");
    expect(details.textContent).not.toContain("not shown");
  });

  it("checks exact history without charge and retains unknown on a missing-history conflict", async () => {
    recoverMutate.mockReset();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <CharacterProvenanceRecovery
          character={{ provenanceStatus: "unknown" }}
          characterId={42}
          draftId={17}
          roleId="role-1"
          testID="mobile-recovery"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("mobile-recovery-button"));
    expect(recoverMutate).toHaveBeenCalledWith(
      {
        characterId: 42,
        data: { draftId: 17, roleId: "role-1" },
      },
      expect.any(Object),
    );
    const callbacks = recoverMutate.mock.calls[0][1] as {
      onSuccess: (character: { provenanceStatus: string }) => Promise<void>;
    };
    await act(async () => {
      await callbacks.onSuccess({ provenanceStatus: "verified_generated" });
    });
    expect(screen.getByTestId("mobile-recovery-message").textContent).toContain(
      "record recovered",
    );

    recoverMutate.mockReset();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CharacterProvenanceRecovery
          character={{ provenanceStatus: "unknown" }}
          characterId={43}
          draftId={18}
          roleId="role-2"
          testID="mobile-conflict"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("mobile-conflict-button"));
    const conflictCallbacks = recoverMutate.mock.calls[0][1] as {
      onError: (error: { status: number }) => void;
    };
    await act(async () => {
      conflictCallbacks.onError({ status: 409 });
    });
    expect(screen.getByTestId("mobile-conflict-message").textContent).toContain(
      "No matching immutable generation history",
    );
  });
});