import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { BrandMark, IconAlert, IconGlobe, IconLock, IconUser } from "@/components/icons";
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
      <Night>
        <Card>
          <CardIcon tone="warn">
            <IconAlert />
          </CardIcon>
          <h1 className="mt-5 text-xl font-semibold text-white">The Physical Plans layer can&apos;t be opened</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            {noAccess
              ? `${session.fullName}, your account does not have access to the layer, or its address is wrong. Ask the layer owner to share it with you.`
              : err instanceof Error
                ? err.message
                : String(err)}
          </p>
          <p className="mt-4 break-all rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] text-slate-400">{config.featureLayerUrl}</p>
          <form action="/api/auth/logout" method="post" className="mt-6">
            <button type="submit" className="h-11 rounded-xl border border-white/15 px-4 text-sm font-medium text-slate-200 hover:bg-white/5">
              Sign out
            </button>
          </form>
        </Card>
      </Night>
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

function Night({ children }: { children: ReactNode }) {
  return (
    <main className="night-backdrop flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">{children}</div>
    </main>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="animate-rise rounded-3xl border border-ice/15 bg-night-2/90 p-7 shadow-[0_40px_120px_-40px_rgb(56_189_248/0.45)] backdrop-blur sm:p-8">
      {children}
    </section>
  );
}

function CardIcon({ tone, children }: { tone: "warn" | "ice"; children: ReactNode }) {
  const tones = { warn: "bg-amber-400/10 text-amber-300 ring-amber-300/25", ice: "bg-ice/10 text-ice ring-ice/25" };
  return <span className={`grid size-11 place-items-center rounded-2xl ring-1 ${tones[tone]}`}>{children}</span>;
}

function SignIn({ portalHost, authError, username }: { portalHost: string; authError?: string; username?: string }) {
  return (
    <Night>
      <Card>
        <div className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">Physical Plan Submission</p>
            <p className="text-xs text-ice/80">ArcGIS Online · {portalHost}</p>
          </div>
        </div>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-white">Sign in to ArcGIS Online</h1>
        <p className="mt-1.5 text-sm text-slate-400">Use your ArcGIS Online username and password.</p>

        {authError && (
          <p className="mt-5 flex gap-2.5 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm leading-5 text-rose-100" role="alert">
            <IconAlert className="mt-0.5 shrink-0 text-rose-300" width={16} height={16} />
            {authError}
          </p>
        )}

        <form action="/api/auth/password" method="post" className="mt-6 space-y-4">
          <Field label="Username" icon={<IconUser width={16} height={16} />}>
            <input
              name="username"
              autoComplete="username"
              required
              defaultValue={username}
              autoFocus={!username}
              spellCheck={false}
              autoCapitalize="none"
              className="peer h-12 w-full rounded-xl border border-white/10 bg-black/40 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-ice/60 focus:ring-4 focus:ring-ice/15"
              placeholder="e.g. jdoe_rla"
            />
          </Field>
          <Field label="Password" icon={<IconLock width={16} height={16} />}>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus={!!username}
              className="h-12 w-full rounded-xl border border-white/10 bg-black/40 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-ice/60 focus:ring-4 focus:ring-ice/15"
              placeholder="••••••••"
            />
          </Field>
          <button type="submit" className="btn-ice mt-2 h-12 w-full rounded-xl text-sm font-semibold transition">
            Sign in
          </button>
        </form>

        <div className="my-6 flex items-center gap-3 text-[11px] uppercase tracking-widest text-slate-600">
          <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
        </div>

        <a
          href="/api/auth/login"
          className="flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 text-sm font-medium text-slate-200 transition hover:border-ice/40 hover:bg-ice/5"
        >
          <IconGlobe width={16} height={16} className="text-ice" />
          Sign in with ArcGIS
          <span className="text-slate-500">(organization / SSO)</span>
        </a>

        <p className="mt-6 text-center text-[11px] leading-5 text-slate-500">
          Your password is used once to sign in to ArcGIS Online and is never stored.
        </p>
      </Card>
    </Night>
  );
}

function Field({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
      <span className="relative block">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">{icon}</span>
        {children}
      </span>
    </label>
  );
}

function SetupNeeded({ problem }: { problem: string }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const portal = process.env.ARCGIS_PORTAL_URL || "https://rla.maps.arcgis.com";
  const steps: ReactNode[] = [
    <>
      In{" "}
      <a className="text-ice underline-offset-2 hover:underline" href={`${portal}/home/content.html`} target="_blank" rel="noreferrer">
        ArcGIS Online
      </a>
      : <b className="font-semibold text-white">Content → New item → Developer credentials → OAuth 2.0 credentials</b>
    </>,
    <>
      Redirect URL <code className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-xs text-ice">{appUrl}/api/auth/callback</code>
    </>,
    <>
      Copy the <b className="font-semibold text-white">Client ID</b> into the <code className="font-mono text-xs">ARCGIS_OAUTH_CLIENT_ID</code> setting
    </>,
  ];
  return (
    <Night>
      <Card>
        <CardIcon tone="warn">
          <IconAlert />
        </CardIcon>
        <h1 className="mt-5 text-xl font-semibold text-white">One step left: connect to ArcGIS Online</h1>
        <p className="mt-2 text-sm text-slate-400">{problem}</p>
        <ol className="mt-6 space-y-4">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm leading-6 text-slate-300">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ice/10 font-mono text-xs text-ice">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Card>
    </Night>
  );
}
