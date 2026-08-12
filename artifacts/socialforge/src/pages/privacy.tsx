import { Link } from "wouter";
import { useGetLandingContent, type LandingContent } from "@workspace/api-client-react";
import { usePageMeta } from "@/lib/seo";
import { DEFAULT_LANDING } from "@/pages/landing";

/**
 * Public privacy policy page, rendered from the CMS-managed landing document
 * so superadmins can edit it in the admin "Landing Page" editor.
 */
export function PrivacyPage() {
  const { data } = useGetLandingContent();
  const content: LandingContent = data ?? DEFAULT_LANDING;
  const { site, privacy } = content;

  usePageMeta(
    `${privacy.title} — ${site.brand}`,
    `How ${site.brand} collects, uses and protects your data.`,
    "https://app.kokao.in/privacy",
  );

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: site.color_bg, color: site.color_ink }}
      data-testid="privacy-page"
    >
      <header className="py-5 px-4 md:px-8 max-w-3xl mx-auto w-full flex items-center justify-between">
        <Link href="/" className="font-extrabold text-xl tracking-tight">
          {site.brand}
        </Link>
        <Link href="/" className="text-sm font-semibold underline underline-offset-4 opacity-80 hover:opacity-100">
          ← Back to home
        </Link>
      </header>
      <main className="flex-1 px-4 md:px-8 max-w-3xl mx-auto w-full py-10">
        <h1 className="text-4xl font-extrabold mb-2">{privacy.title}</h1>
        <p className="text-sm opacity-70 mb-6">{privacy.updated}</p>
        <p className="text-lg leading-relaxed mb-10 opacity-85">{privacy.intro}</p>
        <div className="space-y-8">
          {privacy.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-2xl font-bold mb-3">{s.heading}</h2>
              {s.body.split("\n\n").map((para, i) => (
                <p key={i} className="leading-relaxed opacity-85 mb-3">
                  {para}
                </p>
              ))}
            </section>
          ))}
        </div>
      </main>
      <footer
        className="py-8 border-t text-center text-sm opacity-70"
        style={{ borderColor: `${site.color_ink}14` }}
      >
        {content.footer.text}
      </footer>
    </div>
  );
}
