import { useState } from "react";
import { 
  useListContent, 
  useDeleteContent,
  useUpdateContent,
  getListContentQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Calendar, Edit, MoreVertical, Trash2, LayoutGrid } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function LibraryPage() {
  const { data: content, isLoading } = useListContent();
  const deleteContent = useDeleteContent();
  const updateContent = useUpdateContent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editItem, setEditItem] = useState<any | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCaption, setEditCaption] = useState("");

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this content?")) return;
    deleteContent.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Content deleted" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      }
    });
  };

  const openEdit = (item: any) => {
    setEditItem(item);
    setEditTitle(item.title);
    setEditCaption(item.caption || "");
  };

  const handleUpdate = () => {
    if (!editItem) return;
    updateContent.mutate({
      id: editItem.id,
      data: { title: editTitle, caption: editCaption }
    }, {
      onSuccess: () => {
        toast({ title: "Content updated" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setEditItem(null);
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-72 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const items = content || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Content Library</h1>
          <p className="text-muted-foreground text-lg mt-1">Manage your generated captions and images.</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-20 bg-muted/30 rounded-2xl border border-border border-dashed">
          <LayoutGrid className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-xl font-semibold">Library is empty</h3>
          <p className="text-muted-foreground mt-2 mb-6">You haven't saved any content yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {items.map((item, i) => (
            <Card key={item.id} className="overflow-hidden flex flex-col group hover:shadow-lg transition-all duration-300 border-border animate-in fade-in" style={{ animationDelay: `${i * 50}ms` }}>
              {item.imagePath ? (
                <div className="aspect-square w-full bg-muted relative overflow-hidden border-b">
                  <img src={`/api/storage${item.imagePath}`} alt={item.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              ) : (
                <div className="aspect-video w-full bg-primary/5 flex flex-col items-center justify-center p-6 border-b relative">
                  <LayoutGrid className="h-10 w-10 text-primary/30 mb-2" />
                  <p className="text-xs font-medium text-primary/50 uppercase tracking-widest">Text Only</p>
                </div>
              )}
              
              <CardContent className="flex-1 p-5">
                <div className="flex justify-between items-start gap-2 mb-3">
                  <h3 className="font-semibold text-lg line-clamp-1" title={item.title}>{item.title}</h3>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2 shrink-0">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(item)}><Edit className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(item.id)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                
                {item.caption && (
                  <p className="text-muted-foreground text-sm line-clamp-3 mb-4">{item.caption}</p>
                )}
              </CardContent>
              
              <CardFooter className="p-4 pt-0 bg-card flex justify-between items-center text-xs text-muted-foreground">
                <span className="capitalize font-medium px-2 py-1 bg-muted rounded-md">{item.platform}</span>
                <span className={`px-2 py-1 rounded-md font-medium uppercase ${item.status === 'published' ? 'text-green-600 bg-green-600/10' : item.status === 'scheduled' ? 'text-blue-600 bg-blue-600/10' : 'text-orange-600 bg-orange-600/10'}`}>
                  {item.status}
                </span>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editItem} onOpenChange={(open) => !open && setEditItem(null)}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Content</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Caption</label>
              <Textarea 
                value={editCaption} 
                onChange={e => setEditCaption(e.target.value)} 
                className="min-h-[150px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={updateContent.isPending}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}