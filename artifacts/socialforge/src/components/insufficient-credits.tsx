import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Coins } from "lucide-react";
import { useLocation } from "wouter";

/**
 * What a workspace sees when it runs out of credits.
 *
 * The failure mode this exists to prevent is a generic "something went wrong",
 * which tells someone they have a problem without telling them how big it is
 * or what to do. A prepaid balance needs the opposite: the exact shortfall and
 * a way to fix it in the same breath, at the moment intent is highest.
 */

export interface CreditShortfall {
  code: "insufficient_credits";
  error: string;
  required: number;
  available: number;
  shortfall: number;
}

/**
 * Recognise the API's 402 body.
 *
 * Both the whole-job preflight and the meter's own mid-flight refusal emit the
 * same shape, so a shortfall that could not be predicted — a retry, a scene
 * the plan did not account for — reaches the user looking identical to one
 * that could.
 */
export function asCreditShortfall(error: unknown): CreditShortfall | null {
  const body = (error as { body?: unknown; response?: { data?: unknown } })?.body ??
    (error as { response?: { data?: unknown } })?.response?.data ??
    error;
  if (
    body &&
    typeof body === "object" &&
    (body as { code?: string }).code === "insufficient_credits" &&
    typeof (body as { required?: unknown }).required === "number"
  ) {
    return body as CreditShortfall;
  }
  return null;
}

function fmt(credits: number): string {
  return credits.toFixed(credits < 10 ? 1 : 0);
}

export function InsufficientCreditsDialog({
  shortfall,
  onClose,
}: {
  shortfall: CreditShortfall | null;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  const lines = useMemo(() => {
    if (!shortfall) return null;
    return {
      required: fmt(shortfall.required),
      available: fmt(shortfall.available),
      needed: fmt(shortfall.shortfall),
    };
  }, [shortfall]);

  if (!shortfall || !lines) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dialog-insufficient-credits">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-primary" /> You need more credits
          </DialogTitle>
          <DialogDescription>
            This one needs{" "}
            <strong className="text-foreground">{lines.required} credits</strong>{" "}
            and you have{" "}
            <strong className="text-foreground">{lines.available}</strong>. Top
            up {lines.needed} more and it will run straight away — nothing you
            set up is lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} data-testid="button-credits-cancel">
            Not now
          </Button>
          <Button
            onClick={() => {
              onClose();
              navigate("/billing");
            }}
            data-testid="button-credits-topup"
          >
            Top up credits
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
