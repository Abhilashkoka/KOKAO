/**
 * Unit tests for the tolerant model-output JSON parser used by all AI
 * generation routes. Motivated by a production incident where DeepSeek
 * wrapped its JSON reply in prose/fences despite response_format
 * json_object, making carousel generation 500.
 */
import { describe, it, expect } from "vitest";
import { parseModelJsonObject } from "./ai";

describe("parseModelJsonObject", () => {
  it("parses plain JSON objects", () => {
    expect(parseModelJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJsonObject('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("rejects arrays and scalars", () => {
    expect(parseModelJsonObject("[1,2]")).toBeNull();
    expect(parseModelJsonObject('"hi"')).toBeNull();
    expect(parseModelJsonObject("just prose, no json")).toBeNull();
  });

  it("extracts from a ```json fence", () => {
    const raw = 'Here you go:\n```json\n{"title":"T","slides":[]}\n```\nHope that helps!';
    expect(parseModelJsonObject(raw)).toEqual({ title: "T", slides: [] });
  });

  it("skips a non-JSON fence and uses a later valid one", () => {
    const raw = "```\nnot json {oops\n```\nreal answer:\n```json\n{\"ok\":true}\n```";
    expect(parseModelJsonObject(raw)).toEqual({ ok: true });
  });

  it("recovers an object embedded in prose with stray braces around it", () => {
    const raw = 'Note: use {placeholders} carefully. Result: {"caption":"hi","hashtags":["a"]} — done {end}';
    expect(parseModelJsonObject(raw)).toEqual({ caption: "hi", hashtags: ["a"] });
  });

  it("handles braces and escaped quotes inside JSON strings", () => {
    const raw = 'prefix {"body":"a {curly} \\"quoted\\" value","n":2} suffix';
    expect(parseModelJsonObject(raw)).toEqual({ body: 'a {curly} "quoted" value', n: 2 });
  });

  it("parses nested objects via the balanced scan", () => {
    const raw = 'blah {"slides":[{"heading":"h","body":"b"}],"title":"t"} blah';
    expect(parseModelJsonObject(raw)).toEqual({
      slides: [{ heading: "h", body: "b" }],
      title: "t",
    });
  });

  it("returns null for truncated JSON", () => {
    expect(parseModelJsonObject('{"a": [1, 2')).toBeNull();
  });
});
