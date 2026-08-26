import { useEffect } from "react";
import { SignIn, SignUp } from "@clerk/react";
import { useBrand } from "@/lib/brand";
import { usePageMeta } from "@/lib/seo";
import { savePlanIntent } from "@/lib/planIntent";

function AuthHeader({ subtitle }: { subtitle: string }) {
  const { logoUrl, appName } = useBrand();
  return (
    <div className="text-center mb-8 flex flex-col items-center">
      {logoUrl ? (
        <img src={logoUrl} alt={appName} className="h-10 w-auto mb-3" />
      ) : (
        <div className="h-10 mb-3" aria-hidden="true" />
      )}
      <p className="text-muted-foreground mt-2">{subtitle}</p>
    </div>
  );
}

export function SignInPage() {
  usePageMeta(
    "Sign In — KOKAO",
    "Sign in to KOKAO, the AI social media content studio, to create, schedule and publish on-brand content.",
  );
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <AuthHeader subtitle="Sign in to your workspace" />
        <SignIn
          routing="path"
          path="/sign-in"
          signUpUrl="/sign-up"
          fallbackRedirectUrl="/dashboard"
        />
      </div>
    </div>
  );
}

export function SignUpPage() {
  // Capture the plan + cycle chosen on the public pricing page. Clerk's
  // multi-step sign-up flow drops query params across redirects, so stash the
  // intent in localStorage; the billing flow consumes it after sign-up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("plan");
    const cycle = params.get("cycle");
    if (planId) {
      savePlanIntent(planId, cycle === "yearly" ? "yearly" : "monthly");
    }
  }, []);
  usePageMeta(
    "Sign Up Free — KOKAO",
    "Create a free KOKAO account and start generating on-brand captions, images and videos with auto-publishing to your social accounts.",
  );
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <AuthHeader subtitle="Create your workspace" />
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </div>
    </div>
  );
}
