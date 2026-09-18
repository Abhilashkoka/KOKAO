import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterLikenessConsent,
  useGrantCharacterLikenessConsent,
  useRevokeCharacterLikenessConsent,
  useAcknowledgeCharacterLikenessRecipient,
  useRevokeCharacterLikenessRecipient,
  getGetCharacterLikenessConsentQueryKey,
} from "@workspace/api-client-react";
import { getListCharactersQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertCircle, FileText, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function CharacterLikenessConsent({
  characterId,
  testId,
}: {
  characterId: number;
  testId?: string;
}) {
  const queryClient = useQueryClient();
  const { data: res, isLoading, error } = useGetCharacterLikenessConsent(characterId, {
    query: {
      queryKey: getGetCharacterLikenessConsentQueryKey(characterId),
    },
  });

  const data = res?.data;

  const grantConsent = useGrantCharacterLikenessConsent();
  const revokeConsent = useRevokeCharacterLikenessConsent();
  const acknowledgeRecipient = useAcknowledgeCharacterLikenessRecipient();
  const revokeRecipient = useRevokeCharacterLikenessRecipient();
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [subject, setSubject] = useState<"self" | "authorized_person">("self");
  const [imageRightsConfirmed, setImageRightsConfirmed] = useState(false);
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [likenessConfirmed, setLikenessConfirmed] = useState(false);
  const [writtenPermissionConfirmed, setWrittenPermissionConfirmed] = useState(false);
  
  const [allowOutfitEdits, setAllowOutfitEdits] = useState(false);
  const [allowVideoDepiction, setAllowVideoDepiction] = useState(false);
  const [allowScriptedSpeech, setAllowScriptedSpeech] = useState(false);

  const [grantError, setGrantError] = useState<string | null>(null);

  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Reset form when opening or data changes
  useEffect(() => {
    if (formOpen) {
      setSubject("self");
      setImageRightsConfirmed(false);
      setAdultConfirmed(false);
      setLikenessConfirmed(false);
      setWrittenPermissionConfirmed(false);
      setAllowOutfitEdits(false);
      setAllowVideoDepiction(false);
      setAllowScriptedSpeech(false);
      setGrantError(null);
    }
  }, [formOpen, data?.sourceSha256]);

  if (isLoading) return <div className="text-xs text-muted-foreground animate-pulse">Checking authorization status...</div>;
  if (error) return <div className="text-xs text-destructive">Failed to load authorization status.</div>;
  if (!data) return null;

  if (data.status === "not_required") {
    return null;
  }

  const handleGrant = () => {
    setGrantError(null);
    if (!data.sourceSha256) {
      setGrantError("Missing image reference to authorize.");
      return;
    }
    
    grantConsent.mutate({
      characterId,
      data: {
        sourceSha256: data.sourceSha256,
        policyVersion: data.policyVersion,
        subject,
        imageRightsConfirmed,
        adultConfirmed,
        likenessConfirmed,
        writtenPermissionConfirmed: subject === "authorized_person" ? writtenPermissionConfirmed : false,
        allowOutfitEdits,
        allowVideoDepiction,
        allowScriptedSpeech,
      },
    }, {
      onSuccess: () => {
        setFormOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetCharacterLikenessConsentQueryKey(characterId) });
        queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
        // The characters and provenance impact draft validity, but we don't know the draft ID here.
        // It's safest to invalidate the whole query cache or just let the user see it updated.
      },
      onError: (err) => {
        setGrantError(apiErrorMessage(err, "Could not grant authorization."));
      }
    });
  };

  const handleRevoke = () => {
    setRevokeError(null);
    revokeConsent.mutate({ characterId }, {
      onSuccess: () => {
        setRevokeDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetCharacterLikenessConsentQueryKey(characterId) });
        queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      },
      onError: (err) => {
        setRevokeError(apiErrorMessage(err, "Could not revoke authorization."));
      }
    });
  };

  const canSubmit = 
    imageRightsConfirmed && 
    adultConfirmed && 
    likenessConfirmed && 
    (subject === "self" || writtenPermissionConfirmed);

  const refreshConsent = () => {
    queryClient.invalidateQueries({ queryKey: getGetCharacterLikenessConsentQueryKey(characterId) });
    queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
  };

  // Acknowledging a newly routed provider is one click. The attestation covers
  // the depicted person and stays valid, so nothing is re-signed here.
  const handleAcknowledge = (entry: { provider: string; model: string; operation: string }) => {
    setRecipientError(null);
    acknowledgeRecipient.mutate({
      characterId,
      data: {
        consentId: data.consent?.id,
        provider: entry.provider,
        model: entry.model,
        operation: entry.operation as never,
      },
    }, {
      onSuccess: refreshConsent,
      onError: (err) => setRecipientError(apiErrorMessage(err, "Could not acknowledge this provider.")),
    });
  };

  const handleRevokeRecipient = (disclosureId: number) => {
    setRecipientError(null);
    revokeRecipient.mutate({ characterId, disclosureId }, {
      onSuccess: refreshConsent,
      onError: (err) => setRecipientError(apiErrorMessage(err, "Could not withdraw this provider.")),
    });
  };

  const activeConsent = data.status === "active";
  const staleConsent = data.status === "stale";
  const revokedConsent = data.status === "revoked";
  const needsRecipient = data.status === "needs_recipient_acknowledgement";
  const attested = activeConsent || needsRecipient;
  const pending = data.pendingRecipients ?? [];
  const recipients = data.recipients ?? [];

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3" data-testid={testId}>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
        <div>
          <h4 className="text-sm font-medium flex items-center gap-1.5">
            {activeConsent ? (
              <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Authorization recorded</>
            ) : needsRecipient ? (
              <><Info className="h-4 w-4 text-sky-500" /> New provider to confirm</>
            ) : staleConsent ? (
              <><AlertTriangle className="h-4 w-4 text-amber-500" /> Authorization stale</>
            ) : revokedConsent ? (
              <><AlertCircle className="h-4 w-4 text-destructive" /> Authorization revoked</>
            ) : (
              <><FileText className="h-4 w-4 text-muted-foreground" /> Likeness authorization</>
            )}
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {activeConsent
              ? "Explicit likeness permission is active for this uploaded origin."
              : needsRecipient
                ? "Your authorization still stands. One newly configured provider needs confirming before it receives this likeness."
                : staleConsent
                  ? "The character's image changed since you authorized it. Please authorize again."
                  : "Grant explicit permission to use this real person's likeness in AI generated videos."}
          </p>
        </div>
        
        <div className="flex gap-2 shrink-0">
          {!attested ? (
            <Button size="sm" onClick={() => setFormOpen(!formOpen)} data-testid={`${testId}-btn-open-grant`}>
              {formOpen ? "Cancel" : staleConsent ? "Re-authorize" : "Authorize"}
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setRevokeDialogOpen(true)} data-testid={`${testId}-btn-open-revoke`}>
              Revoke
            </Button>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="text-xs bg-sky-50 dark:bg-sky-950/20 p-2 rounded border border-sky-200 dark:border-sky-900 space-y-2">
          <span className="font-medium text-foreground">Providers awaiting your confirmation</span>
          <ul className="space-y-1.5">
            {pending.map((entry, i) => (
              <li key={i} className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">
                  {entry.scopeLabel}
                  {!entry.providerAccepts && entry.reason && (
                    <span className="block text-[11px] text-destructive mt-0.5">{entry.reason}</span>
                  )}
                </span>
                {entry.providerAccepts && attested && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] shrink-0"
                    disabled={acknowledgeRecipient.isPending}
                    onClick={() => handleAcknowledge(entry)}
                    data-testid={`${testId}-btn-ack-${entry.provider}-${entry.operation}`}
                  >
                    Confirm
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recipients.length > 0 && (
        <div className="text-xs bg-background p-2 rounded border border-border space-y-1.5">
          <span className="font-medium text-foreground">Providers that receive this likeness</span>
          <ul className="space-y-1.5">
            {recipients.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-2">
                <span className={entry.revokedAt ? "text-muted-foreground line-through" : "text-muted-foreground"}>
                  {entry.scopeLabel}
                </span>
                {entry.revokedAt ? (
                  <Badge variant="secondary" className="text-[10px] py-0 h-4 shrink-0">Withdrawn</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-destructive shrink-0"
                    disabled={revokeRecipient.isPending}
                    onClick={() => handleRevokeRecipient(entry.id)}
                    data-testid={`${testId}-btn-revoke-recipient-${entry.id}`}
                  >
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground pt-1 border-t border-border">
            Withdrawing one provider keeps your authorization intact.
          </p>
        </div>
      )}

      {recipientError && (
        <p className="text-xs text-destructive bg-destructive/10 p-2 rounded" role="alert" data-testid={`${testId}-recipient-error`}>
          {recipientError}
        </p>
      )}

      {data.eligibility.length > 0 && (
        <details className="text-xs bg-background rounded border border-border">
          <summary className="cursor-pointer p-2 font-medium text-foreground">
            Provider eligibility for this likeness
          </summary>
          <ul className="px-2 pb-2 space-y-1">
            {data.eligibility.map((el, i) => (
              <li key={i} className="flex justify-between items-start gap-2">
                <span className="text-muted-foreground">
                  {el.provider} ({el.surface})
                  {el.requiresVerifiedIdentity && (
                    <span className="block text-[11px]">Also needs this provider&apos;s own identity check.</span>
                  )}
                </span>
                <Badge
                  variant={el.status === "eligible" ? "default" : "secondary"}
                  className="text-[10px] py-0 h-4 shrink-0"
                >
                  {el.status === "eligible" ? "Eligible" :
                   el.status === "consent_required" ? "Requires authorization" :
                   el.status === "verification_required" ? "Source unverified" :
                   el.status === "provider_refused" ? "Refused by provider" :
                   "Unsupported"}
                </Badge>
              </li>
            ))}
          </ul>
        </details>
      )}

      {formOpen && !attested && (
        <div className="bg-background rounded-md border border-border p-3 space-y-4 animate-in slide-in-from-top-2">
          <div className="text-xs space-y-2 text-muted-foreground p-2 bg-muted/30 rounded border border-border">
            <div className="flex gap-2">
              <Info className="h-4 w-4 shrink-0 text-primary" />
              <p>
                <strong>Server Statement (v{data.policyVersion}):</strong> {data.statement}
              </p>
            </div>
            <p className="pl-6 text-[11px]">
              This authorization is not tied to one provider. You will be shown each provider that
              receives this likeness and can withdraw any of them individually.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Subject of this image</Label>
              <div className="flex gap-4">
                <Label className="flex items-center gap-2 text-xs font-normal cursor-pointer">
                  <input type="radio" name="subject" value="self" checked={subject === "self"} onChange={() => setSubject("self")} className="accent-primary" data-testid={`${testId}-radio-self`} />
                  This is my own face
                </Label>
                <Label className="flex items-center gap-2 text-xs font-normal cursor-pointer">
                  <input type="radio" name="subject" value="authorized_person" checked={subject === "authorized_person"} onChange={() => setSubject("authorized_person")} className="accent-primary" data-testid={`${testId}-radio-authorized`} />
                  Another person
                </Label>
              </div>
            </div>

            <div className="space-y-2 border-t border-border pt-3">
              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={imageRightsConfirmed} onCheckedChange={(c) => setImageRightsConfirmed(!!c)} data-testid={`${testId}-chk-rights`} />
                <span className="text-xs leading-none mt-0.5">I confirm I have the right to upload and use this image.</span>
              </Label>
              
              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={adultConfirmed} onCheckedChange={(c) => setAdultConfirmed(!!c)} data-testid={`${testId}-chk-adult`} />
                <span className="text-xs leading-none mt-0.5">I confirm the person in this image is an adult (18+).</span>
              </Label>
              
              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={likenessConfirmed} onCheckedChange={(c) => setLikenessConfirmed(!!c)} data-testid={`${testId}-chk-likeness`} />
                <span className="text-xs leading-none mt-0.5">I explicitly authorize using this likeness for AI video generation.</span>
              </Label>

              {subject === "authorized_person" && (
                <Label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox checked={writtenPermissionConfirmed} onCheckedChange={(c) => setWrittenPermissionConfirmed(!!c)} data-testid={`${testId}-chk-written`} />
                  <span className="text-xs leading-none mt-0.5">I hold written, explicit permission from this person to generate videos of their likeness.</span>
                </Label>
              )}
            </div>

            <div className="space-y-2 border-t border-border pt-3">
              <span className="text-xs font-medium block">
                Permitted uses — each is separate
              </span>

              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={allowOutfitEdits} onCheckedChange={(c) => setAllowOutfitEdits(!!c)} data-testid={`${testId}-chk-outfit`} />
                <span className="text-xs leading-none mt-0.5">Allow AI outfit edits and wardrobe generation for this likeness.</span>
              </Label>

              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={allowVideoDepiction} onCheckedChange={(c) => setAllowVideoDepiction(!!c)} data-testid={`${testId}-chk-video`} />
                <span className="text-xs leading-none mt-0.5">Allow this person to be depicted in generated video.</span>
              </Label>

              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={allowScriptedSpeech} onCheckedChange={(c) => setAllowScriptedSpeech(!!c)} data-testid={`${testId}-chk-speech`} />
                <span className="text-xs leading-none mt-0.5">Allow lip-syncing to scripted speech or cloned voices.</span>
              </Label>
            </div>
          </div>

          {grantError && (
            <p className="text-xs text-destructive bg-destructive/10 p-2 rounded" role="alert" data-testid={`${testId}-grant-error`}>
              {grantError}
            </p>
          )}

          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={handleGrant} disabled={!canSubmit || grantConsent.isPending} data-testid={`${testId}-btn-submit-grant`}>
              {grantConsent.isPending ? "Recording..." : "Record authorization"}
            </Button>
          </div>
        </div>
      )}

      {/* Revocation Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Authorization</DialogTitle>
            <DialogDescription>
              Are you sure you want to withdraw likeness permission for this character?
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm space-y-2 text-foreground">
            <p>Revoking this permission will:</p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>Prevent any future submission of this likeness to any provider.</li>
              <li>Mark the character as unauthorized in Video Studio.</li>
            </ul>
            <p className="text-amber-600 dark:text-amber-400 font-medium mt-2">
              Note: You cannot recall or delete videos that have already been generated and sent to the provider.
            </p>
            
            {revokeError && (
              <p className="text-xs text-destructive mt-2" role="alert" data-testid={`${testId}-revoke-error`}>
                {revokeError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)} disabled={revokeConsent.isPending}>
              Keep authorization
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={revokeConsent.isPending} data-testid={`${testId}-btn-submit-revoke`}>
              {revokeConsent.isPending ? "Revoking..." : "Revoke authorization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
