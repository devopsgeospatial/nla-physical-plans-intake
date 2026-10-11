"use client";

import { useEffect, useState } from "react";

/**
 * "Continue with ArcGIS". ArcGIS's sign-in page cannot be shown inside another site's frame, so when
 * the app is embedded (e.g. in Experience Builder) the link opens the app in a new tab instead.
 */
export default function SsoLink({ className }: { className?: string }) {
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      setEmbedded(true);
    }
  }, []);
  if (embedded) {
    return (
      <a href="/" target="_blank" rel="noopener" className={className}>
        Open in a new tab
      </a>
    );
  }
  return (
    <a href="/api/auth/login" className={className}>
      Continue with ArcGIS
    </a>
  );
}
