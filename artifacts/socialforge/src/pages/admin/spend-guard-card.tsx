import { useEffect, useState } from "react";
import {
  useAdminGetCreditSpendGuard,
  useAdminUpdateCreditSpendGuard,
  getAdminGetCreditSpendGuardQueryKey,
  getGetCreditsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/**
 * Superadmin control for when a paid action must be confirmed before any
 * credit is spent. Users see the price on every paid button either way; this
 * decides when a click becomes "are you sure?".
 */
export function SpendGuardCard() {
  const { data: guard, isLoading } = useAdminGetCreditSpendGuard();
  const update = useAdminUpdateCreditSpendGuard();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [credits, setCredits] = useState("100");
  const [percent, setPercent] = useState("25");

  useEffect(() => {
    if (!guard) return;
    setCredits(String(guard.confirmAboveCredits));
    setPercent(String(guard.confirmAbovePercent));
  }, [guard]);

  const save = () => {
    const confirmAboveCredits = Math.trunc(Number(credits));
    const confirmAbovePercent = Math.trunc(Number(percent));
    if (
      !Number.isFinite(confirmAboveCredits) ||
      confirmAboveCredits < 0 ||
      !Number.isFinite(confirmAbovePercent) ||
      confirmAbovePercent < 0 ||
      confirmAbovePercent > 100
    ) {
      toast({
        title: "Check the numbers",
        description: "Credits must be 0 or more, and percent 0–100.",
        variant: "destructive",
      });
      return;
    }
    update.mutate(
      { data: { confirmAboveCredits, confirmAbovePercent } },
      {
        onSuccess: () => {
          toast({ title: "Spend guard saved" });
          queryClient.invalidateQueries({
            queryKey: getAdminGetCreditSpendGuardQueryKey(),
          });
          queryClient.invalidateQueries({ queryKey: getGetCreditsQueryKey() });
        },
        onError: (error) =>
          toast({
            title: "Could not save",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card className="border-border shadow-sm" data-testid="card-spend-guard">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Spend guard
        </CardTitle>
        <CardDescription>
          One action quoted above either threshold asks the user to confirm the
          itemised price before anything is charged. Set a threshold to 0 to
          switch it off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="spend-guard-credits">Confirm above (credits)</Label>
                <Input
                  id="spend-guard-credits"
                  type="number"
                  min={0}
                  value={credits}
                  onChange={(e) => setCredits(e.target.value)}
                  data-testid="input-spend-guard-credits"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="spend-guard-percent">Confirm above (% of balance)</Label>
                <Input
                  id="spend-guard-percent"
                  type="number"
                  min={0}
                  max={100}
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  data-testid="input-spend-guard-percent"
                />
              </div>
            </div>
            <Button
              onClick={save}
              disabled={update.isPending}
              data-testid="button-save-spend-guard"
            >
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
