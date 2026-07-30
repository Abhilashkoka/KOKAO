/**
 * Tools and keyboard shortcuts.
 *
 * The keymap follows Photoshop's, deliberately and without improvement. Anyone
 * who asked for these features already has V/M/L/W/B/E/T in their hands, and a
 * "better" mapping is one they have to learn for a single app. Where this
 * editor has no Photoshop equivalent the key is chosen to not collide.
 *
 * `resolveShortcut` is a pure function from an event-shaped object to a command
 * id, which is what lets the whole keymap be tested without mounting the
 * editor — and keeps the one genuinely subtle rule (never steal a key while
 * the user is typing in a field) in one checkable place.
 */

export type ToolId =
  | "move"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "polygon"
  | "wand"
  | "crop"
  | "brush"
  | "eraser"
  | "mask-brush"
  | "text"
  | "shape"
  | "gradient"
  | "eyedropper"
  | "hand"
  | "zoom";

export interface ToolDef {
  id: ToolId;
  label: string;
  key: string;
  /** Tools that paint into the selection rather than manipulating layers. */
  group: "select" | "paint" | "vector" | "view";
  hint: string;
}

export const TOOLS: ToolDef[] = [
  { id: "move", label: "Move", key: "v", group: "select", hint: "Move and transform layers" },
  { id: "marquee-rect", label: "Rectangle select", key: "m", group: "select", hint: "Drag a rectangular selection" },
  { id: "marquee-ellipse", label: "Ellipse select", key: "M", group: "select", hint: "Drag an elliptical selection" },
  { id: "lasso", label: "Lasso", key: "l", group: "select", hint: "Draw a freehand selection" },
  { id: "polygon", label: "Polygon lasso", key: "L", group: "select", hint: "Click to place selection corners" },
  { id: "wand", label: "Magic wand", key: "w", group: "select", hint: "Select similar pixels" },
  { id: "crop", label: "Crop", key: "c", group: "select", hint: "Trim the canvas" },
  { id: "brush", label: "Brush", key: "b", group: "paint", hint: "Paint on the active paint layer" },
  { id: "eraser", label: "Eraser", key: "e", group: "paint", hint: "Erase from the active paint layer" },
  { id: "mask-brush", label: "Mask brush", key: "k", group: "paint", hint: "Paint the selected layer's mask" },
  { id: "text", label: "Text", key: "t", group: "vector", hint: "Add a text layer" },
  { id: "shape", label: "Shape", key: "u", group: "vector", hint: "Draw a shape layer" },
  { id: "gradient", label: "Gradient", key: "g", group: "vector", hint: "Add a gradient layer" },
  { id: "eyedropper", label: "Eyedropper", key: "i", group: "vector", hint: "Pick a colour from the canvas" },
  { id: "hand", label: "Hand", key: "h", group: "view", hint: "Pan the canvas (or hold space)" },
  { id: "zoom", label: "Zoom", key: "z", group: "view", hint: "Click to zoom in, alt-click to zoom out" },
];

export type CommandId =
  | "undo"
  | "redo"
  | "save"
  | "delete"
  | "duplicate"
  | "group"
  | "ungroup"
  | "select-all"
  | "deselect"
  | "invert-selection"
  | "feather"
  | "zoom-in"
  | "zoom-out"
  | "zoom-fit"
  | "zoom-100"
  | "bring-forward"
  | "send-backward"
  | "bring-to-front"
  | "send-to-back"
  | "toggle-visibility"
  | "flip-horizontal"
  | "flip-vertical"
  | "nudge-left"
  | "nudge-right"
  | "nudge-up"
  | "nudge-down"
  | "nudge-left-big"
  | "nudge-right-big"
  | "nudge-up-big"
  | "nudge-down-big"
  | "clip-to-below"
  | "add-mask"
  | "brush-smaller"
  | "brush-larger";

