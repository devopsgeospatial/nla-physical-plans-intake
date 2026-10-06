import { cookies } from "next/headers";
import PlanIntakeForm from "@/components/PlanIntakeForm";
import SetupLayerPanel from "@/components/SetupLayerPanel";
import { ConfigurationError, getArcGisConfig, type ArcGisConfig } from "@/lib/arcgis/config";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, type UserSession } from "@/lib/auth/session";
import { checkLayerStatus, type LayerStatus } from "@/lib/plans/layer-status";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ auth_error?: string }> }) {
  let config: ArcGisConfig;
  try {
    config = getArcGisConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) return <Shell><AppNotRegistered problem={err.message} /></Shell>;
    throw err;
  }

  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret);
  const { auth_error: authError } = await searchParams;

  if (!session) {
    return (
      <Shell>
        <SignInCard portalHost={new URL(config.portalUrl).host} authError={authError} />
      </Shell>
    );
  }

  let status: LayerStatus | { state: "error"; message: string };
  try {
    status = await checkLayerStatus(createUserTokenProvider(config, session));
  } catch (err) {
    status = { state: "error", message: err instanceof Error ? err.message : String(err) };
  }

  return (
    <Shell session={session}>
      {status.state === "ready" && <PlanIntakeForm />}
      {status.state === "missing" && <SetupLayerPanel serviceName={status.serviceName} layerUrl={config.featureLayerUrl} />}
      {(status.state === "no_access" || status.state === "misconfigured" || status.state === "error") && (
        <Notice title="The plan submissions layer is not usable yet">
          <p>{status.message}</p>
          {status.state === "no_access" && (
            <p className="mt-2">Ask the layer owner to share it with your group (Plan Submitters) and enable editing.</p>
          )}
        </Notice>
      )}
    </Shell>
  );
}

function Shell({ session, children }: { session?: UserSession; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Physical Plan Submission</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload the plan boundary and supporting documents. Submissions go straight to the planning review queue.
          </p>
        </div>
        {session && (
          <form action="/api/auth/logout" method="post" className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{session.fullName}</span>{" "}
              <span className="text-slate-400">({session.username})</span>
            </span>
            <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100">
              Sign out
            </button>
          </form>
        )}
      </header>
      {children}
    </main>
  );
}

function SignInCard({ portalHost, authError }: { portalHost: string; authError?: string }) {
  return (
    <section className="max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-medium">Sign in to submit a plan</h2>
      <p className="mt-1 text-sm text-slate-600">
        Use your ArcGIS Online account ({portalHost}). Your submissions are recorded under your name.
      </p>
      {authError && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {authError}
        </p>
      )}
      <a href="/api/auth/login" className="mt-4 inline-block rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
        Sign in with ArcGIS
      </a>
    </section>
  );
}

function AppNotRegistered({ problem }: { problem: string }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const portal = process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com";
  return (
    <Notice title="Setup needed: register this app with ArcGIS Online">
      <p className="text-red-800">{problem}</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5">
        <li>
          Sign in at{" "}
          <a className="underline" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
            {portal}
          </a>{" "}
          → <b>Content → New item → Developer credentials → OAuth 2.0 credentials</b>.
        </li>
        <li>
          Redirect URL: <code className="rounded bg-white px-1">{appUrl}/api/auth/callback</code> (no privileges needed).
        </li>
        <li>Give it a title such as <i>Physical Plan Intake</i> and save. Copy the <b>Client ID</b> from the item page.</li>
        <li>
          In <code className="rounded bg-white px-1">.env.local</code> set <code className="rounded bg-white px-1">ARCGIS_OAUTH_CLIENT_ID=&lt;Client ID&gt;</code>,
          save, and reload this page.
        </li>
      </ol>
    </Notice>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
      <h2 className="mb-2 text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}
