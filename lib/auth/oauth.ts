import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { TokenProvider } from "../arcgis/auth";
import type { ArcGisConfig } from "../arcgis/config";
import { ArcGisRequestError, arcgisRequest } from "../arcgis/rest";
import type { UserSession } from "./session";

/**
 * ArcGIS OAuth 2.0 authorization-code flow with PKCE. Users sign in on the org's own login page
 * (built-in, SSO and MFA all work); the server then edits the layer with that user's token.
 */

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  username: string;
  refresh_token?: string;
  refresh_token_expires_in?: number; // seconds
}

export interface CommunitySelf {
  username: string;
  fullName?: string;
  orgId?: string;
  privileges?: string[];
  groups?: { id: string; title: string }[];
}

/** Raised for sign-in problems that should be shown to the user verbatim. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export function createPkcePair(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge, state: randomBytes(16).toString("base64url") };
}

export function buildAuthorizeUrl(config: ArcGisConfig, state: string, codeChallenge: string): string {
  const url = new URL(`${config.portalUrl}/sharing/rest/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: config.oauthClientId,
    response_type: "code",
    redirect_uri: config.oauthRedirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    expiration: String(config.sessionMinutes),
  }).toString();
  return url.toString();
}

export async function exchangeCode(config: ArcGisConfig, code: string, codeVerifier: string): Promise<UserSession> {
  const res = await arcgisRequest<OAuthTokenResponse>(
    `${config.portalUrl}/sharing/rest/oauth2/token`,
    {
      client_id: config.oauthClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.oauthRedirectUri,
      code_verifier: codeVerifier,
    },
    { referer: config.appUrl },
  );
  if (!res.refresh_token) throw new SignInError("ArcGIS did not return a refresh token. Check the OAuth app's settings.");

  const now = Date.now();
  const self = await getCommunitySelf(config, res.access_token);
  assertMayUseApp(config, self);
  return {
    username: res.username,
    fullName: self.fullName || res.username,
    accessToken: res.access_token,
    accessExpiresAt: now + res.expires_in * 1000,
    refreshToken: res.refresh_token,
    refreshExpiresAt: now + (res.refresh_token_expires_in ?? config.sessionMinutes * 60) * 1000,
  };
}

export async function getCommunitySelf(config: ArcGisConfig, token: string): Promise<CommunitySelf> {
  return arcgisRequest<CommunitySelf>(
    `${config.portalUrl}/sharing/rest/community/self`,
    {},
    { referer: config.appUrl, token, method: "GET" },
  );
}

export function assertMayUseApp(config: ArcGisConfig, self: CommunitySelf): void {
  if (config.allowedGroupId && !self.groups?.some((g) => g.id === config.allowedGroupId)) {
    throw new SignInError(
      `${self.username} is not a member of the plan submission group. Ask your ArcGIS administrator to add you.`,
    );
  }
  if (self.privileges && !self.privileges.includes("features:user:edit")) {
    throw new SignInError(
      `${self.username} does not have the "Edit features" privilege (Viewer accounts cannot submit). Ask your administrator for a Contributor, Mobile Worker or Creator user type.`,
    );
  }
}

/**
 * Token provider backed by a user's session. Refreshes the access token with the refresh token
 * when it is about to expire (or after a 498), and exposes the updated session so the route can
 * re-issue the cookie.
 */
export function createUserTokenProvider(
  config: ArcGisConfig,
  initial: UserSession,
): TokenProvider & { readonly session: UserSession; readonly refreshed: boolean } {
  let session = initial;
  let refreshed = false;
  let forceRefresh = false;

  return {
    referer: config.appUrl,
    get session() {
      return session;
    },
    get refreshed() {
      return refreshed;
    },
    async getToken() {
      if (!forceRefresh && session.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return session.accessToken;
      // Username/password sign-ins have no refresh token: the session simply ends with the token.
      if (!session.refreshToken) {
        if (!forceRefresh && session.accessExpiresAt > Date.now()) return session.accessToken;
        throw new SessionExpiredError();
      }
      forceRefresh = false;
      try {
        const res = await arcgisRequest<OAuthTokenResponse>(
          `${config.portalUrl}/sharing/rest/oauth2/token`,
          { client_id: config.oauthClientId, grant_type: "refresh_token", refresh_token: session.refreshToken },
          { referer: config.appUrl },
        );
        session = { ...session, accessToken: res.access_token, accessExpiresAt: Date.now() + res.expires_in * 1000 };
        refreshed = true;
        return session.accessToken;
      } catch (err) {
        // A coded ArcGIS error (e.g. 400 invalid_grant) means the refresh token is no longer valid; network errors propagate.
        if (err instanceof ArcGisRequestError && err.code !== undefined) throw new SessionExpiredError();
        throw err;
      }
    },
    invalidate() {
      forceRefresh = true;
    },
  };
}

export class SessionExpiredError extends Error {
  constructor(message = "Your ArcGIS session has expired. Please sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}
