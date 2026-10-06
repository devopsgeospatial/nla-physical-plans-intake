import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { BrandMark, IconAlert, IconGlobe, IconLayers, IconShield } from "@/components/icons";
import UploadWorkspace, { type LayerSummary } from "@/components/UploadWorkspace";
import { ConfigurationError, getArcGisConfig, getUploadLimits, type ArcGisConfig } from "@/lib/arcgis/config";
import { FeatureLayerClient } from "@/lib/arcgis/feature-layer";
import { ArcGisRequestError } from "@/lib/arcgis/rest";
import { createUserTokenProvider } from "@/lib/auth/oauth";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ auth_error?: string }> }) {
  let config: ArcGisConfig;
  try {
    config = getArcGisConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) return <SetupNeeded problem={err.message} />;
    throw err;
  }

  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret);
  const { auth_error: authError } = await searchParams;
  if (!session) return <SignIn portalHost={new URL(config.portalUrl).host} authError={authError} />;

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
      <Backdrop>
        <Card>
          <StatusIcon tone="amber">
            <IconAlert />
          </StatusIcon>
          <h1 className="mt-5 text-xl font-semibold">The Physical Plans layer can&apos;t be opened</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            {noAccess
              ? `${session.fullName}, your account does not have access to the layer, or its address is wrong. Ask the layer owner to share it with you.`
              : err instanceof Error
                ? err.message
                : String(err)}
          </p>
          <p className="mt-4 break-all rounded-lg bg-ink-950/60 p-3 font-mono text-[11px] text-slate-400">{config.featureLayerUrl}</p>
          <SignOutButton className="mt-6" />
        </Card>
      </Backdrop>
    );
  }

  return (
    <UploadWorkspace
      layer={layer}
      user={{ fullName: session.fullName, username: session.username }}
      portalHost={new URL(config.portalUrl).host}
      maxRequestBytes={getUploadLimits().maxRequestBytes}
    />
  );
}

// ---------------------------------------------------------------------------------------------------

function Backdrop({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div
        className="absolute inset-0 scale-105 bg-cover bg-center"
        style={{ backgroundImage: "url(/hero-muhanga.jpg)" }}
        aria-hidden
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(7_11_20/0.35),rgb(7_11_20/0.92)_60%)]" aria-hidden />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/40 to-transparent" aria-hidden />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-8">
        <header className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-wide">Physical Plans</p>
            <p className="text-xs text-slate-400">National Land Authority · Rwanda</p>
          </div>
        </header>
        <div className="flex flex-1 items-center py-10">{children}</div>
        <footer className="text-[11px] text-slate-500">Imagery: Muhanga · Esri, Maxar, Earthstar Geographics</footer>
      </div>
    </main>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="glass w-full max-w-md animate-rise rounded-3xl p-7 sm:p-8">{children}</section>;
}

function StatusIcon({ tone, children }: { tone: "amber" | "sky"; children: ReactNode }) {
  const tones = { amber: "bg-amber-400/15 text-amber-300 ring-amber-400/30", sky: "bg-sky/15 text-sky ring-sky/30" };
  return <span className={`grid size-11 place-items-center rounded-2xl ring-1 ${tones[tone]}`}>{children}</span>;
}

function SignIn({ portalHost, authError }: { portalHost: string; authError?: string }) {
  return (
    <Backdrop>
      <div className="grid w-full items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div className="hidden animate-rise lg:block">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
            <span className="size-1.5 rounded-full bg-hill" /> Live connection to ArcGIS Online
          </p>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.05] tracking-tight">
            Plans in.
            <br />
            <span className="bg-gradient-to-r from-sky via-hill to-sun bg-clip-text text-transparent">On the map in seconds.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-slate-300">
            Drop a Shapefile or GeoJSON, check the parcels on the map, and append them, with their attributes and documents, straight
            into the Physical Plans layer.
          </p>
        </div>

        <Card>
          <StatusIcon tone="sky">
            <IconLayers />
          </StatusIcon>
          <h2 className="mt-5 text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-400">Use your ArcGIS Online account. Every upload is recorded under your name.</p>

          {authError && (
            <p className="mt-5 flex gap-2.5 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-sm leading-5 text-red-200" role="alert">
              <IconAlert className="mt-0.5 shrink-0" width={16} height={16} />
              {authError}
            </p>
          )}

          <a
            href="/api/auth/login"
            className="btn-primary mt-6 flex h-12 items-center justify-center gap-2.5 rounded-xl text-sm font-semibold text-white transition"
          >
            <IconGlobe width={18} height={18} />
            Sign in with ArcGIS
          </a>
          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-500">
            <IconShield width={14} height={14} /> Secured by {portalHost}
          </p>
        </Card>
      </div>
    </Backdrop>
  );
}

function SetupNeeded({ problem }: { problem: string }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const portal = process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com";
  const steps: ReactNode[] = [
    <>
      In{" "}
      <a className="text-sky underline-offset-2 hover:underline" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
        ArcGIS Online
      </a>
      : <b className="font-semibold text-white">Content → New item → Developer credentials → OAuth 2.0 credentials</b>
    </>,
    <>
      Redirect URL <code className="rounded bg-ink-950/70 px-1.5 py-0.5 font-mono text-xs text-sun">{appUrl}/api/auth/callback</code>
    </>,
    <>
      Copy the <b className="font-semibold text-white">Client ID</b> into the <code className="font-mono text-xs">ARCGIS_OAUTH_CLIENT_ID</code> setting
    </>,
  ];
  return (
    <Backdrop>
      <Card>
        <StatusIcon tone="amber">
          <IconAlert />
        </StatusIcon>
        <h1 className="mt-5 text-xl font-semibold">One step left: connect to ArcGIS Online</h1>
        <p className="mt-2 text-sm text-slate-400">{problem}</p>
        <ol className="mt-6 space-y-4">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm leading-6 text-slate-300">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sky/15 font-mono text-xs text-sky">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Card>
    </Backdrop>
  );
}

function SignOutButton({ className = "" }: { className?: string }) {
  return (
    <form action="/api/auth/logout" method="post" className={className}>
      <button type="submit" className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200 hover:bg-white/5">
        Sign out
      </button>
    </form>
  );
}
