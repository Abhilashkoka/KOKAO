import type { SmartEditBox, SmartEditInput } from "@workspace/api-client-react";

export function clampEditRange(
  start: number, end: number, duration: number, moved: "start" | "end",
  min = 1, max = 12,
): [number, number] {
  // Round down the media boundary so tenths never exceed the actual duration.
  const total = Math.floor(duration * 10) / 10;
  if (!Number.isFinite(total) || total < min) return [0, 0];
  let s = Math.max(0, Math.min(start, total));
  let e = Math.max(0, Math.min(end, total));
  if (moved === "start") {
    s = Math.min(s, total - min);
    e = Math.max(s + min, Math.min(e, s + max, total));
  } else {
    e = Math.max(min, e);
    s = Math.max(0, Math.min(e - min, Math.max(s, e - max)));
  }
  return [Math.round(s * 10) / 10, Math.round(e * 10) / 10];
}

export function regionFromPoints(
  from: [number, number], to: [number, number], width: number, height: number,
): SmartEditBox | null {
  if (!width || !height) return null;
  const x = (v: number) => Math.max(0, Math.min(1, v / width));
  const y = (v: number) => Math.max(0, Math.min(1, v / height));
  const box = {
    x: Math.min(x(from[0]), x(to[0])),
    y: Math.min(y(from[1]), y(to[1])),
    width: Math.abs(x(to[0]) - x(from[0])),
    height: Math.abs(y(to[1]) - y(from[1])),
  };
  return box.width >= 0.02 && box.height >= 0.02 ? box : null;
}

export function editCanSubmit(input: SmartEditInput, duration: number, consent: boolean): boolean {
  const length = input.endSec - input.startSec;
  if (duration < 1 || length < 1 || length > 12 || input.startSec < 0 || input.endSec > duration) return false;
  if (input.type === "dialogue") return consent && (input.dialogueText?.trim().length ?? 0) >= 2;
  if (input.type === "remove") return !!input.box;
  return input.type === "regenerate" || (input.instruction?.trim().length ?? 0) >= 3;
}

export function secondsLabel(value: number): string {
  return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
}
