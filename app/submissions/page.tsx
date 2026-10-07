import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SubmissionsView from "@/components/SubmissionsView";
import { getArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { loadMySubmissions, type Submission } from "@/lib/plans/my-submissions";

export const dynamic = "force-dynamic";

/** The signed-in planner's submissions and NLA's response to each. */
export default async function SubmissionsPage() {
  const config = getArcGisConfig();
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret);
  if (!session) redirect("/");

  let submissions: Submission[] = [];
  let error: string | null = null;
  try {
    const layer = new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session));
    submissions = await loadMySubmissions(layer, await layer.getMetadata(), session.username);
  } catch (err) {
    console.error("[submissions]", err);
    error = "Your submissions could not be loaded. Please try again.";
  }

  return <SubmissionsView submissions={submissions} error={error} fullName={session.fullName} />;
}
