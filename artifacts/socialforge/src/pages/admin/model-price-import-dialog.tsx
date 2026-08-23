import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdminGetAiCostConfigQueryKey,
  getAdminGetAiCostReportQueryKey,
  getAdminListAuditLogsQueryKey,
  getAdminListWalletPendingPricesQueryKey,
  type AiModelPriceImportPreview,
  useAdminConfirmAiModelPriceImport,
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
}

const valueOrNull = (value: string): number | null =>
  value.trim() === "" ? null : Number(value);

const valueFromPrice = (value: number | null) => (value === null ? "" : String(value));

export function ModelPriceImportDialog({
  open,
  onOpenChange,
  initialKind = "text",
  initialProvider,
  initialModel,
  enforceTarget = false,
}: ModelPriceImportDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const previewPrice = useAdminPreviewAiModelPriceImport();
  const confirmPrice = useAdminConfirmAiModelPriceImport();
  const [sourceUrl, setSourceUrl] = useState("");
  const [kind, setKind] = useState<ModelPriceKind>(initialKind);
  const [preview, setPreview] = useState<AiModelPriceImportPreview | null>(null);
  const [error, setError] = useState("");
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [imageUsd, setImageUsd] = useState("");
  const [secondUsd, setSecondUsd] = useState("");
  const [videoUsd, setVideoUsd] = useState("");

  useEffect(() => {
    if (!open) return;
    setSourceUrl("");
    setKind(initialKind);
    setPreview(null);
    setError("");
    setInputUsd("");
    setOutputUsd("");
    setImageUsd("");
    setSecondUsd("");
    setVideoUsd("");
  }, [open, initialKind, initialProvider, initialModel]);

  const targetMismatch = useMemo(() => {
    if (!preview || !enforceTarget) return false;
    const providerMismatch =
      Boolean(initialProvider?.trim()) &&
      preview.provider.toLowerCase() !== initialProvider!.trim().toLowerCase();
    const modelMismatch =
      Boolean(initialModel?.trim()) &&
      preview.model.toLowerCase() !== initialModel!.trim().toLowerCase();
    return providerMismatch || modelMismatch;
  }, [preview, enforceTarget, initialProvider, initialModel]);

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
  };

  const handlePreview = () => {
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
    if (!preview || !priceComplete || targetMismatch) return;
    setError("");
    confirmPrice.mutate(
      {
        data: {
          sourceUrl: preview.sourceUrl,
          provider: preview.provider,
          model: preview.model,
          kind: preview.kind,
          ...prices,
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
          {(initialProvider || initialModel) && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Pricing target:{" "}
              <span className="font-medium text-foreground">
                {initialProvider ?? "unknown provider"} · {initialModel ?? "unknown model"}
              </span>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={kind}
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
              disabled={previewPrice.isPending || !sourceUrl.trim()}
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
                  selected pending price is {initialProvider ?? "unknown provider"} ·{" "}
                  {initialModel ?? "unknown model"}. Use that exact provider model’s
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
            disabled={!preview || !priceComplete || targetMismatch || confirmPrice.isPending}
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