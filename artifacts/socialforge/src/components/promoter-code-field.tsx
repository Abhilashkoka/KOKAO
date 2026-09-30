import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, useAttachCreatorCode, getGetCreditsQueryKey } from "@workspace/api-client-react";
import type { AttachCreatorCode200 } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";

export function PromoterCodeField() {
  const { flags, isLoading } = useFeatureFlags();
  const { toast } = useToast();
  const client = useQueryClient();
  const attach = useAttachCreatorCode();
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<AttachCreatorCode200 | null>(null);
  const submit = () => {
    if (code.trim().length < 3) return;
    attach.mutate({ data: { code: code.trim() } }, {
      onSuccess: result => {
        setApplied(result);
        setCode("");
        void client.invalidateQueries({ queryKey: getGetCreditsQueryKey() });
        toast({ title: "Code applied", description: result.message });
      },
      onError: error => {
        const data: unknown = error instanceof ApiError ? error.data : null;
        const detail = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : error instanceof Error ? error.message : "Check the code and try again.";
        toast({ title: "Couldn't apply that code", description: detail, variant: "destructive" });
      },
    });
  };
  if (isLoading || !flags.creatorProgram) return null;
  if (applied) return <Card className="border-primary/20 bg-primary/[0.03]"><CardContent className="space-y-1 py-4"><p data-testid="promoter-code-applied" className="font-medium">{applied.code} applied</p><p className="text-sm text-muted-foreground">You'll get {applied.bonusBps / 100}% bonus credits on qualifying purchases during the attribution window, courtesy of {applied.promoter}. Bonus credits are added when you buy, not now.</p></CardContent></Card>;
  return <Card><CardContent className="space-y-2 py-4"><label htmlFor="promoter-code" className="text-sm font-medium">Have a promoter code?</label><div className="flex gap-2"><Input id="promoter-code" data-testid="input-promoter-code" className="font-mono" autoComplete="off" placeholder="KC-XXXXXXXX" value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === "Enter") submit(); }} /><Button data-testid="button-apply-promoter-code" disabled={code.trim().length < 3 || attach.isPending} onClick={submit}>{attach.isPending ? "Applying…" : "Apply"}</Button></div><p className="text-xs text-muted-foreground">Bonus credits are added when you buy, not now. Attaching a code grants no credits immediately.</p></CardContent></Card>;
}