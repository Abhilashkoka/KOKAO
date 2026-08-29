import { useRef, useState } from "react";
import {
  useListCharacters,
  useCreateCharacter,
  useDeleteCharacter,
  getListCharactersQueryKey,
  useListVisualAssets,
  useCreateVisualAsset,
  useDeleteVisualAsset,
  getListVisualAssetsQueryKey,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import { Upload, Trash2, Users, Images } from "lucide-react";

export const MAX_CHARACTERS = 5;
export const MAX_VISUAL_ASSETS = 7;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function errText(err: unknown): string {
  if (err && typeof err === "object" && "error" in err && typeof (err as { error: unknown }).error === "string") {
    return (err as { error: string }).error;
  }
  return err instanceof Error ? err.message : "Please try again.";
}

/** Upload a local image file to tenant storage; returns the /objects/... path. */
function useImageUpload() {
  const requestUploadUrl = useRequestUploadUrl();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<string | null> => {
    if (!IMAGE_TYPES.includes(file.type)) {
      toast({
        title: "Not a supported image",
        description: "Please pick a PNG, JPEG, or WebP image.",
        variant: "destructive",
      });
      return null;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Image too large",
        description: "Images must be under 10 MB.",
        variant: "destructive",
      });
      return null;
    }
    setUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      return objectPath;
    } catch (err) {
      toast({ title: "Upload failed", description: errText(err), variant: "destructive" });
      return null;
    } finally {
      setUploading(false);
    }
  };

  return { upload, uploading };
}

function SavedImageTile({
  name,
  imagePath,
  onDelete,
  deleting,
  testId,
}: {
  name: string;
  imagePath: string;
  onDelete: () => void;
  deleting: boolean;
  testId: string;
}) {
  return (
    <div className="relative group w-24" data-testid={testId}>
      <img
        src={`/api/storage${imagePath}`}
        alt={name}
        className="h-24 w-24 object-cover rounded-lg border border-border"
      />
      <button
        type="button"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
        disabled={deleting}
        className="absolute -top-2 -right-2 bg-background border border-border rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {deleting ? <RippleSpinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
      <div className="mt-1 text-xs text-muted-foreground truncate" title={name}>
        {name}
      </div>
    </div>
  );
}

