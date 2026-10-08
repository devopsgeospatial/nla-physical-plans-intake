import { cookies } from "next/headers";
import type { ReactNode } from "react";
import Landing from "@/components/Landing";
import { liveDistrictSlugs } from "@/lib/public/availability";
import { DISTRICTS } from "@/lib/public/districts";
import ReviewWorkspace, { type ReviewView } from "@/components/ReviewWorkspace";
import { formatDateTime } from "@/components/StatusTag";
import UploadWorkspace, { type LayerSummary, type Revision } from "@/components/UploadWorkspace";
import { redirect } from "next/navigation";
import { ConfigurationError, getAppLinks, getAppMode, getArcGisConfig, getPublicConfig, getUploadLimits, type ArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE, type UserSession } from "@/lib/auth/session";
import { fullNames } from "@/lib/arcgis/users";
import { loadSubmission, loadSubmissions } from "@/lib/plans/submissions";

export const dynamic = "force-dynamic";

type SearchParams = { auth_error?: string; u?: string; revise?: string; view?: string };

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (getAppMode() === "home") {
    // Districts open as soon as NLA approves a plan in them (checked against the live layer).
    const live = await liveDistrictSlugs(getPublicConfig());
    const districts = DISTRICTS.map((d) => ({ slug: d.slug, name: d.name, province: d.province, live: live.has(d.slug) }));
    return <Landing {...getAppLinks()} districts={districts} />;
  }
  if (getAppMode() === "public") {
    // Districts are chosen on the landing page; a district deployment opens its own map.
    redirect(getPublicConfig().lockedDistrict ? `/${getPublicConfig().lockedDistrict}` : getAppLinks().homeUrl);
  }

  let config: ArcGisConfig;
  try {
    config = getArcGisConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) return <SetupNeeded problem={err.message} />;
    throw err;
  }

  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config);
  const params = await searchParams;
  const appTitle = config.appMode === "review" ? "Physical Plan Review" : "Physical Plan Submission";
  if (!session) return <SignIn title={appTitle} authError={params.auth_error} username={params.u} />;

  try {
    return config.appMode === "review" ? await reviewApp(config, session, params) : await submissionApp(config, session, params);
  } catch (err) {
    const noAccess = err instanceof ArcGisRequestError && [400, 403, 499].includes(err.code ?? 0);
    return (
      <HubScreen title={appTitle}>
        <h1 className="text-center text-[20px] font-semibold text-ink">The Physical Plans layer can&apos;t be opened</h1>
        <p className="mt-4 text-[14px] leading-6 text-graphite">
          {noAccess
            ? "Your account does not have access to the layer, or its address is wrong. Ask the layer owner to share it with you."
            : err instanceof Error
              ? err.message
              : String(err)}
        </p>
        <p className="mt-5 break-all rounded-lg bg-mist px-3 py-2 text-[12px] leading-5 text-graphite">{config.featureLayerUrl}</p>
        <form action="/api/auth/logout" method="post" className="mt-7">
          <button type="submit" className="h-11 w-full rounded-lg border border-[#dfe5ea] text-[15px] font-medium text-ink transition hover:border-nla-light hover:text-nla">
            Sign out
          </button>
        </form>
      </HubScreen>
    );
  }
}

/** Planners: upload a plan (or the revised plan for a submission NLA returned). */
async function submissionApp(config: ArcGisConfig, session: UserSession, params: SearchParams) {
  // Read the target layer as the signed-in user: its fields drive the attribute matching preview.
  const client = new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session));
  const meta = await client.getMetadata();
  const layer: LayerSummary = {
    name: meta.name,
    fields: meta.fields.map(({ name, type, alias, length, editable }) => ({ name, type, alias, length, editable })),
    hasAttachments: meta.hasAttachments,
  };

  let revising: Revision | undefined;
  const reviseAt = Number(params.revise);
  if (Number.isInteger(reviseAt) && reviseAt > 0) {
    const returned = await loadSubmission(client, meta, session.username, reviseAt);
    if (returned?.status === "returned") {
      revising = { submittedAt: reviseAt, label: `submitted ${formatDateTime(reviseAt)}`, comments: returned.comments };
    }
  }

  return (
    <UploadWorkspace
      layer={layer}
      user={{ fullName: session.fullName, username: session.username }}
      maxRequestBytes={getUploadLimits().maxRequestBytes}
      map={mapSettings(config)}
      revising={revising}
    />
  );
}

