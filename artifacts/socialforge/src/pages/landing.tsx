import { Link } from "wouter";
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useGetLandingContent, type LandingContent } from "@workspace/api-client-react";
import { usePageMeta } from "@/lib/seo";
import { INACTIVITY_SIGNOUT_FLAG } from "@/hooks/use-idle-logout";
import defaultContent from "@/content/landing-default.json";

// The bundled default document renders instantly on first paint; the fetched
// (possibly admin-customized) document replaces it when it arrives.
export const DEFAULT_LANDING = defaultContent as LandingContent;

// Kept in sync with the FAQPage JSON-LD in index.html (enforced by
// seo-static.test.ts): the crawlable structured data must match the default
// FAQ rendered on this page.
export const FAQ_ITEMS = DEFAULT_LANDING.faq.items.map(({ q, a }) => ({
  question: q,
  answer: a,
}));

/** Renders an anchor ("#pricing"), internal route ("/sign-up") or external link. */
function CmsLink({
  href,
  className,
  style,
  children,
  testId,
}: {
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  testId?: string;
}) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={className} style={style} data-testid={testId}>
        {children}
      </Link>
    );
  }
  // Defense in depth against stored XSS: only render safe URL schemes.
  const safe = /^(https:\/\/|mailto:|#)/i.test(href) ? href : "#";
  return (
    <a href={safe} className={className} style={style} data-testid={testId}>
      {children}
    </a>
  );
}

function BrandMark({ site }: { site: LandingContent["site"] }) {
  return (
    <span className="flex items-center gap-2.5">
      {site.logo ? (
        <img src={site.logo} alt={site.brand} className="h-9 w-auto" />
      ) : (
        <span
          className="h-9 w-9 rounded-xl flex items-center justify-center font-extrabold text-lg"
          style={{
            background: `linear-gradient(135deg, ${site.color_accent1}, ${site.color_accent2})`,
            color: site.color_ink,
          }}
          aria-hidden="true"
        >
          {site.brand.charAt(0) || "K"}
        </span>
      )}
      <span className="font-extrabold text-xl tracking-tight">{site.brand}</span>
    </span>
  );
}

