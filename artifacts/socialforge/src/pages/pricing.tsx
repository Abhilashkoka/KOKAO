import { Link } from "wouter";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { useBrand } from "@/lib/brand";
import { usePageMeta } from "@/lib/seo";
import { useListPlans } from "@workspace/api-client-react";
import type { Plan } from "@workspace/api-client-react";

const CANONICAL_ORIGIN = "https://app.kokao.in";

/**
 * Best-effort structured price for a plan, kept in lockstep with what the
 * page displays. Prefers the authoritative numeric Razorpay price (paise);
 * falls back to parsing the display label ("$29 / mo", "₹999 / mo").
 * Returns null when the label has no parseable price (e.g. "No monthly fee",
 * "Contact us") — such plans are simply omitted from the Offer JSON-LD so we
 * never publish a price we don't actually show.
 */
function structuredPrice(plan: Plan): { price: string; currency: string } | null {
  if (plan.priceInr != null) {
    return { price: (plan.priceInr / 100).toFixed(2), currency: "INR" };
  }
  const m = plan.priceLabel.match(/([$₹])\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    return {
      price: m[2].replace(/,/g, ""),
      currency: m[1] === "₹" ? "INR" : "USD",
    };
  }
  if (plan.id === "free" || /\bfree\b/i.test(plan.priceLabel)) {
    return { price: "0", currency: "INR" };
  }
  return null;
}

/** Formats a paise amount as an INR display string, e.g. "₹24,999". */
function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * Percentage saved by paying the annual total instead of 12 monthly payments.
 * Null when either price is missing or there is no actual saving.
 */
function yearlySavingsPercent(plan: Plan): number | null {
  if (plan.priceInr == null || plan.priceInrYearly == null) return null;
  const monthlyTotal = plan.priceInr * 12;
  if (plan.priceInrYearly >= monthlyTotal) return null;
  return Math.round(((monthlyTotal - plan.priceInrYearly) / monthlyTotal) * 100);
}

/**
 * Sign-up link for a plan card CTA. Paid plans carry the selected plan id and
 * billing cycle so the post-signup billing flow can preselect them; yearly is
 * only claimed when the plan actually offers a yearly price. Free/contact
 * plans link plainly to /sign-up.
 */
function signUpHref(plan: Plan, annual: boolean): string {
  const paid = plan.priceInr != null && plan.priceInr > 0;
  if (!paid) return "/sign-up";
  const cycle = annual && plan.priceInrYearly != null ? "yearly" : "monthly";
  return `/sign-up?plan=${encodeURIComponent(plan.id)}&cycle=${cycle}`;
}

/** Product + Offer JSON-LD mirroring the plans rendered on this page. */
function buildPricingJsonLd(plans: Plan[]): string {
  const offers = plans.flatMap((plan) => {
    const out: object[] = [];
    const priced = structuredPrice(plan);
    if (priced) {
      out.push({
        "@type": "Offer",
        name: `KOKAO ${plan.name} plan`,
        description: plan.features.join("; "),
        price: priced.price,
        priceCurrency: priced.currency,
        url: `${CANONICAL_ORIGIN}/pricing`,
        availability: "https://schema.org/InStock",
        category: "SaaS subscription",
      });
    }
    // Annual offer: only when the plan actually has a yearly paise price —
    // this is exactly what the annual toggle displays.
    if (plan.priceInrYearly != null) {
      out.push({
        "@type": "Offer",
        name: `KOKAO ${plan.name} plan (annual)`,
        description: plan.features.join("; "),
        price: (plan.priceInrYearly / 100).toFixed(2),
        priceCurrency: "INR",
        url: `${CANONICAL_ORIGIN}/pricing`,
        availability: "https://schema.org/InStock",
        category: "SaaS subscription",
      });
    }
    return out;
  });
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "KOKAO",
    description:
      "AI social media content studio: on-brand caption copywriting, AI image and video generation, scheduling with auto-publishing to Facebook, Instagram, LinkedIn, X (Twitter) and Threads, plus ads management.",
    brand: { "@type": "Brand", name: "KOKAO" },
    url: `${CANONICAL_ORIGIN}/pricing`,
    image: `${CANONICAL_ORIGIN}/opengraph.jpg`,
    offers,
  });
}

/**
 * Injects the pricing Product/Offer JSON-LD into <head> once real plan data
 * is loaded, and removes it on unmount so other routes don't carry it.
 */