/** NLA reviewers: every submission since the app went live, by status. */
async function reviewApp(config: ArcGisConfig, session: UserSession, params: SearchParams) {
  const tokens = createUserTokenProvider(config, session);
  const client = new FeatureLayerClient(config.featureLayerUrl, tokens);
  const meta = await client.getMetadata();
  const submissions = await loadSubmissions(client, meta, { since: config.reviewSince });
  const view: ReviewView = params.view === "returned" || params.view === "approved" ? params.view : "waiting";
  const names = await fullNames(config.portalUrl, tokens, submissions.map((s) => s.planner));
  const comment = meta.fields.find((f) => f.name.toLowerCase() === "remarks");
  return (
    <ReviewWorkspace
      key={view} // switching lists closes the open submission
      submissions={submissions}
      view={view}
      plannerNames={names}
      fullName={session.fullName}
      map={mapSettings(config)}
      maxRequestBytes={getUploadLimits().maxRequestBytes}
      maxCommentLength={comment?.length ?? 255}
      canAttach={meta.hasAttachments}
    />
  );
}

function mapSettings(config: ArcGisConfig) {
  return { portalUrl: config.webMapPortalUrl, webMapId: config.webMapId };
}

// ---------------------------------------------------------------------------------------------------

/** Same structure as the Rwanda Spatial Data Hub: slate-teal header bar, black band, grey panel. */
function HubScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-[#f6f8fa]">
      <header className="flex h-16 shrink-0 items-center gap-5 border-b border-hairline bg-white px-5 sm:px-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/nla-logo.png" alt="National Land Authority" width={72} height={36} className="h-[34px] w-auto" />
        <p className="border-l border-hairline pl-5 text-[17px] font-semibold text-ink">{title}</p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-start px-4 py-10 sm:justify-center sm:py-14">
        <section className="w-full max-w-[440px] rounded-2xl border border-hairline bg-white px-7 py-9 shadow-[0_10px_40px_rgba(16,40,60,0.08)] sm:px-9">{children}</section>
      </div>
    </main>
  );
}

const inputClass =
  "h-11 w-full rounded-lg border border-[#dfe5ea] bg-white px-3 text-[15px] text-ink outline-none transition focus:border-nla-light focus:shadow-[0_0_0_3px_rgba(23,160,219,0.15)]";

function SignIn({ title, authError, username }: { title: string; authError?: string; username?: string }) {
  return (
    <HubScreen title={title}>
      <h1 className="text-center text-[22px] font-normal text-ink">
        Sign in to <span className="font-semibold">{title}</span>
      </h1>
      <p className="mt-3 text-center text-[14px] leading-6 text-graphite">Use your ArcGIS Online account.</p>

      {authError && (
        <p className="mt-6 rounded-lg border-l-[3px] border-alert bg-[#fdf1f1] px-3 py-2 text-[14px] leading-6 text-[#7a1c1c]" role="alert">
          {authError}
        </p>
      )}

      <form action="/api/auth/password" method="post" className="mt-7 space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-[14px] text-graphite">Username</span>
          <input
            name="username"
            autoComplete="username"
            required
            defaultValue={username}
            autoFocus={!username}
            spellCheck={false}
            autoCapitalize="none"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[14px] text-graphite">Password</span>
          <input name="password" type="password" autoComplete="current-password" required autoFocus={!!username} className={inputClass} />
        </label>
        <button
          type="submit"
          className="h-11 w-full rounded-lg bg-nla text-[16px] font-semibold text-white transition hover:bg-[#096a97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nla-light"
        >
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-[14px] text-graphite">
        Organization or two-step sign-in?{" "}
        <a href="/api/auth/login" className="font-medium text-nla underline underline-offset-2 hover:text-nla-light">
          Continue with ArcGIS
        </a>
      </p>
    </HubScreen>
  );
}

function SetupNeeded({ problem }: { problem: string }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const portal = process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com";
  return (
    <HubScreen title={process.env.APP_MODE === "review" ? "Physical Plan Review" : "Physical Plan Submission"}>
      <h1 className="text-center text-[20px] font-semibold text-ink">This app is not set up yet</h1>
      <p className="mt-3 text-center text-[13px] text-graphite">{problem}</p>
      <ol className="mt-7 list-decimal space-y-3 pl-5 text-[14px] leading-6 text-graphite">
        <li>
          In{" "}
          <a className="text-nla underline underline-offset-2" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
            ArcGIS Online
          </a>
          , create Developer credentials → OAuth 2.0 credentials.
        </li>
        <li>
          Redirect URL: <span className="break-all text-ink">{appUrl}/api/auth/callback</span>
        </li>
        <li>
          Put the Client ID in the <span className="font-semibold text-ink">ARCGIS_OAUTH_CLIENT_ID</span> setting.
        </li>
      </ol>
    </HubScreen>
  );
}
