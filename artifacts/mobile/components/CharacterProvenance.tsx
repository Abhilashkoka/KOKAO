import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGuidedStoryDraftQueryKey,
  getListCharactersQueryKey,
  useRecoverCharacterProvenance,
  type CharacterProvenanceStatus as ApiCharacterProvenanceStatus,
  type CharacterProvenanceSummaryMethod,
} from "@workspace/api-client-react";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { Button, Input } from "@/components/ui";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

export type CharacterProvenanceStatus = ApiCharacterProvenanceStatus;

export type CharacterWithOptionalProvenance = {
  /** Existing Character fields keep this projection structurally compatible. */
  referenceSource?: unknown;
  provenanceStatus?: CharacterProvenanceStatus | null;
  provenanceSummary?: {
    provider?: string | null;
    model?: string | null;
    method?: CharacterProvenanceSummaryMethod | null;
    createdAt?: string | null;
  } | null;
};

type Summary = {
  provider: string | null;
  model: string | null;
  method: CharacterProvenanceSummaryMethod | null;
  createdAt: string | null;
};

const c = colors.light;
const LABELS: Record<CharacterProvenanceStatus, string> = {
  verified_generated: "Generated origin recorded",
  uploaded: "Uploaded origin",
  unknown: "Origin not verified",
};

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 160 || /[\r\n]/.test(text)) return null;
  return text;
}

function readSummary(value: unknown): Summary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { provider: null, model: null, method: null, createdAt: null };
  }
  const summary = value as Record<string, unknown>;
  return {
    provider: safeText(summary.provider),
    model: safeText(summary.model),
    method:
      summary.method === "textgenerated" ||
      summary.method === "upload" ||
      summary.method === "imageedit" ||
      summary.method === "derived"
        ? summary.method
        : null,
    createdAt: safeText(summary.createdAt),
  };
}

export function characterProvenance(
  character: CharacterWithOptionalProvenance | null | undefined,
): { status: CharacterProvenanceStatus; label: string; summary: Summary } {
  const status =
    character?.provenanceStatus === "verified_generated" ||
    character?.provenanceStatus === "uploaded"
      ? character.provenanceStatus
      : "unknown";
  return { status, label: LABELS[status], summary: readSummary(character?.provenanceSummary) };
}

