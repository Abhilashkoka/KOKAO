import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateAiErrorClaim,
  useGetVideoJobErrorClaim,
  useGetVideoJobGoodwill,
  getGetVideoJobErrorClaimQueryKey,
  getGetVideoJobGoodwillQueryKey,
  getGetVideoJobCreditReceiptQueryKey,
  type AiErrorClaim,
  type AiErrorClaimInputCategory,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { ShieldAlert } from "lucide-react";

const storage = (path: string) => `/api/storage${path}`;

export const CLAIM_CATEGORY_LABELS: Record<AiErrorClaimInputCategory, string> = {
  product_changed: "My product or outfit was changed",
  script_missed: "A script line was skipped or changed",
  wrong_person: "Wrong face or person",
  garbled_text: "On-screen text is garbled",
  other: "Something else",
};

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/** One line for an existing claim: refunded, under review, or not approved. */
export function claimStatusText(claim: AiErrorClaim): string {
  if (claim.status === "approved") {
    return claim.creditsRefunded > 0
      ? `Refunded ${fmt(claim.creditsRefunded)} credits for the AI error.`
      : "Claim approved.";
  }
  if (claim.status === "rejected") {
    return `Claim not approved${claim.decisionNote ? `: ${claim.decisionNote}` : "."}`;
  }
  return "Your AI error claim is under review. We'll refund the credits if it's approved.";
}

/**
 * AI Error Guarantee on a finished video.
 *
 * Fix first: most mistakes are cheaper to fix than to refund, and the user
 * ends up with a usable video. Only if they'd rather not, they mark the part
 * that's wrong and claim credits back for that share of what the video cost.
 */
export function ReportAiError({
  jobId,
  videoPath,
  onOpenSmartEdit,
}: {
  jobId: number;
  videoPath: string;
  onOpenSmartEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: eligibility } = useGetVideoJobErrorClaim(jobId, {
    query: { queryKey: getGetVideoJobErrorClaimQueryKey(jobId), staleTime: 30_000 },
  });
  const { data: goodwill } = useGetVideoJobGoodwill(jobId, {
    query: { queryKey: getGetVideoJobGoodwillQueryKey(jobId), staleTime: 30_000 },
  });
  const create = useCreateAiErrorClaim();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"fix" | "claim">("fix");
  const [category, setCategory] = useState<AiErrorClaimInputCategory>("product_changed");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("3");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claim = eligibility?.claim ?? null;
  if (claim) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="text-ai-error-claim-status">
        {claimStatusText(claim)}
      </p>
    );
  }
  if (!eligibility?.eligible) return null;

  const freeFix = Boolean(goodwill?.active && goodwill.smartEditFreeAvailable);
  const mark = (which: "start" | "end") => {
    const t = videoRef.current?.currentTime ?? 0;
    if (which === "start") setStart(t.toFixed(1));
    else setEnd(t.toFixed(1));
  };

  const submit = () => {
    setError(null);
    const startSec = Number(start);
    const endSec = Number(end);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < 0.5) {
      setError("Mark where the problem starts and ends (at least half a second).");
      return;
    }
    create.mutate(
      { jobId, data: { category, startSec, endSec, note: note.trim() || undefined } },
      {
        onSuccess: (filed) => {
          setOpen(false);
          void queryClient.invalidateQueries({ queryKey: getGetVideoJobErrorClaimQueryKey(jobId) });
          void queryClient.invalidateQueries({ queryKey: getGetVideoJobCreditReceiptQueryKey(jobId) });
          refreshCreditBalanceSafely(queryClient);
          toast({
            title: filed.status === "approved" ? "Credits refunded" : "Claim sent for review",
            description: claimStatusText(filed),
          });
        },
        onError: (cause) => setError(apiErrorMessage(cause, "Could not send the claim. Please try again.")),
      },
    );
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setStep("fix");
          setError(null);
          setOpen(true);
        }}
        data-testid="button-report-ai-error"
      >
        <ShieldAlert className="h-4 w-4 mr-2" /> Report AI error
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg" data-testid="dialog-report-ai-error">
          <DialogHeader>
            <DialogTitle>Did the AI get something wrong?</DialogTitle>
            <DialogDescription>
              The AI Error Guarantee: within {eligibility.windowDays} days, you can get
              credits back for the part of this video the AI got wrong.
            </DialogDescription>
          </DialogHeader>

          {step === "fix" ? (
            <div className="space-y-3 text-sm">
              <p>
                Most mistakes can be fixed in a few seconds with Smart Edit, and you keep a
                usable video.
                {freeFix && (
                  <strong className="text-foreground">
                    {" "}Your first {goodwill!.smartEditFreeSeconds}s of edits on this video are free.
                  </strong>
                )}
              </p>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setStep("claim")} data-testid="button-ai-error-claim-instead">
                  Request a credit refund instead
                </Button>
                <Button
                  onClick={() => {
                    setOpen(false);
                    onOpenSmartEdit();
                  }}
                  data-testid="button-ai-error-fix"
                >
                  {freeFix ? "Fix it free in Smart Edit" : "Fix it in Smart Edit"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="space-y-1.5">
                <Label>What went wrong?</Label>
                <div className="space-y-1.5">
                  {(Object.keys(CLAIM_CATEGORY_LABELS) as AiErrorClaimInputCategory[]).map((key) => (
                    <label key={key} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="ai-error-category"
                        checked={category === key}
                        onChange={() => setCategory(key)}
                        data-testid={`radio-ai-error-${key}`}
                      />
                      {CLAIM_CATEGORY_LABELS[key]}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Where is it? Play to the spot and mark it.</Label>
                <video
                  ref={videoRef}
                  src={storage(videoPath)}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-56 w-full rounded-md bg-black"
                  data-testid="video-ai-error"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                        inputMode="decimal"
                        aria-label="Problem starts at (seconds)"
                        data-testid="input-ai-error-start"
                      />
                      <Button type="button" size="sm" variant="outline" onClick={() => mark("start")}>
                        Start here
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                        inputMode="decimal"
                        aria-label="Problem ends at (seconds)"
                        data-testid="input-ai-error-end"
                      />
                      <Button type="button" size="sm" variant="outline" onClick={() => mark("end")}>
                        End here
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  The refund is that share of what this video cost. Small, clear errors are
                  refunded straight away; others are checked by our team.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-error-note">
                  Details {category === "other" ? "(required)" : "(optional)"}
                </Label>
                <Textarea
                  id="ai-error-note"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. The saree border changed colour in this part."
                  data-testid="input-ai-error-note"
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert" data-testid="error-ai-error-claim">
                  {error}
                </p>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="ghost" onClick={() => setStep("fix")}>Back</Button>
                <Button onClick={submit} disabled={create.isPending} data-testid="button-ai-error-submit">
                  {create.isPending ? "Sending…" : "Claim credits back"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
