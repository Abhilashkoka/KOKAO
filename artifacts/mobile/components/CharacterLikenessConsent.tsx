import React, { useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterLikenessConsent,
  useGrantCharacterLikenessConsent,
  useRevokeCharacterLikenessConsent,
  useAcknowledgeCharacterLikenessRecipient,
  useRevokeCharacterLikenessRecipient,
  type CharacterLikenessConsentResponse,
  type CharacterLikenessConsentSubject,
} from "@workspace/api-client-react";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Badge, Button, Card } from "@/components/ui";

const c = colors.light;
const domain = process.env.EXPO_PUBLIC_DOMAIN;

type ConsentStatus = CharacterLikenessConsentResponse["status"];
type Subject = CharacterLikenessConsentSubject;

function Checkbox({
  checked,
  label,
  onPress,
  testID,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={styles.checkboxRow}
      testID={testID}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </Pressable>
  );
}

function statusLabel(status: ConsentStatus | undefined): string {
  switch (status) {
    case "active":
      return "Consent active";
    case "revoked":
      return "Consent withdrawn";
    case "stale":
      return "Consent needs renewal";
    case "not_required":
      return "Consent not required";
    default:
      return "Consent not granted";
  }
}

/**
 * Personal likeness authorization is deliberately separate from BytePlus
 * liveness. This record authorizes only the server-disclosed Atlas Cloud Wan
 * reference-to-video paths; it is not provider or identity verification.
 */
