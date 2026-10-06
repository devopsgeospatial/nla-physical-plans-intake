/**
 * Allowed attribute values. Shared by the intake form (dropdowns) and the API route (validation),
 * and used by scripts/provision-layer.ts to build coded-value domains on the feature layer.
 * Edit these to match your municipality before provisioning.
 */

/** Rwanda's 30 districts, grouped by province (Kigali City, Southern, Western, Northern, Eastern). */
export const DISTRICTS = [
  "Gasabo", "Kicukiro", "Nyarugenge",
  "Gisagara", "Huye", "Kamonyi", "Muhanga", "Nyamagabe", "Nyanza", "Nyaruguru", "Ruhango",
  "Karongi", "Ngororero", "Nyabihu", "Nyamasheke", "Rubavu", "Rusizi", "Rutsiro",
  "Burera", "Gakenke", "Gicumbi", "Musanze", "Rulindo",
  "Bugesera", "Gatsibo", "Kayonza", "Kirehe", "Ngoma", "Nyagatare", "Rwamagana",
] as const;

export const PLAN_TYPES = ["Master Plan", "Zoning Amendment", "Subdivision"] as const;

export const PLAN_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;

export type District = (typeof DISTRICTS)[number];
export type PlanType = (typeof PLAN_TYPES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_NAME_MAX_LENGTH = 255;

export function isDistrict(value: string): value is District {
  return (DISTRICTS as readonly string[]).includes(value);
}

export function isPlanType(value: string): value is PlanType {
  return (PLAN_TYPES as readonly string[]).includes(value);
}

/** Field names on the hosted feature layer. Keep in sync with scripts/provision-layer.ts. */
export const LAYER_FIELDS = {
  planName: "plan_name",
  district: "district",
  planType: "plan_type",
  status: "status",
  submissionDate: "submission_date",
  reviewComments: "review_comments",
} as const;
