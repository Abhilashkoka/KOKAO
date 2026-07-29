import { Link } from "wouter";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Image as ImageIcon, Calendar as CalendarIcon, Clock } from "lucide-react";
import { useBrand } from "@/lib/brand";
import { INACTIVITY_SIGNOUT_FLAG } from "@/hooks/use-idle-logout";

export function LandingPage() {
  const { logoUrl, appName } = useBrand();
  // Show a one-time notice when the user landed here via inactivity sign-out.
  const [inactivityNotice, setInactivityNotice] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(INACTIVITY_SIGNOUT_FLAG) === "1") {
        sessionStorage.removeItem(INACTIVITY_SIGNOUT_FLAG);
        setInactivityNotice(true);
      }
    } catch {
      // sessionStorage unavailable: skip the notice.
    }
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {inactivityNotice && (
        <div
          className="bg-primary/10 border-b border-primary/20 text-sm text-foreground px-4 py-3 flex items-center justify-center gap-2"
          role="status"
          data-testid="inactivity-signout-notice"
        >
          <Clock className="h-4 w-4 text-primary" />
          <span>You were signed out due to inactivity. Please sign in again.</span>
        </div>
      )}
      <header className="py-6 px-4 md:px-8 max-w-7xl mx-auto w-full flex items-center justify-between">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt={appName} className="h-9 w-auto" />
          ) : (
            <div className="h-9" aria-hidden="true" />
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in">
            <Button variant="ghost" className="font-semibold">Sign In</Button>
          </Link>
          <Link href="/sign-up">
            <Button className="font-semibold shadow-lg shadow-primary/20">Get Started</Button>
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative py-20 md:py-32 px-4 text-center max-w-5xl mx-auto flex flex-col items-center">
          <div className="pointer-events-none absolute inset-0 -z-10 overflow-visible" aria-hidden="true">
            <div className="absolute left-1/2 top-1/3 -translate-x-[80%] h-72 w-72 rounded-full bg-primary/25 blur-3xl" />
            <div className="absolute left-1/2 top-1/2 translate-x-[10%] h-80 w-80 rounded-full bg-purple-400/25 blur-3xl" />
            <div className="absolute left-1/2 bottom-0 -translate-x-1/2 h-56 w-[28rem] rounded-full bg-fuchsia-300/20 blur-3xl" />
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary font-medium text-sm mb-6 border border-primary/20">
            <Sparkles className="h-4 w-4" />
            <span>The AI creative studio for modern brands</span>
          </div>
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-balance leading-tight mb-8">
            Create. Organize. <br/><span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-purple-400">Dominate Social.</span>
          </h1>
          <p className="text-xl text-muted-foreground mb-10 max-w-2xl text-balance">
            Generate on-brand captions and stunning imagery in seconds. Manage your brand kits, schedule posts, and organize your content library in one powerful workspace.
          </p>
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <Link href="/sign-up">
              <Button size="lg" className="h-14 px-8 text-lg font-semibold rounded-xl shadow-xl shadow-primary/25 group">
                Start Creating Free
                <ArrowRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
          </div>
        </section>

        <section className="px-4 max-w-6xl mx-auto pb-32">
          <div className="relative rounded-2xl overflow-hidden border border-border shadow-2xl shadow-black/5 aspect-video bg-muted">
            <img src="/hero-image.png" alt="KOKAO Studio" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent pointer-events-none" />
          </div>
        </section>

        <section className="py-24 bg-muted/50 px-4">
          <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="flex flex-col gap-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <Sparkles className="h-7 w-7" />
              </div>
              <h3 className="text-2xl font-bold">AI Copywriting</h3>
              <p className="text-muted-foreground text-lg leading-relaxed">
                Generate engaging, on-brand captions tailored to your voice, platform, and audience with a single click.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <ImageIcon className="h-7 w-7" />
              </div>
              <h3 className="text-2xl font-bold">Image Generation</h3>
              <p className="text-muted-foreground text-lg leading-relaxed">
                Create stunning, high-resolution visuals that perfectly match your brand's aesthetic without a designer.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <CalendarIcon className="h-7 w-7" />
              </div>
              <h3 className="text-2xl font-bold">Content Planning</h3>
              <p className="text-muted-foreground text-lg leading-relaxed">
                Organize your assets in a central library and schedule them across all your connected social accounts seamlessly.
              </p>
            </div>
          </div>
        </section>
      </main>
      
      <footer className="py-12 border-t border-border text-center text-muted-foreground">
        <div className="flex items-center justify-center mb-4">
          {logoUrl ? (
            <img src={logoUrl} alt={appName} className="h-7 w-auto" />
          ) : (
            <div className="h-7" aria-hidden="true" />
          )}
        </div>
        <p>&copy; {new Date().getFullYear()} KOKAO Inc. All rights reserved.</p>
      </footer>
    </div>
  );
}
