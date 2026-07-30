import { describe, it, expect } from "vitest";
import {
  TOOLS,
  formatShortcut,
  isTypingTarget,
  resolveShortcut,
  shortcutForCommand,
  type KeyEventLike,
} from "./shortcuts";

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("resolveShortcut", () => {
  it("picks tools by their Photoshop letters", () => {
    expect(resolveShortcut(key("v"))).toEqual({ kind: "tool", tool: "move" });
    expect(resolveShortcut(key("b"))).toEqual({ kind: "tool", tool: "brush" });
    expect(resolveShortcut(key("t"))).toEqual({ kind: "tool", tool: "text" });
    expect(resolveShortcut(key("w"))).toEqual({ kind: "tool", tool: "wand" });
  });

  it("distinguishes a shifted tool letter from its unshifted twin", () => {
    expect(resolveShortcut(key("m", { shiftKey: true }))).toEqual({
      kind: "tool",
      tool: "marquee-rect",
    });
    expect(resolveShortcut(key("M", { shiftKey: true }))).toEqual({
      kind: "tool",
      tool: "marquee-ellipse",
    });
    expect(resolveShortcut(key("L", { shiftKey: true }))).toEqual({ kind: "tool", tool: "polygon" });
  });

  it("resolves the editing commands on either platform's modifier", () => {
    expect(resolveShortcut(key("z", { metaKey: true }))).toEqual({ kind: "command", command: "undo" });
    expect(resolveShortcut(key("z", { ctrlKey: true }))).toEqual({ kind: "command", command: "undo" });
    expect(resolveShortcut(key("z", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "command",
      command: "redo",
    });
    expect(resolveShortcut(key("y", { ctrlKey: true }))).toEqual({ kind: "command", command: "redo" });
    expect(resolveShortcut(key("s", { metaKey: true }))).toEqual({ kind: "command", command: "save" });
    expect(resolveShortcut(key("j", { metaKey: true }))).toEqual({
      kind: "command",
      command: "duplicate",
    });
  });

  it("handles selection and grouping commands", () => {
    expect(resolveShortcut(key("a", { metaKey: true }))?.command).toBe("select-all");
    expect(resolveShortcut(key("d", { metaKey: true }))?.command).toBe("deselect");
    expect(resolveShortcut(key("i", { metaKey: true, shiftKey: true }))?.command).toBe(
      "invert-selection",
    );
    expect(resolveShortcut(key("g", { metaKey: true }))?.command).toBe("group");
    expect(resolveShortcut(key("g", { metaKey: true, shiftKey: true }))?.command).toBe("ungroup");
    expect(resolveShortcut(key("g", { metaKey: true, altKey: true }))?.command).toBe("clip-to-below");
  });

  it("nudges by one, and by ten with shift", () => {
    expect(resolveShortcut(key("ArrowLeft"))?.command).toBe("nudge-left");
    expect(resolveShortcut(key("ArrowLeft", { shiftKey: true }))?.command).toBe("nudge-left-big");
    expect(resolveShortcut(key("ArrowDown"))?.command).toBe("nudge-down");
  });

  it("resizes the brush with the bracket keys", () => {
    expect(resolveShortcut(key("["))?.command).toBe("brush-smaller");
    expect(resolveShortcut(key("]"))?.command).toBe("brush-larger");
    // With the modifier those are layer ordering instead.
    expect(resolveShortcut(key("]", { metaKey: true }))?.command).toBe("bring-forward");
    expect(resolveShortcut(key("[", { metaKey: true }))?.command).toBe("send-backward");
  });

  it("deletes on either delete key", () => {
    expect(resolveShortcut(key("Backspace"))?.command).toBe("delete");
    expect(resolveShortcut(key("Delete"))?.command).toBe("delete");
  });

  it("returns null for anything unmapped", () => {
    expect(resolveShortcut(key("q"))).toBeNull();
    expect(resolveShortcut(key("F5"))).toBeNull();
    expect(resolveShortcut(key("p", { metaKey: true }))).toBeNull();
    // Alt alone is reserved for modifier behaviour inside the tools.
    expect(resolveShortcut(key("b", { altKey: true }))).toBeNull();
  });

  it("never maps a modified key to a tool", () => {
    // Otherwise Cmd+V would swap to the move tool instead of pasting.
    for (const tool of TOOLS) {
      expect(resolveShortcut(key(tool.key, { metaKey: true }))?.kind).not.toBe("tool");
    }
  });

  it("gives every tool a unique key", () => {
    const keys = TOOLS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isTypingTarget", () => {
  it("recognises fields the user could be typing into", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
  });

  it("recognises contenteditable elements", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it("lets ordinary elements and null through", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("canvas"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});

describe("shortcut display", () => {
  it("uses symbols on a Mac and words elsewhere", () => {
    expect(formatShortcut("mod+shift+z", true)).toBe("⌘⇧Z");
    expect(formatShortcut("mod+shift+z", false)).toBe("Ctrl+Shift+Z");
  });

  it("finds the combo for a command, and null when there is none", () => {
    expect(shortcutForCommand("undo")).toBe("mod+z");
    expect(shortcutForCommand("delete")).toBe("Backspace");
    expect(shortcutForCommand("toggle-visibility")).toBeNull();
  });
});
