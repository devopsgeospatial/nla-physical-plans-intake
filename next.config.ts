import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (ignored by Vercel).
  output: "standalone",
};

export default nextConfig;
