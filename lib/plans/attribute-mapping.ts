/**
 * Maps attributes from an uploaded file onto the target layer's fields. Isomorphic: the browser
 * uses it for the pre-submit summary, the server for the actual append.
 *
 * Matching is by name, case-insensitively. Shapefile (DBF) field names are limited to 10 characters,
 * so a 10-character file field also matches the single layer field it is a truncation of
 * (e.g. "planning_s" -> "planning_status").
 */

export interface LayerFieldInfo {
  name: string;
  type: string;
  alias?: string;
  length?: number;
  editable?: boolean;
}

export type AttributeValue = string | number | null;

/** Fields the app always fills itself; values in the file are ignored. */
export const AUTO_FIELDS = {
  createdUser: "created_user",
  createdDate: "created_date",
} as const;

/**
 * Fields reserved for NLA's response to a submission: the reviewer sets approval_date when a plan is
 * approved and writes the response in remarks. Values for them in a planner's file are never copied,
 * so a planner's own text can't be mistaken for an NLA response.
 */
export const NLA_RESPONSE_FIELDS = {
  approvalDate: "approval_date",
  comment: "remarks",
} as const;

/** Keyword on attachments a planner uploaded; any other attachment on their parcels came from NLA. */
export const PLANNER_ATTACHMENT_KEYWORD = "planner-submission";

/** Filled from the polygon (in the layer's grid) when the file does not provide a value. */
export const AREA_FIELD = "area_sqm";

const NOT_WRITABLE_TYPES = new Set(["esriFieldTypeOID", "esriFieldTypeGlobalID", "esriFieldTypeGeometry", "esriFieldTypeRaster", "esriFieldTypeBlob"]);
const NUMERIC_TYPES = new Set([
  "esriFieldTypeDouble",
  "esriFieldTypeSingle",
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeBigInteger",
]);
const INTEGER_TYPES = new Set(["esriFieldTypeInteger", "esriFieldTypeSmallInteger", "esriFieldTypeBigInteger"]);
const DBF_NAME_LENGTH = 10;

export interface FieldMatch {
  fileField: string;
  layerField: LayerFieldInfo;
}

export interface FieldMapping {
  matched: FieldMatch[];
  /** File fields with no writable counterpart in the layer. */
  ignored: string[];
  /** File fields that correspond to fields the app fills itself or reserves for NLA's response. */
  automatic: string[];
}

export function writableFields(fields: LayerFieldInfo[]): LayerFieldInfo[] {
  return fields.filter((f) => f.editable !== false && !NOT_WRITABLE_TYPES.has(f.type));
}

export function mapFields(fileFields: string[], layerFields: LayerFieldInfo[]): FieldMapping {
  const writable = writableFields(layerFields);
  const autoNames = new Set<string>([...Object.values(AUTO_FIELDS), ...Object.values(NLA_RESPONSE_FIELDS)]);
  const mapping: FieldMapping = { matched: [], ignored: [], automatic: [] };
  const used = new Set<string>();

  for (const fileField of fileFields) {
    const key = fileField.toLowerCase();
    let target = writable.find((f) => f.name.toLowerCase() === key);
    if (!target && key.length === DBF_NAME_LENGTH) {
      const candidates = writable.filter((f) => f.name.toLowerCase().startsWith(key));
      if (candidates.length === 1) target = candidates[0];
    }
    if (target && autoNames.has(target.name.toLowerCase())) {
      mapping.automatic.push(fileField);
    } else if (target && !used.has(target.name)) {
      used.add(target.name);
      mapping.matched.push({ fileField, layerField: target });
    } else {
      mapping.ignored.push(fileField);
    }
  }
  return mapping;
}

export interface ValueError {
  /** Index of the polygon in the upload. */
  index: number;
  field: string;
  message: string;
}

/**
 * Every value in the upload that the layer cannot store, checked before submitting so the user can
 * fix the file first. `skip` holds polygons that will not be appended (duplicates).
 */
export function findValueErrors(
  features: { properties: Record<string, unknown> }[],
  mapping: FieldMapping,
  skip: ReadonlySet<number> = new Set(),
): ValueError[] {
  const errors: ValueError[] = [];
  features.forEach((feature, index) => {
    if (skip.has(index)) return;
    for (const { fileField, layerField } of mapping.matched) {
      try {
        coerceValue(feature.properties[fileField], layerField);
      } catch (err) {
        errors.push({ index, field: layerField.name, message: (err as Error).message });
      }
    }
  });
  return errors;
}

/** Converts a file value to what the layer field accepts, or throws a message naming the problem. */
export function coerceValue(value: unknown, field: LayerFieldInfo): AttributeValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  if (NUMERIC_TYPES.has(field.type)) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim().replace(",", ".")) : NaN;
    if (!Number.isFinite(n)) throw new Error("not a number");
    if (INTEGER_TYPES.has(field.type) && !Number.isInteger(n)) throw new Error("not a whole number");
    return n;
  }

  if (field.type === "esriFieldTypeDate") {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new Error("invalid date");
      // DBF dates are calendar dates; keep the calendar day regardless of server timezone.
      return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const ms = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? Date.parse(`${value.trim()}T00:00:00Z`) : Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
    throw new Error("not a date");
  }

  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (field.length && text.length > field.length) throw new Error(`too long (${text.length}/${field.length} characters)`);
  return text;
}
