import { useState } from "react";
import { 
  useListAccounts,
  useCreateAccount,
  useDeleteAccount,
  getListAccountsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Share2, Plus, Trash2, CheckCircle2, Instagram, Facebook, Linkedin, Youtube, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ICONS: Record<string, any> = {
  instagram: { icon: Instagram, color: "text-pink-600", bg: "bg-pink-600/10" },
  facebook: { icon: Facebook, color: "text-blue-600", bg: "bg-blue-600/10" },
  linkedin: { icon: Linkedin, color: "text-blue-700", bg: "bg-blue-700/10" },
  youtube: { icon: Youtube, color: "text-red-600", bg: "bg-red-600/10" },
};

const HANDLE_HINTS: Record<string, { placeholder: string; hint: string }> = {
  instagram: {
    placeholder: "@yourbrand",
    hint: "Open the Instagram app or instagram.com and go to your profile. Your handle is the @username shown at the top of your profile.",
  },
  facebook: {
    placeholder: "Your Page name",
    hint: "Go to facebook.com and open your Page. The name appears at the top of the Page, and the @handle is shown under it (Page Settings > Username).",
  },
  linkedin: {
    placeholder: "Your name or company",
    hint: "On linkedin.com, open your profile or company page. Your public handle is in the URL, e.g. linkedin.com/in/your-handle or /company/your-company.",
  },
  youtube: {
    placeholder: "@yourchannel",
    hint: "On youtube.com, click your avatar > Your channel. Your handle is the @name shown under the channel title (or in Settings > Channel).",
  },
};

export function AccountsPage() {
  const { data: accounts, isLoading } = useListAccounts();
  const createAccount = useCreateAccount();
  const deleteAccount = useDeleteAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("instagram");
  const [accountName, setAccountName] = useState("");

  const handleCreate = () => {
    if (!accountName) return;
    createAccount.mutate({
      data: { platform: platform as any, accountName }
    }, {
      onSuccess: () => {
        toast({ title: "Account connected!" });
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        setOpen(false);
        setAccountName("");
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Couldn't connect account",
          description: err?.response?.data?.message || err?.message || "Please try again.",
        });
      },
    });
  };

  const handleDelete = (id: number) => {
    if (!confirm("Disconnect this account?")) return;
    deleteAccount.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Account disconnected" });
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const items = accounts || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Connected Accounts</h1>
          <p className="text-muted-foreground text-lg mt-1">Manage your linked social media profiles.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> Connect
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {items.length === 0 && (
          <div className="col-span-full text-center py-20 bg-card rounded-2xl border border-border">
            <Share2 className="mx-auto h-12 w-12 text-muted mb-4" />
            <h3 className="text-xl font-bold">No Accounts Connected</h3>
            <p className="text-muted-foreground mt-2 mb-6">Connect your social accounts to enable direct scheduling.</p>
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-2" /> Connect Account</Button>
          </div>
        )}
        
        {items.map((acc, i) => {
          const config = ICONS[acc.platform] || { icon: Share2, color: "text-primary", bg: "bg-primary/10" };
          const Icon = config.icon;
          
          return (
            <Card key={acc.id} className="overflow-hidden border-border group transition-all duration-300 hover:shadow-md animate-in fade-in" style={{ animationDelay: `${i * 50}ms` }}>
              <CardContent className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={`h-12 w-12 rounded-xl flex items-center justify-center ${config.bg} ${config.color}`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">{acc.accountName}</h3>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-0.5">
                      <span className="capitalize">{acc.platform}</span>
                      <span className="text-muted-foreground/30">•</span>
                      <span className="text-green-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="text-destructive/50 hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(acc.id)}>
                  <Trash2 className="h-5 w-5" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Connect Account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform</label>
              <Select onValueChange={setPlatform} value={platform}>
                <SelectTrigger><SelectValue placeholder="Select platform" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram"><div className="flex items-center gap-2"><Instagram className="text-pink-600"/> Instagram</div></SelectItem>
                  <SelectItem value="facebook"><div className="flex items-center gap-2"><Facebook className="text-blue-600"/> Facebook</div></SelectItem>
                  <SelectItem value="linkedin"><div className="flex items-center gap-2"><Linkedin className="text-blue-700"/> LinkedIn</div></SelectItem>
                  <SelectItem value="youtube"><div className="flex items-center gap-2"><Youtube className="text-red-600"/> YouTube</div></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Account Handle / Name</label>
              <Input
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder={HANDLE_HINTS[platform]?.placeholder ?? "@yourbrand"}
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                {HANDLE_HINTS[platform]?.hint}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={createAccount.isPending}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createAccount.isPending || !accountName}>
              {createAccount.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
              ) : (
                "Connect"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}