import { useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { downloadVideo } from "@/lib/download-video";

export function VideoDownloadButton({
  objectPath,
  filename,
  testId,
}: {
  objectPath: string;
  filename: string;
  testId: string;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const busy = useRef(false);

  async function onDownload() {
    if (busy.current) return;
    busy.current = true;
    setDownloading(true);
    try {
      // Explicit bearer auth also works when Preview partitions Clerk cookies.
      await downloadVideo(objectPath, filename, await getToken());
    } catch (error) {
      toast({
        title: "Could not download video",
        description: error instanceof Error ? error.message : "Download failed. Please try again.",
        variant: "destructive",
      });
    } finally {
      busy.current = false;
      setDownloading(false);
    }
  }

  return (
    <Button
      variant="outline"
      disabled={downloading}
      aria-busy={downloading}
      onClick={() => void onDownload()}
      data-testid={testId}
    >
      {downloading ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
      {downloading ? "Downloading…" : "Download video"}
    </Button>
  );
}