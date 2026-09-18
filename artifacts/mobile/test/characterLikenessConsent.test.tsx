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
    subjectClass: "uploaded_self" as const,
    consent: null as {
      id: number;
      subject: "self" | "authorized_person";
      subjectClass: string;
      allowOutfitEdits: boolean;
      allowVideoDepiction: boolean;
      allowScriptedSpeech: boolean;
    } | null,
    recipients: [] as Array<{
      id: number;
      provider: string;
      model: string;
      operation: string;
      scopeLabel: string;
      acknowledgedAt: string;
      revokedAt: string | null;
    }>,
    pendingRecipients: [] as Array<{
      operation: string;
      provider: string;
      model: string;
      scopeLabel: string;
      providerAccepts: boolean;
      reason: string | null;
    }>,
    eligibility: [
      {
        surface: "video",
        provider: "atlascloud",
        modelFamily: "Wan 3.0 / Prime reference-to-video",
        requiresVerifiedIdentity: false,
        status: "consent_required",
        reason: "Grant authorization first.",
      },
    ],
  },
  grant: vi.fn(),
  revoke: vi.fn(),
  acknowledgeRecipient: vi.fn(),
  revokeRecipient: vi.fn(),
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
  useAcknowledgeCharacterLikenessRecipient: () => ({
    isPending: false,
    mutate: (variables: unknown, callbacks: { onSuccess?: () => void }) => {
      state.acknowledgeRecipient?.(variables);
      callbacks.onSuccess?.();
    },
  }),
  useRevokeCharacterLikenessRecipient: () => ({
    isPending: false,
    mutate: (variables: unknown, callbacks: { onSuccess?: () => void }) => {
      state.revokeRecipient?.(variables);
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
      subjectClass: "uploaded_self",
      consent: null,
      recipients: [],
      pendingRecipients: [],
      eligibility: [
        {
          surface: "video",
          provider: "atlascloud",
          modelFamily: "Wan 3.0 / Prime reference-to-video",
          requiresVerifiedIdentity: false,
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
        allowVideoDepiction: false,
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
        subjectClass: "uploaded_self",
        allowOutfitEdits: true,
        allowVideoDepiction: true,
        allowScriptedSpeech: false,
      },
      recipients: [
        {
          id: 501,
          provider: "atlascloud",
          model: "alibaba/wan-3.0/reference-to-video",
          operation: "video",
          scopeLabel: "video|Atlas Cloud / alibaba/wan-3.0/reference-to-video",
          acknowledgedAt: "2026-09-18T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    };
    renderConsent();
    expect(screen.getByText("Consent active")).toBeTruthy();
    expect(
      screen.getByText(/Providers receiving this likeness: video\|Atlas Cloud/),
    ).toBeTruthy();
    expect(screen.getByText(/Withdrawing blocks future dispatch only/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("revoke-likeness-consent-7"));
    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith({ characterId: 7 }));
  });

  it("withdraws one recipient without revoking the attestation", async () => {
    state.response = {
      ...state.response,
      status: "active",
      consent: {
        id: 31,
        subject: "self",
        subjectClass: "uploaded_self",
        allowOutfitEdits: true,
        allowVideoDepiction: true,
        allowScriptedSpeech: false,
      },
      recipients: [
        {
          id: 501,
          provider: "atlascloud",
          model: "alibaba/wan-3.0/reference-to-video",
          operation: "video",
          scopeLabel: "video|Atlas Cloud / alibaba/wan-3.0/reference-to-video",
          acknowledgedAt: "2026-09-18T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    };
    renderConsent();
    fireEvent.click(screen.getByTestId("likeness-withdraw-501"));
    await waitFor(() =>
      expect(state.revokeRecipient).toHaveBeenCalledWith({
        characterId: 7,
        disclosureId: 501,
      }),
    );
    expect(state.revoke).not.toHaveBeenCalled();
  });

  it("confirms a newly routed provider without re-attesting", async () => {
    state.response = {
      ...state.response,
      status: "needs_recipient_acknowledgement",
      consent: {
        id: 31,
        subject: "self",
        subjectClass: "uploaded_self",
        allowOutfitEdits: true,
        allowVideoDepiction: true,
        allowScriptedSpeech: false,
      },
      pendingRecipients: [
        {
          operation: "outfit",
          provider: "openai",
          model: "gpt-image-1",
          scopeLabel: "outfit|OpenAI / gpt-image-1",
          providerAccepts: true,
          reason: null,
        },
      ],
    };
    renderConsent();
    fireEvent.click(screen.getByTestId("likeness-confirm-openai-outfit-7"));
    await waitFor(() =>
      expect(state.acknowledgeRecipient).toHaveBeenCalledWith(
        expect.objectContaining({
          characterId: 7,
          data: expect.objectContaining({
            provider: "openai",
            model: "gpt-image-1",
            operation: "outfit",
          }),
        }),
      ),
    );
    expect(state.grant).not.toHaveBeenCalled();
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