export function CharacterProvenance({
  character,
  testID,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const provenance = characterProvenance(character);
  const details = [
    ["Provider", provenance.summary.provider],
    ["Model", provenance.summary.model],
    ["Date", provenance.summary.createdAt],
    ["Method", provenance.summary.method],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <View style={styles.container} testID={testID}>
      <View
        style={[
          styles.badge,
          provenance.status === "verified_generated"
            ? styles.generated
            : provenance.status === "uploaded"
              ? styles.uploaded
              : styles.unknown,
        ]}
      >
        <Text style={styles.badgeText}>{provenance.label}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Text style={styles.detailsLink}>
          {expanded ? "Hide details" : "Details"}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.details} testID={testID ? `${testID}-details` : undefined}>
          {details.length > 0 ? (
            details.map(([label, value]) => (
              <Text key={label} style={styles.detailText}>
                <Text style={styles.detailLabel}>{label}: </Text>
                {value}
              </Text>
            ))
          ) : (
            <Text style={styles.detailText}>
              {provenance.status === "unknown"
                ? "This origin is not verified by a server provenance record."
                : "No additional origin details are available."}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function recoveryErrorMessage(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  if (status === 400) {
    return "Enter the exact original Guided Story draft ID and role ID. Origin remains not verified.";
  }
  if (status === 409) {
    return "No matching immutable generation history was found. Origin remains not verified.";
  }
  return apiErrorMessage(
    error,
    "Generation history could not be checked. Origin remains not verified.",
  );
}

export function CharacterProvenanceRecovery({
  character,
  characterId,
  draftId,
  roleId,
  testID,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  characterId: number;
  draftId?: number | null;
  roleId?: string | null;
  testID?: string;
}) {
  const provenance = characterProvenance(character);
  const queryClient = useQueryClient();
  const recovery = useRecoverCharacterProvenance();
  const [formOpen, setFormOpen] = useState(false);
  const [draftInput, setDraftInput] = useState(
    draftId != null ? String(draftId) : "",
  );
  const [roleInput, setRoleInput] = useState(roleId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  if (provenance.status !== "unknown") return null;

  const parsedDraftId = Number(draftInput.trim());
  const canSubmit =
    Number.isSafeInteger(parsedDraftId) &&
    parsedDraftId > 0 &&
    roleInput.trim().length > 0;
  const hasKnownOrigin = draftId != null && !!roleId?.trim();
  const runRecovery = () => {
    if (!canSubmit) {
      setFormOpen(true);
      setMessage(
        "Enter the exact original Guided Story draft ID and role ID to check history.",
      );
      setMessageIsError(true);
      return;
    }
    setMessage(null);
    setMessageIsError(false);
    recovery.mutate(
      {
        characterId,
        data: {
          draftId: parsedDraftId,
          roleId: roleInput.trim(),
        },
      },
      {
        onSuccess: async (recovered) => {
          await Promise.all([
            queryClient.refetchQueries({
              queryKey: getListCharactersQueryKey(),
            }),
            queryClient.refetchQueries({
              queryKey: getGetGuidedStoryDraftQueryKey(parsedDraftId),
            }),
          ]);
          if (recovered.provenanceStatus !== "verified_generated") {
            setMessage(
              "The server did not verify this origin. Origin remains not verified.",
            );
            setMessageIsError(true);
            return;
          }
          setMessage("Generation origin record recovered.");
          setMessageIsError(false);
        },
        onError: (error) => {
          setMessage(recoveryErrorMessage(error));
          setMessageIsError(true);
        },
      },
    );
  };

  return (
    <View style={styles.recovery} testID={testID}>
      <Button
        title={
          recovery.isPending
            ? "Checking generation history…"
            : "Check generation history"
        }
        variant="outline"
        onPress={() => {
          if (hasKnownOrigin) {
            runRecovery();
          } else {
            setFormOpen((open) => !open);
          }
        }}
        disabled={recovery.isPending}
        testID={testID ? `${testID}-button` : undefined}
      />
      {!hasKnownOrigin && formOpen ? (
        <View style={styles.recoveryForm}>
          <Text style={styles.recoveryLabel}>Guided Story draft ID</Text>
          <Input
            value={draftInput}
            onChangeText={setDraftInput}
            keyboardType="number-pad"
            testID={testID ? `${testID}-draft-id` : undefined}
          />
          <Text style={styles.recoveryLabel}>Original role ID</Text>
          <Input
            value={roleInput}
            onChangeText={setRoleInput}
            testID={testID ? `${testID}-role-id` : undefined}
          />
          <Button
            title="Check generation history"
            variant="secondary"
            onPress={runRecovery}
            disabled={recovery.isPending || !canSubmit}
            testID={testID ? `${testID}-submit` : undefined}
          />
          <Text style={styles.recoveryHint}>
            This checks recorded history only. It does not regenerate or charge.
          </Text>
        </View>
      ) : null}
      {message ? (
        <Text
          style={messageIsError ? styles.recoveryError : styles.recoverySuccess}
          accessibilityRole={messageIsError ? "alert" : "text"}
          testID={testID ? `${testID}-message` : undefined}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 5 },
  badge: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  generated: { backgroundColor: c.accent },
  uploaded: { backgroundColor: c.secondary },
  unknown: { backgroundColor: c.muted },
  badgeText: { fontFamily: fonts.medium, fontSize: 11, color: c.foreground },
  detailsLink: { fontFamily: fonts.medium, fontSize: 11, color: c.mutedForeground },
  details: { width: "100%", borderWidth: 1, borderColor: c.border, borderRadius: colors.radius, backgroundColor: c.muted, padding: 8, gap: 3 },
  detailText: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground },
  detailLabel: { fontFamily: fonts.semiBold, color: c.foreground },
  recovery: { width: "100%", marginTop: 6, gap: 6 },
  recoveryForm: { gap: 6, padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: colors.radius, backgroundColor: c.muted },
  recoveryLabel: { fontFamily: fonts.medium, fontSize: 11, color: c.foreground },
  recoveryHint: { fontFamily: fonts.regular, fontSize: 11, lineHeight: 16, color: c.mutedForeground },
  recoveryError: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 16, color: c.destructive },
  recoverySuccess: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 16, color: c.success },
});