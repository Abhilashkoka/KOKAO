import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdminGetAiCostConfigQueryKey,
  getAdminGetAiCostReportQueryKey,
  getAdminListAuditLogsQueryKey,
  getAdminListWalletPendingPricesQueryKey,
  type AiModelPriceImportPreview,
  type AiModelPriceImportVariant,
  useAdminConfirmAiModelPriceImport,
  useAdminListWalletPendingPrices,
  useAdminPreviewAiModelPriceImport,
} from "@workspace/api-client-react";
import { ExternalLink, Loader2 } from "lucide-react";

import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export type ModelPriceKind = "text" | "image" | "video";

interface ModelPriceImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKind?: ModelPriceKind;
  initialProvider?: string | null;
  initialModel?: string | null;
  enforceTarget?: boolean;
  selectPendingTarget?: boolean;
}

interface PendingPriceTarget {
  id: string;
  kind: ModelPriceKind;
  provider: string | null;
  model: string;
}

const valueOrNull = (value: string): number | null =>
  value.trim() === "" ? null : Number(value);

const valueFromPrice = (value: number | null) => (value === null ? "" : String(value));

function usageKindToPriceKind(usageKind: string): ModelPriceKind | null {
  if (usageKind === "caption") return "text";
  if (usageKind === "image" || usageKind === "video") return usageKind;
  return null;
}

