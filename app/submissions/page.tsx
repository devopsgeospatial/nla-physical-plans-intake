import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SubmissionsView from "@/components/SubmissionsView";
import { getAppMode, getArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { loadSubmissions, type Submission } from "@/lib/plans/submissions";

export const dynamic = "force-dynamic";

/** The signed-in planner's submissions and NLA's response to each. */
export default async function SubmissionsPage() {
  if (getAppMode() !== "submission") redirect("/");
  const config = getArcGisConfig();
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config);
  if (!session) redirect("/");

  let submissions: Submission[] = [];
  let error: string | null = null;
  try {
    const layer = new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session));
    submissions = await loadSubmissions(layer, await layer.getMetadata(), { planner: session.username });
  } catch (err) {
    console.error("[submissions]", err);
    error = "Your submissions could not be loaded. Please try again.";
  }

  return (
    <SubmissionsView
      submissions={submissions}
      error={error}
      fullName={session.fullName}
      map={{ portalUrl: config.webMapPortalUrl, webMapId: config.webMapId }}
    />
  );
}
