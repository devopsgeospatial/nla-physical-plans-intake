import type { Metadata, Viewport } from "next";
import { Nunito_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Closest open font to Avenir, NLA's typeface on lands.rw.
const sans = Nunito_Sans({ subsets: ["latin"], variable: "--font-nunito", display: "swap", axes: ["opsz"] });

export const metadata: Metadata = {
  title: "Physical Plan Submission",
  description: "Append physical plan parcels, with their attributes and documents, to the Physical Plans layer.",
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
