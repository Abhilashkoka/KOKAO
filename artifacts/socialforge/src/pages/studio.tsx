import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useGenerateCaption, 
  useGenerateImage, 
  useCreateContent, 
  useListBrandKits,
  getListContentQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Wand2, Image as ImageIcon, Save, Loader2 } from "lucide-react";
import { navigate } from "wouter/use-browser-location";

const schema = z.object({
  prompt: z.string().min(3, "Prompt must be at least 3 characters"),
  platform: z.string().optional(),
  brandKitId: z.coerce.number().optional().or(z.literal(0)),
  tone: z.string().optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
});

export function StudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [captionResult, setCaptionResult] = useState<{ caption: string, hashtags: string[] } | null>(null);
  const [imageResult, setImageResult] = useState<{ imagePath: string, b64Json: string } | null>(null);

  const { data: brandKits } = useListBrandKits();
  
  const generateCaption = useGenerateCaption();
  const generateImage = useGenerateImage();
  const createContent = useCreateContent();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      prompt: "",
      platform: "instagram",
      tone: "professional",
      size: "1024x1024",
    },
  });

  const handleError = (error: any) => {
    if (error?.status === 402 || error?.response?.status === 402) {
      toast({ title: "Quota Reached", description: "You've reached your monthly AI limit. Please upgrade your plan.", variant: "destructive" });
    } else {
      toast({ title: "Error", description: error?.message || "Failed to generate content.", variant: "destructive" });
    }
  };

  const onGenerateCaption = async (data: z.infer<typeof schema>) => {
    generateCaption.mutate(
      { data: { prompt: data.prompt, platform: data.platform, brandKitId: data.brandKitId || undefined, tone: data.tone } },
      {
        onSuccess: (res) => {
          setCaptionResult(res);
          toast({ title: "Caption generated!" });
        },
        onError: handleError
      }
    );
  };

  const onGenerateImage = async (data: z.infer<typeof schema>) => {
    generateImage.mutate(
      { data: { prompt: data.prompt, size: data.size as any, brandKitId: data.brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setImageResult(res);
          toast({ title: "Image generated!" });
        },
        onError: handleError
      }
    );
  };

  const handleSave = () => {
    if (!captionResult?.caption && !imageResult?.imagePath) {
      toast({ title: "Nothing to save", variant: "destructive" });
      return;
    }
    
    const values = form.getValues();
    createContent.mutate(
      {
        data: {
          title: values.prompt.slice(0, 30) + "...",
          caption: captionResult?.caption || undefined,
          imagePath: imageResult?.imagePath || undefined,
          imagePrompt: imageResult ? values.prompt : undefined,
          platform: values.platform,
          status: "draft",
          brandKitId: values.brandKitId || undefined,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          toast({ title: "Saved to library!" });
          navigate("/library");
        },
        onError: (err) => {
          toast({ title: "Failed to save", description: (err as any).message, variant: "destructive" });
        }
      }
    );
  };

  const isPending = generateCaption.isPending || generateImage.isPending || createContent.isPending;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">AI Content Studio</h1>
        <p className="text-muted-foreground text-lg mt-1">Generate engaging captions and stunning visuals in seconds.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-6">
          <Card className="border-border shadow-md">
            <CardHeader>
              <CardTitle>Creative Brief</CardTitle>
              <CardDescription>Tell the AI what you want to create.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form className="space-y-4">
                  <FormField
                    control={form.control}
                    name="prompt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Prompt</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="e.g. A post announcing our new summer coffee blend, focus on the refreshing taste." 
                            className="min-h-[120px] resize-none"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="platform"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Platform</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Platform" /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="instagram">Instagram</SelectItem>
                              <SelectItem value="twitter">Twitter / X</SelectItem>
                              <SelectItem value="linkedin">LinkedIn</SelectItem>
                              <SelectItem value="facebook">Facebook</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="tone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tone</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Tone" /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="professional">Professional</SelectItem>
                              <SelectItem value="casual">Casual</SelectItem>
                              <SelectItem value="funny">Funny</SelectItem>
                              <SelectItem value="enthusiastic">Energetic</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="brandKitId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Brand Kit</FormLabel>
                          <Select onValueChange={(val) => field.onChange(val === "none" ? 0 : parseInt(val))} value={field.value ? field.value.toString() : "none"}>
                            <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {brandKits?.map(bk => <SelectItem key={bk.id} value={bk.id.toString()}>{bk.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="size"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Image Size</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl><SelectTrigger><SelectValue placeholder="Size" /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="1024x1024">Square (1:1)</SelectItem>
                              <SelectItem value="1536x1024">Landscape (3:2)</SelectItem>
                              <SelectItem value="1024x1536">Portrait (2:3)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="pt-4 flex flex-col gap-3">
                    <Button 
                      type="button" 
                      onClick={form.handleSubmit(onGenerateCaption)} 
                      disabled={isPending}
                      className="w-full"
                    >
                      {generateCaption.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                      Generate Caption
                    </Button>
                    <Button 
                      type="button" 
                      variant="secondary"
                      onClick={form.handleSubmit(onGenerateImage)} 
                      disabled={isPending}
                      className="w-full"
                    >
                      {generateImage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImageIcon className="mr-2 h-4 w-4" />}
                      Generate Image
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-7 flex flex-col gap-6">
          <Card className="border-border shadow-md flex-1 flex flex-col overflow-hidden">
            <CardHeader className="border-b bg-muted/30">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Results</CardTitle>
                  <CardDescription>Review and save your generated content.</CardDescription>
                </div>
                {(captionResult || imageResult) && (
                  <Button onClick={handleSave} disabled={isPending} size="sm">
                    {createContent.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save to Library
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 bg-muted/10">
              {(!captionResult && !imageResult) ? (
                <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <Wand2 className="h-12 w-12 text-muted mb-4" />
                  <p>Your generated content will appear here.</p>
                </div>
              ) : (
                <div className="flex flex-col h-full divide-y">
                  {imageResult && (
                    <div className="p-6 flex items-center justify-center bg-card">
                      <img 
                        src={`data:image/png;base64,${imageResult.b64Json}`} 
                        alt="Generated" 
                        className="max-h-[400px] rounded-lg shadow-lg border border-border object-contain"
                      />
                    </div>
                  )}
                  {captionResult && (
                    <div className="p-6 bg-card flex-1">
                      <h4 className="font-medium text-sm text-muted-foreground mb-3 uppercase tracking-wider">Caption</h4>
                      <p className="whitespace-pre-wrap text-lg">{captionResult.caption}</p>
                      {captionResult.hashtags.length > 0 && (
                        <div className="mt-6 flex flex-wrap gap-2">
                          {captionResult.hashtags.map(tag => (
                            <span key={tag} className="text-sm font-medium text-primary bg-primary/10 px-2 py-1 rounded-md">
                              {tag.startsWith('#') ? tag : `#${tag}`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}