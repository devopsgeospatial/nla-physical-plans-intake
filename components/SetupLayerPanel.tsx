"use client";

import { useState } from "react";

interface ProvisionResponse {
  ok: boolean;
  error?: string;
  layerUrl?: string;
  itemUrl?: string;
  orgName?: string;
  matchesConfig?: boolean;
  log?: string[];
}

/** Shown to a signed-in user when the configured intake layer does not exist yet. */
export default function SetupLayerPanel({ serviceName, layerUrl }: { serviceName: string; layerUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionResponse | null>(null);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/setup/layer", { method: "POST" });
      setResult((await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as ProvisionResponse);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
      <h2 className="text-lg font-medium">One-time setup: create the intake layer</h2>
      <p className="mt-2">
        The layer this app writes to does not exist yet:
        <br />
        <code className="break-all text-xs">{layerUrl}</code>
      </p>
      <p className="mt-2">
        Create <b>{serviceName}</b> now, owned by your account. It will use the same coordinate system as the existing
        Physical_Plans layer and include the review fields, status colours and PDF attachments. Requires the Publisher role.
      </p>

      {!result?.ok && (
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="mt-4 rounded-md bg-amber-700 px-4 py-2 font-medium text-white hover:bg-amber-800 disabled:bg-amber-300"
        >
          {busy ? "Creating layer…" : `Create ${serviceName}`}
        </button>
      )}

      {result && !result.ok && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-red-800">{result.error}</p>}

      {result?.ok && (
        <div className="mt-4 rounded-md bg-white p-4 text-slate-800">
          <p className="font-medium text-emerald-800">Layer created in {result.orgName}.</p>
          <p className="mt-1">
            Item:{" "}
            <a className="underline" href={result.itemUrl} target="_blank" rel="noreferrer">
              {result.itemUrl}
            </a>
          </p>
          {result.matchesConfig ? (
            <button type="button" onClick={() => window.location.reload()} className="mt-3 rounded-md bg-blue-700 px-4 py-2 font-medium text-white">
              Continue to the submission form
            </button>
          ) : (
            <p className="mt-2">
              Its URL differs from <code>ARCGIS_FEATURE_LAYER_URL</code>. Set this in <code>.env.local</code>, then reload:
              <code className="mt-1 block break-all rounded bg-slate-100 p-2 text-xs">ARCGIS_FEATURE_LAYER_URL={result.layerUrl}</code>
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Next on the item page: Settings → enable editing (add, update, delete) and editor tracking, then share it with the
            Plan Submitters and Plan Reviewers groups.
          </p>
        </div>
      )}
    </section>
  );
}
