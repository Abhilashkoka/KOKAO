import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

/**
 * A CardHeader that toggles the card's content like a drop-down: click (or
 * Enter/Space) flips `open`, a chevron shows the state. The caller owns the
 * `open` state and conditionally renders its CardContent.
 */
export function CollapsibleCardHeader({
  title,
  description,
  open,
  onToggle,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  open: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <CardHeader
      className="cursor-pointer select-none"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-4">
        <CardTitle>{title}</CardTitle>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </div>
      {description && <CardDescription>{description}</CardDescription>}
    </CardHeader>
  );
}
