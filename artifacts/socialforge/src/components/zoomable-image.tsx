import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Pencil, X } from "lucide-react";

/**
 * Renders an image that zooms into a full-size lightbox popup when clicked.
 * The popup optionally shows an "Edit image" button that closes the lightbox
 * and invokes the provided callback (e.g. to open the image editor).
 */
export function ZoomableImage({
  src,
  alt,
  className,
  wrapperClassName,
  onEdit,
  editDisabled,
  testId,
}: {
  src: string;
  alt: string;
  /** Classes applied to the inline (thumbnail) image. */
  className?: string;
  /** Optional wrapper classes for the inline image container. */
  wrapperClassName?: string;
  /** When provided, the lightbox shows an "Edit image" button that calls this. */
  onEdit?: () => void;
  editDisabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`block cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md ${wrapperClassName ?? ""}`}
        title="Click to view full size"
        data-testid={testId ? `${testId}-zoom-trigger` : undefined}
      >
        <img src={src} alt={alt} className={className} />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          hideClose
          className="max-w-[95vw] sm:max-w-[92vw] md:max-w-[1100px] p-0 gap-0 overflow-hidden bg-background/95"
          data-testid={testId ? `${testId}-lightbox` : "image-lightbox"}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <DialogDescription className="sr-only">Full-size image preview</DialogDescription>
          <div className="relative flex items-center justify-center bg-black/90">
            <img
              src={src}
              alt={alt}
              className="max-h-[80vh] w-auto max-w-full object-contain"
              data-testid={testId ? `${testId}-lightbox-image` : undefined}
            />
            <div className="absolute top-3 right-3 flex items-center gap-2">
              {onEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={editDisabled}
                  className="shadow-lg"
                  onClick={() => {
                    setOpen(false);
                    onEdit();
                  }}
                  data-testid={testId ? `${testId}-lightbox-edit` : "button-lightbox-edit-image"}
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit image
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="h-8 w-8 shadow-lg"
                onClick={() => setOpen(false)}
                data-testid={testId ? `${testId}-lightbox-close` : undefined}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
