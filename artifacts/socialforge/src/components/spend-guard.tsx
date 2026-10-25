import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Coins } from "lucide-react";
import {
  CreditQuoteSummary,
  useCreditFunding,
  type CreditQuoteLineView,
} from "@/components/credit-balance";

/**
 * The spend guard: one big action is never charged on a single click.
 *
 * Every paid control already shows its price. Above the admin-set threshold —
 * an absolute number of credits, or a share of what the workspace holds — the
 * click opens a confirmation with the itemised quote first. This is the
 * opposite of "it deducted my credits without asking", which is the
 * complaint that sinks prepaid AI apps.
 */

export interface SpendGuardSettings {
  confirmAboveCredits: number;
  confirmAbovePercent: number;
}

/** Mirrors the server default in lib/creditRates.ts (DEFAULT_SPEND_GUARD). */
export const DEFAULT_SPEND_GUARD: SpendGuardSettings = {
  confirmAboveCredits: 100,
  confirmAbovePercent: 25,
};

/** Mirrors spendNeedsConfirmation() on the server. 0 = threshold off. */
export function needsSpendConfirmation(
  guard: SpendGuardSettings,
  quotedCredits: number,
  balance: number,
): boolean {
  if (!(quotedCredits > 0)) return false;
  if (guard.confirmAboveCredits > 0 && quotedCredits > guard.confirmAboveCredits) {
    return true;
  }
  return (
    guard.confirmAbovePercent > 0 &&
    balance > 0 &&
    (quotedCredits / balance) * 100 > guard.confirmAbovePercent
  );
}

export interface SpendQuote {
  credits: number;
  balance: number;
  balanceAfter: number;
  sufficient: boolean;
  lines?: CreditQuoteLineView[];
}

interface PendingSpend {
  quote: SpendQuote;
  actionLabel: string;
  onConfirm: () => void;
}

/**
 * Gate a paid action behind the spend guard.
 *
 * `guard(quote, label, run)` runs `run` straight away when the workspace is not
 * credit-funded, there is no quote, or the quote is under both thresholds;
 * otherwise it opens the confirmation and runs `run` only on "Spend". Render
 * `dialog` once anywhere in the component.
 */
export function useSpendConfirmation(): {
  guard: (quote: SpendQuote | null | undefined, actionLabel: string, run: () => void) => void;
  /** True when this quote must be confirmed before spending. */
  needsConfirm: (quote: SpendQuote | null | undefined) => boolean;
  /** Open the confirmation; `run` fires only on "Spend". */
  confirm: (quote: SpendQuote, actionLabel: string, run: () => void) => void;
  dialog: ReactNode;
} {
  const { creditFunded, credits } = useCreditFunding();
  const [pending, setPending] = useState<PendingSpend | null>(null);
  // A double click must not open two dialogs or run twice.
  const running = useRef(false);
  const settings: SpendGuardSettings = credits?.spendGuard ?? DEFAULT_SPEND_GUARD;

  const needsConfirm = useCallback(
    (quote: SpendQuote | null | undefined) =>
      creditFunded &&
      !!quote &&
      needsSpendConfirmation(settings, quote.credits, quote.balance),
    [creditFunded, settings],
  );

  const confirm = useCallback(
    (quote: SpendQuote, actionLabel: string, run: () => void) => {
      setPending({ quote, actionLabel, onConfirm: run });
    },
    [],
  );

  const guard = useCallback(
    (quote: SpendQuote | null | undefined, actionLabel: string, run: () => void) => {
      if (quote && needsConfirm(quote)) {
        confirm(quote, actionLabel, run);
        return;
      }
      run();
    },
    [needsConfirm, confirm],
  );

  const dialog = (
    <SpendConfirmDialog
      pending={pending}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        if (!pending || running.current) return;
        running.current = true;
        const run = pending.onConfirm;
        setPending(null);
        try {
          run();
        } finally {
          running.current = false;
        }
      }}
    />
  );

  return { guard, needsConfirm, confirm, dialog };
}

function SpendConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingSpend | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!pending) return null;
  const { quote, actionLabel } = pending;
  const credits = quote.credits.toFixed(quote.credits < 10 ? 1 : 0);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="dialog-spend-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-primary" /> Spend {credits} credits?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Nothing is charged until you confirm. If a step fails, its credits
            come back automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <CreditQuoteSummary
          credits={quote.credits}
          balanceAfter={quote.balanceAfter}
          sufficient={quote.sufficient}
          lines={quote.lines}
        />
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-spend-cancel">
            Not now
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={!quote.sufficient}
            data-testid="button-spend-confirm"
          >
            {actionLabel} · {credits} credits
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
