import { useState } from "react";
import {
  useListSupportRequests,
  useCreateSupportRequest,
  getListSupportRequestsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  LifeBuoy,
  Share2,
  Wand2,
  Calendar,
  CheckCircle2,
  MessageSquare,
} from "lucide-react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";

const CATEGORY_OPTIONS = [
  { value: "complaint", label: "Complaint" },
  { value: "question", label: "Question" },
  { value: "bug", label: "Something is broken" },
  { value: "billing", label: "Billing issue" },
  { value: "other", label: "Other" },
] as const;

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
);

const QUICK_HELP = [
  {
    icon: Share2,
    title: "Connecting social accounts",
    text: "Each connection card on the Accounts page has a Setup guide button with step-by-step instructions and links.",
    href: "/accounts",
    linkLabel: "Go to Accounts",
  },
  {
    icon: Wand2,
    title: "Creating content",
    text: "Generate captions, images, carousels and videos in the AI Studio, then publish or schedule them from the Content Library.",
    href: "/studio",
    linkLabel: "Open AI Studio",
  },
  {
    icon: Calendar,
    title: "Scheduling posts",
    text: "Queue content for automatic publishing on the Schedule page and see everything at a glance on the Calendar.",
    href: "/schedule",
    linkLabel: "Go to Schedule",
  },
] as const;

export function HelpPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: requests, isLoading } = useListSupportRequests();
  const create = useCreateSupportRequest();

  const [category, setCategory] = useState<string>("question");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = () => {
    create.mutate(
      {
        data: {
          category: category as
            | "complaint"
            | "question"
            | "bug"
            | "billing"
            | "other",
          subject: subject.trim(),
          message: message.trim(),
        },
      },
      {
        onSuccess: () => {
          setSubject("");
          setMessage("");
          queryClient.invalidateQueries({
            queryKey: getListSupportRequestsQueryKey(),
          });
          toast({
            title: "Request sent",
            description:
              "Our team has been notified and will get back to you here.",
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't send your request",
            description: apiErrorMessage(err, "Something went wrong. Please try again."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const canSubmit =
    subject.trim().length >= 3 &&
    message.trim().length >= 10 &&
    !create.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <LifeBuoy className="h-6 w-6" /> Help & Support
        </h1>
        <p className="text-muted-foreground mt-1">
          Quick answers to common questions, and a direct line to our team when
          something isn't working.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {QUICK_HELP.map((item) => (
          <Card key={item.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <item.icon className="h-4 w-4 text-primary" /> {item.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{item.text}</p>
              <Link href={item.href}>
                <Button variant="outline" size="sm">
                  {item.linkLabel}
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" /> Contact support
          </CardTitle>
          <CardDescription>
            Report a problem, file a complaint, or ask a question — our team is
            notified immediately and replies show up right here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <div className="space-y-2">
              <Label>What's it about?</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger data-testid="support-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary, e.g. 'Instagram post failed to publish'"
                maxLength={200}
                data-testid="support-subject"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Details</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell us what happened, what you expected, and any error message you saw."
              rows={5}
              maxLength={5000}
              data-testid="support-message"
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="support-submit"
          >
            {create.isPending ? (
              <>
                <RippleSpinner className="h-4 w-4 mr-2" /> Sending...
              </>
            ) : (
              "Send to support"
            )}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your requests</CardTitle>
          <CardDescription>
            Everything you've sent us, with status and replies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : !requests || requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No requests yet. If anything's bothering you, use the form above
              — we read every message.
            </p>
          ) : (
            <div className="space-y-3">
              {requests.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg border border-border p-4 space-y-2"
                  data-testid={`support-request-${r.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.subject}</span>
                    <Badge variant="outline">
                      {CATEGORY_LABELS[r.category] ?? r.category}
                    </Badge>
                    {r.status === "resolved" ? (
                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Resolved
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Open</Badge>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {r.message}
                  </p>
                  {r.adminReply && (
                    <div className="rounded-md bg-muted/60 p-3">
                      <p className="text-xs font-semibold mb-1">
                        Reply from support
                      </p>
                      <p className="text-sm whitespace-pre-wrap">
                        {r.adminReply}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default HelpPage;
