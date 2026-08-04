import { Fragment, useState } from "react";
import {
  useListPromptVersions,
  useCreatePromptVersion,
  useTransitionPromptVersion,
  useListPromptReviews,
  useAddPromptReviewComment,
  getListPromptVersionsQueryKey,
  getListPromptReviewsQueryKey,
  getListPromptTemplatesQueryKey,
  PromptVersionTransitionInputTo,
  type PromptTemplate,
  type PromptTemplateVersion,
  type PromptVersionTransitionInputTo as TransitionTo,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  BlockEditor,
  type BlockDraft,
  blocksFromApi,
  blocksToApi,
  hasValidMandatoryBlock,
  newBlockDraft,
} from "./block-editor";

function lifecycleVariant(
  state: PromptTemplateVersion["lifecycleState"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "production":
      return "default";
    case "staging":
    case "approved":
      return "secondary";
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}

function ReviewsPanel({ versionId }: { versionId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: reviews, isLoading } = useListPromptReviews(versionId);
  const addComment = useAddPromptReviewComment();
  const [comment, setComment] = useState("");

  const submit = () => {
    const comments = comment.trim();
    if (!comments) return;
    addComment.mutate(
      { versionId, data: { comments } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListPromptReviewsQueryKey(versionId),
          });
          setComment("");
          toast({ title: "Comment added" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not add comment",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Reviews</p>
      {isLoading || !reviews ? (
        <Skeleton className="h-16 w-full" />
      ) : reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews yet.</p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li
              key={r.id}
              className="rounded-md border border-border p-2 text-sm"
              data-testid={`review-${r.id}`}
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    r.decision === "approved"
                      ? "secondary"
                      : r.decision === "rejected"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {r.decision}
                </Badge>
                <span className="text-muted-foreground">
                  {r.reviewerEmail ?? "unknown"}
                </span>
              </div>
              {r.comments && <p className="mt-1">{r.comments}</p>}
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a review comment"
          rows={2}
          data-testid={`textarea-review-comment-${versionId}`}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={submit}
          disabled={addComment.isPending || !comment.trim()}
          data-testid={`button-add-comment-${versionId}`}
        >
          {addComment.isPending ? "Adding..." : "Add comment"}
        </Button>
      </div>
    </div>
  );
}

interface VersionsSectionProps {
  template: PromptTemplate;
}

export function VersionsSection({ template }: VersionsSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: versions, isLoading } = useListPromptVersions(template.id);
  const createVersion = useCreatePromptVersion();
  const transition = useTransitionPromptVersion();

  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [blocks, setBlocks] = useState<BlockDraft[]>([]);
  const [changeNotes, setChangeNotes] = useState("");
  const [expandedReviews, setExpandedReviews] = useState<number | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getListPromptVersionsQueryKey(template.id),
    });
    queryClient.invalidateQueries({
      queryKey: getListPromptTemplatesQueryKey(),
    });
  };

  const openNewVersion = () => {
    const latest = versions?.[0];
    setBlocks(
      latest ? blocksFromApi(latest.blocks) : [newBlockDraft(true)],
    );
    setChangeNotes("");
    setNewVersionOpen(true);
  };

  const submitNewVersion = () => {
    if (!hasValidMandatoryBlock(blocks)) {
      toast({
        variant: "destructive",
        title: "Check the blocks",
        description:
          "At least one mandatory block needs a title and content.",
      });
      return;
    }
    const latest = versions?.[0];
    createVersion.mutate(
      {
        templateId: template.id,
        data: {
          blocks: blocksToApi(blocks),
          changeNotes: changeNotes.trim() || null,
          parentVersionId: latest?.id ?? null,
        },
      },
      {
        onSuccess: () => {
          refresh();
          setNewVersionOpen(false);
          toast({ title: "Draft version created" });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Could not create version",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const doTransition = (
    version: PromptTemplateVersion,
    to: TransitionTo,
    successTitle: string,
  ) => {
    transition.mutate(
      { versionId: version.id, data: { to } },
      {
        onSuccess: () => {
          refresh();
          toast({ title: successTitle });
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Transition blocked",
            description: apiErrorMessage(err, "Please try again."),
          }),
      },
    );
  };

  const busy = transition.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Versions</p>
        <Button
          size="sm"
          onClick={openNewVersion}
          data-testid={`button-new-version-${template.id}`}
        >
          New version
        </Button>
      </div>

      {isLoading || !versions ? (
        <Skeleton className="h-32 w-full" />
      ) : versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No versions yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>v#</TableHead>
              <TableHead>Lifecycle</TableHead>
              <TableHead>Eval</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v) => {
              const isProd = v.lifecycleState === "production";
              return (
                <Fragment key={v.id}>
                  <TableRow data-testid={`row-version-${v.id}`}>
                    <TableCell className="font-medium">{v.versionNo}</TableCell>
                    <TableCell>
                      <Badge
                        variant={lifecycleVariant(v.lifecycleState)}
                        data-testid={`badge-lifecycle-${v.id}`}
                      >
                        {v.lifecycleState}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {v.evalStatus}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {v.createdBy ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right space-x-1 space-y-1">
                      {(v.lifecycleState === "draft" ||
                        v.lifecycleState === "rejected") && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.pending_review,
                              "Submitted for review",
                            )
                          }
                          data-testid={`button-submit-review-${v.id}`}
                        >
                          Submit review
                        </Button>
                      )}
                      {v.lifecycleState === "pending_review" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              doTransition(
                                v,
                                PromptVersionTransitionInputTo.approved,
                                "Version approved",
                              )
                            }
                            data-testid={`button-approve-${v.id}`}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              doTransition(
                                v,
                                PromptVersionTransitionInputTo.rejected,
                                "Version rejected",
                              )
                            }
                            data-testid={`button-reject-${v.id}`}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {(v.lifecycleState === "approved" ||
                        v.lifecycleState === "draft") && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.staging,
                              "Promoted to staging",
                            )
                          }
                          data-testid={`button-promote-staging-${v.id}`}
                        >
                          → Staging
                        </Button>
                      )}
                      {(v.lifecycleState === "staging" ||
                        v.lifecycleState === "approved") && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.production,
                              "Promoted to production",
                            )
                          }
                          data-testid={`button-promote-production-${v.id}`}
                        >
                          → Production
                        </Button>
                      )}
                      {v.lifecycleState === "deprecated" && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.production,
                              "Rolled back to production",
                            )
                          }
                          data-testid={`button-rollback-${v.id}`}
                        >
                          Rollback
                        </Button>
                      )}
                      {isProd && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.deprecated,
                              "Version deprecated",
                            )
                          }
                          data-testid={`button-deprecate-${v.id}`}
                        >
                          Deprecate
                        </Button>
                      )}
                      {(v.lifecycleState === "deprecated" ||
                        v.lifecycleState === "rejected") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            doTransition(
                              v,
                              PromptVersionTransitionInputTo.archived,
                              "Version archived",
                            )
                          }
                          data-testid={`button-archive-version-${v.id}`}
                        >
                          Archive
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setExpandedReviews((cur) =>
                            cur === v.id ? null : v.id,
                          )
                        }
                        data-testid={`button-toggle-reviews-${v.id}`}
                      >
                        Reviews
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expandedReviews === v.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/30">
                        <ReviewsPanel versionId={v.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={newVersionOpen} onOpenChange={setNewVersionOpen}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New version</DialogTitle>
            <DialogDescription>
              Pre-filled from the latest version. Edit the blocks to create a new
              immutable draft.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <BlockEditor
              blocks={blocks}
              onChange={setBlocks}
              disabled={createVersion.isPending}
              testIdPrefix="version-block"
            />
            <div className="space-y-2">
              <label className="text-sm font-medium">Change notes</label>
              <Textarea
                value={changeNotes}
                onChange={(e) => setChangeNotes(e.target.value)}
                rows={2}
                data-testid="input-version-change-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewVersionOpen(false)}
              disabled={createVersion.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={submitNewVersion}
              disabled={createVersion.isPending}
              data-testid="button-save-version"
            >
              {createVersion.isPending ? "Creating..." : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
