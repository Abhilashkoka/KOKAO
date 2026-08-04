// Guards the SEO head tags and static SEO files against silent breakage:
// canonical URL, absolute share-preview images, valid JSON-LD blocks that
// stay in sync with the landing page FAQ, robots.txt -> sitemap linkage,
// and a well-formed sitemap listing only public routes.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FAQ_ITEMS } from "@/pages/landing";

const root = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");

const CANONICAL = "https://app.kokao.in/";
const PUBLIC_ROUTES = new Set([
  "https://app.kokao.in/",
  "https://app.kokao.in/sign-in",
  "https://app.kokao.in/sign-up",
  "https://app.kokao.in/pricing",
]);

const html = read("index.html");
const doc = new DOMParser().parseFromString(html, "text/html");

const meta = (selector: string) =>
  doc.querySelector(selector)?.getAttribute("content") ?? null;

const isAbsoluteHttps = (url: string | null): boolean =>
  !!url && /^https:\/\/[^\s]+$/.test(url);

describe("index.html SEO head tags", () => {
  it("has the exact canonical URL", () => {
    const canonical = doc.querySelector('link[rel="canonical"]');
    expect(canonical?.getAttribute("href")).toBe(CANONICAL);
  });

  it("og:url matches the canonical URL", () => {
    expect(meta('meta[property="og:url"]')).toBe(CANONICAL);
  });

  it("og:image is an absolute https URL", () => {
    expect(isAbsoluteHttps(meta('meta[property="og:image"]'))).toBe(true);
  });

  it("twitter:image is an absolute https URL", () => {
    expect(isAbsoluteHttps(meta('meta[name="twitter:image"]'))).toBe(true);
  });

  it("has og:title, og:description and twitter:card for share previews", () => {
    expect(meta('meta[property="og:title"]')).toBeTruthy();
    expect(meta('meta[property="og:description"]')).toBeTruthy();
    expect(meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  });
});

describe("index.html JSON-LD", () => {
  const blocks = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  ).map((s) => s.textContent ?? "");

  it("has exactly three JSON-LD blocks that parse as valid JSON", () => {
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  it("covers Organization, SoftwareApplication and FAQPage types", () => {
    const types = blocks.map((b) => JSON.parse(b)["@type"]).sort();
    expect(types).toEqual(["FAQPage", "Organization", "SoftwareApplication"]);
  });

  it("FAQPage questions and answers exactly match the landing page FAQ_ITEMS", () => {
    const faq = blocks
      .map((b) => JSON.parse(b))
      .find((b) => b["@type"] === "FAQPage");
    expect(faq).toBeTruthy();
    const jsonLdQas = (faq.mainEntity as any[]).map((q) => ({
      question: q.name,
      answer: q.acceptedAnswer?.text,
    }));
    const landingQas = FAQ_ITEMS.map(({ question, answer }) => ({
      question,
      answer,
    }));
    expect(jsonLdQas).toEqual(landingQas);
  });

  it("JSON-LD image/logo URLs are absolute https URLs", () => {
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      for (const key of ["image", "logo", "url"]) {
        if (parsed[key] !== undefined) {
          expect(isAbsoluteHttps(parsed[key])).toBe(true);
        }
      }
    }
  });
});

describe("robots.txt", () => {
  const robots = read("public", "robots.txt");

  it("references the sitemap at the canonical domain", () => {
    expect(robots).toMatch(/^Sitemap: https:\/\/app\.kokao\.in\/sitemap\.xml$/m);
  });

  it("disallows the app-internal routes", () => {
    for (const route of ["/studio", "/admin", "/settings", "/api/"]) {
      expect(robots).toMatch(new RegExp(`^Disallow: ${route.replace("/", "\\/")}`, "m"));
    }
  });
});

describe("llms.txt", () => {
  it("exists and references the canonical domain", () => {
    const llms = read("public", "llms.txt");
    expect(llms).toMatch(/^# KOKAO/);
    expect(llms).toContain("https://app.kokao.in");
  });
});

describe("sitemap.xml", () => {
  const sitemapXml = read("public", "sitemap.xml");
  const sitemap = new DOMParser().parseFromString(sitemapXml, "application/xml");

  it("is well-formed XML with a urlset root", () => {
    expect(sitemap.querySelector("parsererror")).toBeNull();
    expect(sitemap.documentElement.tagName).toBe("urlset");
  });

  it("lists only public routes, each with an absolute canonical-domain loc", () => {
    const locs = Array.from(sitemap.getElementsByTagName("loc")).map((l) =>
      (l.textContent ?? "").trim(),
    );
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(loc.startsWith("https://app.kokao.in/")).toBe(true);
      expect(PUBLIC_ROUTES.has(loc)).toBe(true);
    }
    // Every url entry must have a loc.
    expect(sitemap.getElementsByTagName("url").length).toBe(locs.length);
    // The homepage must be present.
    expect(locs).toContain(CANONICAL);
  });

  it("contains no routes disallowed by robots.txt", () => {
    const robots = read("public", "robots.txt");
    const disallowed = robots
      .split("\n")
      .filter((l) => l.startsWith("Disallow: "))
      .map((l) => l.replace("Disallow: ", "").trim());
    const locs = Array.from(sitemap.getElementsByTagName("loc")).map((l) =>
      (l.textContent ?? "").trim(),
    );
    for (const loc of locs) {
      const routePath = loc.replace("https://app.kokao.in", "");
      for (const rule of disallowed) {
        expect(routePath.startsWith(rule)).toBe(false);
      }
    }
  });
});
