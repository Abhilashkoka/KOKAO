import { SignIn, SignUp } from "@clerk/react";
import { useBrand } from "@/lib/brand";

function AuthHeader({ subtitle }: { subtitle: string }) {
  const { logoUrl, appName } = useBrand();
  return (
    <div className="text-center mb-8 flex flex-col items-center">
      <img src={logoUrl} alt={appName} className="h-10 w-auto mb-3" />
      <p className="text-muted-foreground mt-2">{subtitle}</p>
    </div>
  );
}

export function SignInPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <AuthHeader subtitle="Sign in to your workspace" />
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
      </div>
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        <AuthHeader subtitle="Create your workspace" />
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </div>
    </div>
  );
}
