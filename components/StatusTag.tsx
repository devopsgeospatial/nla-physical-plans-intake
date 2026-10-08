import type { SubmissionStatus } from "@/lib/plans/review-status";

const STYLE: Record<SubmissionStatus, string> = {
  waiting: "bg-[#eef2f5] text-graphite",
  returned: "bg-[#fdf1f1] text-alert",
  partly_approved: "bg-nla-tint text-nla",
  approved: "bg-nla text-white",
};

/** Planners wait for NLA; reviewers see the same state as work to do. */
const LABEL: Record<"planner" | "reviewer", Record<SubmissionStatus, string>> = {
  planner: { waiting: "Waiting for NLA", returned: "Returned for changes", partly_approved: "Partly approved", approved: "Approved" },
  reviewer: { waiting: "To review", returned: "Returned", partly_approved: "Partly approved", approved: "Approved" },
};

const KIGALI = "Africa/Kigali";

export default function StatusTag({
  submission,
  audience,
  large,
}: {
  submission: { status: SubmissionStatus; approvedCount: number; objectIds: number[]; approvedAt: number | null };
  audience: "planner" | "reviewer";
  large?: boolean;
}) {
  const detail =
    submission.status === "partly_approved"
      ? ` ${submission.approvedCount}/${submission.objectIds.length}`
      : submission.status === "approved" && submission.approvedAt && large
        ? ` · ${formatDate(submission.approvedAt)}`
        : "";
  return (
    <span className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 font-medium ${large ? "text-[13px]" : "text-[11px]"} ${STYLE[submission.status]}`}>
      {LABEL[audience][submission.status]}
      {detail}
    </span>
  );
}

export function formatDateTime(ms: number): string {
  if (!ms) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: KIGALI }).format(ms);
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: KIGALI }).format(ms);
}
