import { describe, it, expect } from "vitest";
import { extractLogos } from "./draft";

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