export function LandingPage() {
  const { data } = useGetLandingContent();
  const content = data ?? DEFAULT_LANDING;
  const { site, nav, hero, platforms, features, how, pricing, testimonials, faq, cta, footer } =
    content;

  usePageMeta(site.meta_title, site.meta_description);

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

  const ink = site.color_ink;
  const pill = (color: string): React.CSSProperties => ({
    backgroundColor: color,
    color: ink,
  });
  const accents = [site.color_accent1, site.color_accent2, site.color_accent3];

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: site.color_bg, color: ink }}
      data-testid="landing-page"
    >
      {inactivityNotice && (
        <div
          className="border-b text-sm px-4 py-3 flex items-center justify-center gap-2"
          style={{ backgroundColor: site.color_accent3, borderColor: `${ink}22` }}
          role="status"
          data-testid="inactivity-signout-notice"
        >
          <Clock className="h-4 w-4" />
          <span>You were signed out due to inactivity. Please sign in again.</span>
        </div>
      )}

      <header className="py-5 px-4 md:px-8 max-w-6xl mx-auto w-full flex items-center justify-between gap-4">
        <BrandMark site={site} />
        <nav className="hidden md:flex items-center gap-6 text-sm font-semibold opacity-80">
          {nav.links.map((l) => (
            <CmsLink key={l.label} href={l.href} className="hover:opacity-100">
              {l.label}
            </CmsLink>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Link
            href="/sign-in"
            className="text-sm font-semibold opacity-80 hover:opacity-100"
            data-testid="link-sign-in"
          >
            Sign in
          </Link>
          <CmsLink
            href={nav.cta_link}
            className="rounded-full px-5 py-2.5 text-sm font-bold shadow-sm hover:opacity-90 transition-opacity"
            style={pill(site.color_accent1)}
            testId="nav-cta"
          >
            {nav.cta}
          </CmsLink>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="px-4 md:px-8 max-w-6xl mx-auto w-full grid md:grid-cols-2 gap-12 items-center py-16 md:py-24">
          <div>
            <span
              className="inline-block rounded-full px-4 py-1.5 text-sm font-semibold mb-6"
              style={pill(site.color_accent3)}
            >
              {hero.badge}
            </span>
            <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05] mb-6 text-balance">
              {hero.title}
            </h1>
            <p className="text-lg md:text-xl opacity-75 mb-8 max-w-xl">{hero.subtitle}</p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-10">
              <CmsLink
                href={hero.cta_primary_link}
                className="rounded-full px-7 py-3.5 font-bold shadow-md hover:opacity-90 transition-opacity"
                style={pill(site.color_accent1)}
                testId="hero-cta-primary"
              >
                {hero.cta_primary}
              </CmsLink>
              <CmsLink
                href={hero.cta_secondary_link}
                className="rounded-full px-7 py-3.5 font-bold border hover:opacity-80"
                style={{ borderColor: `${ink}33` }}
                testId="hero-cta-secondary"
              >
                {hero.cta_secondary}
              </CmsLink>
            </div>
            <dl className="flex flex-wrap gap-8">
              {hero.stats.map((s) => (
                <div key={s.label}>
                  <dt className="sr-only">{s.label}</dt>
                  <dd className="text-2xl font-extrabold">{s.num}</dd>
                  <dd className="text-sm opacity-70">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>
          {/* Product mock card */}
          <div
            className="rounded-3xl p-6 shadow-xl border"
            style={{ backgroundColor: "#FFFFFF", borderColor: `${ink}14` }}
            aria-hidden="true"
          >
            <div
              className="rounded-2xl px-5 py-4 text-sm font-medium mb-4"
              style={{ backgroundColor: site.color_bg }}
            >
              {hero.card_prompt}
            </div>
            <div className="flex gap-2 mb-4">
              {accents.map((c) => (
                <span key={c} className="h-16 flex-1 rounded-xl" style={{ backgroundColor: c }} />
              ))}
            </div>
            <div
              className="rounded-full px-4 py-2 text-xs font-semibold inline-block"
              style={pill(site.color_accent3)}
            >
              {hero.card_status}
            </div>
          </div>
        </section>

        {/* Platforms */}
        <section className="px-4 py-12 text-center">
          <h2 className="text-lg font-bold opacity-70 mb-6">{platforms.title}</h2>
          <ul className="flex flex-wrap justify-center gap-3 max-w-3xl mx-auto">
            {platforms.items.map((p, i) => (
              <li
                key={p}
                className="rounded-full px-4 py-1.5 text-sm font-semibold"
                style={pill(accents[i % accents.length])}
              >
                {p}
              </li>
            ))}
          </ul>
        </section>

        {/* Features */}
        <section id="features" className="px-4 md:px-8 max-w-6xl mx-auto w-full py-20">
          <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-3">{features.title}</h2>
          <p className="text-lg opacity-70 text-center mb-12 max-w-2xl mx-auto">
            {features.subtitle}
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.items.map((f, i) => (
              <div
                key={f.title}
                className="rounded-3xl p-7 border"
                style={{ backgroundColor: "#FFFFFF", borderColor: `${ink}14` }}
              >
                <div
                  className="h-12 w-12 rounded-2xl flex items-center justify-center text-2xl mb-4"
                  style={{ backgroundColor: accents[i % accents.length] }}
                >
                  {f.icon}
                </div>
                <h3 className="text-xl font-bold mb-2">{f.title}</h3>
                <p className="opacity-75 leading-relaxed">{f.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="px-4 md:px-8 max-w-6xl mx-auto w-full py-20">
          <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-3">{how.title}</h2>
          <p className="text-lg opacity-70 text-center mb-12 max-w-2xl mx-auto">{how.subtitle}</p>
          <ol className="grid md:grid-cols-3 gap-6">
            {how.steps.map((s, i) => (
              <li
                key={s.title}
                className="rounded-3xl p-7"
                style={{ backgroundColor: accents[i % accents.length] }}
              >
                <span className="text-sm font-extrabold opacity-60">Step {i + 1}</span>
                <h3 className="text-xl font-bold mt-1 mb-2">{s.title}</h3>
                <p className="opacity-80 leading-relaxed">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Pricing */}
        <section id="pricing" className="px-4 md:px-8 max-w-6xl mx-auto w-full py-20">
          <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-3">{pricing.title}</h2>
          <p className="text-lg opacity-70 text-center mb-12 max-w-2xl mx-auto">
            {pricing.subtitle}
          </p>
          <div className="grid md:grid-cols-3 gap-6 items-stretch">
            {pricing.plans.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-3xl p-7 border flex flex-col ${plan.featured ? "shadow-xl md:-translate-y-2" : ""}`}
                style={{
                  backgroundColor: plan.featured ? site.color_accent1 : "#FFFFFF",
                  borderColor: `${ink}14`,
                }}
                data-testid={`plan-card-${plan.name}`}
              >
                {plan.tag && (
                  <span
                    className="self-start rounded-full px-3 py-1 text-xs font-bold mb-3"
                    style={{ backgroundColor: "#FFFFFF" }}
                  >
                    {plan.tag}
                  </span>
                )}
                <h3 className="text-xl font-bold">{plan.name}</h3>
                <p className="my-3">
                  <span className="text-4xl font-extrabold">{plan.price}</span>
                  <span className="opacity-70">{plan.period}</span>
                </p>
                <ul className="space-y-2 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex gap-2 text-sm">
                      <span aria-hidden="true">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <CmsLink
                  href={plan.cta_link}
                  className="rounded-full px-6 py-3 font-bold text-center border hover:opacity-90"
                  style={{
                    backgroundColor: plan.featured ? site.color_bg : site.color_accent1,
                    borderColor: `${ink}14`,
                    color: ink,
                  }}
                >
                  {plan.cta}
                </CmsLink>
              </div>
            ))}
          </div>
        </section>

        {/* Testimonials */}
        <section className="px-4 md:px-8 max-w-6xl mx-auto w-full py-20">
          <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-12">
            {testimonials.title}
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.items.map((t, i) => (
              <figure
                key={t.name}
                className="rounded-3xl p-7 border"
                style={{ backgroundColor: "#FFFFFF", borderColor: `${ink}14` }}
              >
                <blockquote className="leading-relaxed mb-4">“{t.quote}”</blockquote>
                <figcaption className="flex items-center gap-3">
                  <span
                    className="h-10 w-10 rounded-full flex items-center justify-center font-bold"
                    style={{ backgroundColor: accents[i % accents.length] }}
                    aria-hidden="true"
                  >
                    {t.name.charAt(0)}
                  </span>
                  <span>
                    <span className="block font-bold text-sm">{t.name}</span>
                    <span className="block text-xs opacity-70">{t.role}</span>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="px-4 py-20" aria-labelledby="faq-heading">
          <div className="max-w-3xl mx-auto">
            <h2 id="faq-heading" className="text-3xl md:text-4xl font-extrabold text-center mb-12">
              {faq.title}
            </h2>
            <div className="space-y-8" data-testid="landing-faq">
              {faq.items.map((item) => (
                <div key={item.q}>
                  <h3 className="text-xl font-semibold mb-2">{item.q}</h3>
                  <p className="opacity-75 text-lg leading-relaxed">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-4 pb-24">
          <div
            className="max-w-4xl mx-auto rounded-3xl p-10 md:p-14 text-center"
            style={{
              background: `linear-gradient(135deg, ${site.color_accent1}, ${site.color_accent2})`,
            }}
          >
            <h2 className="text-3xl md:text-4xl font-extrabold mb-3">{cta.title}</h2>
            <p className="text-lg opacity-80 mb-8 max-w-xl mx-auto">{cta.subtitle}</p>
            <CmsLink
              href={cta.link}
              className="inline-block rounded-full px-8 py-4 font-bold shadow-md hover:opacity-90"
              style={{ backgroundColor: site.color_bg, color: ink }}
              testId="final-cta"
            >
              {cta.button}
            </CmsLink>
          </div>
        </section>
      </main>

      <footer
        className="py-10 border-t text-center text-sm"
        style={{ borderColor: `${ink}14` }}
      >
        <div className="flex items-center justify-center mb-4">
          <BrandMark site={site} />
        </div>
        <p className="flex items-center justify-center gap-5 mb-3 font-semibold opacity-80">
          <Link href="/pricing" className="hover:opacity-100 underline underline-offset-4">
            Pricing
          </Link>
          {footer.links.map((l) => (
            <CmsLink key={l.label} href={l.href} className="hover:opacity-100 underline underline-offset-4">
              {l.label}
            </CmsLink>
          ))}
        </p>
        <p className="opacity-70">{footer.text}</p>
      </footer>
    </div>
  );
}
