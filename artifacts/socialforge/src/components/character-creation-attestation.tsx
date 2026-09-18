import type { CreateCharacterLikenessAttestation } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Info } from "lucide-react";

export type CreationAttestationDraft = {
  subject: "self" | "authorized_person";
  imageRightsConfirmed: boolean;
  adultConfirmed: boolean;
  likenessConfirmed: boolean;
  writtenPermissionConfirmed: boolean;
  allowOutfitEdits: boolean;
  allowVideoDepiction: boolean;
  allowScriptedSpeech: boolean;
};

export const emptyCreationAttestation: CreationAttestationDraft = {
  subject: "self",
  imageRightsConfirmed: false,
  adultConfirmed: false,
  likenessConfirmed: false,
  writtenPermissionConfirmed: false,
  allowOutfitEdits: false,
  allowVideoDepiction: false,
  allowScriptedSpeech: false,
};

/** The server's own required checks, mirrored so the button can disable early. */
export function creationAttestationComplete(draft: CreationAttestationDraft): boolean {
  return (
    draft.imageRightsConfirmed &&
    draft.adultConfirmed &&
    draft.likenessConfirmed &&
    (draft.subject === "self" || draft.writtenPermissionConfirmed)
  );
}

/**
 * Build the request field. No policyVersion: the form shows a summary rather
 * than the server statement verbatim, so the server stamps its own current
 * version and stores the authoritative text. Creation therefore never blocks
 * on an extra round trip.
 */
export function creationAttestationPayload(
  draft: CreationAttestationDraft,
): CreateCharacterLikenessAttestation {
  return {
    subject: draft.subject,
    imageRightsConfirmed: draft.imageRightsConfirmed,
    adultConfirmed: draft.adultConfirmed,
    likenessConfirmed: draft.likenessConfirmed,
    writtenPermissionConfirmed:
      draft.subject === "authorized_person" ? draft.writtenPermissionConfirmed : false,
    allowOutfitEdits: draft.allowOutfitEdits,
    allowVideoDepiction: draft.allowVideoDepiction,
    allowScriptedSpeech: draft.allowScriptedSpeech,
  };
}

/**
 * Collected at the moment the photograph arrives, not in a panel the user has
 * to find afterwards.
 *
 * The old flow let a character be created, sheeted and dressed — spending image
 * credits at each step — before anything asked about rights, and then failed at
 * video funding. Asking here costs the user nothing extra and removes that
 * wasted-spend window entirely.
 */
export function CharacterCreationAttestation({
  value,
  onChange,
  testId = "character-creation-attestation",
}: {
  value: CreationAttestationDraft;
  onChange: (next: CreationAttestationDraft) => void;
  testId?: string;
}) {
  const set = <K extends keyof CreationAttestationDraft>(
    key: K,
    next: CreationAttestationDraft[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div
      className="rounded-md border border-border bg-muted/20 p-3 space-y-3"
      data-testid={testId}
    >
      <div className="flex gap-2 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 text-primary" />
        <p>
          This photo shows a real person, so KOKAO records a likeness-rights attestation before
          creating the character. It is not tied to any one provider — you will be shown each
          provider that receives this likeness and can withdraw any of them individually.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">Subject of this photo</Label>
        <div className="flex gap-4">
          <Label className="flex items-center gap-2 text-xs font-normal cursor-pointer">
            <input
              type="radio"
              name={`${testId}-subject`}
              checked={value.subject === "self"}
              onChange={() => set("subject", "self")}
              className="accent-primary"
              data-testid={`${testId}-radio-self`}
            />
            This is my own face
          </Label>
          <Label className="flex items-center gap-2 text-xs font-normal cursor-pointer">
            <input
              type="radio"
              name={`${testId}-subject`}
              checked={value.subject === "authorized_person"}
              onChange={() => set("subject", "authorized_person")}
              className="accent-primary"
              data-testid={`${testId}-radio-authorized`}
            />
            Another person
          </Label>
        </div>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.imageRightsConfirmed}
            onCheckedChange={(c) => set("imageRightsConfirmed", !!c)}
            data-testid={`${testId}-chk-rights`}
          />
          <span className="text-xs leading-none mt-0.5">
            I confirm I have the right to upload and use this image.
          </span>
        </Label>
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.adultConfirmed}
            onCheckedChange={(c) => set("adultConfirmed", !!c)}
            data-testid={`${testId}-chk-adult`}
          />
          <span className="text-xs leading-none mt-0.5">
            I confirm the person in this image is an adult (18+).
          </span>
        </Label>
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.likenessConfirmed}
            onCheckedChange={(c) => set("likenessConfirmed", !!c)}
            data-testid={`${testId}-chk-likeness`}
          />
          <span className="text-xs leading-none mt-0.5">
            I explicitly authorize using this likeness in KOKAO.
          </span>
        </Label>
        {value.subject === "authorized_person" && (
          <Label className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              checked={value.writtenPermissionConfirmed}
              onCheckedChange={(c) => set("writtenPermissionConfirmed", !!c)}
              data-testid={`${testId}-chk-written`}
            />
            <span className="text-xs leading-none mt-0.5">
              I hold this person&apos;s written permission covering the uses I select below.
            </span>
          </Label>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <span className="text-xs font-medium block">Permitted uses — each is separate</span>
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.allowOutfitEdits}
            onCheckedChange={(c) => set("allowOutfitEdits", !!c)}
            data-testid={`${testId}-chk-outfit`}
          />
          <span className="text-xs leading-none mt-0.5">
            Allow AI outfit edits and wardrobe generation. Needed for the reference sheet.
          </span>
        </Label>
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.allowVideoDepiction}
            onCheckedChange={(c) => set("allowVideoDepiction", !!c)}
            data-testid={`${testId}-chk-video`}
          />
          <span className="text-xs leading-none mt-0.5">
            Allow this person to be depicted in generated video.
          </span>
        </Label>
        <Label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={value.allowScriptedSpeech}
            onCheckedChange={(c) => set("allowScriptedSpeech", !!c)}
            data-testid={`${testId}-chk-speech`}
          />
          <span className="text-xs leading-none mt-0.5">
            Allow lip-syncing to scripted speech or cloned voices.
          </span>
        </Label>
      </div>
    </div>
  );
}
