import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * True when an event originated inside an interactive control (button, link,
 * form field, video player, open menu...). Used by card-level double-click
 * handlers so double-clicking a card's action controls never also opens the
 * card's edit flow.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      "button, a, input, textarea, select, video, [role='menu'], [role='menuitem'], [role='dialog']",
    )
  );
}
