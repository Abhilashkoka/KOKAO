import { useState } from "react";
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
  useAdminUpdateTextGenSettings,
  useAdminSetTextGenKey,
  useAdminClearTextGenKey,
  getAdminGetTextGenSettingsQueryKey,
  getListAiModelsQueryKey,
  useAdminGetAiSpendSettings,
  useAdminUpdateAiSpendSettings,
  getAdminGetAiSpendSettingsQueryKey,
  getGetAiSpendRatesQueryKey,
  useAdminGetAiCostConfig,
  useAdminUpdateAiCostRate,
  useAdminUpsertAiModelPrice,
  useAdminDeleteAiModelPrice,
  useAdminGetAiCostReport,
  getAdminGetAiCostConfigQueryKey,
  getAdminGetAiCostReportQueryKey,
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
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink } from "lucide-react";

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

function ImageGenProviderCard() {
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
            description: chosen
              ? `Images are now generated with ${chosen.label}.`
              : "Provider selection saved.",
          });
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err && typeof err.error === "string"
              ? err.error
              : "Could not change the image generation provider.";
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
  const effectiveProvider = draftProvider ?? settings?.provider ?? "openai";
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
          Which service creates images in the Studio. The built-in OpenAI option
          needs no key. Other providers use your own API key (stored encrypted).
          The Custom option works with any OpenAI-compatible provider — enter its
          base URL and model name.
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
                  {settings.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {shown &&
                (isDraft ? (
                  <Badge variant="outline">Not saved yet</Badge>
                ) : shown.configured ? (
                  <Badge variant="secondary">Ready</Badge>
                ) : (
                  <Badge variant="destructive">Needs key</Badge>
                ))}
            </div>
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
                  {source.configured ? (
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
              {source.keySource === "database" ? (
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
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err && typeof err.error === "string"
              ? err.error
              : "Could not change the video generation settings.";
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
                            {o.label}
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
                            {o.label}
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
  };

  const effectiveProvider = draftProvider ?? settings?.provider ?? "builtin";
  const modelsValue = modelsInput ?? (settings?.models ?? []).join("\n");
  const modelList = modelsValue
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const defaultModelValue = defaultModelInput ?? settings?.defaultModel ?? "";
  const isDraft = draftProvider !== null && draftProvider !== settings?.provider;

  const saveSelection = (provider: string) => {
    updateSettings.mutate(
      {
        data: {
          provider: provider as "builtin" | "openrouter",
          models: provider === "openrouter" ? modelList : [],
          defaultModel:
            provider === "openrouter" ? defaultModelValue.trim() || null : null,
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
                : "Captions and other text now use the built-in provider.",
          });
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err && typeof err.error === "string"
              ? err.error
              : "Could not change the text generation provider.";
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
    if (provider === "openrouter") {
      // OpenRouter needs a key and a model list first; wait for Save settings.
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

  const showOpenRouterConfig = effectiveProvider === "openrouter";

  return (
    <Card data-testid="card-text-gen-provider">
      <CardHeader>
        <CardTitle>Text Generation Provider</CardTitle>
        <CardDescription>
          Which service writes captions, topics, and campaign text. The built-in
          option needs no key. OpenRouter uses your own API key (stored
          encrypted) and lets you choose which models users can pick. Switching
          back to Built-in instantly restores the previous behavior.
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
            {showOpenRouterConfig && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Models users can choose</p>
                  <p className="text-xs text-muted-foreground">
                    One OpenRouter model id per line (for example
                    openai/gpt-4o-mini or anthropic/claude-3.5-haiku). Copy ids
                    from openrouter.ai/models.
                  </p>
                  <textarea
                    className="w-96 min-h-24 rounded-md border bg-background p-2 text-sm font-mono"
                    placeholder={"openai/gpt-4o-mini\nanthropic/claude-3.5-haiku"}
                    value={modelsValue}
                    onChange={(e) => setModelsInput(e.target.value)}
                    data-testid="input-text-gen-models"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Default model</p>
                  <Input
                    placeholder={modelList[0] ?? "openai/gpt-4o-mini"}
                    value={defaultModelValue}
                    onChange={(e) => setDefaultModelInput(e.target.value)}
                    className="w-96"
                    data-testid="input-text-gen-default-model"
                  />
                  <p className="text-xs text-muted-foreground">
                    Used when a user's saved model is not in the list. Leave
                    empty to use the first listed model.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => saveSelection("openrouter")}
                  disabled={updateSettings.isPending}
                  data-testid="button-save-text-gen-settings"
                >
                  {updateSettings.isPending ? "Saving..." : "Save settings"}
                </Button>
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
  const [feePercent, setFeePercent] = useState<string | null>(null);

  const paiseToRupees = (paise: number) => (paise / 100).toString();
  const captionValue = captionRupees ?? (settings ? paiseToRupees(settings.captionCostPaise) : "");
  const imageValue = imageRupees ?? (settings ? paiseToRupees(settings.imageCostPaise) : "");
  const feeValue = feePercent ?? (settings ? String(settings.feePercent) : "");

  const handleSave = () => {
    const caption = Math.round(Number(captionValue) * 100);
    const image = Math.round(Number(imageValue) * 100);
    const fee = Math.round(Number(feeValue));
    if (
      [caption, image, fee].some((n) => !Number.isFinite(n) || n < 0) ||
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
      { data: { captionCostPaise: caption, imageCostPaise: image, feePercent: fee } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getAdminGetAiSpendSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAiSpendRatesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
          setCaptionRupees(null);
          setImageRupees(null);
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
  const feeNow = Number(feeValue || "0");
  const previewsValid =
    [captionPaiseNow, imagePaiseNow, feeNow].every((n) => Number.isFinite(n) && n >= 0);

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
                {preview(imagePaiseNow, feeNow)} per image (fee included, shown only as "AI
                amount spent").
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

function AiCostCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useAdminGetAiCostConfig();
  const updateRate = useAdminUpdateAiCostRate();
  const upsertPrice = useAdminUpsertAiModelPrice();
  const deletePrice = useAdminDeleteAiModelPrice();

  const [rateInput, setRateInput] = useState<string | null>(null);
  const [kind, setKind] = useState<"text" | "image">("text");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [imageUsd, setImageUsd] = useState("");

  const rateValue =
    rateInput ?? (config ? (config.usdToInrPaise / 100).toString() : "");

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
    const invalid =
      kind === "text"
        ? !validNum(inputUsd) || !validNum(outputUsd) || !hasTokenPair
        : // Image rows: flat $/image, token pair (OpenAI/Gemini image models), or both.
          (!hasImagePrice && !hasTokenPair) ||
          (hasImagePrice && !validNum(imageUsd)) ||
          (hasTokenPair && (!validNum(inputUsd) || !validNum(outputUsd))) ||
          (inputUsd.trim() !== "") !== (outputUsd.trim() !== "");
    if (invalid) {
      toast({
        title: "Invalid price",
        description:
          kind === "text"
            ? "Enter USD per 1M input and output tokens (0 or more)."
            : "Enter USD per image, or both token prices for models that report token usage.",
        variant: "destructive",
      });
      return;
    }
    upsertPrice.mutate(
      {
        data: {
          kind,
          provider: trimmedProvider,
          model: trimmedModel,
          inputUsdPerMtok: hasTokenPair ? Number(inputUsd) : null,
          outputUsdPerMtok: hasTokenPair ? Number(outputUsd) : null,
          usdPerImage: kind === "image" && hasImagePrice ? Number(imageUsd) : null,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          setModel("");
          setInputUsd("");
          setOutputUsd("");
          setImageUsd("");
          toast({ title: "Model price saved" });
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

  const handleDelete = (priceId: number) => {
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
          Record the real provider cost of every caption and image in paise. Costs use
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
              {config.usdToInrPaise === 0 && (
                <p className="text-sm text-destructive">
                  Rate unset — all costs are recorded as unknown.
                </p>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">Model price catalog (USD)</p>
              {config.prices.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-model-prices">
                  No model prices yet. Add the models you use below.
                </p>
              ) : (
                <div className="space-y-2">
                  {config.prices.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                      data-testid={`row-model-price-${p.id}`}
                    >
                      <Badge variant="secondary">{p.kind}</Badge>
                      <span className="font-medium">{p.provider}</span>
                      <span className="text-muted-foreground">{p.model}</span>
                      <span className="ml-auto text-muted-foreground">
                        {p.kind === "text"
                          ? `$${p.inputUsdPerMtok ?? 0} in / $${p.outputUsdPerMtok ?? 0} out per 1M tokens`
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
                        onClick={() => handleDelete(p.id)}
                        disabled={deletePrice.isPending}
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
                  <Select value={kind} onValueChange={(v) => setKind(v as "text" | "image")}>
                    <SelectTrigger data-testid="select-price-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="image">Image</SelectItem>
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
                    data-testid="input-price-provider"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="price-model">
                    Model
                  </label>
                  <Input
                    id="price-model"
                    placeholder="gpt-4o-mini"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    data-testid="input-price-model"
                  />
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
                <Button
                  onClick={handleAddPrice}
                  disabled={upsertPrice.isPending}
                  data-testid="button-save-model-price"
                >
                  Save price
                </Button>
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

function AiCostReportCard() {
  const [month, setMonth] = useState<string | null>(null);
  const { data: report, isLoading } = useAdminGetAiCostReport(
    month ? { month } : undefined,
  );

  return (
    <Card data-testid="card-ai-cost-report">
      <CardHeader>
        <CardTitle>Actual Cost Report</CardTitle>
        <CardDescription>
          Per-tenant real AI cost for the selected month, next to what the tenant-facing
          "AI amount spent" rates would display for the same volume.
        </CardDescription>
      </CardHeader>
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
                  {report.summary.captionCount + report.summary.imageCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  {report.summary.captionCount} captions, {report.summary.imageCount} images
                  {report.summary.unknownCount > 0
                    ? ` · ${report.summary.unknownCount} unknown cost`
                    : ""}
                </div>
              </div>
            </div>
            {report.tenants.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-report-rows">
                No caption or image usage recorded for this month.
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
                      <th className="py-2 pr-3 font-medium text-right">Actual cost</th>
                      <th className="py-2 pr-3 font-medium text-right">Displayed spend</th>
                      <th className="py-2 pr-3 font-medium text-right">Margin</th>
                      <th className="py-2 font-medium text-right">Unknown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.tenants.map((t) => {
                      const unknown = t.unknownCaptionCount + t.unknownImageCount;
                      const margin = t.displaySpendPaise - t.totalCostPaise;
                      // Averages cover only events with a known cost.
                      const knownCaptions = t.captionCount - t.unknownCaptionCount;
                      const knownImages = t.imageCount - t.unknownImageCount;
                      const avgCaption =
                        knownCaptions > 0 ? Math.round(t.captionCostPaise / knownCaptions) : null;
                      const avgImage =
                        knownImages > 0 ? Math.round(t.imageCostPaise / knownImages) : null;
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
                  Displayed spend in the trend uses today's tenant-facing rates for every
                  month, so it compares volume, not historical pricing. Up to 12 months are
                  shown, newest first.
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Caption and image cost columns show the month's known-cost total with the
              per-generation average in parentheses (averages cover only events with a
              computed cost). "Unknown" counts events where no price or conversion rate
              applied. Displayed spend uses the current tenant-facing rates for comparison.
            </p>
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
      {flags.aiCostTracking && (
        <>
          <AiCostCard />
          <AiCostReportCard />
        </>
      )}
      <TextGenProviderCard />
      <ImageGenProviderCard />
      <VideoGenProviderCard />
      <StockSourcesCard />
      <AsrProviderCard />
    </div>
  );
}
