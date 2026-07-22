import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGenerateVideo,
  useGetVideoJob,
  useListVideoJobs,
  useSaveVideoToLibrary,
  useGetGoogleDriveStatus,
  useDisconnectGoogleDrive,
  useListGoogleDriveFiles,
  useImportGoogleDriveFiles,
  useRequestUploadUrl,
  useListContent,
  getGoogleDriveAuthUrl,
  getListVideoJobsQueryKey,
  getGetVideoJobQueryKey,
  getGetGoogleDriveStatusQueryKey,
  getListGoogleDriveFilesQueryKey,
  getListContentQueryKey,
  type VideoJob,
  type GoogleDriveFile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Clapperboard,
  Film,
  Image as ImageIcon,
  Images,
  Upload,
  X,
  Music,
  Save,
  Folder,
  HardDrive,
  ChevronLeft,
  Library,
  CheckCircle2,
  XCircle,
  Sparkles,
  Lightbulb,
} from "lucide-react";
import { navigate } from "wouter/use-browser-location";

type Engine = "text_to_video" | "image_to_video" | "slideshow" | "topic_to_video";
type Aspect = "16:9" | "9:16" | "1:1";
type Voice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

const VOICES: { value: Voice; label: string }[] = [
  { value: "alloy", label: "Alloy · balanced" },
  { value: "nova", label: "Nova · bright" },
  { value: "shimmer", label: "Shimmer · warm" },
  { value: "echo", label: "Echo · deep" },
  { value: "onyx", label: "Onyx · bold" },
  { value: "fable", label: "Fable · storyteller" },
];

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MUSIC_TYPES = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav"];
const MAX_PHOTOS = 20;

interface PickedPhoto {
  objectPath: string;
  /** Local object URL for fresh uploads; storage URL otherwise. */
  previewUrl: string;
  name: string;
}

function storageUrl(path: string): string {
  return `/api/storage${path}`;
}

const ENGINE_META: Record<Engine, { title: string; blurb: string }> = {
  text_to_video: {
    title: "Text to Video",
    blurb: "Describe the clip and AI films it for you.",
  },
  image_to_video: {
    title: "Animate Photo",
    blurb: "Bring one photo to life with subtle AI motion.",
  },
  slideshow: {
    title: "Photo Slideshow",
    blurb: "Photos in, a polished video with crossfades out. No AI cost.",
  },
  topic_to_video: {
    title: "Topic to Video",
    blurb: "Give a topic — AI writes the script, narrates it, and cuts stock footage to match.",
  },
};

