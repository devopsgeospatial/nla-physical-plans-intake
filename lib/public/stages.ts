/**
 * Sites and their stages. A site is a site-plan boundary; the approved parcels inside it are its
 * subdivided parcels. The stage belongs to the site, not to the parcels, and is written in the site
 * layer's `site_stage` field. It is matched by keywords or a stage number, so "Draft review",
 * "Draft Review & Technical Assessment", "technical assessment" and "2" all mean stage 2. A site's status
 * follows from its stage: stages 1–4 are ongoing, stage 5 (gazetted) is completed.
 */

/** Reserved field names on the site layer. */
export const SITE_NAME_FIELD = "site_name";
export const SITE_STAGE_FIELD = "site_stage";

export type PlanStatus = "Ongoing" | "Completed";

export interface Stage {
  /** 1–5 */
  n: number;
  name: string;
  short: string;
  color: string;
  /** Which status the stage belongs to: a plan is completed once it is gazetted. */
  status: PlanStatus;
  match: RegExp;
}

export const STAGES: Stage[] = [
  { n: 1, name: "Initial Proposal and Conceptualization", short: "Initial proposal", color: "#a9dcf3", status: "Ongoing", match: /initial|concept|proposal/i },
  { n: 2, name: "Draft Review and Technical Assessment", short: "Draft review", color: "#6fc3ea", status: "Ongoing", match: /draft|technical/i },
  { n: 3, name: "Public Consultation and Provisional Approval", short: "Public consultation", color: "#2fa6dc", status: "Ongoing", match: /consult|provisional/i },
  { n: 4, name: "Executive Review and Final Approval", short: "Executive approval", color: "#0b7fb5", status: "Ongoing", match: /executive|final/i },
  { n: 5, name: "Gazettement and Implementation Monitoring", short: "Gazettement", color: "#0b4f73", status: "Completed", match: /gazett|implement|monitor/i },
];

export const STATUSES: PlanStatus[] = ["Ongoing", "Completed"];

/** The stage a `site_stage` value refers to (name, keywords or 1–5), or null when none is recorded. */
export function stageOf(value: unknown): Stage | null {
  if (typeof value === "number") return STAGES.find((s) => s.n === value) ?? null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = value.trim().match(/^(?:stage\s*)?([1-5])\b/i);
  if (number) return STAGES.find((s) => s.n === Number(number[1])) ?? null;
  return STAGES.find((s) => s.match.test(value)) ?? null;
}

export function stagesFor(status: PlanStatus | null): Stage[] {
  return status ? STAGES.filter((s) => s.status === status) : STAGES;
}

/** A site without a `site_name` is named after its layer: "Karama_physical" → "Karama Physical". */
export function siteNameFromLayer(layerName: string): string {
  return layerName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
