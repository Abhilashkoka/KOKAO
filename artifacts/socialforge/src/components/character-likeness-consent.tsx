import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCharacterLikenessConsent,
  useGrantCharacterLikenessConsent,
  useRevokeCharacterLikenessConsent,
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

  const [formOpen, setFormOpen] = useState(false);
  const [subject, setSubject] = useState<"self" | "authorized_person">("self");
  const [imageRightsConfirmed, setImageRightsConfirmed] = useState(false);
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [likenessConfirmed, setLikenessConfirmed] = useState(false);
  const [writtenPermissionConfirmed, setWrittenPermissionConfirmed] = useState(false);
  
  const [allowOutfitEdits, setAllowOutfitEdits] = useState(false);
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
        allowScriptedSpeech,
        providers: ["atlascloud"],
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

  const activeConsent = data.status === "active";
  const staleConsent = data.status === "stale";
  const revokedConsent = data.status === "revoked";

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3" data-testid={testId}>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
        <div>
          <h4 className="text-sm font-medium flex items-center gap-1.5">
            {activeConsent ? (
              <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Authorization recorded</>
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
              : staleConsent
                ? "The character's image changed since you authorized it. Please authorize again."
                : "Grant explicit permission to use this real person's likeness in AI generated videos."}
          </p>
        </div>
        
        <div className="flex gap-2 shrink-0">
          {!activeConsent ? (
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

      {data.eligibility.length > 0 && (
        <div className="text-xs bg-background p-2 rounded border border-border">
          <span className="font-medium text-foreground">Video model eligibility:</span>
          <ul className="mt-1 space-y-1">
            {data.eligibility.map((el, i) => (
              <li key={i} className="flex justify-between items-start">
                <span className="text-muted-foreground">
                  {el.provider === 'atlascloud' ? 'Wan (Atlas)' : el.provider} - {el.modelFamily}:
                </span>
                <Badge variant={el.status === 'eligible' ? 'default' : 'secondary'} className="text-[10px] py-0 h-4">
                  {el.status === 'eligible' ? 'Eligible' : 
                   el.status === 'consent_required' ? 'Requires authorization' :
                   el.status === 'verification_required' ? 'Requires BytePlus verification' :
                   'Unsupported'}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {formOpen && !activeConsent && (
        <div className="bg-background rounded-md border border-border p-3 space-y-4 animate-in slide-in-from-top-2">
          <div className="text-xs space-y-2 text-muted-foreground p-2 bg-muted/30 rounded border border-border">
            <div className="flex gap-2">
              <Info className="h-4 w-4 shrink-0 text-primary" />
              <p>
                <strong>Server Statement (v{data.policyVersion}):</strong> {data.statement}
              </p>
            </div>
            <p className="pl-6 text-[11px]">Provider: <strong>Wan via atlascloud</strong> (Seedance uses separate BytePlus liveness)</p>
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
              <span className="text-xs font-medium block">Additional Scopes (Optional)</span>
              
              <Label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={allowOutfitEdits} onCheckedChange={(c) => setAllowOutfitEdits(!!c)} data-testid={`${testId}-chk-outfit`} />
                <span className="text-xs leading-none mt-0.5">Allow AI outfit edits and wardrobe generation for this likeness.</span>
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
              <li>Prevent any future AI video generation for this character using the Wan provider.</li>
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
