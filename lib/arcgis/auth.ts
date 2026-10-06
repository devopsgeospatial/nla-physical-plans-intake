/**
 * Token plumbing shared by the ArcGIS clients. The app authenticates as the signed-in user
 * (see lib/auth/oauth.ts, which implements TokenProvider on top of the OAuth session).
 */
import { ArcGisRequestError } from "./rest";

export interface TokenProvider {
  /** Sent as the Referer header on REST calls. */
  readonly referer: string;
  getToken(): Promise<string>;
  /** Forces the next getToken() to obtain a fresh token. */
  invalidate(): void;
}

/** Runs an authenticated call, refreshing the token once if ArcGIS rejects it (498/499). */
export async function withToken<T>(provider: TokenProvider, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await provider.getToken());
  } catch (err) {
    if (err instanceof ArcGisRequestError && err.isTokenError) {
      provider.invalidate();
      return call(await provider.getToken());
    }
    throw err;
  }
}
