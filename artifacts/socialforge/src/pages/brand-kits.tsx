import { useState } from "react";
import { 
  useListBrandKits,
  useCreateBrandKit,
  useDeleteBrandKit,
  getListBrandKitsQueryKey
} from "@workspace/api-client-react";
import { ObjectUploader } from "@workspace/object-storage-web";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Palette, Plus, Trash2, Image as ImageIcon } from "lucide-react";

export function BrandKitsPage() {
  const { data: kits, isLoading } = useListBrandKits();
  const createBrandKit = useCreateBrandKit();
  const deleteBrandKit = useDeleteBrandKit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#5b21b6");
  const [secondaryColor, setSecondaryColor] = useState("#ec4899");
  const [voice, setVoice] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [logoPath, setLogoPath] = useState<string | null>(null);

  const handleCreate = () => {
    if (!name) return;
    
    createBrandKit.mutate({
      data: {
        name,
        primaryColor,
        secondaryColor,
        voice,
        hashtags: hashtags.split(",").map(h => h.trim()).filter(Boolean),
        logoPath
      }
    }, {
      onSuccess: () => {
        toast({ title: "Brand Kit created!" });
        queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
        setOpen(false);
        // Reset form
        setName(""); setVoice(""); setHashtags(""); setLogoPath(null);
      }
    });
  };

  const handleDelete = (id: number) => {
    if (!confirm("Delete this brand kit?")) return;
    deleteBrandKit.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Brand Kit deleted" });
        queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const items = kits || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Brand Kits</h1>
          <p className="text-muted-foreground text-lg mt-1">Manage colors, logos, and voices for your brands.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> New Kit
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-24 bg-card rounded-2xl border border-border shadow-sm">
          <Palette className="mx-auto h-16 w-16 text-muted mb-4" />
          <h3 className="text-xl font-bold">No Brand Kits</h3>
          <p className="text-muted-foreground mt-2 mb-6">Create your first brand kit to maintain consistency across AI generation.</p>
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-2" /> Create Kit</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((kit, i) => (
            <Card key={kit.id} className="overflow-hidden flex flex-col group hover:shadow-lg transition-all duration-300 border-border animate-in fade-in" style={{ animationDelay: `${i * 50}ms` }}>
              <div className="h-24 w-full flex" style={{ background: `linear-gradient(135deg, ${kit.primaryColor} 0%, ${kit.secondaryColor} 100%)` }}>
                {kit.logoPath && (
                  <div className="m-auto h-16 w-16 bg-white/20 backdrop-blur-md rounded-xl p-2 border border-white/30 shadow-xl">
                    <img src={`/api/storage${kit.logoPath}`} alt={kit.name} className="w-full h-full object-contain drop-shadow-md" />
                  </div>
                )}
              </div>
              <CardContent className="flex-1 p-6 relative">
                <div className="flex justify-between items-start gap-4 mb-4">
                  <h3 className="font-bold text-xl">{kit.name}</h3>
                  <Button variant="ghost" size="icon" className="text-destructive/50 hover:text-destructive hover:bg-destructive/10 -mt-2 -mr-2" onClick={() => handleDelete(kit.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">Brand Voice</span>
                    <p className="text-sm font-medium leading-relaxed">{kit.voice || "Not specified"}</p>
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Colors</span>
                    <div className="flex gap-2">
                      <div className="h-8 w-8 rounded-full shadow-inner border border-black/10" style={{ backgroundColor: kit.primaryColor }} title="Primary" />
                      <div className="h-8 w-8 rounded-full shadow-inner border border-black/10" style={{ backgroundColor: kit.secondaryColor }} title="Secondary" />
                    </div>
                  </div>
                  {kit.hashtags && kit.hashtags.length > 0 && (
                    <div>
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">Tags</span>
                      <div className="flex flex-wrap gap-1">
                        {kit.hashtags.map(tag => (
                          <span key={tag} className="text-xs bg-muted px-2 py-1 rounded-md text-foreground font-medium">#{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create Brand Kit</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto px-1">
            <div className="space-y-2">
              <label className="text-sm font-medium">Kit Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme Corp Summer" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Primary Color</label>
                <div className="flex gap-2">
                  <Input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="w-12 p-1 h-10" />
                  <Input value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="flex-1" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Secondary Color</label>
                <div className="flex gap-2">
                  <Input type="color" value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className="w-12 p-1 h-10" />
                  <Input value={secondaryColor} onChange={e => setSecondaryColor(e.target.value)} className="flex-1" />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Brand Voice</label>
              <Textarea 
                value={voice} 
                onChange={e => setVoice(e.target.value)} 
                placeholder="e.g. Professional, authoritative, yet approachable..." 
                className="resize-none"
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Default Hashtags (comma separated)</label>
              <Input value={hashtags} onChange={e => setHashtags(e.target.value)} placeholder="tech, innovation, future" />
            </div>

            <div className="space-y-2 pt-2">
              <label className="text-sm font-medium block">Logo</label>
              {logoPath ? (
                <div className="flex items-center gap-4 p-4 bg-muted rounded-lg border border-border">
                  <div className="h-12 w-12 bg-white rounded flex items-center justify-center overflow-hidden p-1 shadow-sm">
                    <img src={`/api/storage${logoPath}`} alt="Logo" className="max-w-full max-h-full object-contain" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Logo uploaded</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setLogoPath(null)}>Remove</Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-border rounded-lg p-6 flex flex-col items-center justify-center bg-muted/30">
                  <ImageIcon className="h-8 w-8 text-muted-foreground/50 mb-3" />
                  <ObjectUploader
                    onGetUploadParameters={async (file) => {
                      const res = await fetch("/api/storage/uploads/request-url", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
                      });
                      const { uploadURL, objectPath } = await res.json();
                      // We store the objectPath in localStorage temporarily as a hack to pass it to onComplete since Uppy meta is messy
                      localStorage.setItem('tempUploadPath', objectPath);
                      return { method: "PUT", url: uploadURL, headers: { "Content-Type": file.type } };
                    }}
                    onComplete={() => {
                      const path = localStorage.getItem('tempUploadPath');
                      if (path) {
                        setLogoPath(path);
                        localStorage.removeItem('tempUploadPath');
                        toast({ title: "Logo uploaded successfully" });
                      }
                    }}
                  >
                    Upload Image
                  </ObjectUploader>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createBrandKit.isPending || !name}>Create Kit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}