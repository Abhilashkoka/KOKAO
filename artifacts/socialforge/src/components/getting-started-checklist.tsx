import { Link } from "wouter";
import { CheckCircle2, Circle, Rocket, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetFirstPostProgress,
  useDismissFirstPostNudge,
  getGetFirstPostProgressQueryKey,
} from "@workspace/api-client-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { track } from "@/lib/analytics";

interface Step {
  key: string;
  label: string;
  description: string;
  href: string;
  cta: string;
  done: boolean;
}

/**
 * Contextual "getting started" checklist nudging stalled users toward their
 * first published post. Driven by the tenant's own funnel state from the
 * server (generated / saved / connected / published). Hidden once the tenant
 * has published, or after an explicit dismissal (persisted server-side).
 * Emits analytics so nudge effectiveness is measurable.
 */
export function GettingStartedChecklist() {
  const queryClient = useQueryClient();
  const { data: progress } = useGetFirstPostProgress();
  const { mutate: dismissNudge, isPending } = useDismissFirstPostNudge();
  const [dismissError, setDismissError] = useState<string | null>(null);
  const shownTracked = useRef(false);

  const visible =
    !!progress && !progress.published && !progress.dismissed;

  const steps: Step[] = progress
    ? [
        {
          key: "generate",
          label: "Generate your first content",
          description: "Let AI draft a caption and image in the Studio.",
          href: "/studio",
          cta: "Open Studio",
          done: progress.generated,
        },
        {
          key: "save",
          label: "Save it to your library",
          description: "Keep a draft you can polish and reuse.",
          href: progress.generated ? "/library" : "/studio",
          cta: progress.generated ? "Open Library" : "Open Studio",
          done: progress.saved,
        },
        {
          key: "connect",
          label: "Connect a social account",
          description: "Link the account you want to publish to.",
          href: "/accounts",
          cta: "Connect account",
          done: progress.connected,
        },
        {
          key: "publish",
          label: "Publish your first post",
          description: "Send a saved draft live or schedule it.",
          href: "/library",
          cta: "Publish now",
          done: progress.published,
        },
      ]
    : [];

  const nextStep = steps.find((s) => !s.done);

  useEffect(() => {
    if (visible && nextStep && !shownTracked.current) {
      shownTracked.current = true;
      track("first_post_nudge_shown", {
        next_step: nextStep.key,
        steps_done: steps.filter((s) => s.done).length,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, nextStep?.key]);

  if (!visible) return null;

  const doneCount = steps.filter((s) => s.done).length;

  const dismiss = () => {
    if (isPending) return;
    setDismissError(null);
    track("first_post_nudge_dismissed", {
      next_step: nextStep?.key,
      steps_done: doneCount,
    });
    dismissNudge(undefined, {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getGetFirstPostProgressQueryKey(),
        }),
      onError: (err) =>
        setDismissError(
          apiErrorMessage(
            err,
            "Couldn't dismiss right now. Click X to try again.",
          ),
        ),
    });
  };

  return (
    <div
      className="relative rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 overflow-hidden"
      data-testid="checklist-getting-started"
    >
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/10 rounded-full -mr-12 -mt-12 blur-2xl pointer-events-none" />
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0">
          <Rocket className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground">
            Get your first post live
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {doneCount} of {steps.length} steps done — you're close.
          </p>
          {dismissError ? (
            <p
              className="text-sm text-destructive mt-1.5"
              data-testid="text-checklist-dismiss-error"
            >
              {dismissError}
            </p>
          ) : null}
          <ul className="mt-3 space-y-2">
            {steps.map((step) => (
              <li
                key={step.key}
                className="flex items-center gap-3"
                data-testid={`step-${step.key}`}
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground/50 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span
                    className={
                      step.done
                        ? "text-sm font-medium text-muted-foreground line-through"
                        : "text-sm font-medium text-foreground"
                    }
                  >
                    {step.label}
                  </span>
                  {!step.done && step.key === nextStep?.key ? (
                    <p className="text-xs text-muted-foreground">
                      {step.description}
                    </p>
                  ) : null}
                </div>
                {!step.done && step.key === nextStep?.key ? (
                  <Link href={step.href}>
                    <Button
                      size="sm"
                      data-testid={`button-step-${step.key}`}
                      onClick={() =>
                        track("first_post_nudge_step_clicked", {
                          step: step.key,
                        })
                      }
                    >
                      {step.cta}
                    </Button>
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={dismiss}
          disabled={isPending}
          aria-label="Dismiss getting started checklist"
          data-testid="button-dismiss-checklist"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
