import { useState } from "react";
import {
  useGetTasteProfile,
  useUpdateTasteProfile,
  useClearTasteProfile,
  getGetTasteProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Brain } from "lucide-react";

export function TasteMemorySettings() {
  const { data: profile, isLoading } = useGetTasteProfile();
  const updateProfile = useUpdateTasteProfile();
  const clearProfile = useClearTasteProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [clearOpen, setClearOpen] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetTasteProfileQueryKey() });

  if (isLoading) {
    return <Skeleton className="h-[300px] w-full rounded-xl" />;
  }

  const totalSignals = profile
    ? profile.signalCounts.saved +
      profile.signalCounts.scheduled +
      profile.signalCounts.published +
      profile.signalCounts.discarded
    : 0;

  const learned: string[] = [];
  if (profile?.captionLength === "short") learned.push("Prefers short, punchy captions");
  if (profile?.captionLength === "medium") learned.push("Prefers medium-length captions");
  if (profile?.captionLength === "long") learned.push("Prefers longer, storytelling captions");
  if (profile?.hashtagStyle) learned.push(`Hashtags: ${profile.hashtagStyle}`);
  if (profile?.emojiStyle) learned.push(`Emojis: ${profile.emojiStyle}`);

  return (
    <Card className="border-border shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" /> Style memory
            </CardTitle>
            <CardDescription className="mt-1.5">
              KOKAO learns your style from what you save, schedule, publish, and
              discard, then quietly nudges future generations toward it. Your
              brand kit and your prompt always take priority.
            </CardDescription>
          </div>
          <Switch
            checked={profile?.enabled ?? true}
            disabled={updateProfile.isPending}
            onCheckedChange={(enabled) => {
              updateProfile.mutate(
                { data: { enabled } },
                {
                  onSuccess: () => {
                    refresh();
                    toast({
                      title: enabled ? "Style memory on" : "Style memory off",
                      description: enabled
                        ? "Future generations will use your learned preferences."
                        : "Learning is paused and preferences are not applied. Nothing is deleted.",
                    });
                  },
                  onError: () =>
                    toast({ title: "Failed to update", variant: "destructive" }),
                },
              );
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!profile?.hasData ? (
          <p className="text-sm text-muted-foreground">
            Nothing learned yet. As you save, schedule, publish, or discard
            content, your preferences will show up here.
          </p>
        ) : (
          <>
            {learned.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">What KOKAO has learned</h4>
                <ul className="space-y-1.5">
                  {learned.map((item) => (
                    <li key={item} className="text-sm text-muted-foreground">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {learned.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Still learning — no strong preferences detected yet. Keep saving
                and publishing content you like.
              </p>
            )}
            {profile.approvedExamples.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Recent approved captions used as style reference</h4>
                <ul className="space-y-2">
                  {profile.approvedExamples.map((text, i) => (
                    <li
                      key={i}
                      className="text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2 line-clamp-2"
                    >
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Based on {totalSignals} signal{totalSignals === 1 ? "" : "s"}:{" "}
              {profile.signalCounts.published} published, {profile.signalCounts.scheduled}{" "}
              scheduled, {profile.signalCounts.saved} saved, {profile.signalCounts.discarded}{" "}
              discarded.
            </div>
            <div className="pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClearOpen(true)}
                disabled={clearProfile.isPending}
              >
                Clear learned preferences
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear style memory?</DialogTitle>
            <DialogDescription>
              This permanently removes everything KOKAO has learned about your
              style. Learning starts over from your next save or publish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={clearProfile.isPending}
              onClick={() => {
                clearProfile.mutate(undefined, {
                  onSuccess: () => {
                    refresh();
                    setClearOpen(false);
                    toast({ title: "Style memory cleared" });
                  },
                  onError: () =>
                    toast({ title: "Failed to clear", variant: "destructive" }),
                });
              }}
            >
              Clear everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
