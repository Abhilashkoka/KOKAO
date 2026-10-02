import { Link } from "wouter";
import { useGetLandingContent } from "@workspace/api-client-react";
import { DEFAULT_LANDING } from "@/pages/landing";
import { usePageMeta } from "@/lib/seo";
import { TERMS_CONTACT, TERMS_SECTIONS, TERMS_UPDATED } from "@/content/terms";

export function TermsPage() {
  const { data } = useGetLandingContent();
  const content = data ?? DEFAULT_LANDING;
  const { site } = content;

  usePageMeta(
    "Terms and Conditions — KOKAO",
    "Terms for using KOKAO by ASMI Enterprises, including credit packs, subscriptions, cancellation and acceptable use.",
    "https://app.kokao.in/terms",
  );

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: site.color_bg, color: site.color_ink }} data-testid="terms-page">
      <header className="py-5 px-4 md:px-8 max-w-3xl mx-auto w-full flex items-center justify-between gap-4">
        <Link href="/" className="font-extrabold text-xl tracking-tight">{site.brand}</Link>
        <Link href="/" className="text-sm font-semibold underline underline-offset-4">← Back to home</Link>
      </header>
      <main className="flex-1 px-4 md:px-8 max-w-3xl mx-auto w-full py-10">
        <h1 className="text-4xl font-extrabold mb-2">Terms and Conditions</h1>
        <p className="text-sm opacity-70 mb-6">Last updated: {TERMS_UPDATED}</p>
        <p className="text-lg leading-relaxed mb-8">Please read these terms before using KOKAO or purchasing credits or a subscription.</p>
        <nav aria-label="Terms sections" className="border rounded-xl p-5 mb-10" style={{ borderColor: `${site.color_ink}30` }}>
          <h2 className="font-bold mb-3">On this page</h2>
          <ul className="space-y-2 text-sm">
            {TERMS_SECTIONS.map(section => <li key={section.id}><a className="underline underline-offset-4" href={`#${section.id}`}>{section.heading}</a></li>)}
            <li><a className="underline underline-offset-4" href="#contact">11. Contact us</a></li>
          </ul>
        </nav>
        <div className="space-y-8">
          {TERMS_SECTIONS.map(section => (
            <section key={section.id} id={section.id} className="scroll-mt-6">
              <h2 className="text-2xl font-bold mb-3">{section.heading}</h2>
              {section.paragraphs.map(paragraph => <p key={paragraph} className="leading-relaxed mb-3 break-words">{paragraph}</p>)}
              {section.id === "privacy" && <Link href="/privacy" className="underline underline-offset-4">Read our Privacy Policy</Link>}
            </section>
          ))}
          <section id="contact" className="scroll-mt-6">
            <h2 className="text-2xl font-bold mb-3">11. Contact us</h2>
            <p className="leading-relaxed mb-3">For questions about these terms, payments or subscription cancellation, contact ASMI Enterprises, Telangana, India.</p>
            <a href={`mailto:${TERMS_CONTACT}`} className="underline underline-offset-4 break-all">{TERMS_CONTACT}</a>
            <p className="text-sm mt-3">Never send passwords, card details or one-time passcodes by email.</p>
          </section>
        </div>
      </main>
      <footer className="py-8 px-4 border-t text-center text-sm" style={{ borderColor: `${site.color_ink}14` }}>
        <Link href="/privacy" className="underline underline-offset-4">Privacy Policy</Link>
        <p className="mt-3 opacity-70">{content.footer.text}</p>
      </footer>
    </div>
  );
}