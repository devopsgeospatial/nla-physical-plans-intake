/**
 * Token acquisition for a server-side service account (ArcGIS Online or Enterprise portal), with
 * in-memory caching, request de-duplication and early refresh. API keys are long-lived and used as-is.
 */
import { ArcGisRequestError, arcgisRequest } from "./rest";

export type TokenCredentials =
  | { mode: "password"; username: string; password: string }
  | { mode: "client_credentials"; clientId: string; clientSecret: string }
  | { mode: "api_key"; apiKey: string };

export interface TokenProviderOptions {
  portalUrl: string;
  referer: string;
  expirationMinutes: number;
  credentials: TokenCredentials;
}

export interface TokenProvider {
  readonly referer: string;
  getToken(): Promise<string>;
  invalidate(): void;
}

interface GenerateTokenResponse {
  token?: string;
  expires?: number; // epoch ms
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
}

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  let current: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const fetchToken = async (): Promise<string> => {
    const { portalUrl, referer, expirationMinutes, credentials } = options;

    if (credentials.mode === "api_key") {
      // Expiry is managed in the portal (Developer credentials); a 498 surfaces as an error after one retry.
      current = { token: credentials.apiKey, expiresAt: Number.MAX_SAFE_INTEGER };
      return current.token;
    }

    if (credentials.mode === "password") {
      const url = `${portalUrl}/sharing/rest/generateToken`;
      const res = await arcgisRequest<GenerateTokenResponse>(
        url,
        {
          username: credentials.username,
          password: credentials.password,
          client: "referer",
          referer,
          expiration: expirationMinutes,
        },
        { referer },
      );
      if (!res.token) throw new ArcGisRequestError("generateToken response did not include a token.", url);
      current = { token: res.token, expiresAt: res.expires ?? Date.now() + expirationMinutes * 60_000 };
    } else {
      const url = `${portalUrl}/sharing/rest/oauth2/token`;
      const res = await arcgisRequest<OAuthTokenResponse>(
        url,
        {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: "client_credentials",
          expiration: expirationMinutes,
        },
        { referer },
      );
      if (!res.access_token) throw new ArcGisRequestError("oauth2/token response did not include an access_token.", url);
      current = {
        token: res.access_token,
        expiresAt: Date.now() + (res.expires_in ?? expirationMinutes * 60) * 1000,
      };
    }
    return current.token;
  };

  return {
    referer: options.referer,
    async getToken() {
      if (current && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.token;
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      current = undefined;
    },
  };
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
