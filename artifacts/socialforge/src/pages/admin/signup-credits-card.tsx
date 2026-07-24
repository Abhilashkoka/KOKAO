import { useEffect, useState } from "react";
import {
  useAdminGetSignupCreditSettings,
  useAdminUpdateSignupCreditSettings,
  getAdminGetSignupCreditSettingsQueryKey,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Gift, BadgeCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

export function SignupCreditsCard() {
  const { data: settings, isLoading } = useAdminGetSignupCreditSettings();
  const updateSettings = useAdminUpdateSignupCreditSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [captions, setCaptions] = useState("0");
  const [images, setImages] = useState("0");
  const [videos, setVideos] = useState("0");

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setCaptions(String(settings.captionCredits));
    setImages(String(settings.imageCredits));
    setVideos(String(settings.videoCredits));
  }, [settings]);

  const handleSave = () => {
    const captionCredits = Math.max(0, Number(captions) || 0);
    const imageCredits = Math.max(0, Number(images) || 0);
    const videoCredits = Math.max(0, Number(videos) || 0);
    if (enabled && captionCredits === 0 && imageCredits === 0 && videoCredits === 0) {
      toast({
        title: "Add some credits",
        description:
          "The welcome bundle needs at least one caption, image, or video credit while it is on.",
        variant: "destructive",
      });
      return;
    }
    updateSettings.mutate(
      { data: { enabled, captionCredits, imageCredits, videoCredits } },
      {
        onSuccess: () => {
          toast({ title: "Signup credits saved" });
          queryClient.invalidateQueries({
            queryKey: getAdminGetSignupCreditSettingsQueryKey(),
          });
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
    <Card className="border-border shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-primary" /> Signup credits
        </CardTitle>
        <CardDescription>
          A welcome credit bundle granted automatically, exactly once, to every
          brand-new workspace at first sign-in. Existing workspaces are never
          granted retroactively.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                data-testid="switch-signup-credits"
              />
              <span className="text-sm">
                {enabled ? "Granting to new workspaces" : "Off"}
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="signup-captions">Caption credits</Label>
                <Input
                  id="signup-captions"
                  type="number"
                  min={0}
                  max={100000}
                  value={captions}
                  onChange={(e) => setCaptions(e.target.value)}
                  data-testid="input-signup-captions"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-images">Image credits</Label>
                <Input
                  id="signup-images"
                  type="number"
                  min={0}
                  max={100000}
                  value={images}
                  onChange={(e) => setImages(e.target.value)}
                  data-testid="input-signup-images"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-videos">Video credits</Label>
                <Input
                  id="signup-videos"
                  type="number"
                  min={0}
                  max={100000}
                  value={videos}
                  onChange={(e) => setVideos(e.target.value)}
                  data-testid="input-signup-videos"
                />
              </div>
            </div>
            <Button
              onClick={handleSave}
              disabled={updateSettings.isPending}
              data-testid="button-save-signup-credits"
            >
              {updateSettings.isPending ? "Saving..." : "Save"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SignupCreditsStatusCard() {
  const { data: settings, isLoading } = useAdminGetSignupCreditSettings();
  const updateSettings = useAdminUpdateSignupCreditSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleToggle = () => {
    if (!settings) return;
    const nextEnabled = !settings.enabled;
    if (
      nextEnabled &&
      settings.captionCredits === 0 &&
      settings.imageCredits === 0 &&
      settings.videoCredits === 0
    ) {
      toast({
        title: "Add some credits first",
        description:
          "Set at least one caption, image, or video credit in the Signup credits card before activating.",
        variant: "destructive",
      });
      return;
    }
    updateSettings.mutate(
      {
        data: {
          enabled: nextEnabled,
          captionCredits: settings.captionCredits,
          imageCredits: settings.imageCredits,
          videoCredits: settings.videoCredits,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: nextEnabled
              ? "Signup credits activated"
              : "Signup credits deactivated",
          });
          queryClient.invalidateQueries({
            queryKey: getAdminGetSignupCreditSettingsQueryKey(),
          });
        },
        onError: (error) =>
          toast({
            title: "Could not update",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card className="border-border shadow-sm" data-testid="card-signup-credits-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BadgeCheck className="h-5 w-5 text-primary" /> Welcome bundle status
        </CardTitle>
        <CardDescription>
          The currently saved welcome bundle. Activate or deactivate it here
          without changing the saved amounts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !settings ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                variant={settings.enabled ? "default" : "secondary"}
                data-testid="badge-signup-credits-status"
              >
                {settings.enabled ? "Active" : "Inactive"}
              </Badge>
              <span className="text-sm text-muted-foreground" data-testid="text-signup-credits-bundle">
                {settings.captionCredits} caption / {settings.imageCredits}{" "}
                image / {settings.videoCredits} video credits
              </span>
            </div>
            <Button
              variant={settings.enabled ? "outline" : "default"}
              onClick={handleToggle}
              disabled={updateSettings.isPending}
              data-testid="button-toggle-signup-credits"
            >
              {updateSettings.isPending ? (
                <>
                  <RippleSpinner className="mr-2 h-4 w-4" />
                  {settings.enabled ? "Deactivating..." : "Activating..."}
                </>
              ) : settings.enabled ? (
                "Deactivate"
              ) : (
                "Activate"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
