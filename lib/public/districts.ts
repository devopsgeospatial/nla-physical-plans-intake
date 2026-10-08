/**
 * Districts of the public Physical Plans viewer. Every district gets the same app at /<slug>; a
 * district goes live when its cadastre (the layer citizens' UPIs are looked up in) is listed here.
 */

export interface District {
  slug: string;
  name: string;
  province: string;
  /** Cadastral parcels layer with the UPI field (public, queried without sign-in). */
  parcelsLayerUrl?: string;
  upiField?: string;
  /** Web map shown behind the parcels; defaults to PUBLIC_WEBMAP_ID. */
  webMapId?: string;
  /** The district's published plan reports (shown in Documents next to the national ones). */
  reports?: ReferenceDocument[];
}

export interface ReferenceDocument {
  title: string;
  subtitle: string;
  href: string;
}

/** National documents every district's viewer lists. */
export const NATIONAL_DOCUMENTS: ReferenceDocument[] = [
  {
    title: "Zoning Regulations",
    subtitle: "Land use master plans, edition two",
    href: "https://www.lands.rw/fileadmin/user_upload/LANDS/Publications/Master_Plans/Land_Use_Plans_Zoning_Regulations/Land_Use_Master_Plans__Zoning_Regulations_-_Edition_Two.pdf",
  },
];

const PARCELS = "https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services";

const PROVINCES: [province: string, districts: string[]][] = [
  ["City of Kigali", ["Gasabo", "Kicukiro", "Nyarugenge"]],
  ["Eastern Province", ["Bugesera", "Gatsibo", "Kayonza", "Kirehe", "Ngoma", "Nyagatare", "Rwamagana"]],
  ["Northern Province", ["Burera", "Gakenke", "Gicumbi", "Musanze", "Rulindo"]],
  ["Southern Province", ["Gisagara", "Huye", "Kamonyi", "Muhanga", "Nyamagabe", "Nyanza", "Nyaruguru", "Ruhango"]],
  ["Western Province", ["Karongi", "Ngororero", "Nyabihu", "Nyamasheke", "Rubavu", "Rusizi", "Rutsiro"]],
];

/** Districts whose cadastre (every parcel with its UPI) is connected. */
const LIVE: Record<string, Pick<District, "parcelsLayerUrl" | "upiField" | "webMapId" | "reports">> = {
  Muhanga: { parcelsLayerUrl: `${PARCELS}/Muhanga_Parcels/FeatureServer/0`, upiField: "upi" },
};

/** Published district plan reports, listed once the district is live. */
const REPORTS: Record<string, ReferenceDocument[]> = {
  Gakenke: [
    {
      title: "Master Plan Report",
      subtitle: "Gakenke District Land Use Plan",
      href: "https://www.lands.rw/fileadmin/user_upload/LANDS/Publications/Master_Plans/District_Land_Use_Plans/Reports/OG_n___Special_of_30.07.2025__GAKENKE_Igishushanyo_mbonera_cy_imikoreshereze_n_imitunganyirize_by_ubutaka.pdf",
    },
  ],
};

export const DISTRICTS: District[] = PROVINCES.flatMap(([province, names]) =>
  names.map((name) => ({ slug: name.toLowerCase(), name, province, reports: REPORTS[name], ...LIVE[name] })),
);

export function findDistrict(slug: string): District | undefined {
  return DISTRICTS.find((d) => d.slug === slug.toLowerCase());
}

/**
 * Whether citizens can look up any parcel by UPI (the district's cadastre is connected). Districts without
 * one still open in the app as soon as they have approved plans (see availability.ts): their UPI search
 * then covers the planned parcels only.
 */
export function hasCadastre(district: District): boolean {
  return !!district.parcelsLayerUrl;
}

export function provinces(): string[] {
  return PROVINCES.map(([p]) => p);
}

/**
 * Rwandan UPIs look like 2/07/01/01/5833 (province/district/sector/cell/parcel). Accepts the usual
 * typing variations (spaces, dashes or backslashes) and returns the canonical form, or null.
 */
export function normalizeUpi(input: string): string | null {
  const parts = input.trim().split(/\s*[/\\\-–\s]\s*/).filter(Boolean);
  if (parts.length !== 5 || !parts.every((p) => /^\d{1,6}$/.test(p))) return null;
  return parts.join("/");
}