export function ModelPriceImportDialog({
  open,
  onOpenChange,
  initialKind = "text",
  initialProvider,
  initialModel,
  enforceTarget = false,
  selectPendingTarget = false,
}: ModelPriceImportDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: pendingPrices } = useAdminListWalletPendingPrices({
    query: {
      queryKey: getAdminListWalletPendingPricesQueryKey(),
      enabled: open && selectPendingTarget,
    },
  });
  const previewPrice = useAdminPreviewAiModelPriceImport();
  const confirmPrice = useAdminConfirmAiModelPriceImport();
  const [sourceUrl, setSourceUrl] = useState("");
  const [kind, setKind] = useState<ModelPriceKind>(initialKind);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [preview, setPreview] = useState<AiModelPriceImportPreview | null>(null);
  const [error, setError] = useState("");
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [imageUsd, setImageUsd] = useState("");
  const [secondUsd, setSecondUsd] = useState("");
  const [videoUsd, setVideoUsd] = useState("");
  const [variants, setVariants] = useState<AiModelPriceImportVariant[]>([]);

  const fixedTarget = useMemo<PendingPriceTarget | null>(() => {
    if (!enforceTarget || !initialModel?.trim()) return null;
    return {
      id: "fixed",
      kind: initialKind,
      provider: initialProvider ?? null,
      model: initialModel.trim(),
    };
  }, [enforceTarget, initialKind, initialModel, initialProvider]);

  const pendingTargets = useMemo(() => {
    const seen = new Set<string>();
    return (pendingPrices ?? []).flatMap<PendingPriceTarget>((pending) => {
      const targetKind = usageKindToPriceKind(pending.usageKind);
      if (pending.reason !== "no_price" || !pending.model || !targetKind) return [];
      const id = `${targetKind}:${pending.provider ?? ""}:${pending.model}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [{
        id,
        kind: targetKind,
        provider: pending.provider,
        model: pending.model,
      }];
    });
  }, [pendingPrices]);

  const selectedTarget = pendingTargets.find((target) => target.id === selectedTargetId) ?? null;
  const target = fixedTarget ?? selectedTarget;
  const requiresTarget = enforceTarget || selectPendingTarget;

  useEffect(() => {
    if (!open) return;
    setSourceUrl("");
    setKind(fixedTarget?.kind ?? initialKind);
    setSelectedTargetId("");
    setPreview(null);
    setError("");
    setInputUsd("");
    setOutputUsd("");
    setImageUsd("");
    setSecondUsd("");
    setVideoUsd("");
    setVariants([]);
  }, [open, initialKind, fixedTarget]);

  const targetMismatch = useMemo(() => {
    if (!preview || !requiresTarget || !target) return false;
    const providerMismatch =
      Boolean(target.provider?.trim()) &&
      preview.provider.toLowerCase() !== target.provider!.trim().toLowerCase();
    const modelMismatch =
      preview.model.toLowerCase() !== target.model.trim().toLowerCase();
    return providerMismatch || modelMismatch;
  }, [preview, requiresTarget, target]);

  const prices = {
    inputUsdPerMtok: valueOrNull(inputUsd),
    outputUsdPerMtok: valueOrNull(outputUsd),
    usdPerImage: valueOrNull(imageUsd),
    usdPerSecond: valueOrNull(secondUsd),
    usdPerVideo: valueOrNull(videoUsd),
  };
  const enteredValues = Object.values(prices).filter((value) => value !== null);
  const numbersValid = enteredValues.every(
    (value) => Number.isFinite(value) && (value ?? -1) >= 0,
  );
  const hasTokenPair =
    prices.inputUsdPerMtok !== null && prices.outputUsdPerMtok !== null;
  const priceComplete =
    numbersValid &&
    (kind === "text"
      ? hasTokenPair
      : kind === "image"
        ? prices.usdPerImage !== null || hasTokenPair
        : prices.usdPerSecond !== null || prices.usdPerVideo !== null);

  const clearPreview = () => {
    setPreview(null);
    setError("");
  };

  const applyPreview = (result: AiModelPriceImportPreview) => {
    setPreview(result);
    setInputUsd(valueFromPrice(result.inputUsdPerMtok));
    setOutputUsd(valueFromPrice(result.outputUsdPerMtok));
    setImageUsd(valueFromPrice(result.usdPerImage));
    setSecondUsd(valueFromPrice(result.usdPerSecond));
    setVideoUsd(valueFromPrice(result.usdPerVideo));
    setVariants(result.variants ?? []);
  };

  const handlePreview = () => {
    if (requiresTarget && !target) {
      setError("Choose a model with used generations that is missing a catalog price.");
      return;
    }
    if (!sourceUrl.trim()) {
      setError("Paste an official Replicate, OpenRouter, OpenAI, or Google Gemini model URL.");
      return;
    }
    setError("");
    setPreview(null);
    previewPrice.mutate(
      { data: { sourceUrl: sourceUrl.trim(), kind } },
      {
        onSuccess: applyPreview,
        onError: (requestError) =>
          setError(
            apiErrorMessage(
              requestError,
              "Could not detect a supported price from this model URL.",
            ),
          ),
      },
    );
  };

  const invalidatePricing = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostConfigQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostReportQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getAdminListWalletPendingPricesQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const handleConfirm = () => {
    if (!preview || !priceComplete || targetMismatch || (requiresTarget && !target)) return;
    setError("");
    confirmPrice.mutate(
      {
        data: {
          sourceUrl: preview.sourceUrl,
          provider: preview.provider,
          model: preview.model,
          kind: preview.kind,
          ...prices,
          variants,
        },
      },
      {
        onSuccess: () => {
          invalidatePricing();
          toast({
            title: "Model price imported",
            description: `${preview.provider} · ${preview.model} now uses the reviewed catalog price.`,
          });
          onOpenChange(false);
        },
        onError: (requestError) =>
          setError(
            apiErrorMessage(requestError, "Could not save the reviewed model price."),
          ),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import model price from URL</DialogTitle>
          <DialogDescription>
            Paste an official Replicate, OpenRouter, OpenAI, or Google Gemini model page.
            KOKAO reads that provider's public catalog, then lets you review the detected
            USD rate before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {selectPendingTarget ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Model requiring a price</label>
              <Select
                value={selectedTargetId}
                onValueChange={(value) => {
                  const nextTarget = pendingTargets.find((candidate) => candidate.id === value);
                  setSelectedTargetId(value);
                  if (nextTarget) setKind(nextTarget.kind);
                  clearPreview();
                }}
              >
                <SelectTrigger data-testid="select-import-price-target">
                  <SelectValue placeholder="Choose a used model with no catalog price" />
                </SelectTrigger>
                <SelectContent>
                  {pendingTargets.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.provider ?? "unknown provider"} · {candidate.model} ({candidate.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pendingTargets.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  There are no used models currently missing a catalog price.
                </p>
              )}
            </div>
          ) : target ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Pricing target:{" "}
              <span className="font-medium text-foreground">
                {target.provider ?? "unknown provider"} · {target.model}
              </span>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={kind}
                disabled={requiresTarget}
                onValueChange={(value) => {
                  setKind(value as ModelPriceKind);
                  clearPreview();
                }}
              >
                <SelectTrigger data-testid="select-import-price-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="import-price-url">
                Official model page URL
              </label>
              <Input
                id="import-price-url"
                type="url"
                placeholder="https://developers.openai.com/api/docs/models/gpt-image-1"
                value={sourceUrl}
                disabled={requiresTarget && !target}
                onChange={(event) => {
                  setSourceUrl(event.target.value);
                  clearPreview();
                }}
                data-testid="input-import-price-url"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Only plain HTTPS model pages on the supported official provider hosts are supported.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={handlePreview}
              disabled={previewPrice.isPending || !sourceUrl.trim() || (requiresTarget && !target)}
              data-testid="button-preview-import-price"
            >
              {previewPrice.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {previewPrice.isPending ? "Reading price…" : "Read price"}
            </Button>
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
              data-testid="text-import-price-error"
            >
              {error}
            </p>
          )}

          {preview && (
            <div className="space-y-4 rounded-lg border p-4" data-testid="panel-import-price-preview">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{preview.kind}</Badge>
                <span className="font-medium">{preview.provider}</span>
                <span className="text-sm text-muted-foreground">{preview.model}</span>
                <a
                  href={preview.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  View source <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              {preview.warnings.map((warning) => (
                <p
                  key={warning}
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
                >
                  {warning} You can enter the published amount manually before confirming.
                </p>
              ))}
              {targetMismatch && (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="text-import-price-mismatch"
                >
                  This URL is for {preview.provider} · {preview.model}, but the
                  selected pending price is {target?.provider ?? "unknown provider"} ·{" "}
                  {target?.model ?? "unknown model"}. Use that exact provider model’s
                  official page instead.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {preview.kind === "image" && (
                  <PriceInput
                    id="import-price-image"
                    label="$ / image"
                    value={imageUsd}
                    onChange={setImageUsd}
                  />
                )}
                {preview.kind === "video" ? (
                  <>
                    <PriceInput
                      id="import-price-second"
                      label="$ / second"
                      value={secondUsd}
                      onChange={setSecondUsd}
                    />
                    <PriceInput
                      id="import-price-video"
                      label="$ / video"
                      value={videoUsd}
                      onChange={setVideoUsd}
                    />
                  </>
                ) : (
                  <>
                    <PriceInput
                      id="import-price-input"
                      label="$ / 1M input tokens"
                      value={inputUsd}
                      onChange={setInputUsd}
                    />
                    <PriceInput
                      id="import-price-output"
                      label="$ / 1M output tokens"
                      value={outputUsd}
                      onChange={setOutputUsd}
                    />
                  </>
                )}
              </div>
              {preview.kind === "video" && variants.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Published price variants</p>
                  {variants.map((variant, index) => (
                    <div key={index} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        {Object.entries(variant.criteria)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(" · ")}
                      </p>
                      <PriceInput
                        id={`import-price-variant-second-${index}`}
                        label="$ / second"
                        value={valueFromPrice(variant.usdPerSecond)}
                        onChange={(value) =>
                          setVariants((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, usdPerSecond: valueOrNull(value) }
                                : item,
                            ),
                          )
                        }
                      />
                      <PriceInput
                        id={`import-price-variant-video-${index}`}
                        label="$ / video"
                        value={valueFromPrice(variant.usdPerVideo)}
                        onChange={(value) =>
                          setVariants((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, usdPerVideo: valueOrNull(value) }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              {!priceComplete && (
                <p className="text-xs text-destructive">
                  Enter a complete non-negative price for this model type before confirming.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={
              !preview ||
              !priceComplete ||
              targetMismatch ||
              (requiresTarget && !target) ||
              confirmPrice.isPending
            }
            data-testid="button-confirm-import-price"
          >
            {confirmPrice.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmPrice.isPending ? "Saving…" : "Confirm and save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.000001"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${id}`}
      />
    </div>
  );
}