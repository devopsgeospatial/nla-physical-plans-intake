import Link from "next/link";

export interface HeaderTab {
  href: string;
  label: string;
  active: boolean;
  /** Small count after the label (e.g. submissions waiting for review). */
  count?: number;
}

/** Header for signed-in pages: white, as on the public map — NLA logo, app title, views, user and sign out. */
export default function AppHeader({ title, tabs, fullName }: { title: string; tabs: HeaderTab[]; fullName: string }) {
  return (
    <header className="relative z-[1001] flex h-16 shrink-0 items-center justify-between gap-4 border-b border-hairline bg-white px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/nla-logo.png" alt="National Land Authority" width={72} height={36} className="h-[34px] w-auto shrink-0" />
        <span className="hidden truncate border-l border-hairline pl-5 text-[17px] font-semibold text-ink md:inline">{title}</span>
        <nav className="flex h-16 gap-5">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={`flex items-center gap-1.5 border-b-2 px-1 text-[14px] font-medium whitespace-nowrap transition ${
                tab.active ? "border-nla-light text-nla" : "border-transparent text-graphite hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && <span className="rounded-full bg-nla-tint px-1.5 text-[11px] leading-[18px] font-semibold text-nla">{tab.count}</span>}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden text-[14px] text-graphite lg:inline">{fullName}</span>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="h-9 rounded-full border border-[#dfe5ea] px-4 text-[13px] font-medium text-ink transition hover:border-nla-light hover:text-nla">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

/** The submission app's two views. */
export function submissionTabs(active: "submit" | "submissions"): HeaderTab[] {
  return [
    { href: "/", label: "Submit", active: active === "submit" },
    { href: "/submissions", label: "My submissions", active: active === "submissions" },
  ];
}
