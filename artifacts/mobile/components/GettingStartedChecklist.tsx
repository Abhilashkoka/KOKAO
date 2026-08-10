import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  useGetFirstPostProgress,
  useDismissFirstPostNudge,
  getGetFirstPostProgressQueryKey,
} from "@workspace/api-client-react";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { track } from "@/lib/analytics";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const c = colors.light;

interface Step {
  key: string;
  label: string;
  description: string;
  route: string;
  cta: string;
  done: boolean;
}

/**
 * Mobile counterpart of the web dashboard's getting-started checklist. Nudges
 * stalled users toward their first published post, driven by the shared
 * GET /api/first-post-progress endpoint. Dismissal persists server-side via
 * the same tenant flag as web, so dismissing on either surface hides both.
 * Emits the same analytics event names as web so nudge effectiveness is
 * measurable across platforms.
 */
export function GettingStartedChecklist() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: progress } = useGetFirstPostProgress();
  const dismissMutation = useDismissFirstPostNudge();
  const [dismissError, setDismissError] = React.useState<string | null>(null);
  const shownTracked = React.useRef(false);

  const visible = !!progress && !progress.published && !progress.dismissed;

  const steps: Step[] = progress
    ? [
        {
          key: "generate",
          label: "Generate your first content",
          description: "Let AI draft a caption and image in the Studio.",
          route: "/(tabs)/studio",
          cta: "Open Studio",
          done: progress.generated,
        },
        {
          key: "save",
          label: "Save it to your library",
          description: "Keep a draft you can polish and reuse.",
          route: progress.generated ? "/(tabs)/library" : "/(tabs)/studio",
          cta: progress.generated ? "Open Library" : "Open Studio",
          done: progress.saved,
        },
        {
          key: "connect",
          label: "Connect a social account",
          description: "Link the account you want to publish to.",
          route: "/(tabs)/accounts",
          cta: "Connect account",
          done: progress.connected,
        },
        {
          key: "publish",
          label: "Publish your first post",
          description: "Send a saved draft live or schedule it.",
          route: "/(tabs)/library",
          cta: "Publish now",
          done: progress.published,
        },
      ]
    : [];

  const nextStep = steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  React.useEffect(() => {
    if (visible && nextStep && !shownTracked.current) {
      shownTracked.current = true;
      track("first_post_nudge_shown", {
        next_step: nextStep.key,
        steps_done: doneCount,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, nextStep?.key]);

  if (!visible) return null;

  const dismiss = () => {
    if (dismissMutation.isPending) return;
    setDismissError(null);
    track("first_post_nudge_dismissed", {
      next_step: nextStep?.key,
      steps_done: doneCount,
    });
    dismissMutation.mutate(undefined, {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getGetFirstPostProgressQueryKey(),
        }),
      onError: (err) =>
        setDismissError(
          apiErrorMessage(err, "Couldn't dismiss right now. Tap X to try again."),
        ),
    });
  };

  return (
    <View style={styles.banner} testID="checklist-getting-started">
      <View style={styles.iconBox}>
        <Feather name="send" size={18} color={c.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.title}>Get your first post live</Text>
        <Text style={styles.message}>
          {doneCount} of {steps.length} steps done — you're close.
        </Text>
        {dismissError ? (
          <Text style={styles.dismissError} testID="text-checklist-dismiss-error">
            {dismissError}
          </Text>
        ) : null}
        <View style={{ marginTop: 10, gap: 10 }}>
          {steps.map((step) => {
            const isNext = !step.done && step.key === nextStep?.key;
            return (
              <View key={step.key} style={styles.stepRow} testID={`step-${step.key}`}>
                <Feather
                  name={step.done ? "check-circle" : "circle"}
                  size={18}
                  color={step.done ? c.primary : c.mutedForeground + "80"}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={step.done ? styles.stepLabelDone : styles.stepLabel}>
                    {step.label}
                  </Text>
                  {isNext ? (
                    <Text style={styles.stepDescription}>{step.description}</Text>
                  ) : null}
                  {isNext ? (
                    <Pressable
                      onPress={() => {
                        track("first_post_nudge_step_clicked", { step: step.key });
                        router.push(step.route as never);
                      }}
                      style={({ pressed }) => [
                        styles.cta,
                        { opacity: pressed ? 0.85 : 1 },
                      ]}
                      testID={`button-step-${step.key}`}
                    >
                      <Text style={styles.ctaText}>{step.cta}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </View>
      <Pressable
        onPress={dismiss}
        disabled={dismissMutation.isPending}
        accessibilityLabel="Dismiss getting started checklist"
        hitSlop={8}
        style={({ pressed }) => [
          styles.closeBtn,
          { opacity: dismissMutation.isPending ? 0.4 : pressed ? 0.7 : 1 },
        ]}
        testID="button-dismiss-checklist"
      >
        <Feather name="x" size={16} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginTop: 20,
    padding: 14,
    borderRadius: colors.radius + 2,
    borderWidth: 1,
    borderColor: c.primary + "4D",
    backgroundColor: c.primary + "0D",
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: c.primary + "26",
    borderWidth: 1,
    borderColor: c.primary + "33",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  message: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  dismissError: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    marginTop: 6,
  },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  stepLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  stepLabelDone: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.mutedForeground,
    textDecorationLine: "line-through",
  },
  stepDescription: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  cta: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: c.primary,
  },
  ctaText: { fontFamily: fonts.semiBold, fontSize: 12, color: "#ffffff" },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
