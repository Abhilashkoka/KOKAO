import { useState } from "react";
import {
  useAttachCreatorCode,
  getGetCreditsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Check, Tag } from "lucide-react";

/**
 * Buyer-side promoter code entry. Drop this onto the credits / billing page,
 * above the pack selector.
 *
 * Applying a code grants nothing immediately — that is the whole point of the
 * purchase-triggered design — so the copy has to be honest about when the bonus
 * lands, or the user reads the silence as a bug.
 */
export function PromoterCodeField() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const attach = useAttachCreatorCode();
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<{
    code: string;
    promoter: string;
    bonusBps: number;
  } | null>(null);

  const submit = () => {
    const trimmed = code.trim();
    if (trimmed.length < 3) return;
    attach.mutate(
      { data: { code: trimmed } },
      {
        onSuccess: (result: any) => {
          setApplied({
            code: result.code,
            promoter: result.promoter,
            bonusBps: result.bonusBps,
          });
          setCode("");
          void queryClient.invalidateQueries({
            queryKey: getGetCreditsQueryKey(),
          });
          toast({ title: "Code applied", description: result.message });
        },
        onError: (err: any) =>
          toast({
            title: "Couldn't apply that code",
            description: err?.message || "Check the spelling and try again.",
            variant: "destructive",
          }),
      },
    );
  };

  if (applied) {
    return (
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardContent className="flex items-start gap-2.5 py-3.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-0.5 text-sm">
            <p className="font-medium" data-testid="promoter-code-applied">
              {applied.code} applied
            </p>
            <p className="text-muted-foreground">
              You'll get {(applied.bonusBps / 100).toLocaleString()}% bonus
              credits on this purchase, courtesy of {applied.promoter}.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-2 py-3.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Tag className="h-3.5 w-3.5 text-muted-foreground" />
          Have a promoter code?
        </div>
        <div className="flex gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="KC-XXXXXXXX"
            className="font-mono tracking-wider"
            autoComplete="off"
            data-testid="input-promoter-code"
          />
          <Button
            variant="secondary"
            disabled={code.trim().length < 3 || attach.isPending}
            onClick={submit}
            data-testid="button-apply-promoter-code"
          >
            {attach.isPending ? "Applying…" : "Apply"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bonus credits are added when you buy, not now.
        </p>
      </CardContent>
    </Card>
  );
}
