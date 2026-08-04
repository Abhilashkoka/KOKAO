import type { PromptBlock } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

/** A locally-editable prompt block. `mandatory` maps to the API's boolean; the
 *  spec's "mandatory" | "editable" distinction is exactly that flag. */
export interface BlockDraft {
  id: string;
  title: string;
  content: string;
  mandatory: boolean;
}

let blockSeq = 0;

export function newBlockDraft(mandatory = true): BlockDraft {
  blockSeq += 1;
  return {
    id: `block-${Date.now().toString(36)}-${blockSeq}`,
    title: "",
    content: "",
    mandatory,
  };
}

export function blocksFromApi(blocks: PromptBlock[]): BlockDraft[] {
  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((b) => ({
      id: b.id,
      title: b.title,
      content: b.content,
      mandatory: b.mandatory,
    }));
}

/** Serialize local drafts into API blocks, assigning a stable `order`. */
export function blocksToApi(drafts: BlockDraft[]): PromptBlock[] {
  return drafts.map((b, i) => ({
    id: b.id.slice(0, 40),
    title: b.title.trim(),
    content: b.content,
    mandatory: b.mandatory,
    order: i,
  }));
}

/** At least one non-empty mandatory block is required to save a template. */
export function hasValidMandatoryBlock(drafts: BlockDraft[]): boolean {
  return drafts.some(
    (b) => b.mandatory && b.title.trim() !== "" && b.content.trim() !== "",
  );
}

interface BlockEditorProps {
  blocks: BlockDraft[];
  onChange: (blocks: BlockDraft[]) => void;
  disabled?: boolean;
  testIdPrefix?: string;
}

export function BlockEditor({
  blocks,
  onChange,
  disabled,
  testIdPrefix = "block",
}: BlockEditorProps) {
  const setBlock = (idx: number, patch: Partial<BlockDraft>) =>
    onChange(blocks.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

  const removeBlock = (idx: number) =>
    onChange(blocks.filter((_, i) => i !== idx));

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...blocks];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {blocks.map((block, idx) => (
        <div
          key={block.id}
          className="rounded-lg border border-border p-3 space-y-2"
          data-testid={`${testIdPrefix}-row-${idx}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={block.mandatory ? "secondary" : "outline"}>
                {block.mandatory ? "Mandatory" : "Editable"}
              </Badge>
              <span className="text-xs text-muted-foreground">#{idx + 1}</span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || idx === 0}
                onClick={() => move(idx, -1)}
                aria-label="Move block up"
                data-testid={`${testIdPrefix}-up-${idx}`}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || idx === blocks.length - 1}
                onClick={() => move(idx, 1)}
                aria-label="Move block down"
                data-testid={`${testIdPrefix}-down-${idx}`}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                onClick={() => removeBlock(idx)}
                aria-label="Remove block"
                data-testid={`${testIdPrefix}-remove-${idx}`}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </div>
          <Input
            value={block.title}
            onChange={(e) => setBlock(idx, { title: e.target.value })}
            placeholder="Block title"
            disabled={disabled}
            data-testid={`${testIdPrefix}-title-${idx}`}
          />
          <Textarea
            value={block.content}
            onChange={(e) => setBlock(idx, { content: e.target.value })}
            placeholder="Block content — use {{placeholder}} for variables"
            rows={4}
            disabled={disabled}
            data-testid={`${testIdPrefix}-content-${idx}`}
          />
          <div className="flex items-center gap-2">
            <Switch
              checked={block.mandatory}
              onCheckedChange={(on) => setBlock(idx, { mandatory: on })}
              disabled={disabled}
              aria-label="Mandatory block"
              data-testid={`${testIdPrefix}-mandatory-${idx}`}
            />
            <span className="text-sm text-muted-foreground">
              Mandatory (users cannot override)
            </span>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...blocks, newBlockDraft(true)])}
          data-testid={`${testIdPrefix}-add-mandatory`}
        >
          <Plus className="h-4 w-4 mr-1" /> Mandatory block
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...blocks, newBlockDraft(false)])}
          data-testid={`${testIdPrefix}-add-editable`}
        >
          <Plus className="h-4 w-4 mr-1" /> Editable block
        </Button>
      </div>
    </div>
  );
}
