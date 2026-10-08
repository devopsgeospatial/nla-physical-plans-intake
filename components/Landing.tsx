import type { ReactNode } from "react";
import { STAGES } from "@/lib/public/stages";
import DistrictPicker, { type PickerDistrict } from "./DistrictPicker";


const STAGE_TEXT: Record<number, string> = {
  1: "The district sets out the plan's vision and scope.",
  2: "The draft is tested against national standards.",
  3: "Citizens see the plan and share their views.",
  4: "The plan is reviewed and approved for adoption.",
  5: "The plan becomes law and its delivery is tracked.",
};

/** Entry page, laid out after landlogic.ai. Choosing a district opens its public map directly. */
export default function Landing({
  submissionUrl,
  reviewUrl,
  publicUrl,
  districts,
}: {
  submissionUrl: string;
  reviewUrl: string;
  publicUrl: string;
  districts: PickerDistrict[];
}) {
  const picker = (props: Omit<Parameters<typeof DistrictPicker>[0], "districts" | "publicUrl">) => <DistrictPicker districts={districts} publicUrl={publicUrl} {...props} />;

  return (
    <main className={`ll-landing bg-white text-black antialiased`}>
      {/* ---- Header ---------------------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-black/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-[68px] max-w-[1320px] items-center justify-between gap-6 px-5 sm:px-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/nla-logo.png" alt="National Land Authority" width={84} height={42} className="h-[38px] w-auto" />
          <nav className="hidden items-center gap-7 text-[17px] font-medium lg:flex">
            <a href="#map" className="transition hover:text-[#00a982]">The map</a>
            <a href="#pipeline" className="transition hover:text-[#00a982]">How it works</a>
            <a href="#stages" className="transition hover:text-[#00a982]">Plan stages</a>
          </nav>
          <div className="flex items-center gap-5">
            <a href={submissionUrl} className="hidden text-[16px] font-medium transition hover:text-[#00a982] sm:block">
              Submit a plan
            </a>
            {picker({ align: "right" })}
          </div>
        </div>
      </header>

      {/* ---- Hero ------------------------------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        <div className="ll-glow pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-[1320px] px-5 pt-20 pb-24 text-center sm:px-8 sm:pt-28">
          <Eyebrow>Know your land. Shape your community.</Eyebrow>
          <h1 className="ll-rise mx-auto mt-5 max-w-[900px] text-[40px] leading-[1.05] font-semibold tracking-[-0.02em] [animation-delay:100ms] sm:text-[64px]">
            The physical plans platform
            <br className="hidden sm:block" /> for building what&apos;s next.
          </h1>
          <p className="ll-rise mx-auto mt-6 max-w-[560px] text-[18px] leading-7 text-black/80 [animation-delay:200ms] sm:text-[20px]">
            Rwanda Physical Plans delivers complete parcel-level planning intelligence, from a district&apos;s first proposal to the public map.
          </p>
          <div className="ll-rise relative z-30 mt-8 flex flex-wrap items-center justify-center gap-3 [animation-delay:300ms]">
            {picker({ label: "Get Started", align: "center" })}
            <a href={submissionUrl} className="inline-flex h-11 items-center rounded-md border border-black px-5 text-[15px] font-semibold transition hover:bg-black hover:text-white">
              Submit a plan
            </a>
          </div>

          {/* Framed media, as on landlogic.ai: a planned settlement with a parcel answer on top */}
          <div id="map" className="ll-rise relative z-0 mx-auto mt-16 max-w-[1060px] scroll-mt-28 [animation-delay:420ms]">
            <div className="overflow-hidden rounded-2xl border-[3px] border-white shadow-[0_30px_80px_rgba(20,60,80,0.25)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/planned-settlement.jpg" alt="A planned settlement in Kigali, seen from above" className="aspect-[16/9] w-full object-cover" />
            </div>
            <p className="absolute right-3 bottom-2 text-[11px] text-white/80">Imagery: Esri, Maxar</p>
          </div>
        </div>
      </section>

      {/* ---- Districts strip (in place of "trusted by") ---------------------------------------- */}
      <section className="border-y border-[#eeeeee] py-8">
        <p className="text-center text-[14px] font-bold tracking-[0.08em] uppercase">For every district of Rwanda</p>
        <div className="ll-marquee mt-5 overflow-hidden">
          <div className="ll-marquee-track flex w-max gap-10 text-[20px] font-semibold whitespace-nowrap">
            {[...districts, ...districts].map((d, i) => (
              <span key={i} className={d.live ? "text-black" : "text-black/25"}>
                {d.name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Pipeline -------------------------------------------------------------------------- */}
      <section id="pipeline" className="scroll-mt-20 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <div className="text-center">
            <Eyebrow>Built on one pipeline</Eyebrow>
            <h2 className="mx-auto mt-5 max-w-[760px] text-[34px] leading-[1.1] font-semibold tracking-[-0.01em] sm:text-[48px]">
              From a district&apos;s proposal to every citizen&apos;s parcel.
            </h2>
            <p className="mx-auto mt-5 max-w-[640px] text-[17px] leading-7 text-[#656368]">
              Districts submit their plans, the National Land Authority reviews them, and approved plans appear on the public map with their documents.
            </p>
            <div className="mt-7">{picker({ label: "Find your parcel", align: "center" })}</div>
          </div>

          <div className="mt-14 grid rounded-2xl bg-[linear-gradient(135deg,#0a7a5c_0%,#00a982_45%,#1cd396_100%)] text-white lg:grid-cols-[1fr_1.25fr]">
            <div className="relative z-10 p-8 sm:p-10">
              <h3 className="text-[30px] font-semibold">Physical Plans Map</h3>
              <p className="mt-3 text-[17px] leading-7 text-white/90">Is your parcel in the plan? Search it by UPI and see what the approved plan says about it.</p>
              <ul className="mt-6 space-y-2.5 text-[16px] font-semibold">
                {["Search any parcel by UPI", "See its zoning and plan coverage", "Follow the plan's stage", "Open the plan's documents"].map((t) => (
                  <li key={t} className="flex items-center gap-2.5">
                    <Check light /> {t}
                  </li>
                ))}
              </ul>
              <div className="mt-8">{picker({ label: "Open the map", variant: "light" })}</div>
            </div>
            <div className="relative min-h-[260px] overflow-hidden rounded-b-2xl lg:min-h-0 lg:rounded-r-2xl lg:rounded-bl-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/landing-app.jpg"
                alt="The Physical Plans Map showing a parcel's zoning"
                className="absolute top-8 left-8 w-[150%] max-w-none rounded-xl border border-white/40 shadow-[0_20px_50px_rgba(0,0,0,0.3)] lg:top-10"
              />
            </div>
          </div>

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <AppCard
              title="Physical Plan Submission"
              text="District planners upload the plan's parcels and documents, check them on the map, and follow NLA's response."
              href={submissionUrl}
              action="Submit a plan"
              tone="from-[#0b2235] via-[#103757] to-[#0e6b74]"
            />
            <AppCard
              title="Physical Plan Review"
              text="NLA reviewers approve each submitted plan, or return it to the district with comments and documents."
              href={reviewUrl}
              action="Open review"
              tone="from-[#111111] via-[#1b2a33] to-[#0c5c4c]"
            />
          </div>
        </div>
      </section>

      {/* ---- Stages (dark, rounded) ------------------------------------------------------------ */}
      <section id="stages" className="scroll-mt-20 px-3 sm:px-6">
        <div className="mx-auto max-w-[1360px] rounded-2xl bg-black px-5 py-20 text-white sm:px-10">
          <div className="text-center">
            <Eyebrow dark>From proposal to gazettement</Eyebrow>
            <h2 className="mx-auto mt-5 max-w-[640px] text-[34px] leading-[1.1] font-semibold sm:text-[48px]">Every plan, at every stage.</h2>
            <p className="mx-auto mt-5 max-w-[560px] text-[17px] leading-7 text-white/75">
              See where each site plan stands: ongoing sites move through four stages, and completed sites are gazetted and monitored.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-[1180px] gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STAGES.map((s) => (
              <div key={s.n} className="flex flex-col rounded-xl bg-[#151515] p-5">
                <span className={`grid size-9 place-items-center rounded-full text-[15px] font-bold ${s.n <= 2 ? "text-[#0b4f73]" : "text-white"}`} style={{ background: s.color }}>
                  {s.n}
                </span>
                <p className="mt-5 text-[17px] leading-6 font-semibold">{s.name}</p>
                <p className="mt-2 flex-1 text-[14px] leading-6 text-white/65">{STAGE_TEXT[s.n]}</p>
                <span className={`mt-5 w-fit border-b-2 pb-0.5 text-[13px] font-semibold ${s.status === "Completed" ? "border-[#1cd396] text-[#1cd396]" : "border-[#00aaff] text-[#7fd4ff]"}`}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Call to action + footer (black) --------------------------------------------------- */}
      <section className="mt-24 bg-black px-5 pt-24 pb-10 text-white sm:px-8">
        <div className="text-center">
          <h2 className="text-[34px] font-semibold sm:text-[48px]">Ready to get started?</h2>
          <p className="mt-4 text-[17px] text-white/80">Choose your district and search your parcel, or submit your district&apos;s plan.</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {picker({ variant: "light", align: "center" })}
            <a href={submissionUrl} className="inline-flex h-11 items-center rounded-md border border-white px-5 text-[15px] font-semibold transition hover:bg-white hover:text-black">
              Submit a plan
            </a>
          </div>
        </div>

        <footer className="mx-auto mt-28 max-w-[1320px] border-t border-white/25 pt-10">
          <div className="grid gap-8 text-[15px] sm:grid-cols-3">
            <FooterCol title="Apps">
              <a href="#map">Physical Plans Map</a>
              <a href={submissionUrl}>Physical Plan Submission</a>
              <a href={reviewUrl}>Physical Plan Review</a>
            </FooterCol>
            <FooterCol title="Resources">
              <a href="https://www.lands.rw/fileadmin/user_upload/LANDS/Publications/Master_Plans/Land_Use_Plans_Zoning_Regulations/Land_Use_Master_Plans__Zoning_Regulations_-_Edition_Two.pdf" target="_blank" rel="noopener">
                Zoning Regulations
              </a>
              <a href="#stages">Plan stages</a>
            </FooterCol>
            <FooterCol title="National Land Authority">
              <a href="https://www.lands.rw" target="_blank" rel="noopener">
                www.lands.rw
              </a>
            </FooterCol>
          </div>
          <p className="mt-14 text-[12px] text-white/60">© {new Date().getFullYear()} National Land Authority, Republic of Rwanda</p>
        </footer>
      </section>
    </main>
  );
}

function Eyebrow({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <div className="ll-rise inline-block">
      <p className={`text-[15px] font-bold tracking-[0.06em] uppercase ${dark ? "text-white" : "text-black"}`}>{children}</p>
      <span className="mt-1.5 block h-[3px] w-full bg-[linear-gradient(90deg,#00aaff_0%,#1cd3a5_100%)]" aria-hidden />
    </div>
  );
}

function AppCard({ title, text, href, action, tone }: { title: string; text: string; href: string; action: string; tone: string }) {
  return (
    <div className={`flex flex-col rounded-2xl bg-gradient-to-br ${tone} p-8 text-white`}>
      <h3 className="text-[22px] font-semibold">{title}</h3>
      <p className="mt-2 flex-1 text-[16px] leading-7 text-white/85">{text}</p>
      <a href={href} className="mt-6 inline-flex h-10 w-fit items-center rounded-md bg-white px-4 text-[14px] font-semibold text-black transition hover:bg-[#1cd396]">
        {action}
      </a>
    </div>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <div className="mt-3 flex flex-col gap-2 text-white/75 [&_a]:w-fit [&_a]:transition [&_a:hover]:text-[#1cd396]">{children}</div>
    </div>
  );
}

function Check({ light }: { light?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-[18px] shrink-0 fill-none ${light ? "stroke-white" : "stroke-[#00a982]"}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m8 12.5 2.7 2.7L16.2 9.6" />
    </svg>
  );
}
