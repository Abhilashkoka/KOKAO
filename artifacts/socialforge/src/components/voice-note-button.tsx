import { useRef, useState } from "react";
import { useTranscribeAudio } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Mic, Square, Loader2 } from "lucide-react";

interface VoiceNoteButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

/** Record a short voice note and turn it into text via the transcribe API. */
export function VoiceNoteButton({ onTranscript, disabled }: VoiceNoteButtonProps) {
  const { toast } = useToast();
  const transcribe = useTranscribeAudio();
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const stopTracks = (recorder: MediaRecorder) => {
    recorder.stream.getTracks().forEach((t) => t.stop());
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stopTracks(recorder);
        setRecording(false);
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `voice-note.${ext}`, { type });
        transcribe.mutate(
          { data: { audio: file } },
          {
            onSuccess: (result) => {
              if (result.text) {
                onTranscript(result.text);
              } else {
                toast({
                  title: "Nothing heard",
                  description: "The recording came back empty. Try speaking closer to the microphone.",
                });
              }
            },
            onError: (error) => {
              const message =
                error instanceof Error && error.message
                  ? error.message
                  : "Could not transcribe the recording.";
              toast({ title: "Transcription failed", description: message, variant: "destructive" });
            },
          },
        );
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast({
        title: "Microphone unavailable",
        description: "Allow microphone access in your browser to record a voice note.",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  if (transcribe.isPending) {
    return (
      <Button type="button" variant="outline" size="sm" disabled data-testid="button-voice-note">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Transcribing...
      </Button>
    );
  }

  return recording ? (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={stopRecording}
      data-testid="button-voice-note"
    >
      <Square className="h-4 w-4 mr-2" />
      Stop recording
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={startRecording}
      disabled={disabled}
      data-testid="button-voice-note"
    >
      <Mic className="h-4 w-4 mr-2" />
      Voice note
    </Button>
  );
}