export function VideoStudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [engine, setEngine] = useState<Engine>("text_to_video");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [durationSec, setDurationSec] = useState(5);
  const [slideDurationSec, setSlideDurationSec] = useState(3);
  const [overlayText, setOverlayText] = useState("");
  const [voice, setVoice] = useState<Voice>("alloy");
  const [paragraphCount, setParagraphCount] = useState(1);
  const [subtitles, setSubtitles] = useState(true);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [music, setMusic] = useState<{ objectPath: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const [saveCaption, setSaveCaption] = useState("");
  const [savePlatform, setSavePlatform] = useState("instagram");

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);

  const requestUploadUrl = useRequestUploadUrl();
  const generateVideo = useGenerateVideo();
  const saveToLibrary = useSaveVideoToLibrary();
  const { data: jobs } = useListVideoJobs({
    query: { queryKey: getListVideoJobsQueryKey() },
  });

  // Poll the active job until it settles; the server does the heavy lifting.
  const { data: activeJob } = useGetVideoJob(activeJobId ?? 0, {
    query: {
      queryKey: getGetVideoJobQueryKey(activeJobId ?? 0),
      enabled: activeJobId !== null,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "processing" ? 3000 : false;
      },
    },
  });

  // Announce settle exactly once per job.
  const announcedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeJob || announcedRef.current === activeJob.id) return;
    if (activeJob.status === "succeeded") {
      announcedRef.current = activeJob.id;
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      toast({ title: "Video ready", description: "Preview it below, then save it to your library." });
    } else if (activeJob.status === "failed") {
      announcedRef.current = activeJob.id;
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      toast({
        title: "Video generation failed",
        description: activeJob.error ?? "Please try again.",
        variant: "destructive",
      });
    }
  }, [activeJob, queryClient, toast]);

  // Google Drive OAuth lands back here with ?drive=connected|error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (!drive) return;
    if (drive === "connected") {
      toast({ title: "Google Drive connected", description: "Pick photos via 'From Google Drive'." });
      void queryClient.invalidateQueries({ queryKey: getGetGoogleDriveStatusQueryKey() });
    } else {
      toast({
        title: "Google Drive connection failed",
        description: params.get("reason") ?? undefined,
        variant: "destructive",
      });
    }
    params.delete("drive");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }, [queryClient, toast]);

  const uploadFile = async (file: File): Promise<string> => {
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
  };

  const addPhotos = (picked: PickedPhoto[]) => {
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.objectPath));
      const fresh = picked.filter((p) => !seen.has(p.objectPath));
      return [...prev, ...fresh].slice(0, MAX_PHOTOS);
    });
  };

  const handlePhotoFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (accepted.length !== files.length) {
      toast({
        title: "Some files skipped",
        description: "Only PNG, JPEG, and WebP photos are supported.",
        variant: "destructive",
      });
    }
    const oversize = accepted.filter((f) => f.size > 10 * 1024 * 1024);
    if (oversize.length) {
      toast({ title: "Photo too large", description: "Photos must be under 10 MB.", variant: "destructive" });
    }
    const good = accepted.filter((f) => f.size <= 10 * 1024 * 1024);
    if (!good.length) return;
    setUploading(true);
    try {
      const uploaded: PickedPhoto[] = [];
      for (const file of good) {
        const objectPath = await uploadFile(file);
        uploaded.push({ objectPath, previewUrl: URL.createObjectURL(file), name: file.name });
      }
      addPhotos(uploaded);
    } catch {
      toast({ title: "Upload failed", description: "Could not upload photos. Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const handleMusicFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!MUSIC_TYPES.includes(file.type)) {
      toast({ title: "Not a supported audio file", description: "Use MP3, M4A, AAC, or WAV.", variant: "destructive" });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "Track too large", description: "Music must be under 15 MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      setMusic({ objectPath, name: file.name });
    } catch {
      toast({ title: "Upload failed", description: "Could not upload the track. Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (musicInputRef.current) musicInputRef.current.value = "";
    }
  };

  const canGenerate = useMemo(() => {
    if (generateVideo.isPending || uploading) return false;
    if (engine === "text_to_video" || engine === "topic_to_video")
      return prompt.trim().length >= 3;
    if (engine === "image_to_video") return photos.length >= 1;
    return photos.length >= 1;
  }, [engine, prompt, photos, generateVideo.isPending, uploading]);

  const busy =
    activeJob != null &&
    activeJob.id === activeJobId &&
    (activeJob.status === "queued" || activeJob.status === "processing");

  const onGenerate = () => {
    generateVideo.mutate(
      {
        data: {
          engine,
          prompt: prompt.trim() || null,
          sourceImagePaths:
            engine === "text_to_video" || engine === "topic_to_video"
              ? []
              : engine === "image_to_video"
                ? photos.slice(0, 1).map((p) => p.objectPath)
                : photos.map((p) => p.objectPath),
          aspectRatio: aspect,
          durationSec,
          slideDurationSec,
          overlayText: engine === "slideshow" && overlayText.trim() ? overlayText.trim() : null,
          musicPath:
            engine === "slideshow" || engine === "topic_to_video"
              ? (music?.objectPath ?? null)
              : null,
          voice,
          stockSource: "auto",
          subtitles,
          paragraphCount,
        },
      },
      {
        onSuccess: (job) => {
          announcedRef.current = null;
          setActiveJobId(job.id);
          void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
        },
        onError: (error: any) => {
          if (error?.status === 402) {
            toast({
              title: "Video quota reached",
              description: error?.message || "Upgrade your plan or buy a credit pack.",
              variant: "destructive",
            });
          } else {
            toast({
              title: "Could not start the video",
              description: error?.message || "Please try again.",
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  const onSave = () => {
    if (!activeJob || !saveTitle.trim()) return;
    saveToLibrary.mutate(
      { jobId: activeJob.id, data: { title: saveTitle.trim(), caption: saveCaption, platform: savePlatform } },
      {
        onSuccess: () => {
          setSaveOpen(false);
          void queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          toast({ title: "Saved to library", description: "Schedule or publish it from the Content Library." });
          navigate("/library");
        },
        onError: (error: any) =>
          toast({
            title: "Could not save",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const removePhoto = (objectPath: string) =>
    setPhotos((prev) => prev.filter((p) => p.objectPath !== objectPath));

  const needsPhotos = engine === "image_to_video" || engine === "slideshow";
  const meta = ENGINE_META[engine];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clapperboard className="h-6 w-6 text-primary" /> Video Studio
        </h1>
        <p className="text-muted-foreground mt-1">
          Turn ideas and photos into scroll-stopping videos.
        </p>
      </div>

      <Tabs value={engine} onValueChange={(v) => setEngine(v as Engine)}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
          <TabsTrigger value="text_to_video" data-testid="tab-text-to-video">
            <Sparkles className="h-4 w-4 mr-1.5" /> Text to Video
          </TabsTrigger>
          <TabsTrigger value="image_to_video" data-testid="tab-image-to-video">
            <ImageIcon className="h-4 w-4 mr-1.5" /> Animate Photo
          </TabsTrigger>
          <TabsTrigger value="slideshow" data-testid="tab-slideshow">
            <Images className="h-4 w-4 mr-1.5" /> Slideshow
          </TabsTrigger>
          <TabsTrigger value="topic_to_video" data-testid="tab-topic-to-video">
            <Lightbulb className="h-4 w-4 mr-1.5" /> Topic to Video
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>{meta.title}</CardTitle>
          <CardDescription>{meta.blurb}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {engine !== "slideshow" && (
            <div className="space-y-2">
              <Label htmlFor="video-prompt">
                {engine === "text_to_video"
                  ? "Describe your video"
                  : engine === "topic_to_video"
                    ? "What's your video about?"
                    : "Motion hint (optional)"}
              </Label>
              <Textarea
                id="video-prompt"
                data-testid="input-video-prompt"
                placeholder={
                  engine === "text_to_video"
                    ? "A steaming cup of chai on a rain-speckled window sill, cinematic close-up..."
                    : engine === "topic_to_video"
                      ? "5 morning habits that quietly transform your day..."
                      : "Slow zoom in, gentle parallax..."
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
              />
            </div>
          )}

          {needsPhotos && (
            <div className="space-y-3">
              <Label>
                {engine === "image_to_video" ? "Photo to animate" : `Photos (up to ${MAX_PHOTOS}, in order)`}
              </Label>
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {photos.map((photo) => (
                    <div key={photo.objectPath} className="relative group">
                      <img
                        src={photo.previewUrl}
                        alt={photo.name}
                        className="h-20 w-20 object-cover rounded-lg border border-border"
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${photo.name}`}
                        onClick={() => removePhoto(photo.objectPath)}
                        className="absolute -top-2 -right-2 bg-background border border-border rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => photoInputRef.current?.click()}
                  data-testid="button-upload-photos"
                >
                  <Upload className="h-4 w-4 mr-1.5" /> Upload
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLibraryOpen(true)}
                  data-testid="button-pick-library"
                >
                  <Library className="h-4 w-4 mr-1.5" /> From Library
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDriveOpen(true)}
                  data-testid="button-pick-drive"
                >
                  <HardDrive className="h-4 w-4 mr-1.5" /> From Google Drive
                </Button>
              </div>
              <input
                ref={photoInputRef}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple={engine === "slideshow"}
                className="hidden"
                onChange={(e) => void handlePhotoFiles(e.target.files)}
              />
            </div>
          )}

          <div className="flex flex-wrap items-end gap-5">
            <div className="space-y-2">
              <Label>Aspect ratio</Label>
              <ToggleGroup
                type="single"
                value={aspect}
                onValueChange={(v) => v && setAspect(v as Aspect)}
                variant="outline"
              >
                <ToggleGroupItem value="9:16" aria-label="Portrait 9:16">9:16</ToggleGroupItem>
                <ToggleGroupItem value="1:1" aria-label="Square 1:1">1:1</ToggleGroupItem>
                <ToggleGroupItem value="16:9" aria-label="Landscape 16:9">16:9</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {engine === "text_to_video" || engine === "image_to_video" ? (
              <div className="space-y-2">
                <Label>Length</Label>
                <Select value={String(durationSec)} onValueChange={(v) => setDurationSec(Number(v))}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 seconds</SelectItem>
                    <SelectItem value="8">8 seconds</SelectItem>
                    <SelectItem value="10">10 seconds</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : engine === "topic_to_video" ? (
              <>
                <div className="space-y-2">
                  <Label>Length</Label>
                  <Select
                    value={String(paragraphCount)}
                    onValueChange={(v) => setParagraphCount(Number(v))}
                  >
                    <SelectTrigger className="w-36" data-testid="select-video-length">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Short · ~30s</SelectItem>
                      <SelectItem value="2">Medium · ~60s</SelectItem>
                      <SelectItem value="3">Long · ~90s</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={voice} onValueChange={(v) => setVoice(v as Voice)}>
                    <SelectTrigger className="w-44" data-testid="select-video-voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICES.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>Seconds per photo</Label>
                <Select
                  value={String(slideDurationSec)}
                  onValueChange={(v) => setSlideDurationSec(Number(v))}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2, 3, 4, 5].map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s} seconds
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {(engine === "slideshow" || engine === "topic_to_video") && (
            <div className="grid gap-4 sm:grid-cols-2">
              {engine === "slideshow" ? (
                <div className="space-y-2">
                  <Label htmlFor="overlay-text">Caption on video (optional)</Label>
                  <Input
                    id="overlay-text"
                    data-testid="input-overlay-text"
                    maxLength={120}
                    placeholder="Summer collection '26"
                    value={overlayText}
                    onChange={(e) => setOverlayText(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="topic-subtitles">Subtitles</Label>
                  <div className="flex items-center gap-3 border border-border rounded-md px-3 py-2">
                    <Switch
                      id="topic-subtitles"
                      checked={subtitles}
                      onCheckedChange={setSubtitles}
                      data-testid="switch-subtitles"
                    />
                    <span className="text-sm text-muted-foreground">
                      Burn captions into the video
                    </span>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label>Background music (optional)</Label>
                {music ? (
                  <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                    <Music className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate">{music.name}</span>
                    <button type="button" aria-label="Remove music" onClick={() => setMusic(null)} className="ml-auto">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => musicInputRef.current?.click()}
                    data-testid="button-upload-music"
                  >
                    <Music className="h-4 w-4 mr-1.5" /> Add a track
                  </Button>
                )}
                <input
                  ref={musicInputRef}
                  type="file"
                  accept={MUSIC_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => void handleMusicFile(e.target.files)}
                />
              </div>
            </div>
          )}

          <Button
            onClick={onGenerate}
            disabled={!canGenerate || busy}
            className="w-full sm:w-auto"
            data-testid="button-generate-video"
          >
            {generateVideo.isPending || busy ? (
              <>
                <RippleSpinner className="mr-2 h-4 w-4" /> Generating…
              </>
            ) : (
              <>
                <Film className="h-4 w-4 mr-2" /> Generate video
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {activeJob && (
        <Card data-testid="card-active-job">
          <CardContent className="pt-6 space-y-4">
            {busy && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <RippleSpinner className="h-5 w-5" />
                  <div>
                    <p className="font-medium">
                      {activeJob.status === "queued" ? "Queued…" : "Rendering your video…"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {activeJob.engine === "slideshow"
                        ? "Stitching photos with crossfades."
                        : activeJob.engine === "topic_to_video"
                          ? "Writing the script, recording narration, and cutting footage. This can take a few minutes — the job keeps running if you leave."
                          : "AI video can take a few minutes. You can leave this page — the job keeps running."}
                    </p>
                  </div>
                </div>
                <Progress value={activeJob.status === "queued" ? 15 : 60} />
              </div>
            )}
            {activeJob.status === "succeeded" && activeJob.videoPath && (
              <div className="space-y-4">
                <video
                  controls
                  playsInline
                  preload="metadata"
                  poster={activeJob.thumbnailPath ? storageUrl(activeJob.thumbnailPath) : undefined}
                  src={storageUrl(activeJob.videoPath)}
                  className={`rounded-xl border border-border bg-black mx-auto max-h-[480px] ${
                    activeJob.aspectRatio === "16:9" ? "w-full" : ""
                  }`}
                  data-testid="video-preview"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setSaveTitle(activeJob.prompt?.slice(0, 60) || "New video");
                      setSaveOpen(true);
                    }}
                    data-testid="button-save-video"
                  >
                    <Save className="h-4 w-4 mr-2" /> Save to library
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={storageUrl(activeJob.videoPath)} download>
                      Download
                    </a>
                  </Button>
                </div>
              </div>
            )}
            {activeJob.status === "failed" && (
              <div className="flex items-start gap-3 text-destructive">
                <XCircle className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Generation failed</p>
                  <p className="text-sm">{activeJob.error ?? "Please try again."}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {jobs && jobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent videos</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {jobs.map((job: VideoJob) => (
              <button
                key={job.id}
                type="button"
                onClick={() => {
                  announcedRef.current = job.id;
                  setActiveJobId(job.id);
                }}
                className={`text-left rounded-xl border transition-colors overflow-hidden ${
                  job.id === activeJobId ? "border-primary" : "border-border hover:border-primary/50"
                }`}
                data-testid={`job-card-${job.id}`}
              >
                <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
                  {job.thumbnailPath ? (
                    <img
                      src={storageUrl(job.thumbnailPath)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Film className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div className="p-2.5 space-y-1">
                  <p className="text-xs font-medium truncate">
                    {job.prompt || ENGINE_META[job.engine as Engine]?.title || job.engine}
                  </p>
                  <Badge
                    variant={
                      job.status === "succeeded"
                        ? "secondary"
                        : job.status === "failed"
                          ? "destructive"
                          : "outline"
                    }
                  >
                    {job.status === "succeeded" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {job.status}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to Content Library</DialogTitle>
            <DialogDescription>
              The video becomes a draft you can schedule or publish.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="save-title">Title</Label>
              <Input
                id="save-title"
                data-testid="input-save-title"
                value={saveTitle}
                onChange={(e) => setSaveTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="save-caption">Caption (optional)</Label>
              <Textarea
                id="save-caption"
                value={saveCaption}
                onChange={(e) => setSaveCaption(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select value={savePlatform} onValueChange={setSavePlatform}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="twitter">X (Twitter)</SelectItem>
                  <SelectItem value="threads">Threads</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={onSave}
              disabled={!saveTitle.trim() || saveToLibrary.isPending}
              data-testid="button-confirm-save"
            >
              {saveToLibrary.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LibraryPickerDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        single={engine === "image_to_video"}
        onPick={(picked) => {
          if (engine === "image_to_video") setPhotos(picked.slice(0, 1));
          else addPhotos(picked);
          setLibraryOpen(false);
        }}
      />

      <GoogleDrivePickerDialog
        open={driveOpen}
        onOpenChange={setDriveOpen}
        single={engine === "image_to_video"}
        onImported={(picked) => {
          if (engine === "image_to_video") setPhotos(picked.slice(0, 1));
          else addPhotos(picked);
          setDriveOpen(false);
        }}
      />
    </div>
  );
}

/** Pick previously generated/saved images from the content library. */
function LibraryPickerDialog({
  open,
  onOpenChange,
  single,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  single: boolean;
  onPick: (photos: PickedPhoto[]) => void;
}) {
  const { data: content, isLoading } = useListContent({
    query: { queryKey: getListContentQueryKey(), enabled: open },
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  const images = (content ?? []).filter((item) => item.imagePath);

  const toggle = (path: string) => {
    setSelected((prev) => {
      if (single) return new Set(prev.has(path) ? [] : [path]);
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick from your library</DialogTitle>
          <DialogDescription>Images saved in your Content Library.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <RippleSpinner className="h-6 w-6" />
          </div>
        ) : images.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No images in your library yet — generate some in AI Studio first.
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[50vh] overflow-y-auto p-1">
            {images.map((item) => {
              const path = item.imagePath!;
              const isSelected = selected.has(path);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggle(path)}
                  className={`relative rounded-lg overflow-hidden border-2 transition-colors ${
                    isSelected ? "border-primary" : "border-transparent hover:border-primary/40"
                  }`}
                >
                  <img
                    src={storageUrl(path)}
                    alt={item.title}
                    className="aspect-square object-cover w-full"
                  />
                  {isSelected && (
                    <CheckCircle2 className="absolute top-1.5 right-1.5 h-5 w-5 text-primary bg-background rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={() =>
              onPick(
                [...selected].map((path) => ({
                  objectPath: path,
                  previewUrl: storageUrl(path),
                  name: path.split("/").pop() ?? "image",
                })),
              )
            }
          >
            Use {selected.size || ""} {selected.size === 1 ? "photo" : "photos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Connect Google Drive, browse folders, and import selected photos. */
function GoogleDrivePickerDialog({
  open,
  onOpenChange,
  single,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  single: boolean;
  onImported: (photos: PickedPhoto[]) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useGetGoogleDriveStatus({
    query: { queryKey: getGetGoogleDriveStatusQueryKey(), enabled: open },
  });
  const disconnect = useDisconnectGoogleDrive();
  const importFiles = useImportGoogleDriveFiles();

  // Folder navigation stack: [{id, name}]
  const [stack, setStack] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const folderId = stack[stack.length - 1]?.id;

  useEffect(() => {
    if (!open) {
      setStack([]);
      setSelected(new Set());
    }
  }, [open]);

  const connected = !!status?.connected;
  const { data: listing, isLoading: filesLoading } = useListGoogleDriveFiles(
    folderId ? { folderId } : {},
    {
      query: {
        queryKey: getListGoogleDriveFilesQueryKey(folderId ? { folderId } : {}),
        enabled: open && connected,
      },
    },
  );

  const onConnect = async () => {
    setConnecting(true);
    try {
      const { url } = await getGoogleDriveAuthUrl();
      window.location.assign(url);
    } catch (error: any) {
      setConnecting(false);
      toast({
        title: "Google Drive unavailable",
        description: error?.message || "Ask an administrator to configure Google credentials.",
        variant: "destructive",
      });
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (single) return new Set(prev.has(id) ? [] : [id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onImport = () => {
    importFiles.mutate(
      { data: { fileIds: [...selected] } },
      {
        onSuccess: (result) => {
          if (result.failed.length) {
            toast({
              title: `${result.failed.length} photo(s) skipped`,
              description: result.failed[0]?.reason,
              variant: "destructive",
            });
          }
          if (result.imported.length) {
            onImported(
              result.imported.map((f) => ({
                objectPath: f.objectPath,
                previewUrl: storageUrl(f.objectPath),
                name: f.name,
              })),
            );
            toast({
              title: "Photos imported",
              description: `${result.imported.length} photo(s) added from Google Drive.`,
            });
          }
        },
        onError: (error: any) =>
          toast({
            title: "Import failed",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" /> Google Drive
          </DialogTitle>
          <DialogDescription>
            {connected
              ? `Connected as ${status?.accountName ?? "your Google account"}.`
              : "Connect your Google account to import photos."}
          </DialogDescription>
        </DialogHeader>

        {statusLoading ? (
          <div className="py-10 flex justify-center">
            <RippleSpinner className="h-6 w-6" />
          </div>
        ) : !connected ? (
          <div className="py-8 text-center space-y-4">
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {status?.configured
                ? status?.expired
                  ? "Your Google Drive access expired. Reconnect to continue."
                  : "KOKAO only gets read access to your Drive photos, and only imports what you pick."
                : "Google Drive is not configured yet. Ask an administrator to add Google credentials on the Admin page."}
            </p>
            <Button onClick={onConnect} disabled={!status?.configured || connecting} data-testid="button-connect-drive">
              {connecting ? "Redirecting…" : status?.expired ? "Reconnect Google Drive" : "Connect Google Drive"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {stack.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStack((prev) => prev.slice(0, -1))}
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
              )}
              <span className="truncate">
                {stack.length ? stack.map((s) => s.name).join(" / ") : "My Drive"}
              </span>
            </div>
            {filesLoading ? (
              <div className="py-10 flex justify-center">
                <RippleSpinner className="h-6 w-6" />
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[45vh] overflow-y-auto p-1">
                {(listing?.files ?? []).map((file: GoogleDriveFile) =>
                  file.isFolder ? (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setStack((prev) => [...prev, { id: file.id, name: file.name }])}
                      className="flex flex-col items-center justify-center gap-1.5 aspect-square rounded-lg border border-border hover:border-primary/40 transition-colors p-2"
                    >
                      <Folder className="h-7 w-7 text-primary/70" />
                      <span className="text-xs truncate w-full text-center">{file.name}</span>
                    </button>
                  ) : (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => toggle(file.id)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-colors aspect-square bg-muted ${
                        selected.has(file.id)
                          ? "border-primary"
                          : "border-transparent hover:border-primary/40"
                      }`}
                    >
                      {file.thumbnailUrl ? (
                        <img
                          src={file.thumbnailUrl}
                          alt={file.name}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <ImageIcon className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                      {selected.has(file.id) && (
                        <CheckCircle2 className="absolute top-1.5 right-1.5 h-5 w-5 text-primary bg-background rounded-full" />
                      )}
                    </button>
                  ),
                )}
                {(listing?.files ?? []).length === 0 && (
                  <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                    No photos or folders here.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {connected ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({
                      queryKey: getGetGoogleDriveStatusQueryKey(),
                    }),
                })
              }
            >
              Disconnect
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {connected && (
              <Button
                disabled={selected.size === 0 || importFiles.isPending}
                onClick={onImport}
                data-testid="button-import-drive"
              >
                {importFiles.isPending
                  ? "Importing…"
                  : `Import ${selected.size || ""} ${selected.size === 1 ? "photo" : "photos"}`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
