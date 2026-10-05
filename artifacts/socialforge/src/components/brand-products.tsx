import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListBrandProductsQueryKey,
  useCreateBrandProduct,
  useDeleteBrandAsset,
  useDescribeBrandProduct,
  useListBrandProducts,
  useRequestUploadUrl,
  useUpdateBrandProduct,
  type BrandProduct,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Package, RefreshCw, Trash2, Upload } from "lucide-react";

const PRODUCT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_GUIDED_STORY_PRODUCTS = 4;

type Kind = "product" | "service";
type DisplayMode = "in_scene" | "exact";

const DISPLAY_MODES: Array<[DisplayMode, string, string]> = [
  ["in_scene", "In scene", "AI places it naturally in the shot."],
  ["exact", "Exact card", "Your untouched photo appears as a card — best when the label must stay readable."],
];

function SegmentedChoice<T extends string>({
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (next: T) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5" role="radiogroup" data-testid={testId}>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          disabled={disabled}
          onClick={() => onChange(id)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
          data-testid={`${testId}-${id}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function DescriptionStatus({ product }: { product: BrandProduct }) {
  if (product.aiDescriptionStatus === "ready" && product.aiDescription) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`text-product-ai-${product.id}`}>
        <span className="font-medium text-foreground">AI sees:</span> {product.aiDescription}
      </p>
    );
  }
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={`text-product-ai-${product.id}`}>
      {product.aiDescriptionStatus === "failed"
        ? product.aiDescriptionError ?? "Your photo is saved, but the AI description is unavailable. Check your credit balance and AI photo description pricing before retrying."
        : "AI description pending."}
    </p>
  );
}

function ProductRow({ kitId, product }: { kitId: number; product: BrandProduct }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListBrandProductsQueryKey(kitId) });
  const update = useUpdateBrandProduct();
  const describe = useDescribeBrandProduct();
  const remove = useDeleteBrandAsset();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description);
  const [error, setError] = useState<string | null>(null);
  const busy = update.isPending || describe.isPending || remove.isPending;

  const save = (data: { name?: string; description?: string; kind?: Kind; displayMode?: DisplayMode }) => {
    setError(null);
    update.mutate(
      { id: kitId, assetId: product.id, data },
      {
        onSuccess: () => {
          setEditing(false);
          void refresh();
        },
        onError: (err) => setError(apiErrorMessage(err, "Could not save this product.")),
      },
    );
  };

  return (
    <div className="flex gap-3 rounded-lg border p-3" data-testid={`row-brand-product-${product.id}`}>
      <img
        src={`/api/storage${product.imagePath}`}
        alt={product.name}
        className="h-20 w-20 shrink-0 rounded-md border bg-white object-contain"
      />
      <div className="min-w-0 flex-1 space-y-2">
        {editing ? (
          <div className="space-y-2">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Product name" />
            <Textarea
              value={description}
              maxLength={400}
              rows={2}
              className="resize-none"
              onChange={(e) => setDescription(e.target.value)}
              aria-label="What it is and its benefit"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => save({ name: name.trim(), description: description.trim() })}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setName(product.name);
                  setDescription(product.description);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{product.name}</span>
              <Badge variant="secondary" className="capitalize">{product.kind}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{product.description}</p>
          </div>
        )}
        <DescriptionStatus product={product} />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedChoice
            value={product.displayMode as DisplayMode}
            options={DISPLAY_MODES.map(([id, label]): [DisplayMode, string] => [id, label])}
            disabled={busy}
            onChange={(displayMode) => save({ displayMode })}
            testId={`toggle-product-display-${product.id}`}
          />
          {!editing && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {product.aiDescriptionStatus !== "ready" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                describe.mutate(
                  { id: kitId, assetId: product.id },
                  {
                    onSuccess: () => void refresh(),
                    onError: (err) => setError(apiErrorMessage(err, "Could not describe this image.")),
                  },
                )
              }
              data-testid={`button-product-describe-${product.id}`}
            >
              {describe.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              Retry AI look
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() =>
              remove.mutate(
                { id: kitId, assetId: product.id },
                {
                  onSuccess: () => void refresh(),
                  onError: (err) => setError(apiErrorMessage(err, "Could not remove this product.")),
                },
              )
            }
            aria-label={`Remove ${product.name}`}
            data-testid={`button-product-delete-${product.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** Brand Kit tab: the products & services Guided Story can promote. */
export function BrandProductsSection({ kitId }: { kitId: number }) {
  const queryClient = useQueryClient();
  const products = useListBrandProducts(kitId);
  const requestUploadUrl = useRequestUploadUrl();
  const create = useCreateBrandProduct();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("product");
  const [description, setDescription] = useState("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("in_scene");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = uploading || create.isPending;
  const ready = Boolean(file) && name.trim().length >= 2 && description.trim().length >= 3;

  const pick = (next: File | null) => {
    setError(null);
    if (!next) return;
    if (!PRODUCT_IMAGE_TYPES.includes(next.type)) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (next.size > MAX_PRODUCT_IMAGE_BYTES) {
      setError("Image must be 10 MB or smaller.");
      return;
    }
    setFile(next);
    if (!name.trim()) setName(next.name.replace(/\.[^.]+$/, "").slice(0, 80));
  };

  const add = async () => {
    if (!file || !ready) return;
    setError(null);
    setUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await create.mutateAsync({
        id: kitId,
        data: { imagePath: objectPath, name: name.trim(), kind, description: description.trim(), displayMode },
      });
      setFile(null);
      setName("");
      setDescription("");
      setKind("product");
      setDisplayMode("in_scene");
      if (fileRef.current) fileRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: getListBrandProductsQueryKey(kitId) });
    } catch (err) {
      setError(apiErrorMessage(err, "Could not add this product. Please try again."));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="section-brand-products">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4" /> Products & services
        </p>
        <p className="text-xs text-muted-foreground">
          Add photos of what you sell. Guided Story can write them into the script and show them on screen. Saved instantly.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-dashed p-3">
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept={PRODUCT_IMAGE_TYPES.join(",")}
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            data-testid="input-brand-product-file"
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            {file ? "Change photo" : "Choose photo"}
          </Button>
          <span className="truncate text-xs text-muted-foreground">{file?.name ?? "PNG, JPEG or WebP · up to 10 MB"}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="brand-product-name">Name</Label>
            <Input
              id="brand-product-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. HydraGlow Night Serum"
              data-testid="input-brand-product-name"
            />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <SegmentedChoice
              value={kind}
              options={[["product", "Product"], ["service", "Service"]] as Array<[Kind, string]>}
              onChange={(next: Kind) => setKind(next)}
              testId="toggle-brand-product-kind"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="brand-product-description">What it is and the benefit to promote</Label>
          <Textarea
            id="brand-product-description"
            value={description}
            maxLength={400}
            rows={2}
            className="resize-none"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Overnight serum with niacinamide that helps even out skin tone."
            data-testid="input-brand-product-description"
          />
        </div>
        <div className="space-y-1">
          <Label>How it appears in videos</Label>
          <SegmentedChoice
            value={displayMode}
            options={DISPLAY_MODES.map(([id, label]): [DisplayMode, string] => [id, label])}
            onChange={(next: DisplayMode) => setDisplayMode(next)}
            testId="toggle-brand-product-display"
          />
          <p className="text-xs text-muted-foreground">
            {DISPLAY_MODES.find(([id]) => id === displayMode)?.[2]}
          </p>
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="button" size="sm" disabled={!ready || busy} onClick={() => void add()} data-testid="button-brand-product-add">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {busy ? "Adding & describing…" : "Add to brand"}
        </Button>
      </div>

      {products.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading products…</p>
      ) : (products.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No products or services yet.</p>
      ) : (
        <div className="space-y-2">
          {(products.data ?? []).map((product) => (
            <ProductRow key={product.id} kitId={kitId} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Guided Story setup: choose what this story promotes and how hard. */
export function GuidedProductPicker({
  brandKitId,
  selected,
  onSelectedChange,
  promotion,
  onPromotionChange,
  disabled,
}: {
  brandKitId: number | null;
  selected: number[];
  onSelectedChange: (next: number[]) => void;
  promotion: "subtle" | "featured";
  onPromotionChange: (next: "subtle" | "featured") => void;
  disabled?: boolean;
}) {
  const products = useListBrandProducts(brandKitId ?? 0, {
    query: { enabled: brandKitId !== null, queryKey: getListBrandProductsQueryKey(brandKitId ?? 0) },
  });
  if (brandKitId === null) {
    return (
      <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground" data-testid="text-guided-products-need-kit">
        Choose a Brand Kit to promote its products or services in this story.
      </div>
    );
  }
  const items = products.data ?? [];
  const toggle = (id: number) =>
    onSelectedChange(
      selected.includes(id)
        ? selected.filter((value) => value !== id)
        : selected.length >= MAX_GUIDED_STORY_PRODUCTS
          ? selected
          : [...selected, id],
    );
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="section-guided-products">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label>Promote products or services (optional)</Label>
          <p className="text-xs text-muted-foreground">
            Pick up to {MAX_GUIDED_STORY_PRODUCTS}. The script writer sees each photo's description and tags the scenes they appear in.
          </p>
        </div>
        <SegmentedChoice
          value={promotion}
          options={[["featured", "Featured"], ["subtle", "Subtle"]] as Array<["featured" | "subtle", string]>}
          onChange={(next: "featured" | "subtle") => onPromotionChange(next)}
          disabled={disabled || selected.length === 0}
          testId="toggle-guided-promotion"
        />
      </div>
      {selected.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="text-guided-promotion-help">
          {promotion === "featured"
            ? "Featured: a hero moment for the product and a short call to action at the end."
            : "Subtle: shown naturally in one or two scenes, no sales pitch."}
        </p>
      )}
      {products.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading products…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-guided-products-empty">
          This Brand Kit has no products yet. Add them under Brand Kits → Products.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map((product) => {
            const active = selected.includes(product.id);
            return (
              <button
                key={product.id}
                type="button"
                disabled={disabled || (!active && selected.length >= MAX_GUIDED_STORY_PRODUCTS)}
                onClick={() => toggle(product.id)}
                aria-pressed={active}
                className={`flex items-center gap-3 rounded-md border p-2 text-left transition-colors disabled:opacity-50 ${
                  active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted"
                }`}
                data-testid={`button-guided-product-${product.id}`}
              >
                <img
                  src={`/api/storage${product.imagePath}`}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded border bg-white object-contain"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{product.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {product.kind === "service" ? "Service" : "Product"} · {product.displayMode === "exact" ? "Exact card" : "In scene"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Script review: which frozen products a scene shows, toggleable before approval. */
export function SceneProductToggles({
  products,
  productIds,
  onChange,
  disabled,
  sceneLabel,
}: {
  products: Array<{ id: string; name: string; imagePath: string }>;
  productIds: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  sceneLabel: string;
}) {
  if (!products.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`scene-products-${sceneLabel}`}>
      <span className="text-xs font-medium text-muted-foreground">Shows:</span>
      {products.map((product) => {
        const active = productIds.includes(product.id);
        const full = !active && productIds.length >= 2;
        return (
          <button
            key={product.id}
            type="button"
            disabled={disabled || full}
            aria-pressed={active}
            title={full ? "A scene can show at most 2 products." : undefined}
            onClick={() =>
              onChange(active ? productIds.filter((id) => id !== product.id) : [...productIds, product.id])
            }
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
              active ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`toggle-scene-product-${sceneLabel}-${product.id}`}
          >
            <img src={`/api/storage${product.imagePath}`} alt="" className="h-4 w-4 rounded-sm bg-white object-contain" />
            {product.name}
          </button>
        );
      })}
    </div>
  );
}
