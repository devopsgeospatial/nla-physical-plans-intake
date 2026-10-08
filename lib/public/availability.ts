import "server-only";

import type { PublicConfig } from "../arcgis/config";
import { DISTRICTS, hasCadastre, type District } from "./districts";
import { approvedPlansByDistrict } from "./geo-index";

/**
 * The districts the public app opens: every district with at least one approved plan (found from where
 * the plans lie, so a new approval shows up within minutes), plus districts whose cadastre is connected.
 */
export async function liveDistrictSlugs(config: PublicConfig): Promise<Set<string>> {
  const counts = await approvedPlansByDistrict(config).catch((err) => {
    console.error("[public] could not count approved plans by district", err);
    return new Map<string, number>();
  });
  return new Set(DISTRICTS.filter((d) => (counts.get(d.name.toLowerCase()) ?? 0) > 0 || hasCadastre(d)).map((d) => d.slug));
}

export async function isDistrictLive(config: PublicConfig, district: District): Promise<boolean> {
  if (config.lockedDistrict && config.lockedDistrict !== district.slug) return false;
  return (await liveDistrictSlugs(config)).has(district.slug);
}
