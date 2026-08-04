import { useEffect } from "react";

/**
 * Lightweight head management for PUBLIC pages (landing, sign-in, sign-up).
 *
 * BrandProvider owns the document title for the authenticated app (it sets it
 * to the configured app name). Public pages want descriptive, SEO-friendly
 * titles instead, so they register an override here; BrandProvider checks
 * {@link hasPageTitleOverride} before writing its default.
 */
let overrideCount = 0;
let brandDefaultTitle: string | null = null;

export function hasPageTitleOverride(): boolean {
  return overrideCount > 0;
}

/** Called by BrandProvider so we can restore its title when overrides unmount. */
export function setBrandDefaultTitle(title: string) {
  brandDefaultTitle = title;
  if (overrideCount === 0) document.title = title;
}

function setMetaDescription(content: string): () => void {
  const el = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!el) return () => {};
  const previous = el.content;
  el.content = content;
  return () => {
    el.content = previous;
  };
}

function setCanonical(href: string): () => void {
  const el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) return () => {};
  const previous = el.href;
  el.href = href;
  return () => {
    el.href = previous;
  };
}

/**
 * Set a per-page document title (and optionally meta description and
 * canonical URL) for a public route. Restores the brand/app defaults on
 * unmount. Public SEO pages other than the landing page must pass their own
 * canonical, or crawlers will canonicalize them to the home page (the static
 * index.html default).
 */
export function usePageMeta(title: string, description?: string, canonicalUrl?: string) {
  useEffect(() => {
    overrideCount++;
    document.title = title;
    const restoreDescription = description
      ? setMetaDescription(description)
      : () => {};
    const restoreCanonical = canonicalUrl ? setCanonical(canonicalUrl) : () => {};
    return () => {
      overrideCount--;
      restoreDescription();
      restoreCanonical();
      if (overrideCount === 0 && brandDefaultTitle) {
        document.title = brandDefaultTitle;
      }
    };
  }, [title, description, canonicalUrl]);
}
