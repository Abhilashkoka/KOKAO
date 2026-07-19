import { useState } from "react";
import { 
  useListSchedules, 
  useListContent,
  useCreateSchedule,
  useDeleteSchedule,
  getListSchedulesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock, Plus, Trash2, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { PendingPostsWarnings } from "@/components/pending-posts-warning";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { track, trackFeatureUse } from "@/lib/analytics";

export function SchedulePage() {
  const { data: schedules, isLoading: sLoading } = useListSchedules();
  const { data: content, isLoading: cLoading } = useListContent();
  const createSchedule = useCreateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [contentId, setContentId] = useState<string>("");
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [time, setTime] = useState("12:00");
  const [platform, setPlatform] = useState("instagram");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const handleCreate = () => {
    if (!contentId || !date) return;
    
    // Combine date and time
    const [hours, minutes] = time.split(':');
    const scheduledAt = new Date(date);
    scheduledAt.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    createSchedule.mutate({
      data: {
        contentItemId: parseInt(contentId),
        platform,
        scheduledAt: scheduledAt.toISOString()
      }
    }, {
      onSuccess: () => {
        track("post_scheduled", { platform });
        trackFeatureUse("scheduler");
        toast({ title: "Post scheduled!" });
        queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
        setOpen(false);
      },
      onError: (err: any) => {
        toast({ title: "Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleDelete = (id: number) => {
    deleteSchedule.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Schedule removed" });
        queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
      }
    });
  };

  if (sLoading || cLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  const items = schedules || [];
  const sortedItems = [...items].sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Schedule</h1>
          <p className="text-muted-foreground text-lg mt-1">Plan your content calendar.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> Schedule Post
        </Button>
      </div>

      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
        {sortedItems.length === 0 ? (
          <div className="text-center py-24 px-4">
            <CalendarIcon className="mx-auto h-16 w-16 text-muted mb-4" />
            <h3 className="text-xl font-bold">Your calendar is empty</h3>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto">You haven't scheduled any posts yet. Schedule your first piece of content to start planning.</p>
            <Button onClick={() => setOpen(true)} className="mt-6" variant="outline">
              <Plus className="h-4 w-4 mr-2" /> Schedule Now
            </Button>
          </div>
        ) : (
          <div className="divide-y">
            {sortedItems.map((post) => {
              const contentItem = content?.find(c => c.id === post.contentItemId);
              const postDate = new Date(post.scheduledAt);
              const isDone = post.status === "published" || post.status === "failed" || post.status === "cancelled";
              
              return (
                <div key={post.id} className={cn("p-6 flex flex-col md:flex-row items-start md:items-center gap-6 transition-colors hover:bg-muted/30", post.status === "published" && "opacity-60")}>
                  <div className="w-full md:w-48 shrink-0 flex items-center gap-4 border-r border-transparent md:border-border">
                    <div className={cn("h-14 w-14 rounded-2xl flex flex-col items-center justify-center shrink-0 border", isDone ? "bg-muted text-muted-foreground border-border" : "bg-primary/10 text-primary border-primary/20")}>
                      <span className="text-lg font-bold leading-none">{postDate.getDate()}</span>
                      <span className="text-[10px] uppercase font-bold tracking-wider">{format(postDate, 'MMM')}</span>
                    </div>
                    <div>
                      <div className="font-semibold">{format(postDate, 'EEEE')}</div>
                      <div className="text-sm text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> {format(postDate, 'h:mm a')}</div>
                    </div>
                  </div>
                  
                  <div className="flex-1 min-w-0 flex items-center gap-4">
                    {contentItem?.imagePath ? (
                      <img src={`/api/storage${contentItem.imagePath}`} alt="Thumbnail" className="h-16 w-16 rounded-lg object-cover border border-border shadow-sm shrink-0" />
                    ) : (
                      <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center border border-border shrink-0">
                        <CalendarIcon className="h-6 w-6 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h4 className="font-bold text-lg truncate">{contentItem?.title || 'Unknown Post'}</h4>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground uppercase tracking-wider">{post.platform}</span>
                        <span
                          data-testid={`text-schedule-status-${post.id}`}
                          className={cn(
                            "text-xs font-semibold flex items-center gap-1",
                            post.status === "published" && "text-green-600",
                            post.status === "failed" && "text-destructive",
                            post.status === "processing" && "text-amber-600",
                            post.status === "pending" && "text-blue-600",
                            post.status === "cancelled" && "text-muted-foreground",
                          )}
                        >
                          {post.status === "published" && <><CheckCircle2 className="h-3 w-3" /> Published</>}
                          {post.status === "failed" && <><XCircle className="h-3 w-3" /> Failed</>}
                          {post.status === "processing" && <><Loader2 className="h-3 w-3 animate-spin" /> Publishing</>}
                          {post.status === "pending" && "Pending"}
                          {post.status === "cancelled" && "Cancelled"}
                        </span>
                      </div>
                      {post.status === "failed" && post.failureReason && (
                        <p className="text-xs text-destructive mt-2" data-testid={`text-schedule-failure-${post.id}`}>
                          {post.failureReason}
                        </p>
                      )}
                      {contentItem && (
                        <div className="mt-3 [&>div]:mb-0 space-y-2">
                          <PendingPostsWarnings item={contentItem} idPrefix="schedule-" />
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="shrink-0 flex items-center">
                    <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" data-testid={`button-delete-schedule-${post.id}`} onClick={() => setDeleteId(post.id)}>
                      <Trash2 className="h-5 w-5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Schedule Post</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Content</label>
              <Select onValueChange={setContentId} value={contentId}>
                <SelectTrigger><SelectValue placeholder="Select a content item" /></SelectTrigger>
                <SelectContent>
                  {content?.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform</label>
              <Select onValueChange={setPlatform} value={platform}>
                <SelectTrigger><SelectValue placeholder="Platform" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="twitter">Twitter / X</SelectItem>
                  <SelectItem value="threads">Threads</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !date && "text-muted-foreground")}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {date ? format(date, "PPP") : <span>Pick a date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar mode="single" selected={date} onSelect={setDate} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Time</label>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createSchedule.isPending || !contentId || !date}>Schedule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this scheduled post?"
        description="The post will be taken off your calendar. The content itself stays in your library."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (deleteId !== null) handleDelete(deleteId);
        }}
      />
    </div>
  );
}