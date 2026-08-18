import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
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

import { Button, Chip, Input } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { track, setConsentState } from "@/lib/analytics";

const c = colors.light;

const CONSENT_OPTIONS = [
  {
    key: "analytics" as const,
    label: "Usage analytics",
    description: "Screens visited, features used, and errors — helps us improve.",
  },
  {
    key: "deviceDetails" as const,
    label: "Device details",
    description: "Device model, operating system, and network type.",
  },
  {
    key: "locationCoarse" as const,
    label: "Approximate location",
    description: "City-level location from your network. No GPS.",
  },
  {
    key: "locationPrecise" as const,
    label: "Precise location",
    description: "Exact coordinates, only with your device's permission.",
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

const draftKey = (tenantId: number) => `onboarding_draft_answers:${tenantId}`;

type AnswerKey = (typeof QUESTIONS)[number]["key"];

/**
 * Mobile twin of the web onboarding wizard: interviews brand-new users
 * (business, audience, tone), drafts their Brand Kit with AI, and saves a
 * ready-to-edit first post — all via the same endpoints and emitting the
 * same analytics events as the web flow. Skippable at every stage.
 */
export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();

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
  const [done, setDone] = useState(false);

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
  const [resultNotice, setResultNotice] = useState("");
  /** Set to true when POST /brand-kits returns 402 (plan cap). Pauses auto-close
   * so the user can choose to upgrade instead of just seeing the wizard vanish. */
  const [planCapped, setPlanCapped] = useState(false);

  // Track whether we've already attempted to load a draft so the effect
  // doesn't fire again on subsequent renders.
  const draftLoadedRef = useRef(false);

  const shouldShow = !!me && !me.brandOnboardingComplete && !done;
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

  // Restore partial interview answers saved during a previous session.
  // Runs once when the wizard becomes visible (shouldShow flips to true).
  useEffect(() => {
    if (!shouldShow || !me || draftLoadedRef.current) return;
    draftLoadedRef.current = true;

    // Remove the legacy un-namespaced key so stale cross-account data left by
    // an older version of the app can never bleed into a different user's session.
    AsyncStorage.removeItem("onboarding_draft_answers").catch(() => {});

    AsyncStorage.getItem(draftKey(me.tenant.id))
      .then((raw) => {
        if (!raw) return;
        try {
          const saved = JSON.parse(raw) as Partial<Record<AnswerKey, string>>;
          const filled: Record<AnswerKey, string> = {
            name: saved.name ?? "",
            business: saved.business ?? "",
            audience: saved.audience ?? "",
            tone: saved.tone ?? "",
          };
          // Only restore when at least one answer was saved.
          if (!Object.values(filled).some(Boolean)) return;

          // Advance to the first question that hasn't been answered yet.
          const firstUnanswered = QUESTIONS.findIndex((q) => !filled[q.key]);
          const resumeIdx =
            firstUnanswered === -1 ? QUESTIONS.length - 1 : firstUnanswered;

          setAnswers(filled);
          setQuestionIdx(resumeIdx);
          setCurrent(filled[QUESTIONS[resumeIdx]!.key] ?? "");
          setStep("interview");
        } catch {
          // Corrupt draft — ignore and start fresh.
        }
      })
      .catch(() => {});
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
          // Sync the tracker's consent state IMMEDIATELY. Relying only on
          // the query invalidation leaves a refetch-latency window during
          // which track() still sees the pre-response default and silently
          // drops events (e.g. onboarding_skipped on an immediate skip).
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
          queryClient.invalidateQueries({ queryKey: getGetConsentQueryKey() });
          setConsentBusy(false);
          setStep("welcome");
        },
        onError: () => {
          // Best-effort: choices can be changed anytime in Privacy & Data.
          setConsentBusy(false);
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
          // Clear the draft only after the server confirms completion so a
          // transient failure doesn't destroy the resume state.
          if (me) {
            AsyncStorage.removeItem(draftKey(me.tenant.id)).catch(() => {});
          }
          if (!skipped) {
            track("onboarding_completed", {
              completion_time_sec: Math.round(
                (Date.now() - startedAtRef.current) / 1000,
              ),
            });
          }
          setDone(true);
          refresh();
          if (destination) {
            router.push(destination as never);
          }
        },
        onError: () => {
          // Leave the wizard closed rather than trapping the user; the server
          // flag stays unset so it reappears on next launch, and the draft
          // is preserved so they can resume where they left off.
          setDone(true);
          refresh();
        },
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
    // Persist partial answers so a restart can resume from here.
    AsyncStorage.setItem(draftKey(me!.tenant.id), JSON.stringify(nextAnswers)).catch(
      () => {},
    );
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
      if ((err as { status?: number })?.status === 402) {
        // Plan cap — don't auto-close. Let the user choose to upgrade.
        setResultNotice(
          "Your plan's Brand Kit limit has been reached. Upgrade to unlock more Brand Kits.",
        );
        setPlanCapped(true);
      } else {
        setResultNotice(
          "We couldn't create your brand right now — you can set up a Brand Kit anytime from Settings.",
        );
        finish(false);
      }
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
      finish(false, "/(tabs)/library");
    } catch {
      track("onboarding_first_post_failed");
      finish(false, "/(tabs)/studio");
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View style={styles.sheet} testID="onboarding-wizard">
          {effectiveStep === "consent" ? (
            <View>
              <View style={styles.iconCircle}>
                <Feather name="shield" size={24} color={c.primary} />
              </View>
              <Text style={styles.title}>Your data, your choice</Text>
              <Text style={styles.body}>
                KOKAO can collect some usage data to improve the product.
                Everything is optional and off by default. You can change these
                anytime in Privacy & Data, and saying no never limits what you
                can do.
              </Text>
              <ScrollView style={styles.consentList}>
                {CONSENT_OPTIONS.map((opt) => (
                  <View key={opt.key} style={styles.consentRow}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.consentLabel}>{opt.label}</Text>
                      <Text style={styles.consentDesc}>{opt.description}</Text>
                    </View>
                    <Switch
                      value={consentFlags[opt.key] ?? false}
                      onValueChange={(v) =>
                        setConsentFlags((prev) => ({ ...prev, [opt.key]: v }))
                      }
                      accessibilityLabel={opt.label}
                      trackColor={{ true: c.primary }}
                    />
                  </View>
                ))}
              </ScrollView>
              <Button
                title="Continue"
                onPress={handleConsentContinue}
                loading={consentBusy}
                icon="arrow-right"
                style={{ marginTop: 16 }}
              />
            </View>
          ) : effectiveStep === "welcome" ? (
            <View style={{ alignItems: "center" }}>
              <View style={styles.iconCircle}>
                <Feather name="zap" size={26} color={c.primary} />
              </View>
              <Text style={[styles.title, { textAlign: "center" }]}>
                Welcome to KOKAO
              </Text>
              <Text style={[styles.body, { textAlign: "center" }]}>
                Answer four quick questions about your business and we'll set up
                your Brand Kit and write your first post — ready to edit and
                publish.
              </Text>
              <Button
                title="Let's do it"
                icon="message-circle"
                onPress={() => setStep("interview")}
                style={{ marginTop: 20, alignSelf: "stretch" }}
              />
              <Pressable
                onPress={() => handleSkip("welcome")}
                disabled={completeOnboarding.isPending}
                accessibilityLabel="Skip for now"
                style={({ pressed }) => [styles.skipBtn, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={styles.skipText}>Skip for now</Text>
              </Pressable>
            </View>
          ) : effectiveStep === "interview" ? (
            <View>
              <View style={styles.progressRow}>
                {QUESTIONS.map((q, i) => (
                  <View
                    key={q.key}
                    style={[
                      styles.progressSegment,
                      { backgroundColor: i <= questionIdx ? c.primary : c.muted },
                    ]}
                  />
                ))}
              </View>

              <ScrollView style={styles.interviewScroll}>
                {/* Answered questions, shown like a conversation. */}
                {QUESTIONS.slice(0, questionIdx).map((q) => (
                  <View key={q.key} style={{ marginBottom: 12 }}>
                    <Text style={styles.answeredPrompt}>{q.prompt}</Text>
                    <View style={styles.answerBubble}>
                      <Feather name="check" size={13} color={c.primary} />
                      <Text style={styles.answerText}>{answers[q.key]}</Text>
                    </View>
                  </View>
                ))}

                <Text style={styles.prompt}>{question.prompt}</Text>
                {question.key === "tone" ? (
                  <View style={styles.chipRow}>
                    {TONE_CHIPS.map((chip) => (
                      <Chip
                        key={chip}
                        label={chip}
                        selected={current === chip}
                        onPress={() => setCurrent(chip)}
                      />
                    ))}
                  </View>
                ) : null}
                <Input
                  value={current}
                  onChangeText={setCurrent}
                  placeholder={question.placeholder}
                  multiline={question.multiline}
                  autoFocus
                  onSubmitEditing={
                    question.multiline ? undefined : () => submitAnswer(current)
                  }
                  style={{ marginTop: 10 }}
                />
              </ScrollView>

              <View style={styles.footerRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {questionIdx > 0 ? (
                    <Pressable
                      onPress={goBack}
                      accessibilityLabel="Back"
                      style={({ pressed }) => [styles.skipBtn, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Text style={styles.skipText}>Back</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => handleSkip(`question_${question.key}`)}
                    accessibilityLabel="Skip for now"
                    style={({ pressed }) => [styles.skipBtn, { opacity: pressed ? 0.7 : 1 }]}
                  >
                    <Text style={styles.skipText}>Skip for now</Text>
                  </Pressable>
                </View>
                <Button
                  title={
                    questionIdx === QUESTIONS.length - 1 ? "Create my brand" : "Next"
                  }
                  icon={questionIdx === QUESTIONS.length - 1 ? "zap" : "arrow-right"}
                  onPress={() => submitAnswer(current)}
                  disabled={question.required && !current.trim()}
                />
              </View>
            </View>
          ) : planCapped ? (
            <View style={{ alignItems: "center", paddingVertical: 24 }}>
              <View style={styles.iconCircle}>
                <Feather name="lock" size={24} color={c.primary} />
              </View>
              <Text style={[styles.title, { textAlign: "center", marginTop: 8 }]}>
                Plan limit reached
              </Text>
              <Text style={[styles.body, { textAlign: "center" }]}>
                {resultNotice}
              </Text>
              <Button
                title="Upgrade your plan"
                icon="arrow-up-circle"
                onPress={() => finish(false, "/settings")}
                loading={completeOnboarding.isPending}
                style={{ marginTop: 20, alignSelf: "stretch" }}
              />
              <Pressable
                onPress={() => finish(false)}
                disabled={completeOnboarding.isPending}
                accessibilityLabel="Maybe later"
                style={({ pressed }) => [styles.skipBtn, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={styles.skipText}>Maybe later</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ alignItems: "center", paddingVertical: 24 }}>
              <ActivityIndicator size="large" color={c.primary} />
              <Text style={[styles.title, { textAlign: "center", marginTop: 16 }]}>
                Setting things up
              </Text>
              <Text style={[styles.body, { textAlign: "center" }]}>
                {creatingStatus}
              </Text>
              {resultNotice ? (
                <Text style={[styles.body, { textAlign: "center" }]}>
                  {resultNotice}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: c.card,
    borderRadius: 18,
    padding: 22,
    maxHeight: "88%",
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 12,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: c.foreground,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: c.mutedForeground,
    marginTop: 8,
  },
  consentList: { marginTop: 14, maxHeight: 300 },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  consentLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  consentDesc: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  skipBtn: { paddingVertical: 10, paddingHorizontal: 8, alignItems: "center" },
  skipText: { fontFamily: fonts.semiBold, fontSize: 14, color: c.mutedForeground },
  progressRow: { flexDirection: "row", gap: 6, marginBottom: 14 },
  progressSegment: { flex: 1, height: 5, borderRadius: 3 },
  interviewScroll: { maxHeight: 340 },
  answeredPrompt: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginBottom: 4,
  },
  answerBubble: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: c.muted,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignSelf: "flex-start",
  },
  answerText: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground, flexShrink: 1 },
  prompt: { fontFamily: fonts.semiBold, fontSize: 16, color: c.foreground, marginTop: 4 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
  },
});
