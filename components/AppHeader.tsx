import Link from "next/link";

/** Header for signed-in pages: Rwanda coat of arms, title, the two views, user and sign out. */
export default function AppHeader({ active, fullName }: { active: "submit" | "submissions"; fullName: string }) {
  const tab = (href: string, label: string, isActive: boolean) => (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`flex h-14 items-center border-b-[3px] px-1 text-[14px] transition ${
        isActive ? "border-amber text-white" : "border-transparent text-white/65 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="relative z-[1001] flex h-14 shrink-0 items-center justify-between gap-4 bg-hub px-4 text-white sm:px-5">
      <div className="flex min-w-0 items-center gap-6">
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rwanda-emblem.png" alt="Republic of Rwanda" width={30} height={33} className="h-[33px] w-[30px] shrink-0" />
          <span className="hidden truncate text-[17px] md:inline">Physical Plan Submission</span>
        </div>
        <nav className="flex gap-5">
          {tab("/", "Submit", active === "submit")}
          {tab("/submissions", "My submissions", active === "submissions")}
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden text-[14px] lg:inline">{fullName}</span>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="h-8 border border-white/45 px-3.5 text-[13px] transition hover:bg-white/10">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
