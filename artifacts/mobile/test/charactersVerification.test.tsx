import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BytePlusIdentity } from "@workspace/api-client-react";

const state = vi.hoisted(() => ({
  params: { identity: "verified", identityId: "41" } as Record<string, string | undefined>,
  identities: [{
    id: 41, label: "Asha", status: "verified", assetGroupId: "group",
    error: null, verifiedAt: "2026-09-08T00:00:00.000Z",
  }] as BytePlusIdentity[],
  update: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  storage: JSON.stringify({
    name: "", description: "", photoPath: null, photoName: "",
    identityId: 41, existingCharacterId: 7,
  }),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ setParams: vi.fn(), push: vi.fn() }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => Promise.resolve(state.storage)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("expo-file-system/legacy", () => ({
  uploadAsync: vi.fn(() => Promise.resolve({ status: 200, body: "" })),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));
vi.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: vi.fn(() => Promise.resolve({
    canceled: false,
    assets: [{
      uri: "file:///new-person.jpg",
      fileName: "new-person.jpg",
      mimeType: "image/jpeg",
      fileSize: 100,
    }],
  })),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(() => Promise.resolve({ type: "cancel" })),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useListCharacters: () => ({
      data: [{
        id: 7, name: "Asha", description: "", referenceImagePath: "/asha.jpg",
        referenceSource: "uploaded", identityId: null, referenceSheetImagePath: null,
        referenceSheetStatus: "approved", referenceSheetError: null, outfits: [],
        createdAt: new Date(), updatedAt: new Date(),
      }],
      isLoading: false,
    }),
    useListBytePlusIdentities: () => ({
      data: state.identities,
      refetch: vi.fn(),
    }),
    useUpdateCharacter: () => ({
      ...idleMutation(),
      mutateAsync: state.update.mockResolvedValue({}),
    }),
    useCreateCharacter: () => ({
      ...idleMutation(),
      mutateAsync: state.create.mockResolvedValue({}),
    }),
    useStartBytePlusIdentityVerification: () => ({
      ...idleMutation(),
      mutateAsync: state.start.mockResolvedValue({
        ...state.identities[0],
        verificationUrl: "https://verify.example",
      }),
    }),
    useRequestUploadUrl: () => ({
      ...idleMutation(),
      mutateAsync: vi.fn(() => Promise.resolve({
        uploadURL: "https://upload.example",
        objectPath: "/objects/new-person.jpg",
      })),
    }),
  });
});

import CharactersScreen from "../app/characters";

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CharactersScreen />
    </QueryClientProvider>,
  );
}

describe("mobile character liveness return", () => {
  beforeEach(() => {
    state.update.mockClear();
    state.create.mockClear();
    state.start.mockClear();
    state.identities = [{
      id: 41, label: "Asha", status: "verified",
      assetGroupId: "group", error: null, verifiedAt: "2026-09-08T00:00:00.000Z",
    }];
  });

  it("restores the draft and shows the verified return state", async () => {
    renderScreen();
    expect(await screen.findByText("Identity verified. It is ready to attach.")).toBeTruthy();
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
  });

  it("attaches only the restored verified identity to its character", async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId("attach-identity-7"));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        characterId: 7,
        data: { identityId: 41 },
      }),
    );
  });

  it("does not offer attachment when verification failed", async () => {
    state.identities = [{
      id: 41, label: "Asha", status: "failed",
      assetGroupId: null, error: "Not confirmed", verifiedAt: null,
    }];
    renderScreen();
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.queryByTestId("attach-identity-7")).toBeNull();
  });

  it("switches an abandoned attachment into create mode when a new photo is chosen", async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId("choose-character-photo"));
    await waitFor(() => expect(screen.getByText("new-person.jpg")).toBeTruthy());
    fireEvent.change(screen.getByTestId("character-name"), {
      target: { value: "New person" },
    });
    fireEvent.click(screen.getByTestId("start-character-verification"));
    await waitFor(() => expect(state.start).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("save-verified-character"));
    await waitFor(() => {
      expect(state.update).not.toHaveBeenCalled();
      expect(state.create).toHaveBeenCalledWith({
        data: {
          name: "New person",
          description: null,
          sourceImagePath: "/objects/new-person.jpg",
          identityId: 41,
        },
      });
    });
  });
});