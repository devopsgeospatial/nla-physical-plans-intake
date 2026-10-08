import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PublicApp from "@/components/public/PublicApp";
import { getAppLinks, getAppMode, getPublicConfig } from "@/lib/arcgis/config";
import { liveDistrictSlugs } from "@/lib/public/availability";
import { DISTRICTS, findDistrict, NATIONAL_DOCUMENTS } from "@/lib/public/districts";
import { districtBoundary } from "@/lib/public/geo-index";

export const dynamic = "force-dynamic";

type Params = Promise<{ district: string }>;

/** The district, if the public app serves it: it has approved plans (or a connected cadastre). */
async function available(slug: string) {
  if (getAppMode() !== "public") return null;
  const config = getPublicConfig();
  const district = findDistrict(slug);
  if (!district || (config.lockedDistrict && config.lockedDistrict !== district.slug)) return null;
  const live = await liveDistrictSlugs(config);
  if (!live.has(district.slug)) return null;
  const boundary = await districtBoundary(config, district.name).catch(() => null);
  if (!boundary) return null;
  return { config, district, boundary, live };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const found = await available((await params).district);
  return found ? { title: `${found.district.name} District · Physical Plans`, description: `Is your parcel in ${found.district.name}'s approved physical plan? Search by UPI.` } : {};
}

/** Public viewer for one district: search a parcel by UPI (or tap the map), explore its sites and plans. */
export default async function DistrictPage({ params }: { params: Params }) {
  const found = await available((await params).district);
  if (!found) notFound();
  const { config, district, boundary, live } = found;
  return (
    <PublicApp
      district={{ slug: district.slug, name: district.name }}
      map={{ portalUrl: config.portalUrl, webMapId: district.webMapId ?? config.webMapId }}
      planLayerUrl={config.planLayerUrl}
      baseFilter={config.planFilter}
      boundary={boundary.esri}
      sitesLayerUrls={config.sitesLayerUrls}
      references={[...(district.reports ?? []), ...NATIONAL_DOCUMENTS]}
      otherDistricts={config.lockedDistrict ? [] : DISTRICTS.filter((d) => live.has(d.slug) && d.slug !== district.slug).map((d) => ({ slug: d.slug, name: d.name }))}
      homeUrl={getAppLinks().homeUrl}
    />
  );
}
