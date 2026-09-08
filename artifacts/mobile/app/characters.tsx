import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListBytePlusIdentitiesQueryKey,
  getListCharactersQueryKey,
  useCreateCharacter,
  useListBytePlusIdentities,
  useListCharacters,
  useRequestUploadUrl,
  useStartBytePlusIdentityVerification,
  useUpdateCharacter,
  type Character,
} from "@workspace/api-client-react";

import { Badge, Button, Card, Input, Label } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const c = colors.light;
const DRAFT_KEY = "kokao-mobile-character-verification-draft";
type Draft = {
  name: string;
  description: string;
  photoPath: string | null;
  photoName: string;
  identityId: number | null;
  existingCharacterId: number | null;
};
const emptyDraft: Draft = {
  name: "", description: "", photoPath: null, photoName: "",
  identityId: null, existingCharacterId: null,
};

export default function CharactersScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ identity?: string; identityId?: string }>();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const charactersQuery = useListCharacters();
  const identitiesQuery = useListBytePlusIdentities({
    query: {
      queryKey: getListBytePlusIdentitiesQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.some((item) => item.status === "pending") ? 3000 : false,
    },
  });
  const createCharacter = useCreateCharacter();
  const updateCharacter = useUpdateCharacter();
  const requestUpload = useRequestUploadUrl();
  const startVerification = useStartBytePlusIdentityVerification();

  const ownCharacters = useMemo(
    () => (charactersQuery.data ?? []).filter((item): item is Character =>
      typeof item.id === "number" && "referenceSource" in item),
    [charactersQuery.data],
  );
  const selectedIdentity = identitiesQuery.data?.find(
    (item) => item.id === draft.identityId,
  );

  useEffect(() => {
    void AsyncStorage.getItem(DRAFT_KEY).then((saved) => {
      if (!saved) return;
      try { setDraft({ ...emptyDraft, ...JSON.parse(saved) }); } catch {}
    });
  }, []);

  useEffect(() => {
    const returnedId = Number(params.identityId);
    if (!params.identity) return;
    setNotice(params.identity === "verified"
      ? "Identity verified. It is ready to attach."
      : "Verification was not completed. You can retry.");
    if (Number.isInteger(returnedId) && returnedId > 0) {
      setDraft((current) => ({ ...current, identityId: returnedId }));
    }
    void identitiesQuery.refetch();
    router.setParams({ identity: undefined, identityId: undefined });
  }, [params.identity, params.identityId]);

  const persist = async (next: Draft) => {
    setDraft(next);
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(next));
  };

  const pickPhoto = async () => {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo access is required to create a real-person character.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"], quality: 0.9,
    });
    if (result.canceled) return;
    const asset = result.assets[0]!;
    setUploading(true);
    try {
      const name = asset.fileName ?? `character-${Date.now()}.jpg`;
      const contentType = asset.mimeType ?? "image/jpeg";
      const size = asset.fileSize ?? 0;
      const prepared = await requestUpload.mutateAsync({
        data: { name, contentType, size },
      });
      const uploaded = await FileSystem.uploadAsync(prepared.uploadURL, asset.uri, {
        httpMethod: "PUT",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { "Content-Type": contentType },
      });
      if (uploaded.status < 200 || uploaded.status >= 300) throw new Error("Upload failed");
      await persist({
        ...draft,
        photoPath: prepared.objectPath,
        photoName: name,
        identityId: null,
        existingCharacterId: null,
      });
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not upload the photo."));
    } finally {
      setUploading(false);
    }
  };

  const verify = async (existingCharacter?: Character) => {
    const label = existingCharacter?.name ?? draft.name.trim();
    if (!label || (!existingCharacter && !draft.photoPath)) return;
    setError(null);
    try {
      const started = await startVerification.mutateAsync({
        data: { label, returnTarget: "mobile" },
      });
      const next = existingCharacter
        ? { ...emptyDraft, identityId: started.id, existingCharacterId: existingCharacter.id }
        : { ...draft, identityId: started.id, existingCharacterId: null };
      await persist(next);
      const result = await WebBrowser.openAuthSessionAsync(
        started.verificationUrl,
        "mobile://characters",
      );
      if (result.type === "success") {
        const url = new URL(result.url);
        router.setParams({
          identity: url.searchParams.get("identity") ?? undefined,
          identityId: url.searchParams.get("identityId") ?? undefined,
        });
      } else if (result.type === "cancel" || result.type === "dismiss") {
        setNotice("Verification is still pending. Reopen it or retry when ready.");
        void identitiesQuery.refetch();
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not start identity verification."));
    }
  };

  const save = async () => {
    if (selectedIdentity?.status !== "verified") return;
    setError(null);
    try {
      if (draft.existingCharacterId) {
        await updateCharacter.mutateAsync({
          characterId: draft.existingCharacterId,
          data: { identityId: selectedIdentity.id },
        });
        setNotice("Verified identity attached to the character.");
      } else {
        await createCharacter.mutateAsync({
          data: {
            name: draft.name.trim(),
            description: draft.description.trim() || null,
            sourceImagePath: draft.photoPath,
            identityId: selectedIdentity.id,
          },
        });
        setNotice("Verified real-person character created.");
      }
      await AsyncStorage.removeItem(DRAFT_KEY);
      setDraft(emptyDraft);
      await queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not attach the verified identity."));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Real-person characters</Text>
      <Text style={styles.subtitle}>A liveness check protects a real person’s likeness before KOKAO uses it.</Text>
      {notice ? <Card><Text style={styles.notice}>{notice}</Text></Card> : null}
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <Card style={styles.form}>
        <Text style={styles.cardTitle}>Create a character</Text>
        <Label>Name</Label>
        <Input
          value={draft.name}
          onChangeText={(name) =>
            void persist({
              ...draft,
              name,
              identityId: null,
              existingCharacterId: null,
            })
          }
          testID="character-name"
        />
        <Label>Appearance notes</Label>
        <Input
          multiline
          value={draft.description}
          onChangeText={(description) =>
            void persist({
              ...draft,
              description,
              identityId: null,
              existingCharacterId: null,
            })
          }
          testID="character-description"
        />
        <Button title={draft.photoName || "Choose reference photo"} variant="outline" onPress={() => void pickPhoto()} loading={uploading} testID="choose-character-photo" />
        {selectedIdentity && draft.existingCharacterId === null ? (
          <View style={styles.statusRow} testID="identity-status">
            <Text style={styles.statusLabel}>{selectedIdentity.label}</Text>
            <Badge
              label={selectedIdentity.status === "pending" ? "Pending" : selectedIdentity.status === "verified" ? "Verified" : "Failed"}
              tone={selectedIdentity.status === "verified" ? "success" : selectedIdentity.status === "failed" ? "destructive" : "accent"}
            />
          </View>
        ) : null}
        {selectedIdentity?.status === "verified" && draft.existingCharacterId === null ? (
          <Button title="Create verified character" onPress={() => void save()} loading={createCharacter.isPending} testID="save-verified-character" />
        ) : (
          <Button
            title={selectedIdentity?.status === "failed" ? "Retry liveness check" : "Verify this person"}
            onPress={() => void verify()}
            loading={startVerification.isPending}
            disabled={!draft.name.trim() || !draft.photoPath}
            testID="start-character-verification"
          />
        )}
      </Card>

      <Text style={styles.sectionTitle}>Your uploaded characters</Text>
      {ownCharacters.map((character) => (
        <Card key={character.id} style={styles.characterRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{character.name}</Text>
            {draft.existingCharacterId === character.id && selectedIdentity ? (
              <View style={styles.existingVerificationStatus}>
                <Badge
                  label={
                    selectedIdentity.status === "pending"
                      ? "Pending"
                      : selectedIdentity.status === "verified"
                        ? "Verified"
                        : "Failed"
                  }
                  tone={
                    selectedIdentity.status === "verified"
                      ? "success"
                      : selectedIdentity.status === "failed"
                        ? "destructive"
                        : "accent"
                  }
                />
              </View>
            ) : (
              <Text style={styles.muted}>
                {character.identityId ? "Identity verified" : "Not verified"}
              </Text>
            )}
          </View>
          {!character.identityId && character.referenceSource === "uploaded" ? (
            draft.existingCharacterId === character.id && selectedIdentity?.status === "verified" ? (
              <Button title="Attach" onPress={() => void save()} loading={updateCharacter.isPending} testID={`attach-identity-${character.id}`} />
            ) : (
              <Button title={draft.existingCharacterId === character.id && selectedIdentity?.status === "failed" ? "Retry" : "Verify"} variant="outline" onPress={() => void verify(character)} testID={`verify-character-${character.id}`} />
            )
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, paddingBottom: 48, gap: 14, backgroundColor: c.background },
  title: { fontFamily: fonts.bold, fontSize: 26, color: c.foreground },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: c.mutedForeground },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 18, color: c.foreground, marginTop: 8 },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: c.foreground },
  form: { gap: 10 },
  characterRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  statusLabel: { fontFamily: fonts.medium, color: c.foreground },
  existingVerificationStatus: { alignItems: "flex-start", marginTop: 5 },
  muted: { fontFamily: fonts.regular, color: c.mutedForeground, marginTop: 3 },
  notice: { fontFamily: fonts.medium, color: c.success },
  error: { fontFamily: fonts.medium, color: c.destructive },
});