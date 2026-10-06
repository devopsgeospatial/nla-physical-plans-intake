import "server-only";

import type { ArcGisConfig } from "../arcgis/config";
import { ArcGisRequestError, arcgisRequest } from "../arcgis/rest";
import { assertMayUseApp, getCommunitySelf, SignInError } from "./oauth";
import type { UserSession } from "./session";

interface GenerateTokenResponse {
  token?: string;
  expires?: number; // epoch ms
}

/** Session length for username/password sign-ins (no refresh token, so the user signs in again after). */
const PASSWORD_SESSION_MINUTES = 12 * 60;

/**
 * Signs a user in with their ArcGIS Online username and password via generateToken. The password is
 * used for this one request and never stored; the resulting token is kept in the encrypted session
 * cookie. Accounts that sign in through SSO or use MFA cannot use generateToken and must use the
 * OAuth ("organization sign-in") flow instead.
 */
export async function signInWithPassword(config: ArcGisConfig, username: string, password: string): Promise<UserSession> {
  let res: GenerateTokenResponse;
  try {
    res = await arcgisRequest<GenerateTokenResponse>(
      `${config.portalUrl}/sharing/rest/generateToken`,
      { username, password, client: "referer", referer: config.appUrl, expiration: PASSWORD_SESSION_MINUTES },
      { referer: config.appUrl },
    );
  } catch (err) {
    if (err instanceof ArcGisRequestError && err.code !== undefined) {
      throw new SignInError(
        /invalid username or password/i.test(err.message)
          ? "Wrong username or password."
          : `ArcGIS Online refused the sign-in: ${err.message} If your account uses organization (SSO) sign-in or two-step verification, use the organization sign-in link below.`,
      );
    }
    throw err;
  }
  if (!res.token) throw new SignInError("ArcGIS Online did not return a token.");

  const self = await getCommunitySelf(config, res.token);
  assertMayUseApp(config, self);
  const expiresAt = res.expires ?? Date.now() + PASSWORD_SESSION_MINUTES * 60_000;
  return {
    username: self.username,
    fullName: self.fullName || self.username,
    accessToken: res.token,
    accessExpiresAt: expiresAt,
    refreshToken: "",
    refreshExpiresAt: expiresAt,
  };
}
