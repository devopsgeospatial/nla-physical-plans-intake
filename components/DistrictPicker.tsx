"use client";

import { useEffect, useRef, useState } from "react";

export interface PickerDistrict {
  slug: string;
  name: string;
  province: string;
  live: boolean;
}

/**
 * "Select your district": choosing one opens that district's public map directly. Districts whose
 * map is not live yet are listed but greyed out.
 */
export default function DistrictPicker({
  districts,
  publicUrl,
  label = "Select your district",
  variant = "solid",
  align = "left",
}: {
  districts: PickerDistrict[];
  publicUrl: string;
  label?: string;
  variant?: "solid" | "outline" | "light";
  align?: "left" | "right" | "center";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const provinces = [...new Set(districts.map((d) => d.province))];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const button = {
    solid: "bg-black text-white hover:bg-[#00a982]",
    outline: "border border-black text-black hover:bg-black hover:text-white",
    light: "bg-white text-black hover:bg-[#1cd396]",
  }[variant];
  const place = { left: "left-0", right: "right-0", center: "left-1/2 -translate-x-1/2" }[align];

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-11 items-center gap-2 rounded-md px-5 text-[15px] font-semibold transition ${button}`}
      >
        {label}
        <svg viewBox="0 0 24 24" className={`size-4 fill-none stroke-current transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.4} strokeLinecap="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className={`ll-pop absolute z-50 mt-2 max-h-[min(75dvh,600px)] w-[min(92vw,520px)] overflow-y-auto rounded-2xl border border-[#e7e7e7] bg-white p-5 text-black shadow-[0_24px_60px_rgba(0,0,0,0.18)] ${place}`}
        >
          <p className="text-[11px] font-bold tracking-[0.1em] text-[#656368] uppercase">Available now</p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {districts
              .filter((d) => d.live)
              .map((d) => (
                <li key={d.slug}>
                  <a
                    role="menuitem"
                    href={`${publicUrl}/${d.slug}`}
                    className="group flex items-center justify-between rounded-xl border border-[#e7e7e7] px-4 py-3 transition hover:border-[#00a982] hover:bg-[#e8faf3]"
                  >
                    <span>
                      <span className="block text-[16px] font-semibold">{d.name}</span>
                      <span className="block text-[12px] text-[#656368]">{d.province}</span>
                    </span>
                    <span className="text-[18px] text-[#00a982] transition-transform group-hover:translate-x-1" aria-hidden>
                      →
                    </span>
                  </a>
                </li>
              ))}
          </ul>

          <p className="mt-6 text-[11px] font-bold tracking-[0.1em] text-[#656368] uppercase">Coming soon</p>
          <div className="mt-2 space-y-2">
            {provinces.map((province) => {
              const soon = districts.filter((d) => d.province === province && !d.live);
              if (soon.length === 0) return null;
              return (
                <p key={province} className="text-[13px] leading-5 text-[#9a9a9a]">
                  <span className="font-semibold text-[#656368]">{province}:</span> {soon.map((d) => d.name).join(", ")}
                </p>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