export function CharacterLikenessConsent({ characterId }: { characterId: number }) {
  const queryClient = useQueryClient();
  const consentQuery = useGetCharacterLikenessConsent(characterId);
  const grant = useGrantCharacterLikenessConsent();
  const revoke = useRevokeCharacterLikenessConsent();
  const response: CharacterLikenessConsentResponse | null =
    consentQuery.data?.data ?? null;
  const status = response?.status;
  const [subject, setSubject] = useState<Subject>("self");
  const [imageRightsConfirmed, setImageRightsConfirmed] = useState(false);
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [likenessConfirmed, setLikenessConfirmed] = useState(false);
  const [writtenPermissionConfirmed, setWrittenPermissionConfirmed] = useState(false);
  const [allowOutfitEdits, setAllowOutfitEdits] = useState(false);
  const [allowVideoDepiction, setAllowVideoDepiction] = useState(false);
  const [allowScriptedSpeech, setAllowScriptedSpeech] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const acknowledgeRecipient = useAcknowledgeCharacterLikenessRecipient();
  const revokeRecipient = useRevokeCharacterLikenessRecipient();

  const canGrant =
    Boolean(response?.sourceSha256) &&
    Boolean(response?.policyVersion) &&
    imageRightsConfirmed &&
    adultConfirmed &&
    likenessConfirmed &&
    (subject === "self" || writtenPermissionConfirmed) &&
    !grant.isPending;

  const eligibility = useMemo(
    () => response?.eligibility ?? [],
    [response?.eligibility],
  );
  const recipients = useMemo(
    () => response?.recipients ?? [],
    [response?.recipients],
  );
  const pendingRecipients = useMemo(
    () => response?.pendingRecipients ?? [],
    [response?.pendingRecipients],
  );

  const refreshAffectedSurfaces = async () => {
    // Consent can change dispatch eligibility in character lists, cast
    // pickers, wardrobe, and video creation. Invalidating active queries
    // keeps all mounted surfaces in sync without guessing their query keys.
    await queryClient.invalidateQueries();
  };

  const grantConsent = () => {
    if (!canGrant || !response?.sourceSha256 || !response.policyVersion) return;
    setMessage(null);
    setMessageIsError(false);
    grant.mutate(
      {
        characterId,
        data: {
          sourceSha256: response.sourceSha256,
          policyVersion: response.policyVersion,
          subject,
          imageRightsConfirmed: true,
          adultConfirmed: true,
          likenessConfirmed: true,
          writtenPermissionConfirmed:
            subject === "authorized_person" && writtenPermissionConfirmed,
          allowOutfitEdits,
          allowVideoDepiction,
          allowScriptedSpeech,
        },
      },
      {
        onSuccess: async () => {
          await refreshAffectedSurfaces();
          setMessage("Authorization saved.");
          setMessageIsError(false);
        },
        onError: (error) => {
          setMessage(apiErrorMessage(error, "Could not save likeness authorization."));
          setMessageIsError(true);
        },
      },
    );
  };

  const revokeConsent = () => {
    if (revoke.isPending) return;
    setMessage(null);
    setMessageIsError(false);
    revoke.mutate(
      { characterId },
      {
        onSuccess: async () => {
          await refreshAffectedSurfaces();
          setMessage("Authorization withdrawn. Previously sent work cannot be recalled.");
          setMessageIsError(false);
        },
        onError: (error) => {
          setMessage(apiErrorMessage(error, "Could not withdraw likeness authorization."));
          setMessageIsError(true);
        },
      },
    );
  };

  const openWebStudio = async () => {
    const url = domain ? `https://${domain}/video-studio` : null;
    if (!url) {
      setMessage("Continue in the web video studio to choose wardrobe and dispatch video.");
      setMessageIsError(false);
      return;
    }
    try {
      await Linking.openURL(url);
    } catch (error) {
      setMessage(apiErrorMessage(error, "Open the web video studio to continue."));
      setMessageIsError(true);
    }
  };

  if (status === "not_required") return null;
  if (consentQuery.isLoading) {
    return (
      <View style={styles.container} testID={`likeness-consent-${characterId}`}>
        <Text style={styles.muted}>Loading likeness authorization...</Text>
      </View>
    );
  }
  if (consentQuery.isError || !response) {
    return (
      <View style={styles.container} testID={`likeness-consent-${characterId}`}>
        <Text style={styles.muted}>Likeness authorization is unavailable right now.</Text>
      </View>
    );
  }

  const canEdit = status !== "active";
  const badgeTone = status === "active" ? "success" : status === "stale" ? "destructive" : "accent";

  return (
    <Card style={styles.container} testID={`likeness-consent-${characterId}`}>
      <View style={styles.headingRow}>
        <Text style={styles.title}>Personal likeness authorization</Text>
        <Badge label={statusLabel(status)} tone={badgeTone} />
      </View>
      <Text style={styles.explanation}>
        This is separate from BytePlus liveness. It is an authorization
        declaration for the exact source photo, not identity or provider
        verification and not legal certification.
      </Text>
      {status === "stale" ? (
        <Text style={styles.warning}>
          The source photo changed. This authorization no longer applies; review and grant it again.
        </Text>
      ) : null}

      <Text style={styles.statementLabel}>Server statement</Text>
      <Text style={styles.statement} testID={`likeness-statement-${characterId}`}>
        {response.statement}
      </Text>
      {pendingRecipients.length > 0 ? (
        <View style={styles.activeDetails} testID={`likeness-pending-${characterId}`}>
          <Text style={styles.formLabel}>Providers awaiting your confirmation</Text>
          {pendingRecipients.map((entry, index) => (
            <View style={styles.eligibilityRow} key={`${entry.provider}-${entry.operation}-${index}`}>
              <View style={styles.eligibilityText}>
                <Text style={styles.detail}>{entry.scopeLabel}</Text>
                {entry.providerAccepts ? null : (
                  <Text style={styles.muted}>{entry.reason}</Text>
                )}
              </View>
              {entry.providerAccepts && response.consent ? (
                <Button
                  title="Confirm"
                  onPress={() => {
                    setMessage(null);
                    setMessageIsError(false);
                    acknowledgeRecipient.mutate(
                      {
                        characterId,
                        data: {
                          consentId: response.consent?.id,
                          provider: entry.provider,
                          model: entry.model,
                          operation: entry.operation,
                        },
                      },
                      {
                        onSuccess: async () => {
                          await refreshAffectedSurfaces();
                          setMessage("Provider confirmed.");
                        },
                        onError: (error) => {
                          setMessage(apiErrorMessage(error, "Could not confirm this provider."));
                          setMessageIsError(true);
                        },
                      },
                    );
                  }}
                  loading={acknowledgeRecipient.isPending}
                  testID={`likeness-confirm-${entry.provider}-${entry.operation}-${characterId}`}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {recipients.length > 0 ? (
        <View style={styles.activeDetails} testID={`likeness-recipients-${characterId}`}>
          <Text style={styles.formLabel}>Providers that receive this likeness</Text>
          {recipients.map((entry) => (
            <View style={styles.eligibilityRow} key={entry.id}>
              <View style={styles.eligibilityText}>
                <Text style={styles.detail}>{entry.scopeLabel}</Text>
              </View>
              {entry.revokedAt ? (
                <Badge label="withdrawn" tone="muted" />
              ) : (
                <Button
                  title="Withdraw"
                  variant="outline"
                  onPress={() => {
                    setMessage(null);
                    setMessageIsError(false);
                    revokeRecipient.mutate(
                      { characterId, disclosureId: entry.id },
                      {
                        onSuccess: async () => {
                          await refreshAffectedSurfaces();
                          setMessage("Provider withdrawn. Your authorization is unchanged.");
                        },
                        onError: (error) => {
                          setMessage(apiErrorMessage(error, "Could not withdraw this provider."));
                          setMessageIsError(true);
                        },
                      },
                    );
                  }}
                  loading={revokeRecipient.isPending}
                  testID={`likeness-withdraw-${entry.id}`}
                />
              )}
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.providerHeading}>Provider eligibility for this likeness</Text>
      {eligibility.length > 0 ? (
        eligibility.map((item, index) => (
          <View style={styles.eligibilityRow} key={`${item.provider ?? "provider"}-${item.modelFamily ?? index}`}>
            <View style={styles.eligibilityText}>
              <Text style={styles.modelFamily}>
                {item.provider ?? "Provider"} · {item.modelFamily ?? "model family"}
              </Text>
              {item.reason ? <Text style={styles.muted}>{item.reason}</Text> : null}
            </View>
            <Badge
              label={item.status ?? "unavailable"}
              tone={item.status === "eligible" ? "success" : item.status === "unsupported" ? "destructive" : "muted"}
            />
          </View>
        ))
      ) : (
        <Text style={styles.muted}>No model eligibility is available from the server.</Text>
      )}

      {status === "active" && response.consent ? (
        <View style={styles.activeDetails} testID={`likeness-active-${characterId}`}>
          <Text style={styles.detail}>
            Providers receiving this likeness:{" "}
            {(response.recipients ?? [])
              .filter((entry) => !entry.revokedAt)
              .map((entry) => entry.scopeLabel)
              .join(", ") || "None disclosed yet"}
          </Text>
          <Text style={styles.detail}>
            Outfit edits: {response.consent.allowOutfitEdits ? "Allowed" : "Not allowed"} · Video depiction:{" "}
            {response.consent.allowVideoDepiction ? "Allowed" : "Not allowed"} · Scripted speech:{" "}
            {response.consent.allowScriptedSpeech ? "Allowed" : "Not allowed"}
          </Text>
          <Text style={styles.withdrawalHint}>
            Withdrawing blocks future dispatch only. It cannot recall work already sent.
          </Text>
          <Button
            title="Withdraw authorization"
            variant="outline"
            onPress={revokeConsent}
            loading={revoke.isPending}
            testID={`revoke-likeness-consent-${characterId}`}
          />
          <Button
            title={domain ? "Continue on web for wardrobe and video" : "Web continuation unavailable"}
            variant="secondary"
            onPress={() => void openWebStudio()}
            disabled={!domain}
            testID={`open-web-studio-${characterId}`}
          />
          {!domain ? (
            <Text style={styles.muted}>
              The web video studio URL is not configured in this build. Use the web app to continue.
            </Text>
          ) : null}
        </View>
      ) : canEdit ? (
        <View style={styles.form} testID={`likeness-form-${characterId}`}>
          <Text style={styles.formLabel}>Who is shown?</Text>
          <View style={styles.subjectRow}>
            {(["self", "authorized_person"] as Subject[]).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: subject === value }}
                onPress={() => setSubject(value)}
                style={[styles.subjectOption, subject === value && styles.subjectSelected]}
                testID={`likeness-subject-${value}-${characterId}`}
              >
                <Text style={[styles.subjectText, subject === value && styles.subjectTextSelected]}>
                  {value === "self" ? "Me" : "Someone else"}
                </Text>
              </Pressable>
            ))}
          </View>
          <Checkbox
            checked={imageRightsConfirmed}
            onPress={() => setImageRightsConfirmed((value) => !value)}
            label="I have the rights to use this image."
            testID={`likeness-image-rights-${characterId}`}
          />
          <Checkbox
            checked={adultConfirmed}
            onPress={() => setAdultConfirmed((value) => !value)}
            label="I confirm that all people shown are adults."
            testID={`likeness-adult-${characterId}`}
          />
          <Checkbox
            checked={likenessConfirmed}
            onPress={() => setLikenessConfirmed((value) => !value)}
            label="I authorize likeness generation from this photo."
            testID={`likeness-generation-${characterId}`}
          />
          {subject === "authorized_person" ? (
            <Checkbox
              checked={writtenPermissionConfirmed}
              onPress={() => setWrittenPermissionConfirmed((value) => !value)}
              label="I hold written permission from the person shown."
              testID={`likeness-written-permission-${characterId}`}
            />
          ) : null}
          <Text style={styles.formLabel}>Separate permissions</Text>
          <Checkbox
            checked={allowOutfitEdits}
            onPress={() => setAllowOutfitEdits((value) => !value)}
            label="Allow AI outfit edits."
            testID={`likeness-outfit-edits-${characterId}`}
          />
          <Checkbox
            checked={allowVideoDepiction}
            onPress={() => setAllowVideoDepiction((value) => !value)}
            label="Allow being depicted in generated video."
            testID={`likeness-video-depiction-${characterId}`}
          />
          <Checkbox
            checked={allowScriptedSpeech}
            onPress={() => setAllowScriptedSpeech((value) => !value)}
            label="Allow scripted speech."
            testID={`likeness-scripted-speech-${characterId}`}
          />
          <Button
            title="Grant likeness authorization"
            onPress={grantConsent}
            disabled={!canGrant}
            loading={grant.isPending}
            testID={`grant-likeness-consent-${characterId}`}
          />
        </View>
      ) : null}
      {message ? (
        <Text style={messageIsError ? styles.error : styles.success} accessibilityRole={messageIsError ? "alert" : "text"}>
          {message}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { width: "100%", gap: 10, marginTop: 8 },
  headingRow: { gap: 8 },
  title: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  explanation: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: c.mutedForeground },
  warning: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 18, color: c.destructive },
  statementLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground },
  statement: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: c.foreground },
  providerHeading: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground, marginTop: 2 },
  eligibilityRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  eligibilityText: { flex: 1, gap: 2 },
  modelFamily: { fontFamily: fonts.medium, fontSize: 12, color: c.foreground },
  activeDetails: { gap: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 },
  detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: c.foreground },
  withdrawalHint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: c.mutedForeground },
  form: { gap: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 },
  formLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground, marginTop: 2 },
  subjectRow: { flexDirection: "row", gap: 8 },
  subjectOption: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: colors.radius, padding: 10, alignItems: "center" },
  subjectSelected: { borderColor: c.primary, backgroundColor: c.accent },
  subjectText: { fontFamily: fonts.medium, fontSize: 12, color: c.mutedForeground },
  subjectTextSelected: { color: c.accentForeground },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 3 },
  checkbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 1, borderColor: c.input, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
  checkboxLabel: { flex: 1, fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: c.foreground },
  muted: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: c.mutedForeground },
  success: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 17, color: c.success },
  error: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 17, color: c.destructive },
});