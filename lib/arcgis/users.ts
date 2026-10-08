import "server-only";

import { withToken, type TokenProvider } from "./auth";
import { arcgisRequest } from "./rest";

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { fullName: string; expiresAt: number }>();

/**
 * Full names of ArcGIS users (the planners behind created_user), for the review list. Falls back to
 * the username when a profile can't be read (e.g. the account was deleted). Cached for an hour.
 */
export async function fullNames(portalUrl: string, tokens: TokenProvider, usernames: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    [...new Set(usernames)].map(async (username) => {
      const hit = cache.get(username);
      if (hit && hit.expiresAt > Date.now()) {
        out[username] = hit.fullName;
        return;
      }
      try {
        const user = await withToken(tokens, (token) =>
          arcgisRequest<{ fullName?: string }>(`${portalUrl}/sharing/rest/community/users/${encodeURIComponent(username)}`, {}, { referer: tokens.referer, token, method: "GET" }),
        );
        out[username] = user.fullName || username;
        cache.set(username, { fullName: out[username]!, expiresAt: Date.now() + TTL_MS });
      } catch {
        out[username] = username;
      }
    }),
  );
  return out;
}