/** The subset of KeyboardEvent this module reads. Keeps callers testable. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutResult {
  kind: "tool" | "command";
  tool?: ToolId;
  command?: CommandId;
}

/**
 * True when a keystroke belongs to whatever the user is typing into.
 *
 * Without this, pressing "b" while renaming a layer swaps to the brush and
 * eats the letter. Checked against the element rather than a focus flag in the
 * editor's own state because a Radix popover can move focus into an input the
 * editor never hears about.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

const COMMAND_KEYS: Record<string, CommandId> = {
  "mod+z": "undo",
  "mod+shift+z": "redo",
  "mod+y": "redo",
  "mod+s": "save",
  "mod+j": "duplicate",
  "mod+g": "group",
  "mod+shift+g": "ungroup",
  "mod+a": "select-all",
  "mod+d": "deselect",
  "mod+shift+i": "invert-selection",
  "mod+alt+d": "feather",
  "mod+=": "zoom-in",
  "mod++": "zoom-in",
  "mod+-": "zoom-out",
  "mod+0": "zoom-fit",
  "mod+1": "zoom-100",
  "mod+]": "bring-forward",
  "mod+[": "send-backward",
  "mod+shift+]": "bring-to-front",
  "mod+shift+[": "send-to-back",
  "mod+alt+g": "clip-to-below",
  "mod+shift+n": "add-mask",
};

const PLAIN_KEYS: Record<string, CommandId> = {
  Backspace: "delete",
  Delete: "delete",
  ArrowLeft: "nudge-left",
  ArrowRight: "nudge-right",
  ArrowUp: "nudge-up",
  ArrowDown: "nudge-down",
  "[": "brush-smaller",
  "]": "brush-larger",
};

const SHIFT_KEYS: Record<string, CommandId> = {
  ArrowLeft: "nudge-left-big",
  ArrowRight: "nudge-right-big",
  ArrowUp: "nudge-up-big",
  ArrowDown: "nudge-down-big",
};

function comboKey(e: KeyEventLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  // Normalise so "mod+shift+z" is stable regardless of modifier order.
  const ordered = ["mod", "alt", "shift"].filter((m) => parts.includes(m));
  ordered.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return ordered.join("+");
}

/**
 * Map a keystroke to a tool or command.
 *
 * Tool letters are matched case-sensitively against `TOOLS`, which is how the
 * shifted variants work: `m` is the rectangular marquee and `M` the elliptical
 * one, exactly as in the app this keymap is borrowed from.
 */
export function resolveShortcut(e: KeyEventLike): ShortcutResult | null {
  const combo = comboKey(e);

  if (e.ctrlKey || e.metaKey) {
    const command = COMMAND_KEYS[combo];
    return command ? { kind: "command", command } : null;
  }

  if (e.altKey) return null;

  if (e.shiftKey) {
    const shifted = SHIFT_KEYS[e.key];
    if (shifted) return { kind: "command", command: shifted };
  } else {
    const plain = PLAIN_KEYS[e.key];
    if (plain) return { kind: "command", command: plain };
  }

  if (e.key === "x" || e.key === "X") return null;

  const tool = TOOLS.find((t) => t.key === e.key);
  if (tool) return { kind: "tool", tool: tool.id };

  return null;
}

/** Printable form for tooltips: ⌘Z on a Mac, Ctrl+Z everywhere else. */
export function formatShortcut(combo: string, isMac: boolean): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      if (part === "alt") return isMac ? "⌥" : "Alt";
      if (part === "shift") return isMac ? "⇧" : "Shift";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac ? "" : "+");
}

/** Reverse lookup, so the UI can label a button with its own shortcut. */
export function shortcutForCommand(command: CommandId): string | null {
  const entry = Object.entries(COMMAND_KEYS).find(([, id]) => id === command);
  if (entry) return entry[0];
  const plain = Object.entries(PLAIN_KEYS).find(([, id]) => id === command);
  return plain ? plain[0] : null;
}