function usePricingJsonLd(plans: Plan[] | undefined) {
  useEffect(() => {
    if (!plans || plans.length === 0) return;
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.id = "pricing-jsonld";
    script.textContent = buildPricingJsonLd(plans);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [plans]);
}

export function PricingPage() {
  const { logoUrl, appName } = useBrand();
  usePageMeta(
    "KOKAO Pricing — Plans for AI Social Media Content",
    "See KOKAO's current plans and prices: free tier, pay-as-you-go wallet billing, and Pro and Business subscriptions for AI captions, images, videos, scheduling and auto-publishing.",
    `${CANONICAL_ORIGIN}/pricing`,
  );
  const { data: plans, isLoading, isError } = useListPlans();
  usePricingJsonLd(plans);
  const hasYearly = (plans ?? []).some((p) => p.priceInrYearly != null);
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const annual = hasYearly && cycle === "yearly";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="py-6 px-4 md:px-8 max-w-7xl mx-auto w-full flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt={appName} className="h-9 w-auto" />
          ) : (
            <div className="h-9" aria-hidden="true" />
          )}
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/sign-in">
            <Button variant="ghost" className="font-semibold">Sign In</Button>
          </Link>
          <Link href="/sign-up">
            <Button className="font-semibold shadow-lg shadow-primary/20">Get Started</Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 px-4 pb-24">
        <section className="text-center max-w-3xl mx-auto pt-12 md:pt-20 pb-12">
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-balance mb-6">
            Simple pricing for{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-purple-400">
              every brand
            </span>
          </h1>
          <p className="text-xl text-muted-foreground text-balance">
            Start free, pay as you go, or subscribe for monthly allowances of AI
            captions, images and videos — with scheduling and auto-publishing on
            every plan.
          </p>
        </section>

        {hasYearly && (
          <div
            className="flex items-center justify-center gap-1 mb-10 rounded-full border border-border p-1 w-fit mx-auto"
            role="group"
            aria-label="Billing cycle"
            data-testid="billing-cycle-toggle"
          >
            <Button
              variant={cycle === "monthly" ? "default" : "ghost"}
              className="rounded-full font-semibold"
              onClick={() => setCycle("monthly")}
              aria-pressed={cycle === "monthly"}
              data-testid="billing-cycle-monthly"
            >
              Monthly
            </Button>
            <Button
              variant={cycle === "yearly" ? "default" : "ghost"}
              className="rounded-full font-semibold"
              onClick={() => setCycle("yearly")}
              aria-pressed={cycle === "yearly"}
              data-testid="billing-cycle-yearly"
            >
              Annual
            </Button>
          </div>
        )}

        <section className="max-w-6xl mx-auto" aria-label="Plans">
          {isLoading && (
            <div className="flex items-center justify-center py-24 text-muted-foreground" data-testid="pricing-loading">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading plans…
            </div>
          )}
          {isError && (
            <p className="text-center py-24 text-muted-foreground" data-testid="pricing-error">
              We couldn't load plans right now. Please refresh, or{" "}
              <Link href="/sign-up" className="text-primary underline">sign up free</Link>{" "}
              to see plans inside the app.
            </p>
          )}
          {plans && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" data-testid="pricing-plans">
              {plans.map((plan) => (
                <div
                  key={plan.id}
                  className="flex flex-col p-6 rounded-2xl border-2 border-border hover:border-primary/30 hover:bg-muted/30 transition-all"
                  data-testid={`pricing-plan-${plan.id}`}
                >
                  <h2 className="font-bold text-xl capitalize">{plan.name}</h2>
                  {annual && plan.priceInrYearly != null ? (
                    <div className="mt-2 mb-6">
                      <p className="text-3xl font-extrabold" data-testid={`pricing-plan-${plan.id}-yearly-price`}>
                        {formatInr(plan.priceInrYearly)} / yr
                      </p>
                      {yearlySavingsPercent(plan) != null && (
                        <p className="text-sm font-semibold text-green-600 mt-1" data-testid={`pricing-plan-${plan.id}-yearly-savings`}>
                          Save {yearlySavingsPercent(plan)}% vs monthly
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-3xl font-extrabold mt-2 mb-6">{plan.priceLabel}</p>
                  )}
                  <ul className="space-y-2.5 flex-1">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" /> {feature}
                      </li>
                    ))}
                  </ul>
                  <Link href={signUpHref(plan, annual)} className="mt-6">
                    <Button className="w-full font-semibold group" data-testid={`pricing-plan-${plan.id}-cta`}>
                      Get Started
                      <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="max-w-3xl mx-auto text-center pt-16">
          <p className="text-muted-foreground">
            All prices are billed in INR at checkout. Wallet-billed workspaces top up a prepaid
            balance instead of a subscription — recharge anytime, and your balance never expires.
            Signing up is free; no credit card required.
          </p>
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
