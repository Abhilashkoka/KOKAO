import { useMemo, useState } from "react";
import {
  getGetGuidedStoryDraftQueryKey,
  getListCharactersQueryKey,
  useRecoverCharacterProvenance,
  type CharacterProvenanceStatus as ApiCharacterProvenanceStatus,
  type CharacterProvenanceSummaryMethod,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/**
 * Provenance is deliberately a separate display projection from Character.
 * The generated API now owns the exact status/summary contract; this UI still
 * allowlists values and never derives a claim from referenceSource, a display
 * label, or an image path.
 */
export type CharacterProvenanceStatus = ApiCharacterProvenanceStatus;

export type CharacterProvenanceSummary = {
  provider?: string | null;
  model?: string | null;
  method?: CharacterProvenanceSummaryMethod | null;
  createdAt?: string | null;
};

export type CharacterWithOptionalProvenance = {
  /** Existing Character fields keep this projection structurally compatible. */
  referenceSource?: unknown;
  provenanceStatus?: CharacterProvenanceStatus | null;
  provenanceSummary?: CharacterProvenanceSummary | null;
};

const STATUS_LABELS: Record<CharacterProvenanceStatus, string> = {
  verified_generated: "Generated origin recorded",
  uploaded: "Uploaded origin",
  unknown: "Origin not verified",
};

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Safe summaries are server-authored, but keep the presentation bounded and
  // reject multiline material so a future contract cannot accidentally turn
  // this compact panel into a prompt or secret dump.
  if (!text || text.length > 160 || /[\r\n]/.test(text)) return null;
  return text;
}

function safeMethod(value: unknown): CharacterProvenanceSummary["method"] {
  return value === "textgenerated" ||
    value === "upload" ||
    value === "imageedit" ||
    value === "derived"
    ? value
    : null;
}

function safeSummary(value: unknown): CharacterProvenanceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const summary = value as Record<string, unknown>;
  return {
    provider: safeText(summary.provider),
    model: safeText(summary.model),
    method: safeMethod(summary.method),
    createdAt: safeText(summary.createdAt),
  };
}

/**
 * Missing or invalid status is intentionally unknown. In particular,
 * `referenceSource: "generated"` is not accepted as provenance evidence.
 */
export function characterProvenance(
  character: CharacterWithOptionalProvenance | null | undefined,
): {
  status: CharacterProvenanceStatus;
  label: string;
  summary: CharacterProvenanceSummary;
} {
  const status =
    character?.provenanceStatus === "verified_generated" ||
    character?.provenanceStatus === "uploaded"
      ? character.provenanceStatus
      : "unknown";
  return {
    status,
    label: STATUS_LABELS[status],
    summary: safeSummary(character?.provenanceSummary),
  };
}

export function characterProvenanceLabel(
  character: CharacterWithOptionalProvenance | null | undefined,
): string {
  return characterProvenance(character).label;
}

/**
 * The frozen image model snapshot is a server-owned eligibility signal. Do
 * not infer this from a model name in a character or from referenceSource.
 * Older drafts without a snapshot remain usable for all existing providers.
 */
export function guidedCharacterRequiresRecordedGeneratedOrigin(
  character: CharacterWithOptionalProvenance | null | undefined,
  imageModelSnapshot: unknown,
): boolean {
  if (characterProvenance(character).status !== "unknown") return false;
  if (!imageModelSnapshot || typeof imageModelSnapshot !== "object") return false;
  const snapshot = imageModelSnapshot as Record<string, unknown>;
  return (
    snapshot.provider === "atlascloud" &&
    typeof snapshot.model === "string" &&
    snapshot.model.trim().length > 0
  );
}

export function CharacterProvenanceBadge({
  character,
  testId,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  testId?: string;
}) {
  const provenance = characterProvenance(character);
  const tone =
    provenance.status === "verified_generated"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
      : provenance.status === "uploaded"
        ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
        : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300";

  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
      data-testid={testId}
      title={
        provenance.status === "unknown"
          ? "Origin evidence is not verified."
          : undefined
      }
    >
      {provenance.label}
    </span>
  );
}

