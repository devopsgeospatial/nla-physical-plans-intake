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
  const portalHost = new URL(config.portalUrl).host;
  if (!session) return <SignIn portalHost={portalHost} authError={authError} username={lastUsername} />;

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
      <Split>
        <h1 className="text-[28px] font-light leading-tight text-white">The Physical Plans layer can&apos;t be opened.</h1>
        <p className="mt-4 text-[15px] leading-7 text-white/60">
          {noAccess
            ? "Your account does not have access to the layer, or its address is wrong. Ask the layer owner to share it with you."
            : err instanceof Error
              ? err.message
              : String(err)}
        </p>
        <p className="mt-6 break-all border-l-2 border-nla pl-3 text-xs leading-5 text-white/45">{config.featureLayerUrl}</p>
        <form action="/api/auth/logout" method="post" className="mt-10">
          <button type="submit" className="h-11 rounded-full border border-white/30 px-6 text-sm text-white transition hover:border-white">
            Sign out
          </button>
        </form>
      </Split>
    );
  }

  return (
    <UploadWorkspace
      layer={layer}
      user={{ fullName: session.fullName, username: session.username }}
      portalHost={portalHost}
      maxRequestBytes={getUploadLimits().maxRequestBytes}
    />
  );
}

// ---------------------------------------------------------------------------------------------------

/** Aerial of Muhanga on the left, black panel on the right. */
function Split({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-ink lg:grid-cols-[1.15fr_1fr]">
      <aside className="relative hidden overflow-hidden lg:block">
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: "url(/aerial-muhanga.jpg)" }} aria-hidden />
        <div className="absolute inset-0 bg-black/55" aria-hidden />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <p className="text-sm tracking-wide text-white/80">
            National Land Authority <span className="text-nla-light">·</span> Republic of Rwanda
          </p>
          <div>
            <p className="max-w-xl text-[56px] font-extralight leading-[1.02] tracking-[-0.02em]">Physical plan submission</p>
            <p className="mt-6 max-w-md text-base font-light leading-7 text-white/75">
              Append plan parcels, with their attributes and documents, to the Physical Plans layer in ArcGIS Online.
            </p>
          </div>
          <p className="text-[11px] text-white/45">Muhanga · Imagery Esri, Maxar, Earthstar Geographics</p>
        </div>
      </aside>

      <section className="flex min-h-dvh border-t-4 border-nla px-6 py-10 sm:px-14 lg:border-t-0 lg:border-l-4">
        <div className="mx-auto flex w-full max-w-[380px] flex-col justify-between gap-12">
          <p className="text-sm text-white/70 lg:invisible">National Land Authority · Rwanda</p>
          <div>{children}</div>
          <p className="text-[11px] text-white/35">Physical Plans · ArcGIS Online</p>
        </div>
      </section>
    </main>
  );
}

function SignIn({ portalHost, authError, username }: { portalHost: string; authError?: string; username?: string }) {
  return (
    <Split>
      <h1 className="text-[34px] font-light leading-tight tracking-[-0.01em] text-white lg:hidden">Physical plan submission</h1>
      <h2 className="mt-8 text-[26px] font-light text-white lg:mt-0">Sign in</h2>
      <p className="mt-2 text-[15px] leading-6 text-white/60">
        With your ArcGIS Online account on <span className="text-white">{portalHost}</span>.
      </p>

      {authError && (
        <p className="mt-6 border-l-2 border-[#ff6b6b] pl-3 text-sm leading-6 text-[#ffb3b3]" role="alert">
          {authError}
        </p>
      )}

      <form action="/api/auth/password" method="post" className="mt-10 space-y-8">
        <Underline label="Username">
          <input
            name="username"
            autoComplete="username"
            required
            defaultValue={username}
            autoFocus={!username}
            spellCheck={false}
            autoCapitalize="none"
            className="w-full border-0 border-b border-white/25 bg-transparent pb-2.5 text-lg font-light text-white outline-none transition focus:border-nla"
          />
        </Underline>
        <Underline label="Password">
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus={!!username}
            className="w-full border-0 border-b border-white/25 bg-transparent pb-2.5 text-lg font-light text-white outline-none transition focus:border-nla"
          />
        </Underline>
        <button
          type="submit"
          className="h-12 w-full rounded-full bg-nla text-[15px] font-semibold text-white transition hover:bg-[#0a9de3] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-nla"
        >
          Sign in
        </button>
      </form>

      <p className="mt-8 text-sm text-white/55">
        Organization or two-step sign-in?{" "}
        <a href="/api/auth/login" className="text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-nla">
          Continue with ArcGIS
        </a>
      </p>
      <p className="mt-12 text-xs leading-5 text-white/35">Your password is sent to ArcGIS Online once to sign you in. It is not stored.</p>
    </Split>
  );
}

function Underline({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs text-white/50">{label}</span>
      {children}
    </label>
  );
}

function SetupNeeded({ problem }: { problem: string }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const portal = process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com";
  return (
    <Split>
      <h1 className="text-[28px] font-light leading-tight text-white">This app is not connected to ArcGIS Online yet.</h1>
      <p className="mt-3 text-sm text-white/45">{problem}</p>
      <ol className="mt-10 space-y-6 text-[15px] leading-7 text-white/75">
        <li className="border-l-2 border-nla pl-4">
          In{" "}
          <a className="text-white underline underline-offset-4" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
            ArcGIS Online
          </a>
          , create <span className="text-white">Developer credentials → OAuth 2.0 credentials</span>.
        </li>
        <li className="border-l-2 border-nla pl-4">
          Redirect URL: <span className="break-all text-white">{appUrl}/api/auth/callback</span>
        </li>
        <li className="border-l-2 border-nla pl-4">
          Put the Client ID in the <span className="text-white">ARCGIS_OAUTH_CLIENT_ID</span> setting.
        </li>
      </ol>
    </Split>
  );
}
