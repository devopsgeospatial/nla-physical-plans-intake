import { cookies } from "next/headers";
import type { ReactNode } from "react";
import UploadWorkspace, { type LayerSummary } from "@/components/UploadWorkspace";
import { ConfigurationError, getArcGisConfig, getUploadLimits, type ArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ auth_error?: string; u?: string }> }) {
  let config: ArcGisConfig;
  try {
    config = getArcGisConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) return <SetupNeeded problem={err.message} />;
    throw err;
  }

  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret);
  const { auth_error: authError, u: lastUsername } = await searchParams;
  if (!session) return <SignIn authError={authError} username={lastUsername} />;

  // Read the target layer as the signed-in user: its fields drive the attribute matching preview.
  let layer: LayerSummary;
  try {
    const meta = await new FeatureLayerClient(config.featureLayerUrl, createUserTokenProvider(config, session)).getMetadata();
    layer = {
      name: meta.name,
      fields: meta.fields.map(({ name, type, alias, length, editable }) => ({ name, type, alias, length, editable })),
      hasAttachments: meta.hasAttachments,
    };
  } catch (err) {
    const noAccess = err instanceof ArcGisRequestError && [400, 403, 499].includes(err.code ?? 0);
    return (
      <HubScreen>
        <h1 className="text-center text-[20px] font-semibold text-white">The Physical Plans layer can&apos;t be opened</h1>
        <p className="mt-4 text-[14px] leading-6 text-silver">
          {noAccess
            ? "Your account does not have access to the layer, or its address is wrong. Ask the layer owner to share it with you."
            : err instanceof Error
              ? err.message
              : String(err)}
        </p>
        <p className="mt-5 break-all bg-black/30 px-3 py-2 text-[12px] leading-5 text-silver/70">{config.featureLayerUrl}</p>
        <form action="/api/auth/logout" method="post" className="mt-7">
          <button type="submit" className="h-11 w-full rounded-none border border-white/40 text-[15px] text-white transition hover:bg-white/10">
            Sign out
          </button>
        </form>
      </HubScreen>
    );
  }

  return (
    <UploadWorkspace
      layer={layer}
      user={{ fullName: session.fullName, username: session.username }}
      maxRequestBytes={getUploadLimits().maxRequestBytes}
    />
  );
}

// ---------------------------------------------------------------------------------------------------

/** Same structure as the Rwanda Spatial Data Hub: slate-teal header bar, black band, grey panel. */
function HubScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-night">
      <header className="flex h-16 shrink-0 items-center bg-hub px-6 sm:px-10">
        <p className="text-[17px] text-white">Physical Plan Submission</p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-start px-4 py-10 sm:justify-center sm:py-14">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/rwanda-emblem.png" alt="Republic of Rwanda" width={117} height={128} className="mb-8 h-[128px] w-[117px]" />
        <section className="w-full max-w-[460px] bg-[rgb(90_90_90/0.4)] px-7 py-9 sm:px-9">{children}</section>
      </div>
    </main>
  );
}

const inputClass =
  "h-11 w-full rounded-none border border-[#bdbdbd] bg-white px-3 text-[15px] text-ink outline-none transition focus:border-nla focus:shadow-[0_0_0_1px_var(--color-nla)]";

function SignIn({ authError, username }: { authError?: string; username?: string }) {
  return (
    <HubScreen>
      <h1 className="text-center text-[20px] font-normal text-white">
        Sign in to <span className="font-semibold">Physical Plan Submission</span>
      </h1>
      <p className="mt-3 text-center text-[14px] leading-6 text-silver">Use your ArcGIS Online account.</p>

      {authError && (
        <p className="mt-6 border-l-2 border-[#ff6b6b] bg-black/30 px-3 py-2 text-[14px] leading-6 text-[#ffc4c4]" role="alert">
          {authError}
        </p>
      )}

      <form action="/api/auth/password" method="post" className="mt-7 space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-[14px] text-silver">Username</span>
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
          <span className="mb-1.5 block text-[14px] text-silver">Password</span>
          <input name="password" type="password" autoComplete="current-password" required autoFocus={!!username} className={inputClass} />
        </label>
        <button
          type="submit"
          className="h-11 w-full rounded-none bg-nla text-[16px] text-white transition hover:bg-[#0b6299] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-[14px] text-silver">
        Organization or two-step sign-in?{" "}
        <a href="/api/auth/login" className="text-nla-light underline underline-offset-2 hover:text-white">
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
    <HubScreen>
      <h1 className="text-center text-[20px] font-semibold text-white">Not connected to ArcGIS Online yet</h1>
      <p className="mt-3 text-center text-[13px] text-silver/70">{problem}</p>
      <ol className="mt-7 list-decimal space-y-3 pl-5 text-[14px] leading-6 text-silver">
        <li>
          In{" "}
          <a className="text-nla-light underline underline-offset-2" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
            ArcGIS Online
          </a>
          , create Developer credentials → OAuth 2.0 credentials.
        </li>
        <li>
          Redirect URL: <span className="break-all text-white">{appUrl}/api/auth/callback</span>
        </li>
        <li>
          Put the Client ID in the <span className="text-white">ARCGIS_OAUTH_CLIENT_ID</span> setting.
        </li>
      </ol>
    </HubScreen>
  );
}
