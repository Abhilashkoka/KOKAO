import { useMemo, useState } from "react";
import {
  useAdminGetAsrSettings,
  useAdminUpdateAsrSettings,
  useAdminSetAsrProviderKey,
  useAdminClearAsrProviderKey,
  getAdminGetAsrSettingsQueryKey,
  useAdminGetDesignSkill,
  useAdminUpdateDesignSkill,
  getAdminGetDesignSkillQueryKey,
  getAdminListAuditLogsQueryKey,
  useAdminGetImageGenSettings,
  useAdminUpdateImageGenSettings,
  useAdminSetImageGenProviderKey,
  useAdminClearImageGenProviderKey,
  getAdminGetImageGenSettingsQueryKey,
  useAdminGetVideoGenSettings,
  useAdminUpdateVideoGenSettings,
  useAdminSetVideoGenProviderKey,
  useAdminClearVideoGenProviderKey,
  useAdminSetStockSourceKey,
  useAdminClearStockSourceKey,
  getAdminGetVideoGenSettingsQueryKey,
  useAdminGetTextGenSettings,
  useAdminListTextGenModelPricing,
  getAdminListTextGenModelPricingQueryKey,
  useAdminListVideoModelPricing,
  getAdminListVideoModelPricingQueryKey,
  useAdminUpdateTextGenSettings,
  useAdminSetTextGenKey,
  useAdminClearTextGenKey,
  getAdminGetTextGenSettingsQueryKey,
  useAdminListCustomAiProviders,
  useAdminCreateCustomAiProvider,
  useAdminUpdateCustomAiProvider,
  useAdminDeleteCustomAiProvider,
  useAdminTestCustomAiProvider,
  getAdminListCustomAiProvidersQueryKey,
  getListAiModelsQueryKey,
  useAdminGetAiSpendSettings,
  useAdminUpdateAiSpendSettings,
  getAdminGetAiSpendSettingsQueryKey,
  getGetAiSpendRatesQueryKey,
  useAdminGetAiCostConfig,
  useAdminUpdateAiCostRate,
  useAdminUpdateAiCostMarkup,
  useAdminRefreshAiCostRate,
  useAdminUpsertAiModelPrice,
  useAdminDeleteAiModelPrice,
  useAdminDedupeAiModelPrices,
  useAdminGetAiCostReport,
  useAdminGetAiCostCampaigns,
  getAdminGetAiCostConfigQueryKey,
  getAdminGetAiCostReportQueryKey,
  getAdminGetAiCostCampaignsQueryKey,
  getListNotificationsQueryKey,
  type CustomVideoApiMapping,
} from "@workspace/api-client-react";
import { useFeatureFlags } from "@/lib/features";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { ExternalLink } from "lucide-react";
import { CollapsibleCardHeader } from "@/components/ui/collapsible-card-header";
import { WalletCard } from "./wallet-card";

const ASR_KEY_PAGES: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  deepgram: "https://console.deepgram.com/",
  assemblyai: "https://www.assemblyai.com/app/api-keys",
};

function AsrProviderCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetAsrSettings();
  const updateSettings = useAdminUpdateAsrSettings();
  const setKey = useAdminSetAsrProviderKey();
  const clearKey = useAdminClearAsrProviderKey();
  const [keyInput, setKeyInput] = useState("");

  const invalidateAsr = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetAsrSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const handleSaveKey = (providerId: string) => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setKey.mutate(
      { providerId, data: { apiKey } },
      {
        onSuccess: () => {
          invalidateAsr();
          setKeyInput("");
          toast({
            title: "API key saved",
            description: "The key is stored encrypted and is now in use.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleClearKey = (providerId: string) => {
    clearKey.mutate(
      { providerId },
      {
        onSuccess: () => {
          invalidateAsr();
          toast({
            title: "API key removed",
            description: "The saved key was deleted.",
          });
        },
        onError: () => {
          toast({
            title: "Remove failed",
            description: "Could not remove the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSelect = (provider: string) => {
    if (!settings || provider === settings.provider) return;
    updateSettings.mutate(
      { data: { provider } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getAdminGetAsrSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
          const chosen = result.providers.find((p) => p.id === result.provider);
          toast({
            title: "Speech-to-text provider updated",
            description: chosen
              ? `Voice notes are now transcribed with ${chosen.label}.`
              : "Provider selection saved.",
          });
        },
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not change the speech-to-text provider.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const selected = settings?.providers.find((p) => p.id === settings.provider);

  return (
    <Card data-testid="card-asr-provider">
      <CardHeader>
        <CardTitle>Speech-to-Text Provider</CardTitle>
        <CardDescription>
          Which service transcribes voice notes in the Studio. Providers marked
          "needs key" require an API key — enter it below and it is stored
          encrypted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !settings ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Select
                value={settings.provider}
                onValueChange={handleSelect}
                disabled={updateSettings.isPending}
              >
                <SelectTrigger className="w-72" data-testid="select-asr-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {settings.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected &&
                (selected.configured ? (
                  <Badge variant="secondary">Ready</Badge>
                ) : (
                  <Badge variant="destructive">Needs key</Badge>
                ))}
            </div>
            {selected && selected.envKey && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">API key for {selected.label}</p>
                  {ASR_KEY_PAGES[selected.id] && (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      data-testid="button-get-asr-key"
                    >
                      <a
                        href={ASR_KEY_PAGES[selected.id]}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Get a {selected.label} key
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
                {selected.keySource === "database" ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-muted-foreground">
                      A key is saved (stored encrypted, never shown). Enter a new
                      one below to replace it.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleClearKey(selected.id)}
                      disabled={clearKey.isPending}
                      data-testid="button-remove-asr-key"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : selected.keySource === "env" ? (
                  <p className="text-sm text-muted-foreground">
                    Currently using the {selected.envKey} secret. A key entered
                    here takes priority over it.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No key set. Paste the provider's API key to enable it.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="w-72"
                    data-testid="input-asr-api-key"
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSaveKey(selected.id)}
                    disabled={setKey.isPending || !keyInput.trim()}
                    data-testid="button-save-asr-key"
                  >
                    {setKey.isPending ? "Saving..." : "Save key"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const IMAGE_GEN_KEY_PAGES: Record<string, string> = {
  gemini: "https://aistudio.google.com/apikey",
  bfl: "https://dashboard.bfl.ai/",
  stability: "https://platform.stability.ai/account/keys",
  replicate: "https://replicate.com/account/api-tokens",
};

/**
 * Sentinel stored in the provider column when the scorer should choose per
 * request. It is not a catalog id, so it never appears in `settings.providers`
 * and none of the model/key sections render for it.
 */
const IMAGE_GEN_AUTO = "auto";

/** Exported for its own test; rendered only from AiTab. */
export function ImageGenProviderCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetImageGenSettings();
  const updateSettings = useAdminUpdateImageGenSettings();
  const setKey = useAdminSetImageGenProviderKey();
  const clearKey = useAdminClearImageGenProviderKey();
  const [keyInput, setKeyInput] = useState("");
  const [modelInput, setModelInput] = useState<string | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetImageGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
    // Activating a model auto-syncs its price row, so refresh the cost card.
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostConfigQueryKey() });
  };

  const modelValue = modelInput ?? settings?.model ?? "";
  const baseUrlValue = baseUrlInput ?? settings?.customBaseUrl ?? "";

  const saveSelection = (provider: string, model: string, customBaseUrl: string) => {
    updateSettings.mutate(
      {
        data: {
          provider,
          model: model.trim() || null,
          customBaseUrl: customBaseUrl.trim() || null,
        },
      },
      {
        onSuccess: (result) => {
          invalidate();
          setDraftProvider(null);
          setModelInput(null);
          setBaseUrlInput(null);
          const chosen = result.providers.find((p) => p.id === result.provider);
          toast({
            title: "Image provider updated",
            description:
              result.provider === IMAGE_GEN_AUTO
                ? "Each image now goes to the best-scoring provider available."
                : chosen
                  ? `Images are now generated with ${chosen.label}.`
                  : "Provider selection saved.",
          });
          if (result.pricingWarning) {
            toast({ title: "Verify model pricing", description: result.pricingWarning });
          }
        },
        onError: (err: unknown) => {
          const message = apiErrorMessage(err, "Could not change the image generation provider.");
          toast({ title: "Update failed", description: message, variant: "destructive" });
        },
      },
    );
  };

  const handleSelect = (provider: string) => {
    if (!settings) return;
    if (provider === settings.provider) {
      // Reverting to the saved provider just discards any unsaved draft.
      setDraftProvider(null);
      setModelInput(null);
      setBaseUrlInput(null);
      return;
    }
    const def = settings.providers.find((p) => p.id === provider);
    // Switching providers resets any model override to that provider's default.
    setModelInput(null);
    if (def?.requiresBaseUrl) {
      // The custom provider needs model + base URL first; wait for Save settings.
      setDraftProvider(provider);
      return;
    }
    setDraftProvider(null);
    saveSelection(provider, "", baseUrlValue);
  };

  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const { flags } = useFeatureFlags();
  const effectiveProvider = draftProvider ?? settings?.provider ?? "openai";
  const isAuto = effectiveProvider === IMAGE_GEN_AUTO && flags.providerScoring;
  const shown = settings?.providers.find((p) => p.id === effectiveProvider);

  const handleSaveKey = (providerId: string) => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setKey.mutate(
      { providerId, data: { apiKey } },
      {
        onSuccess: () => {
          invalidate();
          setKeyInput("");
          toast({
            title: "API key saved",
            description: "The key is stored encrypted and is now in use.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleClearKey = (providerId: string) => {
    clearKey.mutate(
      { providerId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "API key removed", description: "The saved key was deleted." });
        },
        onError: () => {
          toast({
            title: "Remove failed",
            description: "Could not remove the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const isDraft = draftProvider !== null && draftProvider !== settings?.provider;
  const needsSaveButton = isDraft || Boolean(shown?.supportsModelOverride);

  return (
    <Card data-testid="card-image-gen-provider">
      <CardHeader>
        <CardTitle>Image Generation Provider</CardTitle>
        <CardDescription>
          Which service creates images in the Studio. Auto scores every
          configured provider per request and falls back down the ranking when
          one fails. The built-in OpenAI option needs no key. Other providers use
          your own API key (stored encrypted). The Custom option works with any
          OpenAI-compatible provider — enter its base URL and model name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !settings ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Select
                value={effectiveProvider}
                onValueChange={handleSelect}
                disabled={updateSettings.isPending}
              >
                <SelectTrigger className="w-72" data-testid="select-image-gen-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {flags.providerScoring && (
                    <SelectItem value={IMAGE_GEN_AUTO}>
                      Auto — best scoring provider
                    </SelectItem>
                  )}
                  {settings.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isAuto ? (
                <Badge variant="secondary">Ranked per request</Badge>
              ) : (
                shown &&
                (isDraft ? (
                  <Badge variant="outline">Not saved yet</Badge>
                ) : shown.configured ? (
                  <Badge variant="secondary">Ready</Badge>
                ) : (
                  <Badge variant="destructive">Needs key</Badge>
                ))
              )}
            </div>
            {isAuto && (
              <div className="space-y-2 rounded-md border p-3" data-testid="image-gen-auto-ranking">
                <p className="text-sm font-medium">Current ranking</p>
                {settings.autoRanking.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No provider is configured yet, so there is nothing to rank.
                    Add a key to any provider above.
                  </p>
                ) : (
                  <>
                    <ul className="space-y-1.5">
                      {settings.autoRanking.map((r, i) => (
                        <li
                          key={r.id}
                          className="flex items-baseline justify-between gap-3 text-sm"
                          data-testid={`ranking-row-${r.id}`}
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="text-muted-foreground tabular-nums">
                              {i + 1}.
                            </span>
                            <span className="font-medium">{r.label}</span>
                            {!r.healthy && (
                              <Badge variant="outline" className="text-xs">
                                Cooling off
                              </Badge>
                            )}
                          </span>
                          <span className="text-right text-xs text-muted-foreground">
                            {r.reason} · {Math.round(r.score * 100)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      Scored on recent success rate, observed speed, price, and
                      picture quality. Recomputed on every generation, so this
                      order shifts as providers succeed or fail.
                    </p>
                  </>
                )}
              </div>
            )}
            {shown && (shown.supportsModelOverride || shown.requiresBaseUrl) && (
              <div className="space-y-2 rounded-md border p-3">
                {shown.requiresBaseUrl && (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Base URL</p>
                    <Input
                      placeholder="https://api.example.com/v1"
                      value={baseUrlValue}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      className="w-96"
                      data-testid="input-image-gen-base-url"
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-sm font-medium">Model</p>
                  {shown.modelOptions && shown.modelOptions.length > 0 && (
                    <Select
                      value={
                        shown.modelOptions.some((o) => o.value === (modelValue || shown.defaultModel))
                          ? modelValue || shown.defaultModel
                          : ""
                      }
                      onValueChange={(value) => setModelInput(value)}
                    >
                      <SelectTrigger className="w-96" data-testid="select-image-gen-model">
                        <SelectValue placeholder="Pick a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {shown.modelOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    placeholder={shown.defaultModel || "model-name"}
                    value={modelValue}
                    onChange={(e) => setModelInput(e.target.value)}
                    className="w-96"
                    data-testid="input-image-gen-model"
                  />
                  {shown.defaultModel && (
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use the default: {shown.defaultModel}
                    </p>
                  )}
                </div>
                {needsSaveButton && (
                  <Button
                    size="sm"
                    onClick={() => saveSelection(effectiveProvider, modelValue, baseUrlValue)}
                    disabled={updateSettings.isPending}
                    data-testid="button-save-image-gen-settings"
                  >
                    {updateSettings.isPending ? "Saving..." : "Save settings"}
                  </Button>
                )}
              </div>
            )}
            {shown && shown.envKey && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">API key for {shown.label}</p>
                  {IMAGE_GEN_KEY_PAGES[shown.id] && (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      data-testid="button-get-image-gen-key"
                    >
                      <a
                        href={IMAGE_GEN_KEY_PAGES[shown.id]}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Get a {shown.label} key
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
                {shown.keySource === "database" ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-muted-foreground">
                      A key is saved (stored encrypted, never shown). Enter a new
                      one below to replace it.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleClearKey(shown.id)}
                      disabled={clearKey.isPending}
                      data-testid="button-remove-image-gen-key"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : shown.keySource === "env" ? (
                  <p className="text-sm text-muted-foreground">
                    Currently using the {shown.envKey} secret. A key entered here
                    takes priority over it.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No key set. Paste the provider's API key to enable it.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="w-72"
                    data-testid="input-image-gen-api-key"
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSaveKey(shown.id)}
                    disabled={setKey.isPending || !keyInput.trim()}
                    data-testid="button-save-image-gen-key"
                  >
                    {setKey.isPending ? "Saving..." : "Save key"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const VIDEO_GEN_KEY_PAGES: Record<string, string> = {
  replicate: "https://replicate.com/account/api-tokens",
};

const STOCK_SOURCE_KEY_PAGES: Record<string, string> = {
  pexels: "https://www.pexels.com/api/",
  pixabay: "https://pixabay.com/api/docs/",
};

function StockSourcesCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetVideoGenSettings();
  const setKey = useAdminSetStockSourceKey();
  const clearKey = useAdminClearStockSourceKey();
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetVideoGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const handleSaveKey = (sourceId: string) => {
    const apiKey = (keyInputs[sourceId] ?? "").trim();
    if (!apiKey) return;
    setKey.mutate(
      { sourceId, data: { apiKey } },
      {
        onSuccess: () => {
          invalidate();
          setKeyInputs((prev) => ({ ...prev, [sourceId]: "" }));
          toast({
            title: "API key saved",
            description: "The key is stored encrypted and is now in use.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleClearKey = (sourceId: string) => {
    clearKey.mutate(
      { sourceId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "API key removed", description: "The saved key was deleted." });
        },
        onError: () => {
          toast({
            title: "Remove failed",
            description: "Could not remove the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-stock-sources">
      <CardHeader>
        <CardTitle>Stock Footage Sources</CardTitle>
        <CardDescription>
          API keys for the stock video libraries used by the Topic to Video
          engine. Free keys are available from both providers; configuring
          either one is enough (Pexels is preferred when both are set).
          Wikimedia Commons needs no key and backs them up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !settings ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          settings.stockSources.map((source) => (
            <div key={source.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{source.label}</p>
                  {source.keySource === "builtin" ? (
                    <Badge variant="outline">No key needed</Badge>
                  ) : source.configured ? (
                    <Badge variant="secondary">Ready</Badge>
                  ) : (
                    <Badge variant="destructive">Needs key</Badge>
                  )}
                </div>
                {STOCK_SOURCE_KEY_PAGES[source.id] && (
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    data-testid={`button-get-stock-key-${source.id}`}
                  >
                    <a
                      href={STOCK_SOURCE_KEY_PAGES[source.id]}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Get a {source.label} key
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
              </div>
              {source.keySource === "builtin" ? (
                <p className="text-sm text-muted-foreground">
                  Public domain and CC0 clips only — no account, no attribution.
                  Used when the keyed libraries are down or have nothing for a
                  topic, not instead of them.
                </p>
              ) : source.keySource === "database" ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    A key is saved (stored encrypted, never shown). Enter a new
                    one below to replace it.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleClearKey(source.id)}
                    disabled={clearKey.isPending}
                    data-testid={`button-remove-stock-key-${source.id}`}
                  >
                    Remove key
                  </Button>
                </div>
              ) : source.keySource === "env" ? (
                <p className="text-sm text-muted-foreground">
                  Currently using the {source.envKey} secret. A key entered here
                  takes priority over it.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No key set. Paste the provider's API key to enable it.
                </p>
              )}
              {source.keySource !== "builtin" && (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={keyInputs[source.id] ?? ""}
                    onChange={(e) =>
                      setKeyInputs((prev) => ({ ...prev, [source.id]: e.target.value }))
                    }
                    className="w-72"
                    data-testid={`input-stock-key-${source.id}`}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSaveKey(source.id)}
                    disabled={setKey.isPending || !(keyInputs[source.id] ?? "").trim()}
                    data-testid={`button-save-stock-key-${source.id}`}
                  >
                    {setKey.isPending ? "Saving..." : "Save key"}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function VideoGenProviderCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetVideoGenSettings();
  const updateSettings = useAdminUpdateVideoGenSettings();
  const setKey = useAdminSetVideoGenProviderKey();
  const clearKey = useAdminClearVideoGenProviderKey();
  const [keyInput, setKeyInput] = useState("");
  const [textModelInput, setTextModelInput] = useState<string | null>(null);
  const [imageModelInput, setImageModelInput] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetVideoGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
    // Activating a model auto-syncs its price row, so refresh the cost card.
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostConfigQueryKey() });
  };

  const textModelValue = textModelInput ?? settings?.textToVideoModel ?? "";
  const imageModelValue = imageModelInput ?? settings?.imageToVideoModel ?? "";

  const saveSelection = (provider: string, textModel: string, imageModel: string) => {
    updateSettings.mutate(
      {
        data: {
          provider,
          textToVideoModel: textModel.trim() || null,
          imageToVideoModel: imageModel.trim() || null,
        },
      },
      {
        onSuccess: (result) => {
          invalidate();
          setDraftProvider(null);
          setTextModelInput(null);
          setImageModelInput(null);
          const chosen = result.providers.find((p) => p.id === result.provider);
          toast({
            title: "Video settings updated",
            description: chosen
              ? `Videos are now generated with ${chosen.label}.`
              : "Provider selection saved.",
          });
          if (result.pricingWarning) {
            toast({ title: "Verify model pricing", description: result.pricingWarning });
          }
        },
        onError: (err: unknown) => {
          const message = apiErrorMessage(err, "Could not change the video generation settings.");
          toast({ title: "Update failed", description: message, variant: "destructive" });
        },
      },
    );
  };

  const handleSelect = (provider: string) => {
    if (!settings) return;
    if (provider === settings.provider) {
      setDraftProvider(null);
      setTextModelInput(null);
      setImageModelInput(null);
      return;
    }
    // Switching providers resets any model overrides to that provider's defaults.
    setTextModelInput(null);
    setImageModelInput(null);
    setDraftProvider(null);
    saveSelection(provider, "", "");
  };

  const effectiveProvider = draftProvider ?? settings?.provider ?? "replicate";
  const shown = settings?.providers.find((p) => p.id === effectiveProvider);

  // Live Replicate pricing for every model in either dropdown (scraped
  // server-side from replicate.com model pages; fail-soft nulls).
  const videoModelSlugs = [
    ...new Set(
      [
        ...(shown?.textModelOptions ?? []).map((o) => o.value),
        ...(shown?.imageModelOptions ?? []).map((o) => o.value),
      ].filter(Boolean),
    ),
  ];
  const videoPricingParams = { models: videoModelSlugs.join(",") };
  const { data: videoModelPricing } = useAdminListVideoModelPricing(videoPricingParams, {
    query: {
      // Orval partial options drop the generated key, so pass it explicitly.
      queryKey: getAdminListVideoModelPricingQueryKey(videoPricingParams),
      enabled: videoModelSlugs.length > 0 && effectiveProvider === "replicate",
      staleTime: 60 * 60 * 1000,
    },
  });
  const videoPriceFor = (model: string): string | null =>
    videoModelPricing?.find((p) => p.model === model)?.price ?? null;

  const handleSaveKey = (providerId: string) => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setKey.mutate(
      { providerId, data: { apiKey } },
      {
        onSuccess: () => {
          invalidate();
          setKeyInput("");
          toast({
            title: "API key saved",
            description: "The key is stored encrypted and is now in use.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleClearKey = (providerId: string) => {
    clearKey.mutate(
      { providerId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "API key removed", description: "The saved key was deleted." });
        },
        onError: () => {
          toast({
            title: "Remove failed",
            description: "Could not remove the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-video-gen-provider">
      <CardHeader>
        <CardTitle>Video Generation Provider</CardTitle>
        <CardDescription>
          Which service and models power the Studio's Video tab. "Text to Video"
          and "Animate Photo" each have their own model; the Slideshow engine
          runs locally and needs no AI model. Any Replicate model in
          owner/name form works.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !settings ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Select
                value={effectiveProvider}
                onValueChange={handleSelect}
                disabled={updateSettings.isPending}
              >
                <SelectTrigger className="w-72" data-testid="select-video-gen-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {settings.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {shown &&
                (shown.configured ? (
                  <Badge variant="secondary">Ready</Badge>
                ) : (
                  <Badge variant="destructive">Needs key</Badge>
                ))}
            </div>
            {shown && shown.supportsModelOverride && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Text to Video model</p>
                  {shown.textModelOptions && shown.textModelOptions.length > 0 && (
                    <Select
                      value={
                        shown.textModelOptions.some(
                          (o) => o.value === (textModelValue || shown.defaultTextToVideoModel),
                        )
                          ? textModelValue || shown.defaultTextToVideoModel
                          : ""
                      }
                      onValueChange={(value) => setTextModelInput(value)}
                    >
                      <SelectTrigger className="w-96" data-testid="select-video-gen-text-model">
                        <SelectValue placeholder="Pick a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {shown.textModelOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            <span className="flex flex-col items-start">
                              <span>{o.label}</span>
                              {videoPriceFor(o.value) && (
                                <span className="text-xs text-muted-foreground">
                                  {videoPriceFor(o.value)}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    placeholder={shown.defaultTextToVideoModel || "owner/model-name"}
                    value={textModelValue}
                    onChange={(e) => setTextModelInput(e.target.value)}
                    className="w-96"
                    data-testid="input-video-gen-text-model"
                  />
                  {shown.defaultTextToVideoModel && (
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use the default: {shown.defaultTextToVideoModel}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Animate Photo model</p>
                  {shown.imageModelOptions && shown.imageModelOptions.length > 0 && (
                    <Select
                      value={
                        shown.imageModelOptions.some(
                          (o) => o.value === (imageModelValue || shown.defaultImageToVideoModel),
                        )
                          ? imageModelValue || shown.defaultImageToVideoModel
                          : ""
                      }
                      onValueChange={(value) => setImageModelInput(value)}
                    >
                      <SelectTrigger className="w-96" data-testid="select-video-gen-image-model">
                        <SelectValue placeholder="Pick a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {shown.imageModelOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            <span className="flex flex-col items-start">
                              <span>{o.label}</span>
                              {videoPriceFor(o.value) && (
                                <span className="text-xs text-muted-foreground">
                                  {videoPriceFor(o.value)}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    placeholder={shown.defaultImageToVideoModel || "owner/model-name"}
                    value={imageModelValue}
                    onChange={(e) => setImageModelInput(e.target.value)}
                    className="w-96"
                    data-testid="input-video-gen-image-model"
                  />
                  {shown.defaultImageToVideoModel && (
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use the default: {shown.defaultImageToVideoModel}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => saveSelection(effectiveProvider, textModelValue, imageModelValue)}
                  disabled={updateSettings.isPending}
                  data-testid="button-save-video-gen-settings"
                >
                  {updateSettings.isPending ? "Saving..." : "Save settings"}
                </Button>
              </div>
            )}
            {shown && shown.envKey && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">API key for {shown.label}</p>
                  {VIDEO_GEN_KEY_PAGES[shown.id] && (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      data-testid="button-get-video-gen-key"
                    >
                      <a
                        href={VIDEO_GEN_KEY_PAGES[shown.id]}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Get a {shown.label} key
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                      </a>
                    </Button>
                  )}
                </div>
                {shown.keySource === "database" ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-muted-foreground">
                      A key is saved (stored encrypted, never shown). Enter a new
                      one below to replace it.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleClearKey(shown.id)}
                      disabled={clearKey.isPending}
                      data-testid="button-remove-video-gen-key"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : shown.keySource === "env" ? (
                  <p className="text-sm text-muted-foreground">
                    Currently using the {shown.envKey} secret. A key entered here
                    takes priority over it.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No key set. Paste the provider's API key to enable it.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="w-72"
                    data-testid="input-video-gen-api-key"
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSaveKey(shown.id)}
                    disabled={setKey.isPending || !keyInput.trim()}
                    data-testid="button-save-video-gen-key"
                  >
                    {setKey.isPending ? "Saving..." : "Save key"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TextGenProviderCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetTextGenSettings();
  const updateSettings = useAdminUpdateTextGenSettings();
  const setKey = useAdminSetTextGenKey();
  const clearKey = useAdminClearTextGenKey();
  const [keyInput, setKeyInput] = useState("");
  const [modelsInput, setModelsInput] = useState<string | null>(null);
  const [defaultModelInput, setDefaultModelInput] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetTextGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAiModelsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
    // Activating a model auto-syncs its price row, so refresh the cost card.
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostConfigQueryKey() });
  };

  const effectiveProvider = draftProvider ?? settings?.provider ?? "builtin";
  const modelsValue = modelsInput ?? (settings?.models ?? []).join("\n");
  const modelList = modelsValue
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const defaultModelValue = defaultModelInput ?? settings?.defaultModel ?? "";
  const isDraft = draftProvider !== null && draftProvider !== settings?.provider;

  // Live provider pricing for the models being edited (works on unsaved
  // drafts too). Fail-soft: unknown models simply show no price.
  const pricingParams = {
    models: modelList.join(","),
    provider: effectiveProvider === "replicate" ? ("replicate" as const) : ("openrouter" as const),
  };
  const { data: modelPricing } = useAdminListTextGenModelPricing(pricingParams, {
    query: {
      // Orval partial options drop the generated key, so pass it explicitly.
      queryKey: getAdminListTextGenModelPricingQueryKey(pricingParams),
      enabled:
        modelList.length > 0 &&
        (effectiveProvider === "openrouter" || effectiveProvider === "replicate"),
    },
  });
  const priceFor = (model: string) => modelPricing?.find((p) => p.model === model);

  const saveSelection = (provider: string) => {
    updateSettings.mutate(
      {
        data: {
          provider: provider as "builtin" | "openrouter" | "replicate",
          models: provider !== "builtin" ? modelList : [],
          defaultModel:
            provider !== "builtin" ? defaultModelValue.trim() || null : null,
        },
      },
      {
        onSuccess: (result) => {
          invalidate();
          setDraftProvider(null);
          setModelsInput(null);
          setDefaultModelInput(null);
          toast({
            title: "Text generation provider updated",
            description:
              result.provider === "openrouter"
                ? "Captions and other text are now generated through OpenRouter."
                : result.provider === "replicate"
                  ? "Captions and other text are now generated through Replicate."
                  : result.provider.startsWith("custom:")
                    ? "Captions and other text are now generated through your custom provider."
                    : "Captions and other text now use the built-in provider.",
          });
          if (result.pricingWarning) {
            toast({ title: "Verify model pricing", description: result.pricingWarning });
          }
        },
        onError: (err: unknown) => {
          const message = apiErrorMessage(err, "Could not change the text generation provider.");
          toast({ title: "Update failed", description: message, variant: "destructive" });
        },
      },
    );
  };

  const handleSelect = (provider: string) => {
    if (!settings) return;
    if (provider === settings.provider) {
      setDraftProvider(null);
      return;
    }
    if (provider === "openrouter" || provider === "replicate" || provider.startsWith("custom:")) {
      // These need a key and a model list first; wait for Save settings.
      setDraftProvider(provider);
      return;
    }
    setDraftProvider(null);
    saveSelection(provider);
  };

  const handleSaveKey = () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setKey.mutate(
      { data: { apiKey } },
      {
        onSuccess: () => {
          invalidate();
          setKeyInput("");
          toast({
            title: "API key saved",
            description: "The key is stored encrypted and is now in use.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the API key.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleClearKey = () => {
    clearKey.mutate(undefined, {
      onSuccess: () => {
        invalidate();
        toast({ title: "API key removed", description: "The saved key was deleted." });
      },
      onError: () => {
        toast({
          title: "Remove failed",
          description: "Could not remove the API key.",
          variant: "destructive",
        });
      },
    });
  };

  const isReplicate = effectiveProvider === "replicate";
  const isCustom = effectiveProvider.startsWith("custom:");
  const showModelConfig = effectiveProvider === "openrouter" || isReplicate || isCustom;
  const showOpenRouterConfig = effectiveProvider === "openrouter";

  /** "In $0.15 / Out $0.60" from live pricing; placeholders while loading. */
  function formatModelPricing(
    p: { inputPerMTokens?: number | null; outputPerMTokens?: number | null } | undefined,
  ): string {
    if (!p) return "…";
    if (p.inputPerMTokens == null && p.outputPerMTokens == null) return "Pricing unavailable";
    const fmt = (v: number | null | undefined) => (v == null ? "—" : `$${v}`);
    return `In ${fmt(p.inputPerMTokens)} / Out ${fmt(p.outputPerMTokens)}`;
  }

  return (
    <Card data-testid="card-text-gen-provider">
      <CardHeader>
        <CardTitle>Text Generation Provider</CardTitle>
        <CardDescription>
          Which service writes captions, topics, and campaign text. The built-in
          option needs no key. OpenRouter uses your own API key (stored
          encrypted) and lets you choose which models users can pick. Replicate
          reuses the key you saved for video generation. Switching back to
          Built-in instantly restores the previous behavior.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !settings ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Select
                value={effectiveProvider}
                onValueChange={handleSelect}
                disabled={updateSettings.isPending}
              >
                <SelectTrigger className="w-72" data-testid="select-text-gen-provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="builtin">Built-in (OpenAI)</SelectItem>
                  <SelectItem value="openrouter">OpenRouter (your own key)</SelectItem>
                  <SelectItem value="replicate">Replicate (uses your video-gen key)</SelectItem>
                  {(settings.customProviders ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} (custom)
                    </SelectItem>
                  ))}
                  {/* Keep a saved custom selection selectable even if its
                      text toggle was turned off later. */}
                  {effectiveProvider.startsWith("custom:") &&
                    !(settings.customProviders ?? []).some((p) => p.id === effectiveProvider) && (
                      <SelectItem value={effectiveProvider}>
                        {effectiveProvider} (custom, disabled)
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              {isDraft ? (
                <Badge variant="outline">Not saved yet</Badge>
              ) : effectiveProvider === "builtin" || settings.keySource ? (
                <Badge variant="secondary">Ready</Badge>
              ) : (
                <Badge variant="destructive">Needs key</Badge>
              )}
            </div>
            {showModelConfig && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Models users can choose</p>
                  <p className="text-xs text-muted-foreground">
                    {isReplicate
                      ? "One Replicate language model per line, in owner/name form (for example openai/gpt-oss-20b or meta/meta-llama-3-70b-instruct). Copy slugs from replicate.com/collections/language-models."
                      : isCustom
                        ? "One model id per line, exactly as your provider's API expects it. Each model needs a manual price row in the AI Cost card before it can be activated."
                        : "One OpenRouter model id per line (for example openai/gpt-4o-mini or anthropic/claude-3.5-haiku). Copy ids from openrouter.ai/models."}
                  </p>
                  <textarea
                    className="w-96 min-h-24 rounded-md border bg-background p-2 text-sm font-mono"
                    placeholder={
                      isReplicate
                        ? "openai/gpt-oss-20b\nmeta/meta-llama-3-70b-instruct"
                        : "openai/gpt-4o-mini\nanthropic/claude-3.5-haiku"
                    }
                    value={modelsValue}
                    onChange={(e) => setModelsInput(e.target.value)}
                    data-testid="input-text-gen-models"
                  />
                  {modelList.length > 0 && (
                    <div className="w-96 space-y-0.5 pt-1" data-testid="list-text-gen-model-pricing">
                      {modelList.map((m) => (
                        <div
                          key={m}
                          className="flex items-baseline justify-between gap-3 text-xs"
                        >
                          <span className="font-mono truncate">{m}</span>
                          <span className="shrink-0 text-muted-foreground">
                            {formatModelPricing(priceFor(m))}
                          </span>
                        </div>
                      ))}
                      <p className="pt-1 text-xs text-muted-foreground">
                        Live prices from {isReplicate ? "replicate.com" : "openrouter.ai"}, USD per
                        1M tokens.
                      </p>
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Default model</p>
                  <Select
                    value={defaultModelValue || "__first__"}
                    onValueChange={(v) => setDefaultModelInput(v === "__first__" ? "" : v)}
                    disabled={modelList.length === 0}
                  >
                    <SelectTrigger className="w-96" data-testid="input-text-gen-default-model">
                      <SelectValue
                        placeholder={
                          modelList.length === 0 ? "Add models above first" : "Select a model"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__first__">
                        First listed model{modelList[0] ? ` (${modelList[0]})` : ""}
                      </SelectItem>
                      {modelList.map((m) => (
                        <SelectItem key={m} value={m}>
                          <span className="flex flex-col items-start">
                            <span>{m}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatModelPricing(priceFor(m))}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                      {/* Keep a previously saved default selectable even if it
                          was removed from the list above. */}
                      {defaultModelValue && !modelList.includes(defaultModelValue) && (
                        <SelectItem value={defaultModelValue}>
                          {defaultModelValue} (not in list)
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Used when a user's saved model is not in the list.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => saveSelection(isReplicate ? "replicate" : "openrouter")}
                  disabled={updateSettings.isPending}
                  data-testid="button-save-text-gen-settings"
                >
                  {updateSettings.isPending ? "Saving..." : "Save settings"}
                </Button>
              </div>
            )}
            {isReplicate && (
              <div className="space-y-2 rounded-md border p-3" data-testid="text-replicate-key-info">
                <p className="text-sm font-medium">Replicate API key</p>
                {settings.keySource ? (
                  <p className="text-sm text-muted-foreground">
                    Uses the Replicate key already saved for Video Generation
                    {settings.keySource === "env" ? ` (currently the ${settings.envKey} secret)` : ""}.
                    One key powers both video and text — manage it in the Video
                    Generation Provider card below.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No Replicate key found. Save one in the Video Generation
                    Provider card below — text generation reuses the same key.
                  </p>
                )}
              </div>
            )}
            {showOpenRouterConfig && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">OpenRouter API key</p>
                  <Button variant="outline" size="sm" asChild data-testid="button-get-text-gen-key">
                    <a
                      href="https://openrouter.ai/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Get an OpenRouter key
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
                {settings.keySource === "database" ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-muted-foreground">
                      A key is saved (stored encrypted, never shown). Enter a new
                      one below to replace it.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleClearKey}
                      disabled={clearKey.isPending}
                      data-testid="button-remove-text-gen-key"
                    >
                      Remove key
                    </Button>
                  </div>
                ) : settings.keySource === "env" ? (
                  <p className="text-sm text-muted-foreground">
                    Currently using the {settings.envKey} secret. A key entered
                    here takes priority over it.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No key set. Paste your OpenRouter API key to enable it.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste API key"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    className="w-72"
                    data-testid="input-text-gen-api-key"
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveKey}
                    disabled={setKey.isPending || !keyInput.trim()}
                    data-testid="button-save-text-gen-key"
                  >
                    {setKey.isPending ? "Saving..." : "Save key"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DesignSkillCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetDesignSkill();
  const updateSettings = useAdminUpdateDesignSkill();

  const handleToggle = (enabled: boolean) => {
    updateSettings.mutate(
      { data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetDesignSkillQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          toast({
            title: enabled ? "Design skill enabled" : "Design skill disabled",
            description: enabled
              ? "AI image prompts now go through the design skill for all users without an override."
              : "Users without an override now get plain image prompts.",
          });
        },
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not change the design skill setting.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-design-skill">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Design Skill</CardTitle>
          <CardDescription>
            When on, AI image generation first runs each prompt through a
            professional design pass (composition, typography, color) before
            creating the image. Brand kits are woven in automatically. You can
            override this per workspace in the tenants table in the Tenants tab.
          </CardDescription>
        </div>
        {isLoading ? (
          <Skeleton className="h-6 w-11" />
        ) : (
          <Switch
            checked={settings?.enabled ?? true}
            disabled={updateSettings.isPending}
            onCheckedChange={handleToggle}
            aria-label="Toggle the design skill for all users"
            data-testid="switch-design-skill-global"
          />
        )}
      </CardHeader>
    </Card>
  );
}

function AiSpendCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetAiSpendSettings();
  const updateSettings = useAdminUpdateAiSpendSettings();
  const [captionRupees, setCaptionRupees] = useState<string | null>(null);
  const [imageRupees, setImageRupees] = useState<string | null>(null);
  const [videoRupees, setVideoRupees] = useState<string | null>(null);
  const [feePercent, setFeePercent] = useState<string | null>(null);

  const paiseToRupees = (paise: number) => (paise / 100).toString();
  const captionValue = captionRupees ?? (settings ? paiseToRupees(settings.captionCostPaise) : "");
  const imageValue = imageRupees ?? (settings ? paiseToRupees(settings.imageCostPaise) : "");
  const videoValue = videoRupees ?? (settings ? paiseToRupees(settings.videoCostPaise) : "");
  const feeValue = feePercent ?? (settings ? String(settings.feePercent) : "");

  const handleSave = () => {
    const caption = Math.round(Number(captionValue) * 100);
    const image = Math.round(Number(imageValue) * 100);
    const video = Math.round(Number(videoValue) * 100);
    const fee = Math.round(Number(feeValue));
    if (
      [caption, image, video, fee].some((n) => !Number.isFinite(n) || n < 0) ||
      fee > 1000
    ) {
      toast({
        title: "Invalid values",
        description: "Costs must be 0 or more, and the fee must be between 0 and 1000 percent.",
        variant: "destructive",
      });
      return;
    }
    updateSettings.mutate(
      {
        data: {
          captionCostPaise: caption,
          imageCostPaise: image,
          videoCostPaise: video,
          feePercent: fee,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getAdminGetAiSpendSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAiSpendRatesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
          setCaptionRupees(null);
          setImageRupees(null);
          setVideoRupees(null);
          setFeePercent(null);
          toast({
            title: "AI spend rates saved",
            description:
              "Generated content now shows the combined amount (base cost plus your platform fee) as \u201CAI amount spent\u201D.",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the AI spend settings.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const preview = (basePaise: number, fee: number) =>
    `\u20B9${((Math.round(basePaise * (1 + fee / 100))) / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  const captionPaiseNow = Math.round(Number(captionValue || "0") * 100);
  const imagePaiseNow = Math.round(Number(imageValue || "0") * 100);
  const videoPaiseNow = Math.round(Number(videoValue || "0") * 100);
  const feeNow = Number(feeValue || "0");
  const previewsValid =
    [captionPaiseNow, imagePaiseNow, videoPaiseNow, feeNow].every(
      (n) => Number.isFinite(n) && n >= 0,
    );

  return (
    <Card data-testid="card-ai-spend">
      <CardHeader>
        <CardTitle>AI Spend Display</CardTitle>
        <CardDescription>
          Show an "AI amount spent" figure on every generated caption, image, campaign, and
          carousel. Users see one combined number: your base AI cost plus the platform fee
          percentage below. Set everything to 0 to show nothing, or turn the whole display off
          from Feature Controls on the Overview tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-spend-caption">
                  Cost per caption ({"\u20B9"})
                </label>
                <Input
                  id="ai-spend-caption"
                  type="number"
                  min="0"
                  step="0.01"
                  value={captionValue}
                  onChange={(e) => setCaptionRupees(e.target.value)}
                  data-testid="input-ai-spend-caption"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-spend-image">
                  Cost per image ({"\u20B9"})
                </label>
                <Input
                  id="ai-spend-image"
                  type="number"
                  min="0"
                  step="0.01"
                  value={imageValue}
                  onChange={(e) => setImageRupees(e.target.value)}
                  data-testid="input-ai-spend-image"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-spend-video">
                  Cost per video ({"\u20B9"})
                </label>
                <Input
                  id="ai-spend-video"
                  type="number"
                  min="0"
                  step="0.01"
                  value={videoValue}
                  onChange={(e) => setVideoRupees(e.target.value)}
                  data-testid="input-ai-spend-video"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-spend-fee">
                  Platform fee (%)
                </label>
                <Input
                  id="ai-spend-fee"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  value={feeValue}
                  onChange={(e) => setFeePercent(e.target.value)}
                  data-testid="input-ai-spend-fee"
                />
              </div>
            </div>
            {previewsValid && (
              <p className="text-sm text-muted-foreground" data-testid="text-ai-spend-preview">
                Users will see: {preview(captionPaiseNow, feeNow)} per caption,{" "}
                {preview(imagePaiseNow, feeNow)} per image, {preview(videoPaiseNow, feeNow)} per
                video (fee included, shown only as "AI amount spent").
              </p>
            )}
            <Button
              onClick={handleSave}
              disabled={updateSettings.isPending}
              data-testid="button-save-ai-spend"
            >
              Save AI spend rates
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const paiseToInr = (paise: number) =>
  `\u20B9${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Exported for its own test; rendered only from AiTab. */
export function AiCostCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useAdminGetAiCostConfig();
  // The same provider/model catalogs the selection dropdowns use, so the
  // price form can suggest exact spellings instead of relying on free typing.
  // These queries are already active elsewhere on this page, so this reads
  // from the cache rather than adding requests.
  const { data: textGenSettings } = useAdminGetTextGenSettings();
  const { data: imageGenSettings } = useAdminGetImageGenSettings();
  const { data: videoGenSettings } = useAdminGetVideoGenSettings();
  const updateRate = useAdminUpdateAiCostRate();
  const updateMarkup = useAdminUpdateAiCostMarkup();
  const refreshRate = useAdminRefreshAiCostRate();
  const upsertPrice = useAdminUpsertAiModelPrice();
  const deletePrice = useAdminDeleteAiModelPrice();
  const dedupePrices = useAdminDedupeAiModelPrices();

  const [rateInput, setRateInput] = useState<string | null>(null);
  const [markupInput, setMarkupInput] = useState<string | null>(null);
  const [kind, setKind] = useState<"text" | "image" | "video">("text");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [imageUsd, setImageUsd] = useState("");
  const [secondUsd, setSecondUsd] = useState("");
  const [videoUsd, setVideoUsd] = useState("");
  // Known provider ids and model names for the selected type, sourced from
  // the SAME catalogs the provider-selection dropdowns render. Shown as
  // datalist suggestions so prices get saved under spellings that lookups
  // will actually match (free text still allowed for unlisted models).
  const providerSuggestions = useMemo(() => {
    const ids: string[] = [];
    if (kind === "text") {
      ids.push("builtin", "openrouter", "replicate");
      for (const p of textGenSettings?.customProviders ?? []) ids.push(p.id);
    } else if (kind === "image") {
      for (const p of imageGenSettings?.providers ?? []) ids.push(p.id);
    } else {
      for (const p of videoGenSettings?.providers ?? []) ids.push(p.id);
    }
    return [...new Set(ids)];
  }, [kind, textGenSettings, imageGenSettings, videoGenSettings]);

  const modelSuggestions = useMemo(() => {
    const models: string[] = [];
    const typed = provider.trim().toLowerCase();
    if (kind === "text") {
      models.push(...(textGenSettings?.models ?? []));
      if (textGenSettings?.defaultModel) models.push(textGenSettings.defaultModel);
    } else if (kind === "image") {
      for (const p of imageGenSettings?.providers ?? []) {
        if (typed && p.id.toLowerCase() !== typed) continue;
        models.push(p.defaultModel);
        for (const o of p.modelOptions ?? []) models.push(o.value);
      }
    } else {
      for (const p of videoGenSettings?.providers ?? []) {
        if (typed && p.id.toLowerCase() !== typed) continue;
        models.push(p.defaultTextToVideoModel, p.defaultImageToVideoModel);
        for (const o of p.textModelOptions ?? []) models.push(o.value);
        for (const o of p.imageModelOptions ?? []) models.push(o.value);
      }
    }
    return [...new Set(models.filter(Boolean))];
  }, [kind, provider, textGenSettings, imageGenSettings, videoGenSettings]);

  // When editing an existing row, holds its id + original identity so a
  // provider/model rename can delete the old row after the upsert succeeds.
  const [editing, setEditing] = useState<{
    id: number;
    kind: "text" | "image" | "video";
    provider: string;
    model: string;
  } | null>(null);

  const resetPriceForm = () => {
    setEditing(null);
    setModel("");
    setProvider("");
    setInputUsd("");
    setOutputUsd("");
    setImageUsd("");
    setSecondUsd("");
    setVideoUsd("");
  };

  const rateValue =
    rateInput ?? (config ? (config.usdToInrPaise / 100).toString() : "");
  const markupValue =
    markupInput ?? (config ? (config.rateMarkupPaise / 100).toString() : "");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostConfigQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminGetAiCostReportQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const handleSaveRate = () => {
    const paise = Math.round(Number(rateValue) * 100);
    if (!Number.isFinite(paise) || paise < 0 || paise > 100000) {
      toast({
        title: "Invalid rate",
        description: "Enter the rupee value of 1 US dollar (0 to 1000).",
        variant: "destructive",
      });
      return;
    }
    updateRate.mutate(
      { data: { usdToInrPaise: paise } },
      {
        onSuccess: () => {
          invalidate();
          setRateInput(null);
          toast({ title: "Conversion rate saved" });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the conversion rate.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSaveMarkup = () => {
    const paise = Math.round(Number(markupValue) * 100);
    if (!Number.isFinite(paise) || paise < 0 || paise > 100000) {
      toast({
        title: "Invalid markup",
        description: "Enter the rupee markup added to the market rate (0 to 1000).",
        variant: "destructive",
      });
      return;
    }
    updateMarkup.mutate(
      { data: { rateMarkupPaise: paise } },
      {
        onSuccess: () => {
          invalidate();
          setMarkupInput(null);
          toast({
            title: "Markup saved",
            description: "It applies on the next refresh (or refresh now).",
          });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the markup.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleRefreshRate = () => {
    refreshRate.mutate(undefined, {
      onSuccess: () => {
        invalidate();
        // A successful refresh also resolves any fx_rate_stale alert
        // server-side — refetch the banner so it clears without a dismiss.
        queryClient.invalidateQueries({
          queryKey: getListNotificationsQueryKey(),
        });
        setRateInput(null);
        toast({ title: "Rate refreshed from the live market rate" });
      },
      onError: () => {
        toast({
          title: "Refresh failed",
          description:
            "Could not fetch the current USD→INR rate. The saved rate is unchanged.",
          variant: "destructive",
        });
      },
    });
  };

  const handleAddPrice = () => {
    const trimmedProvider = provider.trim();
    const trimmedModel = model.trim();
    if (!trimmedProvider || !trimmedModel) {
      toast({
        title: "Missing fields",
        description: "Provider and model are required.",
        variant: "destructive",
      });
      return;
    }
    const validNum = (s: string) => Number.isFinite(Number(s)) && Number(s) >= 0;
    const hasTokenPair = inputUsd.trim() !== "" && outputUsd.trim() !== "";
    const hasImagePrice = imageUsd.trim() !== "";
    const hasSecondPrice = secondUsd.trim() !== "";
    const hasVideoPrice = videoUsd.trim() !== "";
    const invalid =
      kind === "text"
        ? !validNum(inputUsd) || !validNum(outputUsd) || !hasTokenPair
        : kind === "image"
          ? // Image rows: flat $/image, token pair (OpenAI/Gemini image models), or both.
            (!hasImagePrice && !hasTokenPair) ||
            (hasImagePrice && !validNum(imageUsd)) ||
            (hasTokenPair && (!validNum(inputUsd) || !validNum(outputUsd))) ||
            (inputUsd.trim() !== "") !== (outputUsd.trim() !== "")
          : // Video rows: $/second (most Replicate video models), flat $/video, or both.
            (!hasSecondPrice && !hasVideoPrice) ||
            (hasSecondPrice && !validNum(secondUsd)) ||
            (hasVideoPrice && !validNum(videoUsd));
    if (invalid) {
      toast({
        title: "Invalid price",
        description:
          kind === "text"
            ? "Enter USD per 1M input and output tokens (0 or more)."
            : kind === "image"
              ? "Enter USD per image, or both token prices for models that report token usage."
              : "Enter USD per second of output video, USD per video, or both.",
        variant: "destructive",
      });
      return;
    }
    // Editing where the type/provider/model identity changed: the upsert
    // creates (or overwrites) the row under the NEW identity, so the old row
    // must be removed afterwards or both would linger in the catalog.
    // Compare the way the SERVER matches — trimmed and case-insensitive. A
    // case/whitespace-only edit is folded into the SAME row by the upsert, so
    // deleting the "old" row would delete the row that was just saved.
    const norm = (s: string) => s.trim().toLowerCase();
    const staleRow =
      editing &&
      (editing.kind !== kind ||
        norm(editing.provider) !== norm(trimmedProvider) ||
        norm(editing.model) !== norm(trimmedModel))
        ? editing
        : null;
    const wasEditing = editing !== null;
    upsertPrice.mutate(
      {
        data: {
          kind,
          provider: trimmedProvider,
          model: trimmedModel,
          inputUsdPerMtok: kind !== "video" && hasTokenPair ? Number(inputUsd) : null,
          outputUsdPerMtok: kind !== "video" && hasTokenPair ? Number(outputUsd) : null,
          usdPerImage: kind === "image" && hasImagePrice ? Number(imageUsd) : null,
          usdPerSecond: kind === "video" && hasSecondPrice ? Number(secondUsd) : null,
          usdPerVideo: kind === "video" && hasVideoPrice ? Number(videoUsd) : null,
        },
      },
      {
        onSuccess: () => {
          if (staleRow) {
            deletePrice.mutate(
              { priceId: staleRow.id },
              {
                onSettled: () => invalidate(),
                onError: () => {
                  toast({
                    title: "Old entry not removed",
                    description: `The price was saved under the new name, but the previous entry (${staleRow.provider} · ${staleRow.model}) could not be removed. Remove it manually.`,
                    variant: "destructive",
                  });
                },
              },
            );
          }
          invalidate();
          resetPriceForm();
          toast({ title: wasEditing ? "Model price updated" : "Model price saved" });
        },
        onError: () => {
          toast({
            title: "Save failed",
            description: "Could not save the model price.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDedupe = () => {
    dedupePrices.mutate(undefined, {
      onSuccess: (result) => {
        invalidate();
        toast({
          title:
            result.merged === 0
              ? "No duplicates found"
              : result.merged === 1
                ? "1 duplicate group merged"
                : `${result.merged} duplicate groups merged`,
          description:
            result.merged === 0
              ? "The price catalog is already clean."
              : "Rows differing only in case or whitespace were folded into one, keeping the newest prices.",
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Deduplicate failed",
          description: apiErrorMessage(err, "Could not merge duplicate price rows."),
          variant: "destructive",
        });
      },
    });
  };

  const handleDelete = (priceId: number) => {
    // Removing the row currently being edited would leave the form in a
    // stale "Update" mode pointing at a deleted id.
    if (editing?.id === priceId) resetPriceForm();
    deletePrice.mutate(
      { priceId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Model price removed" });
        },
        onError: () => {
          toast({
            title: "Remove failed",
            description: "Could not remove the model price.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-ai-cost">
      <CardHeader>
        <CardTitle>Actual AI Cost Tracking</CardTitle>
        <CardDescription>
          Record the real provider cost of every caption, image and video in paise. Costs use
          the USD prices below converted at your rate; generations from unknown models
          (or with no rate set) are stored with an unknown cost — nothing is guessed.
          This never changes what tenants see.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !config ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-cost-rate">
                  1 US dollar = ({"\u20B9"})
                </label>
                <Input
                  id="ai-cost-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-36"
                  value={rateValue}
                  onChange={(e) => setRateInput(e.target.value)}
                  data-testid="input-ai-cost-rate"
                />
              </div>
              <Button
                onClick={handleSaveRate}
                disabled={updateRate.isPending}
                data-testid="button-save-ai-cost-rate"
              >
                Save rate
              </Button>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="ai-cost-markup">
                  Markup ({"\u20B9"})
                </label>
                <Input
                  id="ai-cost-markup"
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-28"
                  value={markupValue}
                  onChange={(e) => setMarkupInput(e.target.value)}
                  data-testid="input-ai-cost-markup"
                />
              </div>
              <Button
                variant="outline"
                onClick={handleSaveMarkup}
                disabled={updateMarkup.isPending}
                data-testid="button-save-ai-cost-markup"
              >
                Save markup
              </Button>
              <Button
                variant="outline"
                onClick={handleRefreshRate}
                disabled={refreshRate.isPending}
                data-testid="button-refresh-ai-cost-rate"
              >
                {refreshRate.isPending ? "Refreshing…" : "Refresh now"}
              </Button>
              {config.usdToInrPaise === 0 && (
                <p className="text-sm text-destructive">
                  Rate unset — all costs are recorded as unknown.
                </p>
              )}
            </div>
            {config.rateAutoUpdatedAt &&
              Date.now() - new Date(config.rateAutoUpdatedAt).getTime() >
                3 * 24 * 60 * 60 * 1000 && (
                <p
                  className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="text-ai-cost-rate-stale"
                >
                  The daily rate refresh hasn't succeeded since{" "}
                  {new Date(config.rateAutoUpdatedAt).toLocaleString()} (over 3
                  days ago). AI cost figures are drifting on that old rate —
                  check the exchange-rate API or use Refresh now.
                </p>
              )}
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-ai-cost-rate-auto"
            >
              {config.rateAutoUpdatedAt && config.marketRatePaise !== null ? (
                <>
                  Auto-updated daily: market {paiseToInr(config.marketRatePaise)} +{" "}
                  {paiseToInr(config.rateMarkupPaise)} markup ={" "}
                  {paiseToInr(config.marketRatePaise + config.rateMarkupPaise)}. Last
                  refreshed {new Date(config.rateAutoUpdatedAt).toLocaleString()}.
                </>
              ) : (
                <>
                  The rate auto-updates daily from the live market rate plus your{" "}
                  {paiseToInr(config.rateMarkupPaise)} markup. No successful refresh
                  yet — use Refresh now, or the saved rate stays as-is.
                </>
              )}
            </p>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Model price catalog (USD)</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDedupe}
                  disabled={dedupePrices.isPending}
                  data-testid="button-dedupe-model-prices"
                >
                  {dedupePrices.isPending ? "Deduplicating…" : "Deduplicate"}
                </Button>
              </div>
              {config.duplicateGroups > 0 && (
                <p
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
                  data-testid="text-duplicate-price-hint"
                >
                  {config.duplicateGroups === 1
                    ? "1 possible duplicate"
                    : `${config.duplicateGroups} possible duplicates`}{" "}
                  — rows below differ only in letter case or whitespace and can
                  hold diverging prices.{" "}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-2"
                    onClick={handleDedupe}
                    disabled={dedupePrices.isPending}
                    data-testid="link-dedupe-model-prices"
                  >
                    Deduplicate
                  </button>
                </p>
              )}
              {config.prices.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-model-prices">
                  No model prices yet. Add the models you use below.
                </p>
              ) : (
                <div className="space-y-2">
                  {config.prices.map((p) => (
                    <div
                      key={p.id}
                      className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        p.isDuplicate ? "border-amber-500/60 bg-amber-500/5" : ""
                      }`}
                      data-testid={`row-model-price-${p.id}`}
                    >
                      <Badge variant="secondary">{p.kind}</Badge>
                      {p.isDuplicate && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/60 text-amber-700 dark:text-amber-400"
                          data-testid={`badge-duplicate-price-${p.id}`}
                        >
                          Duplicate
                        </Badge>
                      )}
                      <span className="font-medium">{p.provider}</span>
                      <span className="text-muted-foreground">{p.model}</span>
                      <span className="ml-auto text-muted-foreground">
                        {p.kind === "text"
                          ? `$${p.inputUsdPerMtok ?? 0} in / $${p.outputUsdPerMtok ?? 0} out per 1M tokens`
                          : p.kind === "video"
                            ? [
                                p.usdPerSecond !== null ? `$${p.usdPerSecond} per second` : null,
                                p.usdPerVideo !== null ? `$${p.usdPerVideo} per video` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : [
                                p.usdPerImage !== null ? `$${p.usdPerImage} per image` : null,
                                p.inputUsdPerMtok !== null && p.outputUsdPerMtok !== null
                                  ? `$${p.inputUsdPerMtok} in / $${p.outputUsdPerMtok} out per 1M tokens`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing({
                            id: p.id,
                            kind: p.kind as "text" | "image" | "video",
                            provider: p.provider,
                            model: p.model,
                          });
                          setKind(p.kind as "text" | "image" | "video");
                          setProvider(p.provider);
                          setModel(p.model);
                          setInputUsd(p.inputUsdPerMtok !== null ? String(p.inputUsdPerMtok) : "");
                          setOutputUsd(p.outputUsdPerMtok !== null ? String(p.outputUsdPerMtok) : "");
                          setImageUsd(p.usdPerImage !== null ? String(p.usdPerImage) : "");
                          setSecondUsd(p.usdPerSecond !== null ? String(p.usdPerSecond) : "");
                          setVideoUsd(p.usdPerVideo !== null ? String(p.usdPerVideo) : "");
                        }}
                        disabled={upsertPrice.isPending || deletePrice.isPending}
                        data-testid={`button-edit-price-${p.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(p.id)}
                        disabled={upsertPrice.isPending || deletePrice.isPending}
                        data-testid={`button-delete-price-${p.id}`}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-6 items-end">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Type</label>
                  <Select value={kind} onValueChange={(v) => setKind(v as "text" | "image" | "video")}>
                    <SelectTrigger data-testid="select-price-kind">
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
                  <label className="text-sm font-medium" htmlFor="price-provider">
                    Provider
                  </label>
                  <Input
                    id="price-provider"
                    placeholder="builtin"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    list="price-provider-options"
                    data-testid="input-price-provider"
                  />
                  <datalist id="price-provider-options">
                    {providerSuggestions.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="price-model">
                    Model
                  </label>
                  <Input
                    id="price-model"
                    placeholder={kind === "video" ? "google/veo-3" : "gpt-4o-mini"}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    list="price-model-options"
                    data-testid="input-price-model"
                  />
                  <datalist id="price-model-options">
                    {modelSuggestions.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                {kind === "image" && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="price-image-usd">
                      $ / image
                    </label>
                    <Input
                      id="price-image-usd"
                      type="number"
                      min="0"
                      step="0.001"
                      value={imageUsd}
                      onChange={(e) => setImageUsd(e.target.value)}
                      data-testid="input-price-image-usd"
                    />
                  </div>
                )}
                {kind === "video" && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="price-second-usd">
                        $ / second
                      </label>
                      <Input
                        id="price-second-usd"
                        type="number"
                        min="0"
                        step="0.001"
                        value={secondUsd}
                        onChange={(e) => setSecondUsd(e.target.value)}
                        data-testid="input-price-second-usd"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="price-video-usd">
                        $ / video (optional)
                      </label>
                      <Input
                        id="price-video-usd"
                        type="number"
                        min="0"
                        step="0.001"
                        value={videoUsd}
                        onChange={(e) => setVideoUsd(e.target.value)}
                        data-testid="input-price-video-usd"
                      />
                    </div>
                  </>
                )}
                {kind !== "video" && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="price-input-usd">
                        {kind === "text" ? "$ / 1M input" : "$ / 1M input (optional)"}
                      </label>
                      <Input
                        id="price-input-usd"
                        type="number"
                        min="0"
                        step="0.001"
                        value={inputUsd}
                        onChange={(e) => setInputUsd(e.target.value)}
                        data-testid="input-price-input-usd"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="price-output-usd">
                        $ / 1M output
                      </label>
                      <Input
                        id="price-output-usd"
                        type="number"
                        min="0"
                        step="0.001"
                        value={outputUsd}
                        onChange={(e) => setOutputUsd(e.target.value)}
                        data-testid="input-price-output-usd"
                      />
                    </div>
                  </>
                )}
                <Button
                  onClick={handleAddPrice}
                  disabled={upsertPrice.isPending}
                  data-testid="button-save-model-price"
                >
                  {editing ? "Update price" : "Save price"}
                </Button>
                {editing && (
                  <Button
                    variant="outline"
                    onClick={resetPriceForm}
                    data-testid="button-cancel-edit-price"
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Saving a price for an existing type + provider + model combination updates
                it. When the OpenRouter provider reports a per-request cost, that reported
                cost is used directly and no catalog entry is needed.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AiCostReportCard() {
  const [month, setMonth] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { data: report, isLoading } = useAdminGetAiCostReport(
    month ? { month } : undefined,
  );
  const campaignParams = month ? { month } : undefined;
  const { data: campaignReport } = useAdminGetAiCostCampaigns(campaignParams, {
    query: {
      enabled: open,
      queryKey: getAdminGetAiCostCampaignsQueryKey(campaignParams),
    },
  });

  return (
    <Card data-testid="card-ai-cost-report">
      <CollapsibleCardHeader
        title="Actual Cost Report"
        description='Per-tenant real AI cost for the selected month, next to what the tenant-facing "AI amount spent" rates would display for the same volume.'
        open={open}
        onToggle={() => setOpen((o) => !o)}
        testId="toggle-ai-cost-report-card"
      />
      {open && (
      <CardContent className="space-y-4">
        {isLoading || !report ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium">Month</label>
              <Select
                value={report.month}
                onValueChange={(v) => setMonth(v)}
              >
                <SelectTrigger className="w-40" data-testid="select-report-month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(report.months.includes(report.month)
                    ? report.months
                    : [report.month, ...report.months]
                  ).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
              data-testid="section-cost-summary"
            >
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Total actual cost</div>
                <div className="text-lg font-semibold" data-testid="text-summary-actual-cost">
                  {paiseToInr(report.summary.totalCostPaise)}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Total displayed spend</div>
                <div className="text-lg font-semibold" data-testid="text-summary-display-spend">
                  {paiseToInr(report.summary.displaySpendPaise)}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Overall margin</div>
                <div
                  className={`text-lg font-semibold ${
                    report.summary.displaySpendPaise - report.summary.totalCostPaise < 0
                      ? "text-destructive"
                      : ""
                  }`}
                  data-testid="text-summary-margin"
                >
                  {paiseToInr(report.summary.displaySpendPaise - report.summary.totalCostPaise)}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Generations</div>
                <div className="text-lg font-semibold" data-testid="text-summary-generations">
                  {report.summary.captionCount +
                    report.summary.imageCount +
                    report.summary.videoCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  {report.summary.captionCount} captions, {report.summary.imageCount} images,{" "}
                  {report.summary.videoCount} videos
                  {report.summary.unknownCount > 0
                    ? ` · ${report.summary.unknownCount} unknown cost`
                    : ""}
                </div>
              </div>
            </div>
            {report.tenants.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-report-rows">
                No caption, image, or video usage recorded for this month.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Tenant</th>
                      <th className="py-2 pr-3 font-medium text-right">Captions</th>
                      <th className="py-2 pr-3 font-medium text-right">Caption cost (avg)</th>
                      <th className="py-2 pr-3 font-medium text-right">Images</th>
                      <th className="py-2 pr-3 font-medium text-right">Image cost (avg)</th>
                      <th className="py-2 pr-3 font-medium text-right">Videos</th>
                      <th className="py-2 pr-3 font-medium text-right">Video cost (avg)</th>
                      <th className="py-2 pr-3 font-medium text-right">Actual cost</th>
                      <th className="py-2 pr-3 font-medium text-right">Displayed spend</th>
                      <th className="py-2 pr-3 font-medium text-right">Margin</th>
                      <th className="py-2 font-medium text-right">Unknown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.tenants.map((t) => {
                      const unknown =
                        t.unknownCaptionCount + t.unknownImageCount + t.unknownVideoCount;
                      const margin = t.displaySpendPaise - t.totalCostPaise;
                      // Averages cover only events with a known cost.
                      const knownCaptions = t.captionCount - t.unknownCaptionCount;
                      const knownImages = t.imageCount - t.unknownImageCount;
                      const knownVideos = t.videoCount - t.unknownVideoCount;
                      const avgCaption =
                        knownCaptions > 0 ? Math.round(t.captionCostPaise / knownCaptions) : null;
                      const avgImage =
                        knownImages > 0 ? Math.round(t.imageCostPaise / knownImages) : null;
                      const avgVideo =
                        knownVideos > 0 ? Math.round(t.videoCostPaise / knownVideos) : null;
                      return (
                        <tr
                          key={t.tenantId}
                          className="border-b last:border-0"
                          data-testid={`row-cost-tenant-${t.tenantId}`}
                        >
                          <td className="py-2 pr-3">
                            <div className="font-medium">{t.name ?? `Tenant #${t.tenantId}`}</div>
                            {t.email && (
                              <div className="text-xs text-muted-foreground">{t.email}</div>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">{t.captionCount}</td>
                          <td className="py-2 pr-3 text-right">
                            {paiseToInr(t.captionCostPaise)}
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              ({avgCaption !== null ? paiseToInr(avgCaption) : "—"})
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right">{t.imageCount}</td>
                          <td className="py-2 pr-3 text-right">
                            {paiseToInr(t.imageCostPaise)}
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              ({avgImage !== null ? paiseToInr(avgImage) : "—"})
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right">{t.videoCount}</td>
                          <td className="py-2 pr-3 text-right">
                            {paiseToInr(t.videoCostPaise)}
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              ({avgVideo !== null ? paiseToInr(avgVideo) : "—"})
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right">{paiseToInr(t.totalCostPaise)}</td>
                          <td className="py-2 pr-3 text-right">{paiseToInr(t.displaySpendPaise)}</td>
                          <td
                            className={`py-2 pr-3 text-right ${margin < 0 ? "text-destructive" : ""}`}
                          >
                            {paiseToInr(margin)}
                          </td>
                          <td className="py-2 text-right">
                            {unknown > 0 ? (
                              <Badge variant="outline">{unknown} events</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {report.trend.length > 1 && (
              <div className="space-y-2" data-testid="section-cost-trend">
                <div className="text-sm font-medium">Month-over-month trend</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Month</th>
                        <th className="py-2 pr-3 font-medium text-right">Captions</th>
                        <th className="py-2 pr-3 font-medium text-right">Images</th>
                        <th className="py-2 pr-3 font-medium text-right">Videos</th>
                        <th className="py-2 pr-3 font-medium text-right">Actual cost</th>
                        <th className="py-2 pr-3 font-medium text-right">Displayed spend</th>
                        <th className="py-2 pr-3 font-medium text-right">Margin</th>
                        <th className="py-2 font-medium text-right">Unknown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.trend.map((m) => {
                        const margin = m.displaySpendPaise - m.totalCostPaise;
                        return (
                          <tr
                            key={m.month}
                            className={`border-b last:border-0 ${
                              m.month === report.month ? "bg-muted/50" : ""
                            }`}
                            data-testid={`row-trend-${m.month}`}
                          >
                            <td className="py-2 pr-3 font-medium">{m.month}</td>
                            <td className="py-2 pr-3 text-right">{m.captionCount}</td>
                            <td className="py-2 pr-3 text-right">{m.imageCount}</td>
                            <td className="py-2 pr-3 text-right">{m.videoCount}</td>
                            <td className="py-2 pr-3 text-right">
                              {paiseToInr(m.totalCostPaise)}
                            </td>
                            <td className="py-2 pr-3 text-right">
                              {paiseToInr(m.displaySpendPaise)}
                            </td>
                            <td
                              className={`py-2 pr-3 text-right ${margin < 0 ? "text-destructive" : ""}`}
                            >
                              {paiseToInr(margin)}
                            </td>
                            <td className="py-2 text-right">
                              {m.unknownCount > 0 ? (
                                <Badge variant="outline">{m.unknownCount} events</Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Displayed spend in the trend uses the tenant-facing rates that were in
                  effect when each event was recorded, so changing rates never shifts past
                  months. Up to 12 months are shown, newest first.
                </p>
              </div>
            )}
            {campaignReport && campaignReport.campaigns.length > 0 && (
              <div className="space-y-2" data-testid="section-campaign-costs">
                <div className="text-sm font-medium">Campaign costs</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Tenant</th>
                        <th className="py-2 pr-3 font-medium">Campaign</th>
                        <th className="py-2 pr-3 font-medium text-right">Captions</th>
                        <th className="py-2 pr-3 font-medium text-right">Images</th>
                        <th className="py-2 pr-3 font-medium text-right">Videos</th>
                        <th className="py-2 pr-3 font-medium text-right">Actual cost</th>
                        <th className="py-2 font-medium text-right">Unknown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaignReport.campaigns.map((c) => (
                        <tr
                          key={`${c.tenantId}-${c.campaignId}`}
                          className="border-b last:border-0"
                          data-testid={`row-campaign-cost-${c.tenantId}-${c.campaignId}`}
                        >
                          <td className="py-2 pr-3">
                            <div className="font-medium">
                              {c.tenantName ?? `Tenant #${c.tenantId}`}
                            </div>
                            {c.tenantEmail && (
                              <div className="text-xs text-muted-foreground">{c.tenantEmail}</div>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {c.campaignName ?? (
                              <span className="text-muted-foreground">
                                Campaign #{c.campaignId} (deleted)
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">{c.captionCount}</td>
                          <td className="py-2 pr-3 text-right">{c.imageCount}</td>
                          <td className="py-2 pr-3 text-right">{c.videoCount}</td>
                          <td className="py-2 pr-3 text-right">{paiseToInr(c.totalCostPaise)}</td>
                          <td className="py-2 text-right">
                            {c.unknownCount > 0 ? (
                              <Badge variant="outline">{c.unknownCount} events</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Every caption, image and video generated inside a campaign, summed per
                  campaign for the selected month. Generations made outside a campaign
                  (one-off studio work) are not shown here but are included in the
                  per-tenant table above.
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Caption and image cost columns show the month's known-cost total with the
              per-generation average in parentheses (averages cover only events with a
              computed cost). "Unknown" counts events where no price or conversion rate
              applied. Displayed spend sums each event's snapshotted tenant-facing rate;
              only events recorded before snapshotting fall back to today's rates.
            </p>
          </>
        )}
      </CardContent>
      )}
    </Card>
  );
}

/** Editable form state for the video API mapping (all strings; validated server-side). */
interface VideoApiDraft {
  template: "openrouter" | "custom";
  submitPath: string;
  pollPath: string;
  promptField: string;
  modelField: string;
  durationField: string;
  aspectRatioField: string;
  imageField: string;
  jobIdPath: string;
  statusPath: string;
  pendingValues: string; // comma-separated
  completedValue: string;
  videoUrlPath: string;
  errorPath: string;
}

const EMPTY_VIDEO_API_DRAFT: VideoApiDraft = {
  template: "openrouter",
  submitPath: "",
  pollPath: "",
  promptField: "",
  modelField: "",
  durationField: "",
  aspectRatioField: "",
  imageField: "",
  jobIdPath: "",
  statusPath: "",
  pendingValues: "",
  completedValue: "",
  videoUrlPath: "",
  errorPath: "",
};

type VideoApiMapping = CustomVideoApiMapping;

function videoApiToDraft(mapping: VideoApiMapping | undefined): VideoApiDraft {
  if (!mapping || mapping.template !== "custom") return EMPTY_VIDEO_API_DRAFT;
  return {
    template: "custom",
    submitPath: mapping.submitPath ?? "",
    pollPath: mapping.pollPath ?? "",
    promptField: mapping.promptField ?? "",
    modelField: mapping.modelField ?? "",
    durationField: mapping.durationField ?? "",
    aspectRatioField: mapping.aspectRatioField ?? "",
    imageField: mapping.imageField ?? "",
    jobIdPath: mapping.jobIdPath ?? "",
    statusPath: mapping.statusPath ?? "",
    pendingValues: (mapping.pendingValues ?? []).join(", "),
    completedValue: mapping.completedValue ?? "",
    videoUrlPath: mapping.videoUrlPath ?? "",
    errorPath: mapping.errorPath ?? "",
  };
}

/** Build the request payload from the form state (blank optional fields omitted). */
function draftToVideoApi(d: VideoApiDraft): VideoApiMapping {
  if (d.template !== "custom") return { template: "openrouter" };
  const mapping: VideoApiMapping = { template: "custom" };
  if (d.submitPath.trim()) mapping.submitPath = d.submitPath.trim();
  if (d.pollPath.trim()) mapping.pollPath = d.pollPath.trim();
  if (d.promptField.trim()) mapping.promptField = d.promptField.trim();
  if (d.modelField.trim()) mapping.modelField = d.modelField.trim();
  if (d.durationField.trim()) mapping.durationField = d.durationField.trim();
  if (d.aspectRatioField.trim()) mapping.aspectRatioField = d.aspectRatioField.trim();
  if (d.imageField.trim()) mapping.imageField = d.imageField.trim();
  if (d.jobIdPath.trim()) mapping.jobIdPath = d.jobIdPath.trim();
  if (d.statusPath.trim()) mapping.statusPath = d.statusPath.trim();
  const pending = d.pendingValues
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (pending.length > 0) mapping.pendingValues = pending;
  if (d.completedValue.trim()) mapping.completedValue = d.completedValue.trim();
  if (d.videoUrlPath.trim()) mapping.videoUrlPath = d.videoUrlPath.trim();
  if (d.errorPath.trim()) mapping.errorPath = d.errorPath.trim();
  return mapping;
}

interface CustomProviderDraft {
  id: string | null; // null = creating
  name: string;
  baseUrl: string;
  apiKey: string; // "" = leave unchanged when editing
  clearKey: boolean;
  textEnabled: boolean;
  imageEnabled: boolean;
  videoEnabled: boolean;
  videoApi: VideoApiDraft;
}

const EMPTY_CUSTOM_DRAFT: CustomProviderDraft = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  clearKey: false,
  textEnabled: false,
  imageEnabled: false,
  videoEnabled: false,
  videoApi: EMPTY_VIDEO_API_DRAFT,
};

/** Exported for its own test; rendered only from AiTab. */
export function CustomAiProvidersCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useAdminListCustomAiProviders();
  const createProvider = useAdminCreateCustomAiProvider();
  const updateProvider = useAdminUpdateCustomAiProvider();
  const deleteProvider = useAdminDeleteCustomAiProvider();
  const testProvider = useAdminTestCustomAiProvider();
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  // Latest per-provider test outcome, keyed by "custom:<id>". Cleared when a
  // new test for the same provider starts.
  const [testResults, setTestResults] = useState<
    Record<string, { useCase: string; ok: boolean; message: string }[] | { error: string }>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const runTest = (providerId: string) => {
    setTestingId(providerId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    testProvider.mutate(
      { providerId },
      {
        onSuccess: (result) => {
          setTestResults((prev) => ({ ...prev, [providerId]: result.results }));
        },
        onError: (err: unknown) => {
          setTestResults((prev) => ({
            ...prev,
            [providerId]: { error: apiErrorMessage(err, "Could not run the provider test.") },
          }));
        },
        onSettled: () => setTestingId(null),
      },
    );
  };

  const providers = data?.providers ?? [];
  const pending =
    createProvider.isPending || updateProvider.isPending || deleteProvider.isPending;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListCustomAiProvidersQueryKey() });
    // Custom providers appear in the text/image/video provider dropdowns.
    queryClient.invalidateQueries({ queryKey: getAdminGetTextGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminGetImageGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminGetVideoGenSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const saveDraft = () => {
    if (!draft) return;
    const body = {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      textEnabled: draft.textEnabled,
      imageEnabled: draft.imageEnabled,
      videoEnabled: draft.videoEnabled,
      videoApi: draftToVideoApi(draft.videoApi),
    };
    const onSuccess = () => {
      invalidate();
      setDraft(null);
      toast({
        title: draft.id ? "Custom provider updated" : "Custom provider added",
        description:
          "It is now selectable in the enabled use cases' provider dropdowns.",
      });
    };
    const onError = (err: unknown) => {
      toast({
        title: "Save failed",
        description: apiErrorMessage(err, "Could not save the custom provider."),
        variant: "destructive",
      });
    };
    if (draft.id) {
      const apiKey = draft.clearKey ? null : draft.apiKey.trim() || undefined;
      updateProvider.mutate(
        { providerId: draft.id, data: { ...body, ...(apiKey !== undefined || draft.clearKey ? { apiKey } : {}) } },
        { onSuccess, onError },
      );
    } else {
      createProvider.mutate(
        { data: { ...body, apiKey: draft.apiKey.trim() || null } },
        { onSuccess, onError },
      );
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteProvider.mutate(
      { providerId: deleteTarget.id },
      {
        onSuccess: () => {
          invalidate();
          setDeleteTarget(null);
          toast({ title: "Custom provider deleted" });
        },
        onError: (err: unknown) => {
          setDeleteTarget(null);
          toast({
            title: "Delete failed",
            description: apiErrorMessage(err, "Could not delete the custom provider."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const useBadges = (p: { textEnabled: boolean; imageEnabled: boolean; videoEnabled: boolean }) => {
    const uses: string[] = [];
    if (p.textEnabled) uses.push("Text & captions");
    if (p.imageEnabled) uses.push("Images");
    if (p.videoEnabled) uses.push("Video");
    return uses;
  };

  return (
    <Card data-testid="card-custom-ai-providers">
      <CardHeader>
        <CardTitle>Custom AI Providers</CardTitle>
        <CardDescription>
          Add any OpenAI-compatible service (Together, Fireworks, Nebius, a
          self-hosted server…) and make it selectable for text & captions,
          images, or video — no code change needed. Text and images use the
          standard chat/completions and images/generations endpoints; for
          video, pick the OpenRouter-shaped template or map any JSON video API
          with custom field paths. Enter models in each use
          case's own card; unknown models need a manual price row in the AI
          Cost card before they can be activated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <>
            {providers.length === 0 && !draft && (
              <p className="text-sm text-muted-foreground">No custom providers yet.</p>
            )}
            <div className="space-y-2">
              {providers.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  data-testid={`row-custom-provider-${p.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {p.name}{" "}
                      <span className="font-mono text-xs text-muted-foreground">({p.id})</span>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{p.baseUrl}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {useBadges(p).map((use) => (
                        <Badge key={use} variant="secondary">
                          {use}
                        </Badge>
                      ))}
                      {useBadges(p).length === 0 && (
                        <Badge variant="outline">No use cases enabled</Badge>
                      )}
                      <Badge variant={p.hasKey ? "secondary" : "outline"}>
                        {p.hasKey ? "Key saved" : "No key (public endpoint)"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || testingId !== null || useBadges(p).length === 0}
                      data-testid={`button-test-custom-provider-${p.id}`}
                      onClick={() => runTest(p.id)}
                    >
                      {testingId === p.id ? "Testing…" : "Test"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      data-testid={`button-edit-custom-provider-${p.id}`}
                      onClick={() =>
                        setDraft({
                          id: p.id,
                          name: p.name,
                          baseUrl: p.baseUrl,
                          apiKey: "",
                          clearKey: false,
                          textEnabled: p.textEnabled,
                          imageEnabled: p.imageEnabled,
                          videoEnabled: p.videoEnabled,
                          videoApi: videoApiToDraft(p.videoApi),
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      data-testid={`button-delete-custom-provider-${p.id}`}
                      onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                    >
                      Delete
                    </Button>
                  </div>
                  {(() => {
                    const result = testResults[p.id];
                    if (testingId === p.id) {
                      return (
                        <p className="w-full text-xs text-muted-foreground">
                          Running a live request for each enabled use case…
                        </p>
                      );
                    }
                    if (!result) return null;
                    if ("error" in result) {
                      return (
                        <p
                          className="w-full text-xs text-destructive"
                          data-testid={`text-test-error-${p.id}`}
                        >
                          Test failed: {result.error}
                        </p>
                      );
                    }
                    const labels: Record<string, string> = {
                      text: "Text & captions",
                      image: "Images",
                      video: "Video",
                    };
                    return (
                      <div
                        className="w-full space-y-1 rounded-md border bg-muted/40 p-2"
                        data-testid={`test-results-${p.id}`}
                      >
                        {result.map((r) => (
                          <div key={r.useCase} className="flex items-start gap-2 text-xs">
                            <Badge
                              variant={r.ok ? "secondary" : "destructive"}
                              data-testid={`badge-test-${r.useCase}-${p.id}`}
                            >
                              {labels[r.useCase] ?? r.useCase}: {r.ok ? "Pass" : "Fail"}
                            </Badge>
                            <span className="break-all pt-0.5 text-muted-foreground">
                              {r.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
            {draft ? (
              <div className="space-y-3 rounded-md border p-3" data-testid="form-custom-provider">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Name</p>
                    <Input
                      value={draft.name}
                      maxLength={60}
                      placeholder="Together AI"
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      data-testid="input-custom-provider-name"
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Base URL</p>
                    <Input
                      value={draft.baseUrl}
                      placeholder="https://api.together.xyz/v1"
                      onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                      data-testid="input-custom-provider-base-url"
                    />
                    <p className="text-xs text-muted-foreground">
                      https only; the OpenAI-compatible API root (usually ends in /v1).
                    </p>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">API key</p>
                  <Input
                    type="password"
                    value={draft.apiKey}
                    placeholder={
                      draft.id ? "Leave blank to keep the saved key" : "sk-… (optional)"
                    }
                    disabled={draft.clearKey}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                    data-testid="input-custom-provider-api-key"
                  />
                  {draft.id && (
                    <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                      <Switch
                        checked={draft.clearKey}
                        onCheckedChange={(v) => setDraft({ ...draft, clearKey: v, apiKey: "" })}
                        data-testid="switch-custom-provider-clear-key"
                      />
                      Remove the saved key (keyless endpoint)
                    </label>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Use for</p>
                  {(
                    [
                      ["textEnabled", "Text & captions", "chat/completions"],
                      ["imageEnabled", "Image generation", "images/generations"],
                      ["videoEnabled", "Video generation", "API shape set below"],
                    ] as const
                  ).map(([key, label, api]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={draft[key]}
                        onCheckedChange={(v) => setDraft({ ...draft, [key]: v })}
                        data-testid={`switch-custom-provider-${key}`}
                      />
                      {label} <span className="text-xs text-muted-foreground">({api})</span>
                    </label>
                  ))}
                </div>
                {draft.videoEnabled && (
                  <div className="space-y-3 rounded-md border p-3" data-testid="section-video-api-mapping">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Video API shape</p>
                      <Select
                        value={draft.videoApi.template}
                        onValueChange={(v) =>
                          setDraft({
                            ...draft,
                            videoApi: { ...draft.videoApi, template: v as "openrouter" | "custom" },
                          })
                        }
                      >
                        <SelectTrigger className="w-72" data-testid="select-video-api-template">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openrouter">
                            OpenRouter-shaped (POST /videos, poll /videos/{"{id}"})
                          </SelectItem>
                          <SelectItem value="custom">Custom mapping (any JSON video API)</SelectItem>
                        </SelectContent>
                      </Select>
                      {draft.videoApi.template === "custom" && (
                        <p className="text-xs text-muted-foreground">
                          Field paths use dot notation (e.g. <code>output.video_url</code> or{" "}
                          <code>data.0.url</code>). Leave the poll path blank if the submit
                          response already contains the video URL.
                        </p>
                      )}
                    </div>
                    {draft.videoApi.template === "custom" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(
                          [
                            ["submitPath", "Submit path (required)", "/videos"],
                            ["pollPath", "Poll path (blank = synchronous)", "/videos/{id}"],
                            ["promptField", "Prompt field (required)", "prompt"],
                            ["videoUrlPath", "Video URL path (required)", "unsigned_urls"],
                            ["modelField", "Model field", "model"],
                            ["durationField", "Duration field (seconds)", "duration"],
                            ["aspectRatioField", "Aspect ratio field", "aspect_ratio"],
                            ["imageField", "Start image field (data URL)", "image_url"],
                            ["jobIdPath", "Job id path (needed for polling)", "id"],
                            ["statusPath", "Status path (needed for polling)", "status"],
                            ["pendingValues", "Pending statuses (comma-separated)", "pending, processing, queued, running"],
                            ["completedValue", "Completed status", "completed"],
                            ["errorPath", "Error detail path", "error"],
                          ] as const
                        ).map(([key, label, placeholder]) => (
                          <div key={key} className="space-y-1">
                            <p className="text-xs font-medium">{label}</p>
                            <Input
                              value={draft.videoApi[key]}
                              placeholder={placeholder}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  videoApi: { ...draft.videoApi, [key]: e.target.value },
                                })
                              }
                              data-testid={`input-video-api-${key}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={saveDraft}
                    disabled={pending || !draft.name.trim() || !draft.baseUrl.trim()}
                    data-testid="button-save-custom-provider"
                  >
                    {draft.id ? "Save changes" : "Add provider"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft(EMPTY_CUSTOM_DRAFT)}
                data-testid="button-add-custom-provider"
              >
                Add custom provider
              </Button>
            )}
            <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
              <DialogContent data-testid="dialog-delete-custom-provider">
                <DialogHeader>
                  <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
                  <DialogDescription>
                    This removes the provider and its stored key. If a use case still
                    points at it, the delete is refused until you switch that use case
                    to another provider.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={pending}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={confirmDelete}
                    disabled={pending}
                    data-testid="button-confirm-delete-custom-provider"
                  >
                    Delete
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AiTab() {
  const { flags } = useFeatureFlags();
  return (
    <div className="space-y-8">
      <DesignSkillCard />
      <AiSpendCard />
      {flags.wallet && <WalletCard />}
      {flags.aiCostTracking && (
        <>
          <AiCostCard />
          <AiCostReportCard />
        </>
      )}
      <CustomAiProvidersCard />
      <TextGenProviderCard />
      <ImageGenProviderCard />
      <VideoGenProviderCard />
      <StockSourcesCard />
      <AsrProviderCard />
    </div>
  );
}
