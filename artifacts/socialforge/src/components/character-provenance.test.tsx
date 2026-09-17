import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  CharacterProvenance,
  CharacterProvenanceRecovery,
  GuidedCharacterProvenanceWarning,
  characterProvenance,
  guidedCharacterRequiresRecordedGeneratedOrigin,
} from "./character-provenance";

const { recoverMutate } = vi.hoisted(() => ({
  recoverMutate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useRecoverCharacterProvenance: () => ({
      isPending: false,
      mutate: recoverMutate,
    }),
  });
});

describe("character provenance UI", () => {
  it("treats an absent status as unknown instead of inferring it from referenceSource", () => {
    expect(
      characterProvenance({
        referenceSource: "generated",
      }),
    ).toMatchObject({
      status: "unknown",
      label: "Origin not verified",
    });

    render(
      <CharacterProvenance
        character={{ referenceSource: "generated" }}
        testId="provenance"
      />,
    );
    expect(screen.getByTestId("provenance").textContent).toContain(
      "Origin not verified",
    );
    expect(screen.getByTestId("provenance").textContent).not.toContain(
      "Generated origin recorded",
    );
  });

  it("shows only safe provider, model, date, and method fields in details", () => {
    render(
      <CharacterProvenance
        character={{
          provenanceStatus: "verified_generated",
          provenanceSummary: ({
            provider: "Atlas Cloud",
            model: "reference-v1",
            createdAt: "2026-02-03",
            method: "textgenerated",
            prompt: "do not render this",
            apiKey: "do not render this",
          } as unknown) as never,
        }}
        detailsTestId="details"
      />,
    );

    fireEvent.click(screen.getByText("Provenance details"));
    const details = screen.getByTestId("details");
    expect(details.textContent).toContain("Provider: Atlas Cloud");
    expect(details.textContent).toContain("Model: reference-v1");
    expect(details.textContent).toContain("Date: 2026-02-03");
    expect(details.textContent).toContain("Method: textgenerated");
    expect(details.textContent).not.toContain("do not render this");
  });

  it("uses the frozen Atlas model signal only for the unknown-origin warning", () => {
    expect(
      guidedCharacterRequiresRecordedGeneratedOrigin(
        {},
        { provider: "atlascloud", model: "wan-reference" },
      ),
    ).toBe(true);
    expect(
      guidedCharacterRequiresRecordedGeneratedOrigin(
        {},
        { provider: "openai", model: "other" },
      ),
    ).toBe(false);
    expect(
      guidedCharacterRequiresRecordedGeneratedOrigin(
        { provenanceStatus: "uploaded" },
        { provider: "atlascloud", model: "wan-reference" },
      ),
    ).toBe(false);

    render(
      <GuidedCharacterProvenanceWarning
        character={{}}
        imageModelSnapshot={{ provider: "atlascloud", model: "wan-reference" }}
        testId="atlas-warning"
      />,
    );
    expect(screen.getByTestId("atlas-warning").textContent).toContain(
      "Atlas Seedance requires a verified fictional origin",
    );
  });

  it("checks exact history without charge and refreshes library and Guided views", async () => {
    recoverMutate.mockReset();
    const queryClient = new QueryClient();
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <CharacterProvenanceRecovery
          character={{ provenanceStatus: "unknown" }}
          characterId={42}
          draftId={17}
          roleId="role-1"
          testId="recovery"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("recovery-button"));
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
    expect(screen.getByTestId("recovery-message").textContent).toContain(
      "record recovered",
    );
    expect(refetchQueries).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Origin remains not verified")).toBeNull();
  });

  it("keeps unknown status after a missing immutable history conflict", async () => {
    recoverMutate.mockReset();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <CharacterProvenanceRecovery
          character={{ provenanceStatus: "unknown" }}
          characterId={42}
          draftId={17}
          roleId="role-1"
          testId="recovery-conflict"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("recovery-conflict-button"));
    const callbacks = recoverMutate.mock.calls[0][1] as {
      onError: (error: { status: number }) => void;
    };
    await act(async () => {
      callbacks.onError({ status: 409 });
    });
    expect(screen.getByTestId("recovery-conflict-message").textContent).toContain(
      "No matching immutable generation history",
    );
    expect(screen.getByTestId("recovery-conflict").textContent).toContain(
      "Check generation history",
    );

    recoverMutate.mockReset();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CharacterProvenanceRecovery
          character={{ provenanceStatus: "unknown" }}
          characterId={42}
          draftId={17}
          roleId="role-1"
          testId="recovery-missing-input"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("recovery-missing-input-button"));
    const missingInputCallbacks = recoverMutate.mock.calls[0][1] as {
      onError: (error: { status: number }) => void;
    };
    await act(async () => {
      missingInputCallbacks.onError({ status: 400 });
    });
    expect(
      screen.getByTestId("recovery-missing-input-message").textContent,
    ).toContain("exact original Guided Story draft ID");
  });
});