import { useEffect, useRef, useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { track, setConsentState } from "@/lib/analytics";
import { useLocation } from "wouter";
import {
  useGetMe,
  useGetConsent,
  useUpdateConsent,
  useDraftBrandKit,
  useCreateBrandKit,
  useCompleteOnboarding,
  useGenerateCaption,
  useCreateContent,
  getGetMeQueryKey,
  getGetConsentQueryKey,
  getListBrandKitsQueryKey,
  getListContentQueryKey,
  type BrandKitPayload,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import {
  Sparkles,
  MessageCircle,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Check,
} from "lucide-react";

const CONSENT_OPTIONS = [
  {
    key: "analytics" as const,
    label: "Usage analytics",
    description: "Pages visited, features used, and errors — helps us improve.",
  },
  {
    key: "deviceDetails" as const,
    label: "Device details",
    description: "Browser, operating system, and network type.",
  },
  {
    key: "locationCoarse" as const,
    label: "Approximate location",
    description: "City-level location from your network. No GPS.",
  },
  {
    key: "locationPrecise" as const,
    label: "Precise location",
    description: "Exact coordinates, only with your browser's permission.",
  },
];

/** The interview questions, asked one at a time like a conversation. */
const QUESTIONS = [
  {
    key: "name" as const,
    prompt: "First things first — what's your business or brand called?",
    placeholder: "e.g. Acme Coffee",
    multiline: false,
    required: true,
  },
  {
    key: "business" as const,
    prompt: "Nice to meet you! What do you do? A sentence or two is perfect.",
    placeholder: "e.g. We roast small-batch coffee and ship it across India.",
    multiline: true,
    required: true,
  },
  {
    key: "audience" as const,
    prompt: "Who are you trying to reach with your posts?",
    placeholder: "e.g. Young professionals who love specialty coffee.",
    multiline: true,
    required: true,
  },
  {
    key: "tone" as const,
    prompt: "Last one — how should your posts sound?",
    placeholder: "Pick one or describe it in your own words.",
    multiline: false,
    required: true,
  },
];

const TONE_CHIPS = ["Friendly", "Professional", "Playful", "Bold", "Inspiring"];

type AnswerKey = (typeof QUESTIONS)[number]["key"];

export function OnboardingWizard() {
  const [location, setLocation] = useLocation();
  const { data: me } = useGetMe();
  const { flags: featureFlags } = useFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const draftBrandKit = useDraftBrandKit();
  const createBrandKit = useCreateBrandKit();
  const completeOnboarding = useCompleteOnboarding();
  const updateConsent = useUpdateConsent();
  const generateCaption = useGenerateCaption();
  const createContent = useCreateContent();

  const [step, setStep] = useState<
    "consent" | "welcome" | "interview" | "creating"
  >("consent");
  const [consentFlags, setConsentFlags] = useState<Record<string, boolean>>({
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
  });
  const [consentBusy, setConsentBusy] = useState(false);
  const startedAtRef = useRef(Date.now());
  const startedTrackedRef = useRef(false);

  const [questionIdx, setQuestionIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<AnswerKey, string>>({
    name: "",
    business: "",
    audience: "",
    tone: "",
  });
  const [current, setCurrent] = useState("");
  /** What the "creating" screen is doing right now, shown as progress. */
  const [creatingStatus, setCreatingStatus] = useState("");

  const onAdminPage = location === "/admin" || location.startsWith("/admin/");
  const shouldShow = !!me && !me.brandOnboardingComplete && !onAdminPage;
  const { data: storedConsent } = useGetConsent({
    query: { queryKey: getGetConsentQueryKey(), enabled: shouldShow },
  });

  useEffect(() => {
    if (shouldShow && !startedTrackedRef.current) {
      startedTrackedRef.current = true;
      startedAtRef.current = Date.now();
      track("onboarding_started", { entry_point: "first_login" });
    }
  }, [shouldShow]);

  if (!shouldShow) return null;

  // Users who already answered the consent question skip straight to setup.
  const effectiveStep =
    step === "consent" && storedConsent?.responded ? "welcome" : step;

  const handleConsentContinue = () => {
    setConsentBusy(true);
    updateConsent.mutate(
      { data: consentFlags },
      {
        onSuccess: () => {
          // Sync the tracker's consent state IMMEDIATELY. Relying only on the
          // query invalidation leaves a refetch-latency window during which
          // track() still sees the pre-response default (analytics: false)
          // and silently drops events — e.g. onboarding_skipped when the
          // user clicks "Skip for now" right after Continue.
          setConsentState(
            {
              analytics: consentFlags.analytics ?? false,
              deviceDetails: consentFlags.deviceDetails ?? false,
              locationCoarse: consentFlags.locationCoarse ?? false,
              locationPrecise: consentFlags.locationPrecise ?? false,
              carrier: false,
              responded: true,
            },
            true,
          );
          queryClient.invalidateQueries({
            queryKey: getGetConsentQueryKey(),
          });
          setConsentBusy(false);
          setStep("welcome");
        },
        onError: () => {
          setConsentBusy(false);
          toast({
            title: "Could not save your choices",
            description: "You can change them anytime in Settings.",
            variant: "destructive",
          });
          setStep("welcome");
        },
      },
    );
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
  };

  const finish = (skipped: boolean, destination?: string) => {
    completeOnboarding.mutate(
      { data: { skipped } },
      {
        onSuccess: () => {
          if (!skipped) {
            track("onboarding_completed", {
              completion_time_sec: Math.round(
                (Date.now() - startedAtRef.current) / 1000,
              ),
            });
          }
          refresh();
          // First-time users land where their first content lives (unless
          // the AI studio feature is off).
          if (featureFlags.aiStudio) {
            setLocation(destination ?? "/studio");
          }
        },
        onError: () =>
          toast({ title: "Could not finish setup", variant: "destructive" }),
      },
    );
  };

  const handleSkip = (stage: string) => {
    track("onboarding_skipped", { stage });
    finish(true);
  };

  const question = QUESTIONS[Math.min(questionIdx, QUESTIONS.length - 1)]!;

  const submitAnswer = (value: string) => {
    const trimmed = value.trim();
    if (question.required && !trimmed) return;
    const nextAnswers = { ...answers, [question.key]: trimmed };
    setAnswers(nextAnswers);
    track("onboarding_question_answered", {
      question: question.key,
      step_index: questionIdx,
    });
    if (questionIdx < QUESTIONS.length - 1) {
      setQuestionIdx(questionIdx + 1);
      setCurrent(nextAnswers[QUESTIONS[questionIdx + 1]!.key] ?? "");
    } else {
      void runSetup(nextAnswers);
    }
  };

  const goBack = () => {
    if (questionIdx === 0) return;
    setQuestionIdx(questionIdx - 1);
    setCurrent(answers[QUESTIONS[questionIdx - 1]!.key] ?? "");
  };

  /**
   * Turn the interview answers into a Brand Kit and a first draft post.
   * Every stage degrades gracefully: an AI draft failure falls back to a
   * blank kit, and a post-generation failure (e.g. no funding) still leaves
   * the user with their brand and a pointer to the Studio.
   */
  const runSetup = async (a: Record<AnswerKey, string>) => {
    setStep("creating");
    track("onboarding_interview_completed");

    // 1) Brand Kit drafted from the interview answers.
    setCreatingStatus("Building your Brand Kit…");
    let payload: BrandKitPayload | null = null;
    try {
      const draft = await draftBrandKit.mutateAsync({
        data: {
          brandName: a.name,
          notes: [
            `What the business does: ${a.business}`,
            `Target audience: ${a.audience}`,
            `Preferred tone of voice: ${a.tone}`,
          ].join("\n"),
        },
      });
      payload = draft.payload;
    } catch {
      // Blank kit fallback — the user can refine it later.
    }

    let brandKitId: number | null = null;
    try {
      const kit = await createBrandKit.mutateAsync({
        data: {
          name: a.name,
          brandType: "primary",
          isDefault: true,
          payload,
        },
      });
      brandKitId = kit.id;
      track("onboarding_brand_kit_created", { ai_drafted: payload !== null });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title:
          status === 402 ? "Plan limit reached" : "Could not create your brand",
        description: "You can set up a Brand Kit anytime from the Brand page.",
        variant: "destructive",
      });
      finish(false);
      return;
    }

    // 2) First draft post, written in their voice and saved to the Library.
    setCreatingStatus("Writing your first post…");
    try {
      const result = await generateCaption.mutateAsync({
        data: {
          prompt:
            `An introduction post for ${a.name}. ` +
            `About the business: ${a.business} ` +
            `The audience: ${a.audience}. ` +
            `Introduce the brand and invite people to follow for more.`,
          platform: "instagram",
          tone: a.tone,
          brandKitId,
        },
      });
      if (!result.caption) {
        // The model asked clarifying questions instead — nothing was charged.
        throw new Error("caption_empty");
      }
      track("caption_generated", { source: "onboarding", platform: "instagram" });

      setCreatingStatus("Saving it to your Library…");
      const captionWithTags = result.hashtags.length
        ? `${result.caption}\n\n${result.hashtags.join(" ")}`
        : result.caption;
      await createContent.mutateAsync({
        data: {
          title: result.title?.trim() || `${a.name} — introduction post`,
          caption: captionWithTags,
          platform: "instagram",
          status: "draft",
          brandKitId,
        },
      });
      track("content_saved", { source: "onboarding" });
      track("onboarding_first_post_generated");

      toast({
        title: "Your first post is ready",
        description: "We saved a draft in your Library — edit or publish it anytime.",
      });
      finish(false, "/library");
    } catch {
      track("onboarding_first_post_failed");
      toast({
        title: "Brand created",
        description:
          "We couldn't draft your first post right now — head to the Studio to create one.",
      });
      finish(false, "/studio");
    }
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[520px]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {effectiveStep === "consent" ? (
          <div className="py-2 space-y-5">
            <div className="space-y-2 text-center">
              <div className="mx-auto h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-bold tracking-tight">
                Your data, your choice
              </h2>
              <p className="text-sm text-muted-foreground">
                KOKAO can collect some usage data to improve the product.
                Everything is optional and off by default. You can change these
                anytime under Settings, and saying no never limits what you can
                do.
              </p>
            </div>
            <div className="space-y-3 max-h-[45vh] overflow-y-auto px-1">
              {CONSENT_OPTIONS.map((opt) => (
                <div
                  key={opt.key}
                  className="flex items-start justify-between gap-4 rounded-lg border border-border p-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {opt.description}
                    </p>
                  </div>
                  <Switch
                    checked={consentFlags[opt.key] ?? false}
                    onCheckedChange={(v) =>
                      setConsentFlags((prev) => ({ ...prev, [opt.key]: v }))
                    }
                    aria-label={opt.label}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-1">
              <Button onClick={handleConsentContinue} disabled={consentBusy}>
                {consentBusy ? (
                  <RippleSpinner className="mr-2 h-4 w-4" />
                ) : (
                  <ArrowRight className="mr-2 h-4 w-4" />
                )}
                Continue
              </Button>
            </div>
          </div>
        ) : effectiveStep === "welcome" ? (
          <div className="text-center py-4 space-y-5">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-7 w-7 text-primary" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-extrabold tracking-tight">
                Welcome to KOKAO
              </h2>
              <p className="text-muted-foreground">
                Answer four quick questions about your business and we'll set
                up your Brand Kit and write your first post — ready to edit
                and publish.
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <Button size="lg" onClick={() => setStep("interview")}>
                <MessageCircle className="mr-2 h-4 w-4" /> Let's do it
              </Button>
              <Button
                variant="ghost"
                onClick={() => handleSkip("welcome")}
                disabled={completeOnboarding.isPending}
              >
                {completeOnboarding.isPending ? (
                  <RippleSpinner className="mr-2 h-4 w-4" />
                ) : null}
                Skip for now
              </Button>
            </div>
          </div>
        ) : effectiveStep === "interview" ? (
          <div className="py-2 space-y-5">
            <div className="flex items-center gap-2">
              {QUESTIONS.map((q, i) => (
                <div
                  key={q.key}
                  className={`h-1.5 flex-1 rounded-full ${
                    i <= questionIdx ? "bg-primary" : "bg-muted"
                  }`}
                />
              ))}
            </div>

            <div className="space-y-3 max-h-[45vh] overflow-y-auto px-1">
              {/* Answered questions, shown like a conversation. */}
              {QUESTIONS.slice(0, questionIdx).map((q) => (
                <div key={q.key} className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{q.prompt}</p>
                  <div className="inline-flex items-start gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm">
                    <Check className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
                    <span className="whitespace-pre-wrap">{answers[q.key]}</span>
                  </div>
                </div>
              ))}

              <div className="space-y-2">
                <p className="text-base font-semibold">{question.prompt}</p>
                {question.key === "tone" ? (
                  <div className="flex flex-wrap gap-2 pb-1">
                    {TONE_CHIPS.map((chip) => (
                      <Button
                        key={chip}
                        type="button"
                        variant={current === chip ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrent(chip)}
                      >
                        {chip}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {question.multiline ? (
                  <Textarea
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    placeholder={question.placeholder}
                    className="resize-none"
                    autoFocus
                  />
                ) : (
                  <Input
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    placeholder={question.placeholder}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitAnswer(current);
                    }}
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-1">
                {questionIdx > 0 ? (
                  <Button variant="ghost" size="sm" onClick={goBack}>
                    <ArrowLeft className="mr-1 h-4 w-4" /> Back
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSkip(`question_${question.key}`)}
                >
                  Skip for now
                </Button>
              </div>
              <Button
                onClick={() => submitAnswer(current)}
                disabled={question.required && !current.trim()}
              >
                {questionIdx === QUESTIONS.length - 1 ? (
                  <Sparkles className="mr-2 h-4 w-4" />
                ) : (
                  <ArrowRight className="mr-2 h-4 w-4" />
                )}
                {questionIdx === QUESTIONS.length - 1
                  ? "Create my brand & first post"
                  : "Next"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 space-y-4">
            <RippleSpinner className="mx-auto h-8 w-8" />
            <div className="space-y-1">
              <h2 className="text-lg font-bold tracking-tight">
                Setting things up
              </h2>
              <p className="text-sm text-muted-foreground">{creatingStatus}</p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