function AddSavedImageDialog({
  open,
  onOpenChange,
  title,
  description,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  saving: boolean;
  onSave: (name: string, file: File) => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="space-y-3">
          <Input
            placeholder="Name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            data-testid="input-saved-visual-name"
          />
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => fileRef.current?.click()}
            data-testid="button-saved-visual-file"
          >
            <Upload className="h-4 w-4 mr-2" />
            {file ? file.name : "Choose image"}
          </Button>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={saving || !name.trim() || !file}
            onClick={() => file && onSave(name.trim(), file)}
            data-testid="button-saved-visual-save"
          >
            {saving ? <RippleSpinner className="mr-2 h-4 w-4" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CharactersCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: characters, isLoading } = useListCharacters();
  const createCharacter = useCreateCharacter();
  const deleteCharacter = useDeleteCharacter();
  const { upload, uploading } = useImageUpload();
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // The Video Studio list now also includes shared preset characters. This
  // library manages only tenant-owned uploads; presets are selectable in
  // Video Studio but cannot be deleted or counted against this tenant cap.
  const items = (characters ?? []).filter((character) => typeof character.id === "number");
  const atCap = items.length >= MAX_CHARACTERS;

  const handleSave = async (name: string, file: File) => {
    const objectPath = await upload(file);
    if (!objectPath) return;
    try {
      await createCharacter.mutateAsync({ data: { name, sourceImagePath: objectPath } });
      await queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      setAddOpen(false);
      toast({ title: "Character saved" });
    } catch (err) {
      toast({ title: "Could not save character", description: errText(err), variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await deleteCharacter.mutateAsync({ characterId: id });
      await queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    } catch (err) {
      toast({ title: "Could not delete", description: errText(err), variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card data-testid="card-characters">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Users className="h-5 w-5" /> Characters
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {items.length}/{MAX_CHARACTERS}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Recurring people or mascots. Reuse them in the Video Studio and as reference images in
          AI Studio.
        </p>
        {isLoading ? (
          <RippleSpinner className="h-5 w-5" />
        ) : items.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {items.map((c) => (
              <SavedImageTile
                key={c.id}
                name={c.name}
                imagePath={c.referenceImagePath}
                onDelete={() => {
                  // `items` excludes presets; keep the runtime guard here so
                  // a malformed mixed list cannot issue a delete for a stable
                  // preset string id.
                  if (typeof c.id === "number") void handleDelete(c.id);
                }}
                deleting={deletingId === c.id}
                testId={`tile-character-${c.id}`}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No characters yet.</p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atCap}
          title={atCap ? `Limit of ${MAX_CHARACTERS} reached — delete one to add another.` : undefined}
          onClick={() => setAddOpen(true)}
          data-testid="button-add-character"
        >
          <Upload className="h-4 w-4 mr-2" /> Add character
        </Button>
        <AddSavedImageDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title="Add a character"
          description="Upload a clear photo of the person or mascot and give it a name."
          saving={uploading || createCharacter.isPending}
          onSave={(name, file) => void handleSave(name, file)}
        />
      </CardContent>
    </Card>
  );
}

function AssetsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: assets, isLoading } = useListVisualAssets();
  const createAsset = useCreateVisualAsset();
  const deleteAsset = useDeleteVisualAsset();
  const { upload, uploading } = useImageUpload();
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const items = assets ?? [];
  const atCap = items.length >= MAX_VISUAL_ASSETS;

  const handleSave = async (name: string, file: File) => {
    const objectPath = await upload(file);
    if (!objectPath) return;
    try {
      await createAsset.mutateAsync({ data: { name, imagePath: objectPath } });
      await queryClient.invalidateQueries({ queryKey: getListVisualAssetsQueryKey() });
      setAddOpen(false);
      toast({ title: "Asset saved" });
    } catch (err) {
      toast({ title: "Could not save asset", description: errText(err), variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await deleteAsset.mutateAsync({ assetId: id });
      await queryClient.invalidateQueries({ queryKey: getListVisualAssetsQueryKey() });
    } catch (err) {
      toast({ title: "Could not delete", description: errText(err), variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card data-testid="card-visual-assets">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Images className="h-5 w-5" /> Assets
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {items.length}/{MAX_VISUAL_ASSETS}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Fixed images — products, logos, backdrops. Reuse them as reference images in AI Studio
          or as photos in the Video Studio.
        </p>
        {isLoading ? (
          <RippleSpinner className="h-5 w-5" />
        ) : items.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {items.map((a) => (
              <SavedImageTile
                key={a.id}
                name={a.name}
                imagePath={a.imagePath}
                onDelete={() => void handleDelete(a.id)}
                deleting={deletingId === a.id}
                testId={`tile-asset-${a.id}`}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No assets yet.</p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atCap}
          title={atCap ? `Limit of ${MAX_VISUAL_ASSETS} reached — delete one to add another.` : undefined}
          onClick={() => setAddOpen(true)}
          data-testid="button-add-asset"
        >
          <Upload className="h-4 w-4 mr-2" /> Add asset
        </Button>
        <AddSavedImageDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title="Add an asset"
          description="Upload the image you want to reuse and give it a name."
          saving={uploading || createAsset.isPending}
          onSave={(name, file) => void handleSave(name, file)}
        />
      </CardContent>
    </Card>
  );
}

/** The Characters + Assets cards shown on the Brands page. */
export function SavedVisualsSection() {
  const { flags } = useFeatureFlags();
  const showCharacters = flags.videoGen;
  const showAssets = flags.assetLibrary;
  if (!showCharacters && !showAssets) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {showCharacters && <CharactersCard />}
      {showAssets && <AssetsCard />}
    </div>
  );
}

/**
 * Picker over saved characters and assets. onPick receives the storage path
 * and display name of the chosen image.
 */
export function SavedVisualPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (imagePath: string, name: string) => void;
}) {
  const { flags } = useFeatureFlags();
  const { data: characters, isLoading: charactersLoading } = useListCharacters({
    query: { queryKey: getListCharactersQueryKey(), enabled: open && flags.videoGen },
  });
  const { data: assets, isLoading: assetsLoading } = useListVisualAssets({
    query: { queryKey: getListVisualAssetsQueryKey(), enabled: open && flags.assetLibrary },
  });

  const options: { key: string; name: string; imagePath: string }[] = [
    ...(flags.videoGen
      ? (characters ?? []).map((c) => ({
          key: `character-${c.id}`,
          name: c.name,
          imagePath: c.referenceImagePath,
        }))
      : []),
    ...(flags.assetLibrary
      ? (assets ?? []).map((a) => ({
          key: `asset-${a.id}`,
          name: a.name,
          imagePath: a.imagePath,
        }))
      : []),
  ];
  const loading =
    (flags.videoGen && charactersLoading) || (flags.assetLibrary && assetsLoading);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a saved image</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-8 flex justify-center">
            <RippleSpinner className="h-6 w-6" />
          </div>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No saved characters or assets yet. Add them on the Brands page.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3 max-h-80 overflow-y-auto py-1">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                className="w-24 text-left group"
                onClick={() => {
                  onPick(o.imagePath, o.name);
                  onOpenChange(false);
                }}
                data-testid={`pick-${o.key}`}
              >
                <img
                  src={`/api/storage${o.imagePath}`}
                  alt={o.name}
                  className="h-24 w-24 object-cover rounded-lg border border-border group-hover:ring-2 group-hover:ring-primary"
                />
                <div className="mt-1 text-xs text-muted-foreground truncate" title={o.name}>
                  {o.name}
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