export function CharacterProvenanceDetails({
  character,
  testId,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  testId?: string;
}) {
  const provenance = useMemo(() => characterProvenance(character), [character]);
  const fields = [
    ["Provider", provenance.summary.provider],
    ["Model", provenance.summary.model],
    ["Date", provenance.summary.createdAt],
    ["Method", provenance.summary.method],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <details
      className="text-xs"
      data-testid={testId}
    >
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Provenance details
      </summary>
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
        {fields.length > 0 ? (
          <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt className="inline font-medium">{label}: </dt>
                <dd className="inline text-muted-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">
            {provenance.status === "unknown"
              ? "This origin is not verified by a server provenance record."
              : "No additional origin details are available."}
          </p>
        )}
      </div>
    </details>
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

/**
 * Explicitly checks a server-owned recovery receipt. This never regenerates an
 * image and never changes the displayed status unless the server returns the
 * verified_generated status.
 */
export function CharacterProvenanceRecovery({
  character,
  characterId,
  draftId,
  roleId,
  testId,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  characterId: number;
  draftId?: number | null;
  roleId?: string | null;
  testId?: string;
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
    <div className="mt-2 space-y-2" data-testid={testId}>
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => {
          if (hasKnownOrigin) {
            runRecovery();
          } else {
            setFormOpen((open) => !open);
          }
        }}
        disabled={recovery.isPending}
        data-testid={testId ? `${testId}-button` : undefined}
      >
        {recovery.isPending
          ? "Checking generation history…"
          : "Check generation history"}
      </button>
      {!hasKnownOrigin && formOpen && (
        <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-2">
          <label className="grid gap-1 text-xs">
            <span>Guided Story draft ID</span>
            <input
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              inputMode="numeric"
              value={draftInput}
              onChange={(event) => setDraftInput(event.target.value)}
              data-testid={testId ? `${testId}-draft-id` : undefined}
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span>Original role ID</span>
            <input
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={roleInput}
              onChange={(event) => setRoleInput(event.target.value)}
              data-testid={testId ? `${testId}-role-id` : undefined}
            />
          </label>
          <button
            type="button"
            className="w-fit rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={runRecovery}
            disabled={recovery.isPending || !canSubmit}
            data-testid={testId ? `${testId}-submit` : undefined}
          >
            {recovery.isPending
              ? "Checking generation history…"
              : "Check generation history"}
          </button>
          <p className="text-[11px] text-muted-foreground">
            This checks recorded history only. It does not regenerate or charge.
          </p>
        </div>
      )}
      {message && (
        <p
          className={
            messageIsError
              ? "text-xs text-amber-700 dark:text-amber-300"
              : "text-xs text-emerald-700 dark:text-emerald-300"
          }
          role={messageIsError ? "alert" : "status"}
          data-testid={testId ? `${testId}-message` : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}

export function CharacterProvenance({
  character,
  testId,
  detailsTestId,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  testId?: string;
  detailsTestId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <CharacterProvenanceBadge character={character} testId={testId} />
      <CharacterProvenanceDetails
        character={character}
        testId={detailsTestId}
      />
    </div>
  );
}

export function GuidedCharacterProvenanceWarning({
  character,
  imageModelSnapshot,
  testId,
}: {
  character: CharacterWithOptionalProvenance | null | undefined;
  imageModelSnapshot: unknown;
  testId?: string;
}) {
  if (!guidedCharacterRequiresRecordedGeneratedOrigin(character, imageModelSnapshot)) {
    return null;
  }
  return (
    <p
      className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      role="alert"
      data-testid={testId}
    >
      Origin not verified. This saved character cannot use the fictional-only
      Wan/Atlas path. Choose a character with Generated origin recorded or use
      another provider.
    </p>
  );
}