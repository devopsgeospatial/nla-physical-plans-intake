import type { PlanStatus } from "./stages";

/** What Explore narrows the map (and downloads) to. */
export interface SiteSelection {
  status: PlanStatus | null;
  /** 1–5, or 0 for sites whose stage is not recorded yet. */
  stage: number | null;
  /** One site, by key. */
  site: string | null;
}

/** The sites the selection points at, or null when nothing is chosen (the whole district). Shared by the map and the downloads. */
export function selectSites<S extends { key: string; status: PlanStatus | null; stage: number | null }>(sites: S[], selection: SiteSelection): S[] | null {
  if (selection.site) return sites.filter((s) => s.key === selection.site);
  if (!selection.status && selection.stage === null) return null;
  return sites.filter(
    (s) =>
      (!selection.status || s.status === selection.status) &&
      (selection.stage === null || (selection.stage === 0 ? s.stage === null : s.stage === selection.stage)),
  );
}

/** Fields never published to the public: owners' parcel UPIs and internal bookkeeping (full or shapefile-truncated names). */
export const PRIVATE_FIELDS =
  /^(parcel_upi|upi|created_user|created_us|created_date|created_da|last_edited_user|last_edite|last_edited_date|last_edi_1|creator|creationdate|editor|editdate|globalid|shape__area|shape__length|shape_leng|remarks)$/i;
