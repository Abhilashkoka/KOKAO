import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetAppBrand,
  useUpdateAppBrand,
  useCreateAppBrandUploadUrl,
  getGetAppBrandQueryKey,
} from "@workspace/api-client-react";
import type { AppBrandInput } from "@workspace/api-client-react";
import { ShieldAlert, Upload, Loader2, ImageOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type ImageField = "logoUrl" | "iconUrl";

function UploadSlot({
  label,
  description,
  value,
  uploading,
  onPick,
  onClear,
  previewClassName,
}: {
  label: string;
  description: string;
  value: string | null;
  uploading: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
  previewClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label className="text-sm font-semibold">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="h-20 w-32 shrink-0 rounded-lg border border-border bg-muted/40 flex items-center justify-center overflow-hidden">
          {value ? (
            <img
              src={value}
              alt={label}
              className={previewClassName ?? "max-h-16 max-w-28 object-contain"}
            />
          ) : (
            <ImageOff className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/x-icon"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPick(file);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {value ? "Replace" : "Upload"}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={onClear}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppBrandingPage() {
  const { data: me } = useGetMe();
  const { data: brand } = useGetAppBrand();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateBrand = useUpdateAppBrand();
  const uploadUrl = useCreateAppBrandUploadUrl();

  const [form, setForm] = useState<AppBrandInput>({});
  const [uploadingField, setUploadingField] = useState<ImageField | null>(null);

  useEffect(() => {
    if (brand) {
      setForm({
        appName: brand.appName,
        logoUrl: brand.logoUrl,
        iconUrl: brand.iconUrl,
        primaryColor: brand.primaryColor,
        backgroundColor: brand.backgroundColor,
      });
    }
  }, [brand]);

  if (me && !me.isSuperadmin) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h1 className="text-xl font-bold mb-2">Restricted</h1>
        <p className="text-muted-foreground">
          Branding is available to platform administrators only.
        </p>
      </div>
    );
  }

  const persist = async (next: AppBrandInput) => {
    const saved = await updateBrand.mutateAsync({ data: next });
    await queryClient.invalidateQueries({ queryKey: getGetAppBrandQueryKey() });
    return saved;
  };

  const handleUpload = async (field: ImageField, file: File) => {
    setUploadingField(field);
    try {
      const { uploadURL, servedPath } = await uploadUrl.mutateAsync({
        data: { contentType: file.type || "application/octet-stream" },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      const next = { ...form, [field]: servedPath };
      setForm(next);
      await persist(next);
      toast({ title: "Uploaded", description: "Your change is now live across the app." });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploadingField(null);
    }
  };

  const handleClearImage = async (field: ImageField) => {
    const next = { ...form, [field]: null };
    setForm(next);
    try {
      await persist(next);
      toast({ title: "Removed", description: "Reverted to the default." });
    } catch {
      toast({ title: "Could not update", variant: "destructive" });
    }
  };

  const handleSaveDetails = async () => {
    try {
      await persist(form);
      toast({ title: "Saved", description: "Branding updated across the app." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const saving = updateBrand.isPending && uploadingField === null;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Branding</h1>
        <p className="text-muted-foreground mt-1">
          Upload your logo and icon and set your app name and colors. Changes
          apply live everywhere — navigation, landing page, browser tab, and
          theme.
        </p>
      </div>

      <Card className="p-6 space-y-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          Assets
        </h2>
        <UploadSlot
          label="Logo"
          description="Shown in the sidebar, mobile header, and landing page. SVG or transparent PNG, recommended 512x128 px (4:1, at least 200 px wide)."
          value={form.logoUrl ?? null}
          uploading={uploadingField === "logoUrl"}
          onPick={(file) => handleUpload("logoUrl", file)}
          onClear={() => handleClearImage("logoUrl")}
        />
        <UploadSlot
          label="Icon / Favicon"
          description="Shown in the browser tab. Square PNG or SVG, recommended 512x512 px (at least 64x64)."
          value={form.iconUrl ?? null}
          uploading={uploadingField === "iconUrl"}
          onPick={(file) => handleUpload("iconUrl", file)}
          onClear={() => handleClearImage("iconUrl")}
          previewClassName="max-h-12 max-w-12 object-contain"
        />
      </Card>

      <Card className="p-6 space-y-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
          Details
        </h2>

        <div className="space-y-2">
          <Label htmlFor="appName">App name</Label>
          <Input
            id="appName"
            value={form.appName ?? ""}
            placeholder="KOKAO"
            onChange={(e) =>
              setForm((f) => ({ ...f, appName: e.target.value || null }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Used for the browser tab title and logo alt text.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="primaryColor">Primary color</Label>
            <div className="flex items-center gap-3">
              <input
                id="primaryColor"
                type="color"
                className="h-10 w-14 rounded-md border border-border bg-background cursor-pointer"
                value={form.primaryColor || "#7c3aed"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, primaryColor: e.target.value }))
                }
              />
              <Input
                value={form.primaryColor ?? ""}
                placeholder="Default"
                onChange={(e) =>
                  setForm((f) => ({ ...f, primaryColor: e.target.value || null }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="backgroundColor">Background color</Label>
            <div className="flex items-center gap-3">
              <input
                id="backgroundColor"
                type="color"
                className="h-10 w-14 rounded-md border border-border bg-background cursor-pointer"
                value={form.backgroundColor || "#eeeef0"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, backgroundColor: e.target.value }))
                }
              />
              <Input
                value={form.backgroundColor ?? ""}
                placeholder="Default"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    backgroundColor: e.target.value || null,
                  }))
                }
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSaveDetails} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save changes
          </Button>
        </div>
      </Card>
    </div>
  );
}
