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
} from "@workspace/api-client-react";
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

export function AiTab() {
  return (
    <div className="space-y-8">
      <DesignSkillCard />
      <ImageGenProviderCard />
      <AsrProviderCard />
    </div>
  );
}
