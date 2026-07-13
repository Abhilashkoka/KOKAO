import { describe, it, expect } from "vitest";
import {
  extractLogos,
  normalizeHex,
  classifyHex,
  extractColorCandidates,
  extractThemeColor,
  extractStylesheetUrls,
  decodeHtmlEntities,
} from "./draft";

const page = new URL("https://example.com/about/");

describe("extractLogos", () => {
  it("prefers apple-touch-icon over rel=icon", () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/apple-icon.png">
    `;
    const out = extractLogos(html, page);
    expect(out.iconMark).toBe("https://example.com/apple-icon.png");
    expect(out.favicon).toBe("https://example.com/favicon.ico");
  });

  it("resolves relative hrefs against the page URL", () => {
    const html = `<link rel="icon" href="img/icon.png">`;
    const out = extractLogos(html, page);
    expect(out.iconMark).toBe("https://example.com/about/img/icon.png");
  });

  it("handles sized apple-touch-icon and single-quoted attributes", () => {
    const html = `<link rel='apple-touch-icon' sizes='180x180' href='https://cdn.example.com/logo-180.png'>`;
    const out = extractLogos(html, page);
    expect(out.iconMark).toBe("https://cdn.example.com/logo-180.png");
  });

  it("does not treat shortcut-icon-only rels with other words as icon unless listed", () => {
    const html = `<link rel="shortcut icon" href="/fav.ico">`;
    const out = extractLogos(html, page);
    expect(out.favicon).toBe("https://example.com/fav.ico");
  });

  it("drops non-http(s) and unparseable hrefs", () => {
    const html = `
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="apple-touch-icon" href="javascript:alert(1)">
    `;
    const out = extractLogos(html, page);
    expect(out.iconMark).toBeNull();
    expect(out.favicon).toBeNull();
  });

  it("returns nulls when no link tags exist", () => {
    const out = extractLogos("<html><body>hello</body></html>", page);
    expect(out.iconMark).toBeNull();
    expect(out.favicon).toBeNull();
  });

  it("ignores stylesheet links", () => {
    const html = `<link rel="stylesheet" href="/style.css">`;
    const out = extractLogos(html, page);
    expect(out.iconMark).toBeNull();
    expect(out.favicon).toBeNull();
  });
});

describe("normalizeHex", () => {
  it("expands shorthand and lowercases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#FF6600")).toBe("#ff6600");
  });
  it("rejects non-hex input", () => {
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("rgb(1,2,3)")).toBeNull();
  });
});

describe("classifyHex", () => {
  it("classifies saturated mid-lightness colors as brand", () => {
    expect(classifyHex("#6f4e37")).toBe("brand");
    expect(classifyHex("#ff6600")).toBe("brand");
    expect(classifyHex("#2d4a3e")).toBe("brand");
  });
  it("classifies grays, near-white and near-black as neutral", () => {
    expect(classifyHex("#ffffff")).toBe("neutral");
    expect(classifyHex("#000000")).toBe("neutral");
    expect(classifyHex("#888888")).toBe("neutral");
    expect(classifyHex("#f5f5f5")).toBe("neutral");
  });
});

describe("extractColorCandidates", () => {
  it("ranks by frequency and dedupes shorthand vs full form", () => {
    const out = extractColorCandidates([
      "color:#ff6600; background:#FF6600; border:#f60; text:#123456;",
    ]);
    expect(out[0]).toBe("#ff6600");
    expect(out).toContain("#123456");
    expect(out.filter((c) => c === "#ff6600")).toHaveLength(1);
  });
  it("puts boosted colors first", () => {
    const out = extractColorCandidates(
      ["#aaaaaa #aaaaaa #bbbbbb"],
      ["#123456"],
    );
    expect(out[0]).toBe("#123456");
  });
  it("does not match longer hex-like strings", () => {
    const out = extractColorCandidates(["hash #abcdef12 value"]);
    expect(out).toHaveLength(0);
  });
});

describe("extractThemeColor", () => {
  it("reads the theme-color meta", () => {
    expect(
      extractThemeColor('<meta name="theme-color" content="#FF6600">'),
    ).toBe("#ff6600");
  });
  it("returns null when absent or invalid", () => {
    expect(extractThemeColor('<meta name="viewport" content="w">')).toBeNull();
    expect(
      extractThemeColor('<meta name="theme-color" content="tomato">'),
    ).toBeNull();
  });
});

describe("extractStylesheetUrls", () => {
  const page = new URL("https://example.com/");
  it("resolves stylesheet hrefs and respects the limit", () => {
    const html = `
      <link rel="stylesheet" href="/a.css">
      <link rel="stylesheet" href="https://cdn.example.com/b.css">
      <link rel="stylesheet" href="/c.css">
      <link rel="preload" href="/d.css">
    `;
    const out = extractStylesheetUrls(html, page);
    expect(out).toEqual([
      "https://example.com/a.css",
      "https://cdn.example.com/b.css",
    ]);
  });
  it("skips non-http(s) hrefs", () => {
    const out = extractStylesheetUrls(
      `<link rel="stylesheet" href="data:text/css,body{}">`,
      page,
    );
    expect(out).toHaveLength(0);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes common entities in attribute values", () => {
    expect(decodeHtmlEntities("a?w=180&amp;h=180")).toBe("a?w=180&h=180");
    expect(decodeHtmlEntities("&lt;x&gt; &quot;q&quot; &#39;s&#39;")).toBe(
      `<x> "q" 's'`,
    );
  });
  it("is applied to logo hrefs", () => {
    const html =
      '<link rel="apple-touch-icon" href="https://cdn.example.com/i.png?w=180&amp;h=180">';
    const { iconMark } = extractLogos(html, new URL("https://example.com/"));
    expect(iconMark).toBe("https://cdn.example.com/i.png?w=180&h=180");
  });
});
