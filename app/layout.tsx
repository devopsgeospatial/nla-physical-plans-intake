import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { figtree } from "@/lib/fonts";
import "./globals.css";

const METADATA: Record<string, Metadata> = {
  home: { title: "Physical Plans", description: "Submit district physical plans to the National Land Authority, and review them." },
  public: { title: "Physical Plans", description: "Is your parcel within an approved physical plan? Choose your district and search by UPI." },
  review: { title: "Physical Plan Review", description: "Review submitted physical plans: approve them or return them to the planner with comments." },
  submission: { title: "Physical Plan Submission", description: "Append physical plan parcels, with their attributes and documents, to the Physical Plans layer." },
};

export const metadata: Metadata = METADATA[process.env.APP_MODE ?? ""] ?? METADATA.submission!;

export const viewport: Viewport = { themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
