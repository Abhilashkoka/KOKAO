import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  response: {
    status: "missing",
    sourceSha256: "a".repeat(64),
    policyVersion: "likeness-2026-01",
    statement: "Atlas Cloud receives this source image for Wan reference-to-video processing.",
    consent: null as {
      id: number;
      subject: "self" | "authorized_person";
      providers: string[];
      allowOutfitEdits: boolean;
      allowScriptedSpeech: boolean;
    } | null,
    eligibility: [
      {
        provider: "atlascloud",
        modelFamily: "Wan 3.0 / Prime reference-to-video",
        status: "consent_required",
        reason: "Grant authorization first.",
      },
    ],
  },
  grant: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetCharacterLikenessConsent: () => ({
    data: { data: state.response },
    isLoading: false,
    isError: false,
  }),
  useGrantCharacterLikenessConsent: () => ({
    isPending: false,
    mutate: (variables: unknown, callbacks: { onSuccess?: () => void }) => {
      state.grant(variables);
      callbacks.onSuccess?.();
    },
  }),
  useRevokeCharacterLikenessConsent: () => ({
    isPending: false,
    mutate: (variables: unknown, callbacks: { onSuccess?: () => void }) => {
      state.revoke(variables);
      callbacks.onSuccess?.();
    },
  }),
}));

import { CharacterLikenessConsent } from "../components/CharacterLikenessConsent";

function renderConsent() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CharacterLikenessConsent characterId={7} />
    </QueryClientProvider>,
  );
}

describe("mobile personal likeness authorization", () => {
  beforeEach(() => {
    state.grant.mockClear();
    state.revoke.mockClear();
    state.response = {
      status: "missing",
      sourceSha256: "a".repeat(64),
      policyVersion: "likeness-2026-01",
      statement: "Atlas Cloud receives this source image for Wan reference-to-video processing.",
      consent: null,
      eligibility: [
        {
          provider: "atlascloud",
          modelFamily: "Wan 3.0 / Prime reference-to-video",
          status: "consent_required",
          reason: "Grant authorization first.",
        },
      ],
    };
  });

  it("keeps all declarations off by default and requires each declaration", async () => {
    renderConsent();
    expect(screen.getByText(state.response.statement)).toBeTruthy();
    fireEvent.click(screen.getByTestId("grant-likeness-consent-7"));
    expect(state.grant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("likeness-image-rights-7"));
    fireEvent.click(screen.getByTestId("likeness-adult-7"));
    fireEvent.click(screen.getByTestId("likeness-generation-7"));
    fireEvent.click(screen.getByTestId("grant-likeness-consent-7"));

    await waitFor(() => expect(state.grant).toHaveBeenCalledWith({
      characterId: 7,
      data: {
        sourceSha256: "a".repeat(64),
        policyVersion: "likeness-2026-01",
        subject: "self",
        imageRightsConfirmed: true,
        adultConfirmed: true,
        likenessConfirmed: true,
        writtenPermissionConfirmed: false,
        allowOutfitEdits: false,
        allowScriptedSpeech: false,
        providers: ["atlascloud"],
      },
    }));
  });

  it("requires written permission for an authorized third party", () => {
    renderConsent();
    fireEvent.click(screen.getByTestId("likeness-subject-authorized_person-7"));
    fireEvent.click(screen.getByTestId("likeness-image-rights-7"));
    fireEvent.click(screen.getByTestId("likeness-adult-7"));
    fireEvent.click(screen.getByTestId("likeness-generation-7"));
    fireEvent.click(screen.getByTestId("grant-likeness-consent-7"));
    expect(state.grant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("likeness-written-permission-7"));
    fireEvent.click(screen.getByTestId("grant-likeness-consent-7"));
    expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subject: "authorized_person",
        writtenPermissionConfirmed: true,
      }),
    }));
  });

  it("shows active consent and withdraws only future dispatch authorization", async () => {
    state.response = {
      ...state.response,
      status: "active",
      consent: {
        id: 31,
        subject: "self",
        providers: ["atlascloud"],
        allowOutfitEdits: true,
        allowScriptedSpeech: false,
      },
    };
    renderConsent();
    expect(screen.getByText("Consent active")).toBeTruthy();
    expect(screen.getByText("Provider recipients: atlascloud")).toBeTruthy();
    expect(screen.getByText(/Withdrawing blocks future dispatch only/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("revoke-likeness-consent-7"));
    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith({ characterId: 7 }));
  });

  it("shows a source change as stale instead of silently reusing consent", () => {
    state.response = {
      ...state.response,
      status: "stale",
      sourceSha256: "b".repeat(64),
    };
    renderConsent();
    expect(screen.getByText("Consent needs renewal")).toBeTruthy();
    expect(screen.getByText(/source photo changed/i)).toBeTruthy();
    expect(screen.getByTestId("likeness-form-7")).toBeTruthy();
  });
});